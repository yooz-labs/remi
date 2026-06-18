/**
 * Core auto-approve service.
 *
 * Evaluates PermissionRequest hook events using an LLM (via OpenAI-compatible
 * API). Returns one of: approve, deny, escalate, pick (multi-choice), or
 * cancelled (control plane).
 *
 * Designed to never throw. All errors result in escalation so the user
 * is never blocked by an LLM failure.
 */

import { errorToString } from '@remi/shared';
import { extractJsonObject } from './json-extract.ts';
import { chatCompletion, resolveProviderUrl, warmModel } from './llm-client.ts';
import type { LLMClientConfig } from './llm-client.ts';
import {
  buildMultiChoicePrompt,
  isDesignQuestion,
  isMultiChoicePermission,
  parseMultiChoiceDecision,
} from './multichoice.ts';
import { matchPattern } from './pattern-matcher.ts';
import { matchGroups } from './permission-groups.ts';
import { buildPrompt } from './prompt-builder.ts';
import type { AutoApproveConfig, AutoApproveResult, MultiChoiceMode } from './types.ts';

type BinaryDecision = 'approve' | 'deny' | 'escalate';
const VALID_DECISIONS = new Set<BinaryDecision>(['approve', 'deny', 'escalate']);

/**
 * Convert one `permission_suggestions` entry into an LLM-ready label, or
 * null when the entry carries no useful content. Strings pass through;
 * objects are JSON-serialised so the LLM can read a structured option like
 * `{"type":"addDirectories",...}` (very long serialisations are truncated).
 */
export function normalisePermissionSuggestion(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (entry !== null && typeof entry === 'object') {
    try {
      const serialised = JSON.stringify(entry);
      if (!serialised || serialised === '{}') return null;
      return serialised.length > 200 ? `${serialised.slice(0, 197)}...` : serialised;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse an LLM response string into a binary approve/deny/escalate decision.
 * Tries JSON first. If JSON fails, escalates (no guessing from substring matches).
 * Exported for unit testing.
 */
export function parseDecision(raw: string): { decision: BinaryDecision; reasoning: string } {
  // extractJsonObject tolerates a markdown code fence or a short preamble around
  // the JSON (deterministic, string-aware — never a free-text keyword guess).
  // Many reasoning-tuned local models, notably qwen3.6:35b-mlx, fence every
  // response; without this they escalate every safe verdict on formatting alone.
  const parsed = extractJsonObject(raw);
  if (parsed !== null) {
    const decisionStr = String(parsed['decision'] ?? '').toLowerCase();
    const reasoning = String(parsed['reasoning'] ?? '');
    if (VALID_DECISIONS.has(decisionStr as BinaryDecision)) {
      return { decision: decisionStr as BinaryDecision, reasoning };
    }
  }

  return {
    decision: 'escalate',
    reasoning: `Unparsable LLM response: ${raw.slice(0, 100)}`,
  };
}

export class AutoApproveService {
  private readonly llmConfig: LLMClientConfig;
  private readonly logFn: (msg: string) => void;
  private readonly logDecisions: boolean;
  private readonly allow: readonly string[];
  private readonly deny: readonly string[];
  private readonly approveGroups: readonly string[];
  private readonly denyGroups: readonly string[];
  private readonly instructions: string;
  private readonly multichoiceMode: MultiChoiceMode;
  /** Tool names that always escalate to the user, never auto-decided (#572). */
  private readonly alwaysEscalateTools: ReadonlySet<string>;
  /** Falls back to llmConfig.model when empty. */
  private readonly multichoiceModel: string;
  /** Second-opinion model on a primary 'escalate' (#522); empty = none. Public
   *  so the gate can read it without re-threading the config. */
  readonly escalateModel: string;
  /** Dedicated timeout (ms) for escalate_model calls; 0 => fall back to the
   *  fast model's timeout. The heavy model is usually cold, so it needs a longer
   *  budget than the fast path. */
  private readonly escalateTimeoutMs: number;
  /** True when the provider is Ollama (enables the native warm-up load). */
  private readonly providerIsOllama: boolean;
  /** Max ms a permission eval may wait in the serialization queue before it
   *  escalates gracefully (#551); 0 = no bound. */
  private readonly queueTimeoutMs: number;
  /** Serialize LLM evals: one runs at a time (one GPU). Concurrent requests
   *  QUEUE here instead of escalating-on-busy (#551). `evalActive` is true while
   *  a slot is held; `evalQueue` holds the FIFO waiters. The fast-path
   *  deny/allow/group checks run BEFORE acquiring a slot, so they are never
   *  queued. */
  private evalActive = false;
  private readonly evalQueue: Array<{ grant: () => void }> = [];
  /** Active LLM call's controller; cleared in the eval finally block. cancel()
   *  aborts via this. Held alongside the active slot so they share the same
   *  lifecycle window. */
  private currentAbortController: AbortController | null = null;
  /** Set by cancel() so the catch block can distinguish a user-driven abort
   *  (Claude advanced past the prompt) from a timeout abort. */
  private cancelReason: string | null = null;

  constructor(config: AutoApproveConfig, logFn: (msg: string) => void) {
    this.llmConfig = {
      baseUrl: resolveProviderUrl(config.provider, config.base_url),
      apiKey: config.api_key,
      model: config.model,
      timeoutMs: config.timeout * 1000,
      // Opt-in (Ollama only): native /api/chat with `think: false` to disable
      // reasoning. Faster, but lowers decision quality (the chain-of-thought is
      // load-bearing for following broad user instructions), so default OFF.
      // Everyone else uses the OpenAI-compat path with reasoning on.
      kind: config.provider === 'ollama' && config.disable_thinking ? 'ollama' : 'openai',
    };
    this.logFn = logFn;
    this.logDecisions = config.log_decisions;
    this.allow = config.allow;
    this.deny = config.deny;
    this.approveGroups = config.approve_groups;
    this.denyGroups = config.deny_groups;
    this.instructions = config.instructions;
    this.multichoiceMode = config.multichoice;
    this.alwaysEscalateTools = new Set(config.always_escalate_tools);
    this.multichoiceModel = config.multichoice_model;
    this.escalateModel = config.escalate_model;
    this.escalateTimeoutMs = config.escalate_timeout > 0 ? config.escalate_timeout * 1000 : 0;
    this.queueTimeoutMs = config.queue_timeout > 0 ? config.queue_timeout * 1000 : 0;
    this.providerIsOllama = config.provider === 'ollama';
  }

  /**
   * Acquire the single eval slot, serializing concurrent LLM evaluations (one
   * GPU). Resolves true when the slot is held; resolves false if the wait
   * exceeded `deadlineMs` (the caller then escalates gracefully rather than
   * risking the ~600s hook budget). When the slot is free it is taken
   * immediately; otherwise the caller is queued FIFO and granted by
   * `releaseSlot`.
   */
  private acquireSlot(deadlineMs: number): Promise<boolean> {
    if (!this.evalActive) {
      this.evalActive = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = {
        grant: () => {
          if (timer !== null) clearTimeout(timer);
          resolve(true);
        },
      };
      this.evalQueue.push(waiter);
      if (deadlineMs > 0) {
        timer = setTimeout(() => {
          const i = this.evalQueue.indexOf(waiter);
          if (i !== -1) {
            this.evalQueue.splice(i, 1);
            resolve(false);
          }
        }, deadlineMs);
      }
    });
  }

  /**
   * Release the eval slot. Hands it to the next FIFO waiter (the slot stays
   * active, just changes owner) or marks the evaluator idle when none wait.
   */
  private releaseSlot(): void {
    const next = this.evalQueue.shift();
    if (next) {
      next.grant();
    } else {
      this.evalActive = false;
    }
  }

  /**
   * Warm-load the escalate_model so the FIRST second opinion does not pay a
   * cold model-load (15s+ for a 35B). Ollama only (the native /api/generate
   * empty-prompt load with a long keep_alive); a no-op otherwise or when no
   * escalate_model is configured. Best-effort and never throws — a failed warm
   * just means the first real consult loads the model itself.
   */
  async warmEscalateModel(): Promise<void> {
    if (!this.escalateModel || !this.providerIsOllama) return;
    try {
      await warmModel(this.llmConfig.baseUrl, this.escalateModel);
      this.logFn(`[AutoApprove] Warmed escalate_model ${this.escalateModel} (kept resident 30m)`);
    } catch (err) {
      this.logFn(
        `[AutoApprove] escalate_model warm-up failed (will load on first consult): ${errorToString(err)}`,
      );
    }
  }

  /**
   * Evaluate a permission request. Never throws.
   * On any error, returns escalate so the user gets the question as normal.
   *
   * @param toolName Name of the Claude Code tool (Bash, Edit, etc.)
   * @param toolInput Raw tool input from the PermissionRequest hook
   * @param tag Optional short tag (e.g. sessionId prefix) to include in logs
   *            so multi-session deployments can distinguish whose decision this is.
   * @param permissionSuggestions Optional `permission_suggestions` from the
   *            hook. When present and shape qualifies as multi-choice (#399),
   *            evaluation is routed through the multi-choice path instead of
   *            the binary approve/deny path.
   */
  async evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    tag?: string,
    permissionSuggestions?: readonly unknown[],
    modelOverride?: string,
  ): Promise<AutoApproveResult> {
    const start = Date.now();
    // modelOverride (#522: the escalate_model second opinion) replaces the base
    // model for this call; the fast-path deny/allow/group checks below still run.
    const baseModel = modelOverride || this.llmConfig.model;
    const model = baseModel;
    const prefix = tag ? `[AutoApprove ${tag}]` : '[AutoApprove]';

    const normalisedSuggestions = Array.isArray(permissionSuggestions)
      ? permissionSuggestions
          .map((s) => normalisePermissionSuggestion(s))
          .filter((s): s is string => s !== null)
      : undefined;

    // Entire body wrapped in try/catch so the "never throws" contract holds
    // even if matchPattern or other sync code fails (e.g. malformed config).
    try {
      // Deny list + deny groups: checked first, always win. No LLM call.
      const denyMatch = matchPattern(toolName, toolInput, this.deny);
      if (denyMatch !== null) {
        const reasoning = `deny-matched pattern: "${denyMatch}"`;
        this.logFn(`${prefix} DENIED ${toolName}: ${reasoning} (0ms)`);
        return { decision: 'deny', reasoning, durationMs: 0, model };
      }
      const denyGroupMatch = matchGroups(toolName, toolInput, this.denyGroups);
      if (denyGroupMatch !== null) {
        const reasoning = `deny-matched group: "${denyGroupMatch}"`;
        this.logFn(`${prefix} DENIED ${toolName}: ${reasoning} (0ms)`);
        return { decision: 'deny', reasoning, durationMs: 0, model };
      }

      // Allow list + approve groups: bypass the LLM for known-safe operations.
      const allowMatch = matchPattern(toolName, toolInput, this.allow);
      if (allowMatch !== null) {
        const reasoning = `allow-matched pattern: "${allowMatch}"`;
        if (this.logDecisions) {
          this.logFn(`${prefix} ${toolName}: approve (0ms) - ${reasoning}`);
        }
        return { decision: 'approve', reasoning, durationMs: 0, model };
      }
      const approveGroupMatch = matchGroups(toolName, toolInput, this.approveGroups);
      if (approveGroupMatch !== null) {
        const reasoning = `approve-matched group: "${approveGroupMatch}"`;
        if (this.logDecisions) {
          this.logFn(`${prefix} ${toolName}: approve (0ms) - ${reasoning}`);
        }
        return { decision: 'approve', reasoning, durationMs: 0, model };
      }

      // Design / plan-mode / long-form questions are never auto-decided by the
      // LLM (#572): AskUserQuestion, ExitPlanMode, or any tool that structurally
      // poses a non-binary question. Runs AFTER the deny/allow/group checks
      // (those are deterministic, explicit user rules and intentionally win),
      // but BEFORE the queue and the LLM, so it costs zero latency, takes no
      // eval-queue slot, and never triggers the escalate_model second opinion.
      // Logged unconditionally (like the deny branches): a structural router
      // that bypasses the LLM must be traceable even when log_decisions is off.
      if (isDesignQuestion(toolName, toolInput, permissionSuggestions, this.alwaysEscalateTools)) {
        const reasoning = `always-escalate (design/plan/long-form), tool=${toolName}; never auto-decided by LLM`;
        this.logFn(`${prefix} ${toolName}: escalate (0ms) - ${reasoning}`);
        return { decision: 'escalate', reasoning, durationMs: 0, model };
      }

      const isMultiChoice = isMultiChoicePermission(toolName, permissionSuggestions);

      // Multi-choice + skip mode: never call the LLM. The binary approve/
      // deny mapping cannot express "pick option 2 of N", so evaluating
      // would just produce option-1 (approve) for every plan-mode prompt
      // regardless of what the user actually wanted (#399).
      if (isMultiChoice && this.multichoiceMode === 'skip') {
        const reasoning = `multi-choice prompt (tool=${toolName}, ${permissionSuggestions?.length ?? 0} options); auto_approve.multichoice = "skip"`;
        if (this.logDecisions) {
          this.logFn(`${prefix} ${toolName}: escalate (0ms) - ${reasoning}`);
        }
        return { decision: 'escalate', reasoning, durationMs: 0, model };
      }

      // Index-mismatch guard: when normalisation dropped one or more raw
      // entries (empty object, Map/Set serialising to "{}", null, etc.),
      // the LLM's pick-index would address the normalised list while
      // inject() sends that index to the PTY, which interprets it against
      // the original positions. Different orderings mean a "pick No"
      // decision could land on a different option in the terminal. Escalate
      // instead of risk silently injecting the wrong choice.
      if (
        isMultiChoice &&
        this.multichoiceMode === 'evaluate' &&
        Array.isArray(permissionSuggestions) &&
        normalisedSuggestions !== undefined &&
        normalisedSuggestions.length !== permissionSuggestions.length
      ) {
        const dropped = permissionSuggestions.length - normalisedSuggestions.length;
        const reasoning = `permission_suggestions had ${dropped} unreadable entries (length ${permissionSuggestions.length} -> ${normalisedSuggestions.length}); cannot safely map LLM pick to PTY index`;
        this.logFn(`${prefix} ${toolName}: escalate (0ms) - ${reasoning}`);
        return { decision: 'escalate', reasoning, durationMs: 0, model };
      }

      // Serialize concurrent evals (#551): one LLM call at a time (one GPU).
      // A second request QUEUES instead of escalating-on-busy; only a request
      // that waits past queue_timeout escalates gracefully so a deep burst
      // (parallel subagents) never risks the ~600s hook budget.
      const acquired = await this.acquireSlot(this.queueTimeoutMs);
      if (!acquired) {
        const durationMs = Date.now() - start;
        const reasoning = `eval queue wait exceeded ${this.queueTimeoutMs}ms; escalating to user`;
        this.logFn(`${prefix} ${toolName}: escalate (${durationMs}ms) - ${reasoning}`);
        return { decision: 'escalate', reasoning, durationMs, model };
      }

      this.currentAbortController = new AbortController();
      const externalSignal = this.currentAbortController.signal;
      // The heavy escalate_model gets its dedicated (longer) budget when set, so
      // a cold model-load does not abort the fast model's shorter timeout.
      const isEscalateModelCall =
        modelOverride !== undefined && modelOverride === this.escalateModel;
      const timeoutMs =
        isEscalateModelCall && this.escalateTimeoutMs > 0
          ? this.escalateTimeoutMs
          : this.llmConfig.timeoutMs;
      // Hold the race timer handle so we can clear it whichever side wins.
      // Without clearTimeout, a successful chatCompletion at t=200ms would
      // leave a timer scheduled at t=timeoutMs that fires on the NEXT eval
      // and aborts a healthy call (currentAbortController is shared instance
      // state).
      let raceTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        // Multi-choice + evaluate mode: dedicated prompt, optional alt model.
        // Otherwise the binary approve/deny prompt.
        const useMultiChoice = isMultiChoice && this.multichoiceMode === 'evaluate';
        const callModel =
          useMultiChoice && this.multichoiceModel ? this.multichoiceModel : baseModel;
        // Reuse the base config only when neither the model nor the timeout
        // differs; the escalate_model path overrides both.
        const callConfig: LLMClientConfig =
          callModel === this.llmConfig.model && timeoutMs === this.llmConfig.timeoutMs
            ? this.llmConfig
            : { ...this.llmConfig, model: callModel, timeoutMs };
        const messages = useMultiChoice
          ? buildMultiChoicePrompt(
              toolName,
              toolInput,
              normalisedSuggestions ?? [],
              this.instructions,
            )
          : buildPrompt(toolName, toolInput, this.instructions);
        // Hard kill via Promise.race: even if fetch ignores the abort signal
        // (provider hang, Bun runtime quirk), evaluate() returns within
        // timeoutMs. The race timer also calls abort() so a fetch that does
        // honor the signal releases socket resources promptly.
        const response = await Promise.race([
          chatCompletion(callConfig, messages, externalSignal),
          new Promise<never>((_, reject) => {
            raceTimer = setTimeout(() => {
              this.currentAbortController?.abort();
              reject(new DOMException(`Hard kill after ${timeoutMs}ms`, 'AbortError'));
            }, timeoutMs);
          }),
        ]);
        const durationMs = Date.now() - start;

        const result: AutoApproveResult = useMultiChoice
          ? (() => {
              const parsedMc = parseMultiChoiceDecision(
                response.content,
                normalisedSuggestions?.length ?? 0,
              );
              if (parsedMc.decision === 'pick') {
                return {
                  decision: 'pick' as const,
                  pickIndex: parsedMc.index,
                  reasoning: parsedMc.reasoning,
                  durationMs,
                  model: response.model,
                };
              }
              return {
                decision: 'escalate' as const,
                reasoning: parsedMc.reasoning,
                durationMs,
                model: response.model,
              };
            })()
          : (() => {
              const parsed = parseDecision(response.content);
              return {
                decision: parsed.decision,
                reasoning: parsed.reasoning,
                durationMs,
                model: response.model,
              };
            })();

        if (this.logDecisions) {
          const denyPrefix = result.decision === 'deny' ? `${prefix} DENIED` : prefix;
          this.logFn(
            `${denyPrefix} ${toolName}: ${result.decision} (${durationMs}ms) - ${result.reasoning}`,
          );
        }

        // Clear cancelReason on success so a cancel() that raced with the
        // resolved response (set the flag, but the success path won the
        // microtask race) cannot leak into the NEXT eval's catch block and
        // turn a real timeout into a phantom 'cancelled'. The catch path
        // does its own read-and-clear.
        this.cancelReason = null;
        return result;
      } finally {
        if (raceTimer !== null) clearTimeout(raceTimer);
        this.currentAbortController = null;
        this.releaseSlot();
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = errorToString(err);
      // Bun's fetch can throw plain Error or wrap a TypeError on abort, not
      // always DOMException. Detect by the conventional `name === 'AbortError'`
      // on the error or its `cause` so the signal-shape choice in any runtime
      // routes through the cancel/timeout branch instead of the generic
      // 'Error: ...' escalate. Without this, the stale-decision regression
      // (#387) silently re-occurs on Bun.
      const errName = (err as { name?: unknown } | null)?.name;
      const causeName = (err as { cause?: { name?: unknown } } | null)?.cause?.name;
      const isAbort = errName === 'AbortError' || causeName === 'AbortError';
      // cancelReason is set ONLY by cancel(); a timeout abort leaves it null.
      // Read-and-clear so the next eval starts fresh.
      const cancelledReason = this.cancelReason;
      this.cancelReason = null;

      if (isAbort && cancelledReason !== null) {
        const reasoning = `Cancelled: ${cancelledReason}`;
        this.logFn(`${prefix} CANCELLED ${toolName}: ${reasoning} (${durationMs}ms)`);
        return { decision: 'cancelled', reasoning, durationMs };
      }

      const reasoning = isAbort ? `LLM timeout after ${durationMs}ms` : `Error: ${errorMsg}`;
      // Always log errors regardless of logDecisions setting
      this.logFn(`${prefix} ERROR ${toolName}: ${reasoning} (${durationMs}ms)`);

      return {
        decision: 'escalate',
        reasoning,
        durationMs,
        model,
      };
    }
  }

  /**
   * Abort any in-flight LLM evaluation. Called by the hook bridge when
   * Claude advances past the prompt (PreToolUse / PostToolUse / Stop /
   * SessionEnd) so a slow LLM call cannot return a stale decision after
   * the user already answered in the local terminal.
   *
   * Returns true if a call was actually cancelled, false if there was no
   * in-flight eval (idempotent, safe to call always).
   */
  cancel(reason: string): boolean {
    if (this.currentAbortController === null) return false;
    this.cancelReason = reason;
    this.currentAbortController.abort();
    return true;
  }
}
