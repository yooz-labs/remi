/**
 * Core auto-approve service.
 *
 * Evaluates PermissionRequest hook events using an LLM (via OpenAI-compatible API).
 * Returns one of three decisions: approve, deny, or escalate.
 *
 * Designed to never throw. All errors result in escalation so the user
 * is never blocked by an LLM failure.
 */

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
      try {
        const messages = buildPrompt(toolName, toolInput, this.instructions);
        const response = await chatCompletion(this.llmConfig, messages);
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
      }
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
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
}
