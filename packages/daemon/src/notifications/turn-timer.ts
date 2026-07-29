/**
 * TurnTimer + turn-complete notification decision (#914).
 *
 * ## Why this exists
 *
 * `Stop` fires on EVERY turn, including two-second interactive ones -- a
 * naive "Claude finished" push on every `Stop` is worse than nothing (the
 * user mutes it and the feature is dead). The design gates on turn
 * DURATION: a long turn plausibly means the user walked away; a fast one
 * means they are still watching. `TurnTimer` measures that duration without
 * a new hook registration by keying off `prompt_id` -- present on every hook
 * payload's common fields (`HookCommonInput.prompt_id`, see
 * `docs/claude-code-hook-contract.md`) once Claude Code >= 2.1.196 and past
 * the first user input this session.
 *
 * `observe()` is meant to be called from `HookServer`'s `onAnyEvent` for
 * every event remi's hook server accepts, recording only the FIRST time a
 * given `prompt_id` is seen. remi does NOT register `UserPromptSubmit`
 * (`REMI_REGISTERED_HOOK_EVENTS`, #203 -- every registration is a
 * synchronous roundtrip gating Claude), so the true turn start is missed;
 * the mark instead lands on whichever REGISTERED event fires first for that
 * turn (typically a `PreToolUse` or `PermissionRequest`). That makes
 * `elapsedMs` a slight UNDERESTIMATE of the real turn duration -- the safe
 * direction, since fail-toward-silence (#914) means underestimating can only
 * push a turn below the notify threshold, never spuriously above it.
 *
 * `clear()` drops a `prompt_id`'s entry once its turn is genuinely done, so
 * a normal single-session daemon carries at most a couple of live entries.
 */

/**
 * Cap on tracked `prompt_id` entries. remi is one session per daemon, so
 * under normal operation this map holds 0-1 live entries (the current
 * in-flight turn); the cap exists only to bound the pathological case -- a
 * turn interrupted before its `Stop` ever fires, whose `prompt_id` would
 * otherwise never be cleared -- over a long-lived daemon. 200 entries of a
 * UUID string + a number is a few KB even fully populated, comfortably
 * generous for any real session's turn churn between restarts. Mirrors
 * `SubagentAlerter`'s `MAX_TRACKED_KEYS` bound (`subagent-alert.ts`) and its
 * oldest-first eviction.
 */
const MAX_TRACKED_PROMPTS = 200;

export interface TurnTimerDeps {
  /** Clock override for tests. Defaults to Date.now. */
  readonly nowMs?: () => number;
}

/** Tracks the first-observed time for each in-flight turn's `prompt_id`. */
export class TurnTimer {
  private readonly firstSeenMs = new Map<string, number>();

  constructor(private readonly deps: TurnTimerDeps = {}) {}

  /**
   * Record the first time this `prompt_id` was observed. A repeat
   * observation (any later hook event in the same turn) is a no-op -- the
   * mark stays anchored on the earliest signal. Absent `prompt_id` (older
   * Claude Code, or no user input yet) is silently ignored.
   */
  observe(promptId: string | undefined): void {
    if (!promptId) return;
    if (this.firstSeenMs.has(promptId)) return;
    this.firstSeenMs.set(promptId, this.now());
    this.evictIfOver();
  }

  /**
   * Milliseconds since `promptId` was first observed, or `undefined` when
   * the id is missing or was never observed -- the caller's signal to fail
   * toward silence rather than guess a duration.
   */
  elapsedMs(promptId: string | undefined): number | undefined {
    if (!promptId) return undefined;
    const start = this.firstSeenMs.get(promptId);
    if (start === undefined) return undefined;
    return this.now() - start;
  }

  /** Forget a `prompt_id`'s mark (its turn is done). No-op if absent/undefined. */
  clear(promptId: string | undefined): void {
    if (!promptId) return;
    this.firstSeenMs.delete(promptId);
  }

  /** Number of prompt_ids currently tracked. Test/inspection only. */
  get size(): number {
    return this.firstSeenMs.size;
  }

  private now(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  /** Drop the oldest entries once the map exceeds its cap. */
  private evictIfOver(): void {
    const over = this.firstSeenMs.size - MAX_TRACKED_PROMPTS;
    if (over <= 0) return;
    const oldestFirst = [...this.firstSeenMs.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of oldestFirst.slice(0, over)) {
      this.firstSeenMs.delete(key);
    }
  }
}

/** Inputs to the turn-complete notify decision (#914). Pure and gate-by-gate
 *  so each failure-toward-silence reason is independently testable. */
export interface TurnCompleteCheck {
  /** `config.notifications.on_turn_complete`. */
  readonly onTurnComplete: boolean;
  /** `Stop.stop_hook_active` -- true means this is a stop-hook RE-ENTRY, not
   *  the turn actually finishing; never notify on it. */
  readonly stopHookActive: boolean;
  /** From `TurnTimer.elapsedMs`. `undefined` = unknown duration -> no push. */
  readonly elapsedMs: number | undefined;
  /** `config.notifications.turn_complete_min_seconds`. */
  readonly minSeconds: number;
  /** `Stop.last_assistant_message`. Empty/absent -> nothing to show -> no push. */
  readonly lastAssistantMessage: string | undefined;
  /** Whether at least one device token is registered. */
  readonly hasDeviceTokens: boolean;
}

/**
 * Whether a `Stop` event should produce a turn-complete push. ALL gates must
 * hold; any unknown/missing signal fails toward silence, never toward spam
 * (#914's explicit hard constraint).
 */
export function shouldNotifyTurnComplete(check: TurnCompleteCheck): boolean {
  if (!check.onTurnComplete) return false;
  if (check.stopHookActive) return false;
  if (check.elapsedMs === undefined) return false;
  if (check.elapsedMs < check.minSeconds * 1000) return false;
  if (!check.lastAssistantMessage || check.lastAssistantMessage.trim().length === 0) return false;
  if (!check.hasDeviceTokens) return false;
  return true;
}

/** Cap for the notification title. Matches `notification-dispatcher.ts`'s
 *  `TITLE_MAX` convention for the same lock-screen surface. */
const TITLE_MAX = 120;
/**
 * Cap for the notification body. `last_assistant_message` can run several
 * paragraphs (real captures in `~/.remi/hook-diag.jsonl` include
 * multi-paragraph reviewer summaries, per `hook-bridge-setup.ts`'s
 * `STOP_LOG_MESSAGE_MAX` comment) -- far more than a lock screen shows before
 * the OS itself truncates. 200 matches the existing `BODY_MAX` convention in
 * `notification-dispatcher.ts` for the same surface, long enough to carry a
 * real excerpt of what Claude said, short enough that the push payload stays
 * bounded regardless of how verbose the turn was.
 */
const BODY_MAX = 200;

/** Collapse whitespace (including embedded newlines) to single spaces, same
 *  reason `notification-dispatcher.ts` and `hook-bridge-setup.ts` do it for
 *  the same kind of hook-carried free text. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Build the title/body for a turn-complete push (#914). Dismiss-only: the
 * caller sends no `category`/`questionId` (see `cli.ts`'s wiring), so this
 * only needs display text, not answer affordances. Title names the session,
 * following the `${sessionName}: <event>` house style used by
 * `notification-dispatcher.ts`'s `buildPushText` / `pushHoldTimeoutHandoff`.
 */
export function buildTurnCompleteText(
  sessionName: string,
  lastAssistantMessage: string,
): { title: string; body: string } {
  const title = truncate(`${sessionName}: turn complete`, TITLE_MAX);
  const body = truncate(normalize(lastAssistantMessage), BODY_MAX);
  return { title, body };
}
