/**
 * Core auto-approve service.
 *
 * Evaluates PermissionRequest hook events using an LLM (via OpenAI-compatible API).
 * Returns one of three decisions: approve, deny, or escalate.
 *
 * Designed to never throw. All errors result in escalation so the user
 * is never blocked by an LLM failure.
 */

import { errorToString } from '@remi/shared';
import { chatCompletion, resolveProviderUrl } from './llm-client.ts';
import type { LLMClientConfig } from './llm-client.ts';
import { matchPattern } from './pattern-matcher.ts';
import { buildPrompt } from './prompt-builder.ts';
import type { AutoApproveConfig, AutoApproveDecision, AutoApproveResult } from './types.ts';

const VALID_DECISIONS = new Set<AutoApproveDecision>(['approve', 'deny', 'escalate']);

/**
 * Parse an LLM response string into a decision.
 * Tries JSON first. If JSON fails, escalates (no guessing from substring matches).
 * Exported for unit testing.
 */
export function parseDecision(raw: string): { decision: AutoApproveDecision; reasoning: string } {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const decisionStr = String(parsed.decision ?? '').toLowerCase();
      const reasoning = String(parsed.reasoning ?? '');
      if (VALID_DECISIONS.has(decisionStr as AutoApproveDecision)) {
        return { decision: decisionStr as AutoApproveDecision, reasoning };
      }
    }
  } catch {
    // JSON parse failed, escalate
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
  private readonly instructions: string;
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
    };
    this.logFn = logFn;
    this.logDecisions = config.log_decisions;
    this.allow = config.allow;
    this.deny = config.deny;
    this.instructions = config.instructions;
  }

  /**
   * Evaluate a permission request. Never throws.
   * On any error, returns escalate so the user gets the question as normal.
   *
   * @param toolName Name of the Claude Code tool (Bash, Edit, etc.)
   * @param toolInput Raw tool input from the PermissionRequest hook
   * @param tag Optional short tag (e.g. sessionId prefix) to include in logs
   *            so multi-session deployments can distinguish whose decision this is.
   */
  async evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    tag?: string,
  ): Promise<AutoApproveResult> {
    const start = Date.now();
    const model = this.llmConfig.model;
    const prefix = tag ? `[AutoApprove ${tag}]` : '[AutoApprove]';

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
      try {
        const messages = buildPrompt(toolName, toolInput, this.instructions);
        // Hard kill via Promise.race: even if fetch ignores the abort signal
        // (provider hang, Bun runtime quirk), evaluate() returns within
        // timeoutMs. The race timer also calls abort() best-effort to release
        // socket resources.
        const response = await Promise.race([
          chatCompletion(this.llmConfig, messages, externalSignal),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              this.currentAbortController?.abort();
              reject(new DOMException(`Hard kill after ${timeoutMs}ms`, 'AbortError'));
            }, timeoutMs);
          }),
        ]);
        const durationMs = Date.now() - start;

        const parsed = parseDecision(response.content);

        const result: AutoApproveResult = {
          decision: parsed.decision,
          reasoning: parsed.reasoning,
          durationMs,
          model: response.model,
        };

        if (this.logDecisions) {
          const denyPrefix = result.decision === 'deny' ? `${prefix} DENIED` : prefix;
          this.logFn(
            `${denyPrefix} ${toolName}: ${result.decision} (${durationMs}ms) - ${result.reasoning}`,
          );
        }

        return result;
      } finally {
        this.evaluating = false;
        this.currentAbortController = null;
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = errorToString(err);
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      // cancelReason is set ONLY by cancel(); a timeout abort leaves it null.
      // Read-and-clear so the next eval starts fresh.
      const cancelledReason = this.cancelReason;
      this.cancelReason = null;

      if (isAbort && cancelledReason !== null) {
        const reasoning = `Cancelled: ${cancelledReason}`;
        this.logFn(`${prefix} CANCELLED ${toolName}: ${reasoning} (${durationMs}ms)`);
        return { decision: 'cancelled', reasoning, durationMs, model };
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
