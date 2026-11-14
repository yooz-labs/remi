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
  | { readonly type: 'holder-started' }
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
  readonly stuckLogged: boolean;
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
const RENEWAL_FRACTION = 0.8;

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
    stuckLogged: false,
    questionCapLogged: false,
    holderStartedAt: null,
    lastObservedAt: at,
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
      next = { ...next, status: event.status, lastActivityAt: now, stuckLogged: false };
      break;
    case 'activity':
      next = { ...next, lastActivityAt: now, stuckLogged: false };
      break;
    case 'turn-open':
      next = { ...next, turnOpen: true, lastActivityAt: now, stuckLogged: false };
      break;
    case 'turn-close':
      next = { ...next, turnOpen: false, lastActivityAt: now, stuckLogged: false };
      break;
    case 'session-end':
      next = { ...next, ended: true, turnOpen: false, status: 'idle', lastActivityAt: now };
      break;
    case 'questions': {
      const count = Number.isFinite(event.count) ? Math.max(0, Math.floor(event.count)) : 0;
      const questionStartedAt =
        count === 0 ? null : current.questionCount === 0 ? now : current.questionStartedAt;
      next = {
        ...next,
        questionCount: count,
        questionStartedAt,
        questionCapLogged: count === 0 ? false : current.questionCapLogged,
        lastActivityAt: now,
        stuckLogged: false,
      };
      break;
    }
    case 'holder-started':
      next = { ...next, holderStartedAt: now };
      break;
    case 'holder-failed':
      next = { ...next, failed: true, holderStartedAt: null };
      break;
    case 'tick':
      break;
  }

  const stuckMs = config.stuck_busy_minutes * 60_000;
  const questionCapMs = config.question_hold_minutes * 60_000;
  const graceMs = config.idle_grace_seconds * 1_000;
  const ttlMs = config.ttl_minutes * 60_000;
  const hasBusyStatus = BUSY_STATUSES.has(next.status);
  const hasBusyReason = hasBusyStatus || next.turnOpen;
  const fresh = next.lastActivityAt !== null && now - next.lastActivityAt < stuckMs;
  const stuckExpired = hasBusyReason && !fresh;
  const questionExpired =
    next.questionCount > 0 &&
    next.questionStartedAt !== null &&
    now - next.questionStartedAt >= questionCapMs;
  const questionActive =
    next.questionCount > 0 && next.questionStartedAt !== null && !questionExpired;
  const statusActive = hasBusyStatus && fresh;
  const turnActive = next.turnOpen && fresh;
  const activeReasons = questionActive || statusActive || turnActive;

  if (questionExpired && !next.questionCapLogged) {
    effects.push({ type: 'warning', reason: 'question cap' });
    next = { ...next, questionCapLogged: true };
  }
  if (stuckExpired && !next.stuckLogged) {
    effects.push({ type: 'warning', reason: 'stuck bound' });
    next = { ...next, stuckLogged: true };
  }

  const wasHeld = current.held;
  const blocked = !config.level1 || next.ended || next.failed;
  let held = false;
  let idleSince: number | null = null;
  let releaseReason: AwakeReleaseReason | null = null;

  if (next.ended) {
    releaseReason = 'session end';
  } else if (!config.level1) {
    releaseReason = 'disabled';
  } else if (next.failed) {
    releaseReason = 'caffeinate unavailable';
  } else if (activeReasons) {
    held = true;
  } else if (wasHeld && (questionExpired || stuckExpired)) {
    releaseReason = questionExpired ? 'question cap' : 'stuck bound';
  } else if (wasHeld) {
    idleSince = current.idleSince ?? now;
    if (now < idleSince + graceMs) held = true;
    else releaseReason = 'grace';
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
      reason: reasonFor(next, questionActive, statusActive, turnActive),
    });
  } else if (wasHeld && !held) {
    effects.push({ type: 'release', reason: releaseReason ?? (blocked ? 'disabled' : 'grace') });
  }

  if (held && next.holderStartedAt !== null) {
    const renewalAt = next.holderStartedAt + ttlMs * RENEWAL_FRACTION;
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
  const fresh =
    state.lastActivityAt !== null &&
    now - state.lastActivityAt < config.stuck_busy_minutes * 60_000;
  if (
    (BUSY_STATUSES.has(state.status) || state.turnOpen) &&
    fresh &&
    state.lastActivityAt !== null
  ) {
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
