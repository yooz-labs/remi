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
import { chatCompletion, resolveProviderUrl } from './llm-client.ts';
import type { LLMClientConfig } from './llm-client.ts';
import {
  buildMultiChoicePrompt,
  isMultiChoicePermission,
  parseMultiChoiceDecision,
} from './multichoice.ts';
import { matchPattern } from './pattern-matcher.ts';
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
  let parseErr: unknown = null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const decisionStr = String(parsed.decision ?? '').toLowerCase();
      const reasoning = String(parsed.reasoning ?? '');
      if (VALID_DECISIONS.has(decisionStr as BinaryDecision)) {
        return { decision: decisionStr as BinaryDecision, reasoning };
      }
    }
  } catch (err) {
    // Capture the SyntaxError so the escalation reasoning explains WHY the
    // raw text could not be parsed (markdown fences, "json\n{...}\n" prefix,
    // etc. are common with local LLMs and benefit from a class hint).
    parseErr = err;
  }

  const errHint = parseErr ? ` [${(parseErr as Error).name}: ${(parseErr as Error).message}]` : '';
  return {
    decision: 'escalate',
    reasoning: `Unparsable LLM response: ${raw.slice(0, 100)}${errHint}`,
  };
}

export class AutoApproveService {
  private readonly llmConfig: LLMClientConfig;
  private readonly logFn: (msg: string) => void;
  private readonly logDecisions: boolean;
  private readonly allow: readonly string[];
  private readonly deny: readonly string[];
  private readonly instructions: string;
  private readonly multichoiceMode: MultiChoiceMode;
  /** Falls back to llmConfig.model when empty. */
  private readonly multichoiceModel: string;
  /** Prevents concurrent evaluations. Second request escalates immediately. */
  private evaluating = false;
  /** Active LLM call's controller; cleared in the eval finally block. cancel()
   *  aborts via this. Held alongside `evaluating` so they share the same
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
      // Ollama: use the native /api/chat with `think: false` so the model
      // skips its reasoning (a quick approve/deny classify needs none, and the
      // thinking is most of the latency). Other providers use OpenAI-compat.
      kind: config.provider === 'ollama' ? 'ollama' : 'openai',
    };
    this.logFn = logFn;
    this.logDecisions = config.log_decisions;
    this.allow = config.allow;
    this.deny = config.deny;
    this.instructions = config.instructions;
    this.multichoiceMode = config.multichoice;
    this.multichoiceModel = config.multichoice_model;
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
  ): Promise<AutoApproveResult> {
    const start = Date.now();
    const model = this.llmConfig.model;
    const prefix = tag ? `[AutoApprove ${tag}]` : '[AutoApprove]';

    const normalisedSuggestions = Array.isArray(permissionSuggestions)
      ? permissionSuggestions
          .map((s) => normalisePermissionSuggestion(s))
          .filter((s): s is string => s !== null)
      : undefined;

    // Entire body wrapped in try/catch so the "never throws" contract holds
    // even if matchPattern or other sync code fails (e.g. malformed config).
    try {
      // Deny list: checked first, always wins. No LLM call.
      const denyMatch = matchPattern(toolName, toolInput, this.deny);
      if (denyMatch !== null) {
        const reasoning = `deny-matched pattern: "${denyMatch}"`;
        this.logFn(`${prefix} DENIED ${toolName}: ${reasoning} (0ms)`);
        return { decision: 'deny', reasoning, durationMs: 0, model };
      }

      // Allow list: bypasses LLM for known-safe operations.
      const allowMatch = matchPattern(toolName, toolInput, this.allow);
      if (allowMatch !== null) {
        const reasoning = `allow-matched pattern: "${allowMatch}"`;
        if (this.logDecisions) {
          this.logFn(`${prefix} ${toolName}: approve (0ms) - ${reasoning}`);
        }
        return { decision: 'approve', reasoning, durationMs: 0, model };
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

      if (this.evaluating) {
        this.logFn(`${prefix} Concurrent evaluation blocked, escalating to user`);
        return {
          decision: 'escalate',
          reasoning: 'Concurrent evaluation in progress',
          durationMs: 0,
          model,
        };
      }

      this.evaluating = true;
      this.currentAbortController = new AbortController();
      const externalSignal = this.currentAbortController.signal;
      const timeoutMs = this.llmConfig.timeoutMs;
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
          useMultiChoice && this.multichoiceModel ? this.multichoiceModel : this.llmConfig.model;
        const callConfig: LLMClientConfig =
          callModel === this.llmConfig.model
            ? this.llmConfig
            : { ...this.llmConfig, model: callModel };
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
        this.evaluating = false;
        this.currentAbortController = null;
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
