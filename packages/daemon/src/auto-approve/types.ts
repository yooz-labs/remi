/**
 * Types for the auto-approve feature.
 *
 * The auto-approve system intercepts PermissionRequest hook events and uses
 * an LLM (via OpenAI-compatible API) to decide: approve, deny, escalate,
 * or, for multi-choice prompts, pick a specific option index.
 */

/**
 * Possible decisions returned by AutoApproveService.evaluate().
 *
 * 'pick' is for multi-choice prompts (#399): the LLM chose a specific
 *   option by 1-based index, surfaced via `pickIndex` on the result.
 * 'cancelled' is set ONLY when AutoApproveService.cancel() aborted an
 *   in-flight call; it cannot come from the LLM. See cancel() docs for
 *   the bridge-side contract.
 */
export type AutoApproveDecision = 'approve' | 'deny' | 'escalate' | 'pick' | 'cancelled';

/**
 * LLM-produced (or pattern-matched) decision. `model` is the model that
 * produced the verdict (or the configured model for pattern-matched
 * decisions, since downstream telemetry treats them uniformly).
 *
 * Discriminated by `decision` so the `pick`-only `pickIndex` field is
 * load-bearing in TypeScript: a `pick` result MUST carry `pickIndex`
 * and the approve/deny/escalate variants cannot accidentally set it.
 */
export type AutoApproveDecisionResult =
  | {
      readonly decision: 'approve' | 'deny' | 'escalate';
      readonly reasoning: string;
      readonly durationMs: number;
      readonly model: string;
    }
  | {
      readonly decision: 'pick';
      /** 1-based index into the permission_suggestions array.
       *  Validated by `parseMultiChoiceDecision` against the actual
       *  options length before this result is constructed. */
      readonly pickIndex: number;
      readonly reasoning: string;
      readonly durationMs: number;
      readonly model: string;
    };

/**
 * Control-plane outcome: cancel() aborted the in-flight call, no decision
 * exists. `model` is intentionally omitted — there is no verdict to attribute.
 */
export interface AutoApproveCancelledResult {
  readonly decision: 'cancelled';
  readonly reasoning: string;
  readonly durationMs: number;
}

export type AutoApproveResult = AutoApproveDecisionResult | AutoApproveCancelledResult;

/** How auto-approve treats multi-choice permission prompts (#399). */
export type MultiChoiceMode = 'skip' | 'evaluate';

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
   * Built-in permission groups to approve without calling the LLM (epic #494).
   * A group is a curated set of read-by-definition operations matched with
   * compound-segment-aware prefix logic (see `permission-groups.ts`), safer
   * than the substring `allow` list for Bash. Known groups: "read-only",
   * "vcs-read", "build-test". Default: all three.
   */
  readonly approve_groups: readonly string[];
  /**
   * Built-in permission groups to deny without calling the LLM. Checked before
   * `approve_groups` (and before `allow`); any group/pattern deny wins.
   * Default: empty.
   */
  readonly deny_groups: readonly string[];
  /**
   * Natural-language guidance appended to the LLM system prompt.
   * Lets users steer the LLM for ambiguous cases not covered by allow/deny.
   * Empty string means no extra guidance (use default prompt only).
   */
  readonly instructions: string;
  /**
   * How to treat multi-choice permission prompts (#399): permissions whose
   * suggestions are not the standard Yes / Yes-always / No 3-set or have
   * more than 3 options. 'skip' (default) escalates to the user without
   * calling the LLM, since the binary approve/deny mapping cannot express
   * "pick option 2 out of N". 'evaluate' uses a dedicated prompt that asks
   * the LLM to pick an option index.
   */
  readonly multichoice: MultiChoiceMode;
  /**
   * Optional alternate model for multi-choice evaluation. When empty,
   * `model` is used. Useful for routing complex plan-mode prompts to a
   * smarter model without paying its latency for every binary permission.
   * Ignored unless `multichoice = "evaluate"`.
   */
  readonly multichoice_model: string;
  /**
   * Optional second-opinion model consulted ONLY when the primary `model`
   * returns `escalate` in a main (non-subagent) context (#522). If it approves
   * the broad-but-mutating action -> auto-approve; if it denies -> deny;
   * otherwise the user is asked. Lets a heavy model (e.g. a 35B that honors a
   * broad "approve everything except deletes" policy) improve only the cases
   * that would otherwise interrupt the user, so its latency never hits the
   * common fast path. Empty (default) = no second opinion.
   */
  readonly escalate_model: string;
  /**
   * Ollama only: route through the native /api/chat with `think: false` to
   * turn OFF the model's reasoning. This is FASTER but lowers decision quality
   * — live testing showed the chain-of-thought is load-bearing for following
   * broad user `instructions` (without it even a 35B model reverts to its
   * cautious prior and escalates mutations it would otherwise approve). The
   * buffer-until-verdict design already hides eval latency from the user, so
   * the default is `false` (keep thinking). Opt in only if you value raw speed
   * over nuance. No effect on non-Ollama providers (the OpenAI-compat endpoint
   * has no knob to disable reasoning).
   */
  readonly disable_thinking: boolean;
}
