/**
 * Types for the auto-approve feature.
 *
 * The auto-approve system intercepts PermissionRequest hook events and uses
 * an LLM (via OpenAI-compatible API) to decide: approve, deny, or escalate.
 */

/**
 * Possible decisions returned by AutoApproveService.evaluate().
 *
 * - 'approve' / 'deny' / 'escalate' come from the LLM (or pattern match).
 * - 'cancelled' indicates the eval was aborted by the bridge after the user
 *   already advanced past the prompt (e.g. answered in the local terminal
 *   while the LLM was still cold-loading). Bridge handlers must treat this
 *   as a no-op: do not inject, do not escalate, do not notify.
 */
export type AutoApproveDecision = 'approve' | 'deny' | 'escalate' | 'cancelled';

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
  /** Model name (e.g. 'gemma4:e2b', 'anthropic/claude-3-haiku') */
  readonly model: string;
  /** API key (empty for Ollama, required for OpenRouter) */
  readonly api_key: string;
  /** Full base URL for the OpenAI-compatible API */
  readonly base_url: string;
  /** Seconds before falling through to user (escalate on timeout) */
  readonly timeout: number;
  /** Whether to log all decisions */
  readonly log_decisions: boolean;
  /**
   * Substring patterns that short-circuit to approve without calling the LLM.
   * For Bash: matched against the command string (substring contains).
   * For other tools: list the tool name (e.g. "Read", "Glob") for any invocation.
   * Default: empty. Deny list is checked first and always wins.
   */
  readonly allow: readonly string[];
  /**
   * Substring patterns that short-circuit to deny without calling the LLM.
   * Same matching rules as `allow`. Checked BEFORE allow; always wins.
   * Default: empty.
   */
  readonly deny: readonly string[];
  /**
   * Natural-language guidance appended to the LLM system prompt.
   * Lets users steer the LLM for ambiguous cases not covered by allow/deny.
   * Empty string means no extra guidance (use default prompt only).
   */
  readonly instructions: string;
}
