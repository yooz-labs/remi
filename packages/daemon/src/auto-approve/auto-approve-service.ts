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
    reasoning: `Unparseable LLM response: ${raw.slice(0, 100)}`,
  };
}

export class AutoApproveService {
  private readonly llmConfig: LLMClientConfig;
  private readonly logFn: (msg: string) => void;
  private readonly logDecisions: boolean;
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
  }

  /**
   * Evaluate a permission request. Never throws.
   * On any error, returns escalate so the user gets the question as normal.
   */
  async evaluate(toolName: string, toolInput: Record<string, unknown>): Promise<AutoApproveResult> {
    const start = Date.now();
    const model = this.llmConfig.model;

    if (this.evaluating) {
      this.logFn('[AutoApprove] Concurrent evaluation blocked, escalating to user');
      return {
        decision: 'escalate',
        reasoning: 'Concurrent evaluation in progress',
        durationMs: 0,
        model,
      };
    }

    this.evaluating = true;
    try {
      const messages = buildPrompt(toolName, toolInput);
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
        const prefix = result.decision === 'deny' ? '[AutoApprove] DENIED' : '[AutoApprove]';
        this.logFn(
          `${prefix} ${toolName}: ${result.decision} (${durationMs}ms) - ${result.reasoning}`,
        );
      }

      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const reasoning = isAbort ? `LLM timeout after ${durationMs}ms` : `Error: ${errorMsg}`;

      // Always log errors regardless of logDecisions setting
      this.logFn(`[AutoApprove] ERROR ${toolName}: ${reasoning} (${durationMs}ms)`);

      return {
        decision: 'escalate',
        reasoning,
        durationMs,
        model,
      };
    } finally {
      this.evaluating = false;
    }
  }
}
