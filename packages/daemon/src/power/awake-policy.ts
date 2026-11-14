import type { AgentStatus } from '@remi/shared';
import type { SessionWorkEvent } from '../api/message-api.ts';

export interface AwakePolicyConfig {
  readonly level1: boolean;
  readonly question_hold_minutes: number;
  readonly idle_grace_seconds: number;
  readonly stuck_busy_minutes: number;
  readonly ttl_minutes: number;
}

export type AwakePolicyEvent =
  | SessionWorkEvent
  | { readonly type: 'questions'; readonly count: number }
  | { readonly type: 'tick' }
  // Terminal: only `AwakeSession.dispose()` sends it (PTY exit, registry close,
  // daemon cleanup). Claude's SessionEnd hook also fires on /clear and /resume
  // with the daemon alive, so the hook maps to a turn close instead (#1773).
  | { readonly type: 'session-end' }
  | { readonly type: 'holder-started' }
  // The running caffeinate is gone but may be started again; no renewal is due.
  | { readonly type: 'holder-lost' }
  // caffeinate cannot run at all (missing or not executable): latched.
  | { readonly type: 'holder-failed' };

export type AwakeReason = 'question' | 'turn open' | 'executing' | 'waiting' | 'thinking';
export type AwakeReleaseReason =
  | 'grace'
  | 'stuck bound'
  | 'question cap'
  | 'session end'
  | 'disabled'
  | 'caffeinate unavailable';

export type AwakePolicyEffect =
  | { readonly type: 'hold'; readonly reason: AwakeReason }
  | { readonly type: 'release'; readonly reason: AwakeReleaseReason }
  | { readonly type: 'warning'; readonly reason: 'stuck bound' | 'question cap' }
  | { readonly type: 'renew' };

export interface AwakePolicyState {
  readonly status: AgentStatus;
  readonly turnOpen: boolean;
  readonly questionCount: number;
  readonly questionStartedAt: number | null;
  readonly lastActivityAt: number | null;
  readonly idleSince: number | null;
  readonly held: boolean;
  readonly ended: boolean;
  readonly failed: boolean;
  readonly questionCapLogged: boolean;
  readonly holderStartedAt: number | null;
  readonly lastObservedAt: number;
}

export interface AwakePolicyResult {
  readonly state: AwakePolicyState;
  readonly effects: readonly AwakePolicyEffect[];
  readonly nextDeadline: number | null;
}

const BUSY_STATUSES: ReadonlySet<AgentStatus> = new Set(['thinking', 'executing', 'waiting']);
/**
 * Fixed, not a config option: a holder is renewed after 80 percent of its
 * `ttl_minutes`, so the replacement starts with a fifth of the TTL to spare
 * (ADR 0050, "renewed while busy by spawning the new holder before killing the
 * old one").
 */
export const RENEWAL_FRACTION = 0.8;

export function initialAwakePolicyState(at = 0): AwakePolicyState {
  return {
    status: 'idle',
    turnOpen: false,
    questionCount: 0,
    questionStartedAt: null,
    lastActivityAt: null,
    idleSince: null,
    held: false,
    ended: false,
    failed: false,
    questionCapLogged: false,
    holderStartedAt: null,
    lastObservedAt: at,
  };
}

interface Assessment {
  /** A busy status the stuck bound applies to (`waiting` under a pending question is the question's). */
  readonly statusBusy: boolean;
  /** An open turn the stuck bound applies to (a turn blocked on a pending question is the question's). */
  readonly turnBusy: boolean;
  readonly fresh: boolean;
  readonly questionActive: boolean;
  readonly questionExpired: boolean;
}

/**
 * While a question is pending, the waiting that comes with it (the `waiting`
 * status and the open turn it blocks) is covered by the question, so only
 * `question_hold_minutes` bounds it; activity that arrives meanwhile cannot
 * extend the hold past the cap (#1773 C4). A busy `thinking` or `executing`
 * status (a subagent still working, for example) still holds on its own.
 */
function assess(config: AwakePolicyConfig, state: AwakePolicyState, now: number): Assessment {
  const questionPending = state.questionCount > 0 && state.questionStartedAt !== null;
  const questionExpired =
    questionPending &&
    state.questionStartedAt !== null &&
    now - state.questionStartedAt >= config.question_hold_minutes * 60_000;
  return {
    statusBusy:
      BUSY_STATUSES.has(state.status) && !(state.status === 'waiting' && state.questionCount > 0),
    turnBusy: state.turnOpen && state.questionCount === 0,
    fresh:
      state.lastActivityAt !== null &&
      now - state.lastActivityAt < config.stuck_busy_minutes * 60_000,
    questionActive: questionPending && !questionExpired,
    questionExpired,
  };
}

/**
 * Pure level-1 policy reducer. All deadline comparisons use the supplied
 * monotonic millisecond clock; older timestamps are clamped to the last time
 * observed so a wall-clock rollback cannot release early or extend a hold.
 */
export function stepAwakePolicy(
  config: AwakePolicyConfig,
  current: AwakePolicyState,
  event: AwakePolicyEvent,
  at: number,
): AwakePolicyResult {
  const now = Math.max(current.lastObservedAt, Number.isFinite(at) ? at : current.lastObservedAt);
  let next: AwakePolicyState = { ...current, lastObservedAt: now };
  const effects: AwakePolicyEffect[] = [];

  switch (event.type) {
    case 'status':
      next = { ...next, status: event.status, lastActivityAt: now };
      break;
    case 'activity':
      next = { ...next, lastActivityAt: now };
      break;
    case 'turn-open':
      next = { ...next, turnOpen: true, lastActivityAt: now };
      break;
    case 'turn-close':
      next = { ...next, turnOpen: false, lastActivityAt: now };
      break;
    case 'session-end':
      next = { ...next, ended: true, turnOpen: false, status: 'idle', lastActivityAt: now };
      break;
    case 'questions': {
      const count = Number.isFinite(event.count) ? Math.max(0, Math.floor(event.count)) : 0;
      // The cap clock starts when the count goes from zero to nonzero; a question
      // replaced at the same count keeps the clock it had.
      const questionStartedAt =
        count === 0 ? null : current.questionCount === 0 ? now : current.questionStartedAt;
      next = {
        ...next,
        questionCount: count,
        questionStartedAt,
        questionCapLogged: count === 0 ? false : current.questionCapLogged,
        lastActivityAt: now,
      };
      break;
    }
    case 'holder-started':
      next = { ...next, holderStartedAt: now };
      break;
    case 'holder-lost':
      next = { ...next, holderStartedAt: null };
      break;
    case 'holder-failed':
      next = { ...next, failed: true, holderStartedAt: null };
      break;
    case 'tick':
      break;
  }

  const view = assess(config, next, now);
  const stuckExpired = (view.statusBusy || view.turnBusy) && !view.fresh;
  const statusActive = view.statusBusy && view.fresh;
  const turnActive = view.turnBusy && view.fresh;
  const activeReasons = view.questionActive || statusActive || turnActive;
  const blocked = !config.level1 || next.ended || next.failed;

  if (view.questionExpired && !next.questionCapLogged) {
    if (!blocked) effects.push({ type: 'warning', reason: 'question cap' });
    next = { ...next, questionCapLogged: true };
  }
  if (stuckExpired) {
    // The stale turn and status are dropped in the same step, so later PTY
    // output cannot re-arm them; only a new turn-open or busy status can.
    if (!blocked) effects.push({ type: 'warning', reason: 'stuck bound' });
    next = { ...next, turnOpen: false, status: 'idle' };
  }

  const wasHeld = current.held;
  let held = false;
  let idleSince: number | null = null;
  let releaseReason: AwakeReleaseReason = 'grace';

  if (next.ended) {
    releaseReason = 'session end';
  } else if (!config.level1) {
    releaseReason = 'disabled';
  } else if (next.failed) {
    releaseReason = 'caffeinate unavailable';
  } else if (activeReasons) {
    held = true;
  } else if (wasHeld && (view.questionExpired || stuckExpired)) {
    // A cap or a stuck bound is the limit itself: no idle grace after it.
    releaseReason = view.questionExpired ? 'question cap' : 'stuck bound';
  } else if (wasHeld) {
    idleSince = current.idleSince ?? now;
    if (now < idleSince + config.idle_grace_seconds * 1_000) held = true;
  }

  next = {
    ...next,
    held,
    idleSince: held && !activeReasons ? idleSince : null,
    holderStartedAt: held ? next.holderStartedAt : null,
  };

  if (!wasHeld && held) {
    effects.push({
      type: 'hold',
      reason: reasonFor(next, view.questionActive, statusActive, turnActive),
    });
  } else if (wasHeld && !held) {
    effects.push({ type: 'release', reason: releaseReason });
  }

  if (held && next.holderStartedAt !== null) {
    const renewalAt = next.holderStartedAt + config.ttl_minutes * 60_000 * RENEWAL_FRACTION;
    if (now >= renewalAt) effects.push({ type: 'renew' });
  }

  return { state: next, effects, nextDeadline: deadlineFor(config, next, now) };
}

function reasonFor(
  state: AwakePolicyState,
  questionActive: boolean,
  statusActive: boolean,
  turnActive: boolean,
): AwakeReason {
  if (questionActive) return 'question';
  if (statusActive && state.status === 'executing') return 'executing';
  if (statusActive && state.status === 'waiting') return 'waiting';
  if (turnActive) return 'turn open';
  if (statusActive) return 'thinking';
  return 'turn open';
}

function deadlineFor(
  config: AwakePolicyConfig,
  state: AwakePolicyState,
  now: number,
): number | null {
  if (!state.held) return null;
  const deadlines: number[] = [];
  const view = assess(config, state, now);
  if ((view.statusBusy || view.turnBusy) && view.fresh && state.lastActivityAt !== null) {
    deadlines.push(state.lastActivityAt + config.stuck_busy_minutes * 60_000);
  }
  if (state.questionCount > 0 && state.questionStartedAt !== null) {
    const questionDeadline = state.questionStartedAt + config.question_hold_minutes * 60_000;
    if (questionDeadline > now) deadlines.push(questionDeadline);
  }
  if (state.idleSince !== null) {
    const graceDeadline = state.idleSince + config.idle_grace_seconds * 1_000;
    if (graceDeadline > now) deadlines.push(graceDeadline);
  }
  if (state.holderStartedAt !== null) {
    const renewalAt = state.holderStartedAt + config.ttl_minutes * 60_000 * RENEWAL_FRACTION;
    if (renewalAt > now) deadlines.push(renewalAt);
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}
