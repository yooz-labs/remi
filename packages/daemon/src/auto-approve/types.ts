/**
 * Types for the auto-approve feature.
 *
 * The auto-approve system intercepts PermissionRequest hook events and uses
 * an LLM (via OpenAI-compatible API) to decide: approve, deny, escalate,
 * or, for multi-choice prompts, pick a specific option index.
 */

import type { AutoApproveLevel } from './levels.ts';
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
      /** #628: a one-sentence, lock-screen-friendly question the model produces on
       *  an `escalate` verdict (e.g. "Force-push to main?"). Used for the push
       *  title/body instead of the raw "Allow Bash: <command>". Absent for
       *  approve/deny, pattern-matched verdicts, or when the model omits it. */
      readonly summary?: string | undefined;
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

/**
 * Tools whose invocation is, by definition, a request for user intent the
 * auto-approve LLM must never answer (#572): `AskUserQuestion` (Claude
 * explicitly solicited the user) and `ExitPlanMode` (plan-mode accept /
 * keep-planning is a direction decision). Default for
 * `AutoApproveConfig.always_escalate_tools`.
 */
export const DEFAULT_ALWAYS_ESCALATE_TOOLS: readonly string[] = ['AskUserQuestion', 'ExitPlanMode'];

/** Configuration for the auto-approve feature */
export interface AutoApproveConfig {
  readonly enabled: boolean;
  /**
   * Provider shortname or custom base URL: 'yooz' (the Yooz engine's native
   * /v1/llm/generate, loopback :19924 -- macOS), 'llamacpp' (a thin llama.cpp
   * server, also loopback :19924, on other platforms), 'openrouter', or a URL.
   */
  readonly provider: string;
  /** Model name (e.g. 'yooz-quality-v3', 'anthropic/claude-3-haiku') */
  readonly model: string;
  /** API key (empty for the local engine/llama.cpp, required for OpenRouter) */
  readonly api_key: string;
  /** Full base URL for the OpenAI-compatible API */
  readonly base_url: string;
  /** Seconds before falling through to user (escalate on timeout) */
  readonly timeout: number;
  /** Whether to log all decisions */
  readonly log_decisions: boolean;
  /**
   * Patterns that short-circuit to approve without calling the LLM.
   *
   * NOT substring matching (#536). For Bash the command is split on
   * `; && || |` and EVERY segment must either match one of these as a prefix
   * or be a neutral no-op (`cd`, `pwd`, `echo`, `true`, `:`); a segment with
   * shell control (backticks, `$()`, redirects, `-exec`) is refused even when
   * a prefix matches. An entry shaped like a tool name ("Read", "Glob") matches
   * that TOOL and never a Bash command containing the word.
   *
   * See `matchAllowPattern` in `pattern-matcher.ts` and `matchCoveredCommand`
   * in `shell-safety.ts`. Default: empty. Deny is checked first and always wins.
   */
  readonly allow: readonly string[];
  /**
   * Substring patterns that short-circuit to deny without calling the LLM.
   *
   * Deliberately NOT the same rules as `allow` (#536): deny stays a broad
   * substring match (`matchSubstringPattern`), because a rule meant to STOP
   * something should over-reach rather than under-reach. Checked BEFORE allow;
   * always wins. Default: empty.
   */
  readonly deny: readonly string[];
  /**
   * Substring patterns that, when a BACKGROUND AGENT invokes them, fire an
   * after-the-fact notification (#807). Same matching rules as `allow`/`deny`.
   *
   * This is NOT a gate: the command runs. A subagent permission is never
   * evaluated (#807) and Claude's own allowlist may allow it without ever
   * rendering a prompt, so nothing would otherwise tell you it happened. These
   * patterns pick the commands worth being told about anyway.
   *
   * Default: irreversible filesystem / VCS / privilege operations only.
   * Broader patterns (`curl`, `ssh`) are useful but fire constantly on a
   * session running many agents, so they are opt-in per machine rather than
   * shipped on. Alerts for one (pattern, command) pair collapse within a
   * 5-minute window; see `subagent-alert.ts`.
   */
  readonly subagent_alert: readonly string[];
  /**
   * Built-in permission groups to approve without calling the LLM (epic #494).
   * A group is a curated set of read-by-definition operations matched with
   * compound-segment-aware prefix logic (see `permission-groups.ts`), curated
   * rather than user-supplied like the `allow` list. Known groups: "read-only",
   * "vcs-read", "build-test". Default: all three.
   */
  readonly approve_groups: readonly string[];
  /**
   * Strictness preset (#963). Selects which permission groups are
   * auto-approved without an LLM call. `strict` is today's behavior and the
   * shipped default; `balanced` adds `fs-write`; `trusted` adds `vcs-write`.
   *
   * An explicit `approve_groups` in config OVERRIDES this — see
   * `resolveApproveGroups` in `auto-approve/levels.ts` for why override rather
   * than union, and `loadConfig` for where the two are reconciled.
   */
  readonly level: AutoApproveLevel;
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
   * Seconds of inactivity after which remi drops the model's retained
   * prompt-KV cache while KEEPING its weights resident (#820 stage 1) --
   * cheaper than `keep_alive`'s full unload: no cold reload on the next
   * evaluation, only the cost of recomputing the (identical every time --
   * remi sends the same system prompt) prefix. Measured on an M4 Pro: the
   * engine plateaus about 1.5 GB above its weights-only footprint after
   * evaluations, purely retained cache -- a steady-state WIN (it is why p50
   * stays ~1.0s) but pure cost once idle. 0 disables stage 1. Ignored under
   * a shared engine, same as `keep_alive` (#818): a cache drop still costs
   * another module's latency, so it is gated identically.
   */
  readonly cache_idle: number;
  /**
   * Seconds of inactivity after which remi unloads the model(s) it loaded
   * (#820 stage 2) -- the replacement for ollama's `keep_alive`, which the
   * Yooz engine has no equivalent of (weights stay resident until explicitly
   * unloaded). 0 disables the timer. Ignored under a shared engine, where
   * residency is the host's policy and unloading would cut another module
   * off (#818).
   */
  readonly keep_alive: number;
  /**
   * #818: whether remi owns the engine process on its port. `'owned'` (the
   * default, and the only mode that exists today) means remi spawns and
   * supervises its own helper and may load/unload/delete models. `'shared'`
   * means a super-yooz host owns it: remi evaluates against it but must never
   * spawn, unload or delete, since another module may be mid-generate on the
   * same weights. remi keeps its own port either way.
   */
  readonly engine: 'owned' | 'shared';
  /** Absolute path to the helper remi starts in `'owned'` mode. Empty = none
   *  bundled; remi then attaches to a running engine or reports the gap. */
  readonly engine_path: string;
  /**
   * Directory the engine downloads model weights into. Empty = the engine's
   * own default. Passed to a remi-STARTED engine as `HF_HUB_CACHE`, the
   * standard HuggingFace variable the engine already honors (`EngineConfig.
   * huggingFaceCacheDirectory` checks `HF_HUB_CACHE`, then `HF_HOME`/hub) —
   * so this is a pass-through of an existing contract, not a remi invention.
   *
   * Only affects an engine remi starts. An engine already running (started by
   * a hub, by hand, or by a super-yooz host) keeps whatever cache IT was
   * launched with, and remi cannot retarget it.
   */
  readonly model_cache: string;
  /**
   * Timeout (seconds) for the `escalate_model` second opinion specifically. The
   * heavy model is larger and frequently COLD (escalations are sporadic, so it
   * has usually been unloaded by the host), so its first call pays a model-load
   * penalty that easily exceeds the fast model's `timeout`. Without a dedicated,
   * longer budget the cold load aborts and the second opinion degrades to an
   * error->escalate, adding latency without ever acting. 0 (default) means "use
   * `timeout`". Ignored when `escalate_model` is empty.
   */
  readonly escalate_timeout: number;
  /**
   * Max seconds a permission eval may WAIT in the serialization queue before it
   * escalates gracefully (#551). Evals run one at a time (one GPU); concurrent
   * requests queue instead of escalating. Under a deep burst (parallel
   * subagents) a request could otherwise wait long enough to risk the Claude
   * Code hook budget (~600s). A waiter queued longer than this escalates to the
   * user instead of hanging. 0 = no bound (wait until granted). Default 240.
   */
  readonly queue_timeout: number;
  /**
   * Suppress the model's chain-of-thought reasoning. Default TRUE (changed
   * 2026-07-25): a permission classify wants a short JSON verdict, and on the
   * QAT-lean tiers leaving reasoning on is not merely slow but fatal — the
   * 0.8B spent an entire 600-token budget thinking about a trivial prompt and
   * returned no content at all, so every evaluation degraded to an error.
   *
   * Applies to BOTH transports. The engine gets `/no_think` prefixed onto its
   * prompt; an OpenAI-compatible server gets that same prefix (it is a
   * chat-template convention the Qwen3 family itself honors, so it travels
   * with the model rather than the server) plus
   * `chat_template_kwargs.enable_thinking: false`, which is what vLLM and
   * newer llama.cpp/mlx servers act on. Measured: the prefix alone did NOT
   * suppress on mlx_lm; the chat_template_kwargs did. See `llm-client.ts`.
   */
  readonly disable_thinking: boolean;
  /**
   * Tool names that ALWAYS escalate to the user and are NEVER auto-decided by
   * the LLM (#572) — design / plan-mode / long-form questions whose answers are
   * not yes/no. Matched by tool name BEFORE any LLM call, so it costs zero
   * latency, takes no eval-queue slot, and never triggers the escalate_model
   * second opinion. Explicit `deny`/`allow` rules are deterministic and still
   * checked first, so a user can override this for a specific tool.
   * Default: ["AskUserQuestion", "ExitPlanMode"]. Extend with
   * custom MCP tools that solicit user intent. A free-text heuristic also
   * escalates any tool that structurally carries a question field with
   * non-binary suggestions. See `DEFAULT_ALWAYS_ESCALATE_TOOLS`.
   */
  readonly always_escalate_tools: readonly string[];
  /**
   * Seconds the daemon HOLDS a BINARY main-context PermissionRequest hook open
   * after escalating to the user, instead of returning passthrough immediately
   * (Model B, #573). Claude blocks on the held hook (no native prompt rendered)
   * until the user answers from any channel — the answer resolves the hook to
   * allow/deny with no PTY render and no warm-connection race. On expiry the
   * hold fails open to passthrough (Claude renders its native prompt), so the
   * terminal is never permanently stuck. A human answers here and may be busy,
   * so the default is large + human-paced (1800s). 0 disables holding entirely
   * (escalate -> passthrough, the pre-#573 behavior). Only binary main-context
   * escalations hold; multi-choice / design escalations always passthrough (the
   * hook response cannot express a pick). The registered PermissionRequest hook
   * timeout (hook-config-manager.ts) is kept >= this so Claude does not give up
   * on the hook before the hold does.
   */
  readonly hold_timeout: number;
  /**
   * Seconds before a SLOW eval triggers an early push + hold (Part B, #573). If
   * a binary main-context eval has not produced a verdict within this window,
   * the daemon pushes the question and holds the hook so the user can step in
   * while the model keeps thinking; a late approve/deny then resolves the held
   * hook (no double-push). 0 disables Part B entirely — behavior reverts to the
   * plain hold-on-escalate path (A+C only). Default 60. Kept well below
   * `hold_timeout` so the early-push window opens before the hold itself expires.
   */
  readonly push_hold_timeout: number;
  /**
   * Seconds to wait for a held escalation's notification to be CONFIRMED
   * delivered before deciding the hold is undeliverable (epic #603 Phase 1,
   * R1/R2). A binary escalation holds the PermissionRequest hook (Model B) only
   * makes sense if the user can actually be notified; delivery is "confirmed"
   * when a client is attached (in-app), an APNS push returns 2xx, or an
   * identical push was already sent (deduped). If NONE confirm within this
   * window — e.g. a dead device token (BadDeviceToken) or no registered token on
   * this daemon — the hold no longer blocks Claude for the full `hold_timeout`;
   * it fails open fast to passthrough (native prompt) unless
   * `hold_unconfirmed_timeout` is set. 0 disables delivery gating (legacy: hold
   * to `hold_timeout` regardless of delivery). Default 6.
   */
  readonly delivery_confirm_timeout: number;
  /**
   * Seconds to keep holding a binary escalation whose notification delivery was
   * NOT confirmed within `delivery_confirm_timeout` (epic #603 Phase 1, D2 —
   * the "hold-always-no-phone" two-tier escape). 0 (default) = fail open
   * immediately when delivery is unconfirmed (the hybrid default: let the local
   * terminal answer). > 0 = instead hold to this SHORT secondary timeout (e.g.
   * 180) so a transient delivery failure can recover via retries before the hook
   * fails open — for users who run headless and want the hook to wait for their
   * phone even when no client is currently reachable. Always far below
   * `hold_timeout` so an undeliverable hold can never stall for the full window.
   */
  readonly hold_unconfirmed_timeout: number;
}
