/**
 * Types for the auto-approve feature.
 *
 * The auto-approve system intercepts PermissionRequest hook events and uses
 * an LLM (via OpenAI-compatible API) to decide: approve, deny, or escalate.
 */

/** The three possible LLM decisions */
export type AutoApproveDecision = 'approve' | 'deny' | 'escalate';

/** Result from the auto-approve evaluation */
export interface AutoApproveResult {
  readonly decision: AutoApproveDecision;
  /** LLM's explanation (for audit log) */
  readonly reasoning: string;
  /** How long the LLM call took */
  readonly durationMs: number;
  /** Which model was used */
  readonly model: string;
}

/** Configuration for the auto-approve feature */
export interface AutoApproveConfig {
  readonly enabled: boolean;
  /** Provider shortname or custom base URL: 'ollama', 'openrouter', or a URL */
  readonly provider: string;
  /** Model name (e.g. 'qwen3.5:4b', 'anthropic/claude-3-haiku') */
  readonly model: string;
  /** API key (empty for Ollama, required for OpenRouter) */
  readonly api_key: string;
  /** Full base URL for the OpenAI-compatible API */
  readonly base_url: string;
  /** Seconds before falling through to user (escalate on timeout) */
  readonly timeout: number;
  /** Whether to log all decisions */
  readonly log_decisions: boolean;
}
