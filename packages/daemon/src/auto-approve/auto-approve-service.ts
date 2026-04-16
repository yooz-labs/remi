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

    // Concurrency guard: only one evaluation at a time
    if (this.evaluating) {
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

      const parsed = this.parseDecision(response.content);

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

      if (this.logDecisions) {
        this.logFn(`[AutoApprove] ${toolName}: escalate (${durationMs}ms) - ${reasoning}`);
      }

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

  /**
   * Parse the LLM response into a decision.
   * Tries JSON first, then falls back to regex matching.
   */
  private parseDecision(raw: string): { decision: AutoApproveDecision; reasoning: string } {
    // Try JSON parse
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const decision = String(parsed.decision ?? '').toLowerCase() as AutoApproveDecision;
        const reasoning = String(parsed.reasoning ?? '');
        if (VALID_DECISIONS.has(decision)) {
          return { decision, reasoning };
        }
      }
    } catch {
      // JSON parse failed, try regex fallback
    }

    // Regex fallback: look for decision keywords in the raw text
    const lower = raw.toLowerCase();
    for (const d of VALID_DECISIONS) {
      if (lower.includes(`"decision"`) && lower.includes(`"${d}"`)) {
        return { decision: d, reasoning: `Extracted from non-JSON response: ${raw.slice(0, 100)}` };
      }
    }

    // Cannot determine decision, escalate
    return {
      decision: 'escalate',
      reasoning: `Unparseable LLM response: ${raw.slice(0, 100)}`,
    };
  }
}
