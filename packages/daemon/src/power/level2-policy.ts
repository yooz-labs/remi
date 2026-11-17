/**
 * Pure level 2 policy (ADR 0050, #1773): when an armed level 2 turns on, when a
 * condition pauses it (it reverts to the safe state and resumes by itself once
 * the condition is gone), when only a person can bring it back (disarmed), and
 * why. Nothing here spawns, reads a file or keeps a timer: the hub's controller
 * (L2-CORE) feeds it readings and events and carries out its effects.
 *
 * Owner answers of 2026-11-17 this follows: Q1 (b) `level2 = true` arms it and
 * real work turns it on; the Q9 amendment (pause on a condition, resume by
 * itself, only a person's `stop` or a disarming bound ends it); Q2 (battery
 * limits only on battery power); Q3 (no battery, never on); Q12 (b) (armed after
 * a clean exit only); Q13 (an automatic start or resume needs the lid open for
 * the whole dwell); Q14 (a) (`level2_default_hours` is the longest run,
 * `level2_cap_hours` the on-time in `level2_window_hours`).
 */
import type { ForeignHolder } from './level2-foreign-holders.ts';
import {
  type Level2Settings,
  THERMAL_SETTING_RANK,
  representableEndSeconds,
} from './level2-settings.ts';

export type Level2StateName =
  | 'disabled'
  | 'disarmed'
  | 'armed'
  | 'paused'
  | 'starting'
  | 'on'
  | 'reverting';

export type Level2Origin = 'automatic' | 'explicit';

/** What keeps level 2 from turning on (item 6), in the order they are checked. */
export type Level2BlockReason =
  | 'no-session'
  | 'no-work'
  | 'flag-unknown'
  | 'sleep-disabled-by-other'
  | 'no-battery'
  | 'battery-unknown'
  | 'battery-low'
  | 'battery-time-low'
  | 'thermal-unknown'
  | 'thermal'
  | 'assertions-unknown'
  | 'foreign-holder'
  | 'password-on-wake-unknown'
  | 'password-on-wake-off'
  | 'watchdog-unknown'
  | 'watchdog-missing'
  | 'watchdog-mismatch'
  | 'daily-cap'
  | 'lid-closed'
  | 'resume-interval'
  | 'dwell';

/** What reverts a running level 2 and pauses it (item 7); it resumes by itself. */
export type Level2PauseReason =
  | 'run-limit'
  | 'daily-cap'
  | 'no-battery'
  | 'battery-unknown'
  | 'battery-low'
  | 'battery-time-low'
  | 'thermal-unknown'
  | 'thermal'
  | 'thermal-moderate-held'
  | 'assertions-unknown'
  | 'foreign-holder'
  | 'watchdog-unknown'
  | 'watchdog-missing'
  | 'watchdog-mismatch'
  | 'flag-unknown'
  | 'heartbeat-failed'
  | 'lease-write-failed'
  | 'enable-timeout'
  | 'idle'
  | 'no-session';

/** Only a person's `arm` or `start` leaves `disarmed` (item 8). */
export type Level2DisarmReason =
  | 'stopped'
  | 'flag-cleared-by-other'
  | 'switch-failed'
  | 'revert-not-permitted'
  | 'sudo-refused'
  | 'resume-limit'
  | 'breaker'
  | 'restart';

export type Level2EnableFailure =
  | 'switch-failed'
  | 'revert-not-permitted'
  | 'sudo-refused'
  | 'lease-write-failed';

/** Why a `disable` effect was emitted. */
export type Level2RevertReason = Level2PauseReason | 'stopped' | 'hub-exit' | 'breaker';

export type Level2Condition = Level2BlockReason | Level2PauseReason;
export type Level2Reason = Level2Condition | Level2DisarmReason | Level2RevertReason;

/** Why an `arm`, `start`, `stop` or `extend` changed nothing. */
export type Level2Refusal =
  | 'disabled'
  | 'hours-invalid'
  | 'not-on'
  | 'already-on'
  | 'reverting'
  | 'exiting';

export type Level2Battery =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'battery';
      readonly source: 'ac' | 'battery';
      readonly percent: number;
      readonly remainingMinutes: number | null;
    }
  | { readonly kind: 'unknown' };

export type Level2Thermal = 'nominal' | 'moderate' | 'heavy' | 'trapping' | 'sleeping' | 'unknown';

export type Level2Foreign =
  | { readonly kind: 'ok'; readonly blocking: readonly ForeignHolder[] }
  | { readonly kind: 'unknown' };

/** Every reading a `beat` or a `start` carries (item 4). */
export interface Level2Readings {
  readonly battery: Level2Battery;
  readonly thermal: Level2Thermal;
  readonly sleepDisabled: 'yes' | 'no' | 'unknown';
  readonly foreign: Level2Foreign;
  readonly passwordOnWake: 'on' | 'off' | 'unknown';
  readonly watchdog: 'loaded' | 'missing' | 'mismatch' | 'unknown';
  readonly clamshell: 'open' | 'closed' | 'absent' | 'unknown';
}

export interface Level2Sessions {
  readonly live: number;
  readonly working: number;
}

export type Level2Event =
  /** Full readings: while armed with work, and while paused, starting, on or reverting. */
  | {
      readonly type: 'beat';
      readonly readings: Level2Readings;
      readonly sessions: Level2Sessions;
      /** Epoch seconds. */
      readonly wallNow: number;
    }
  /** The cheap tick while armed with no working session: no readings. */
  | { readonly type: 'census'; readonly sessions: Level2Sessions; readonly wallNow: number }
  /** An explicit start; arms too. Carries fresh readings so it is decided at once. */
  | {
      readonly type: 'start';
      readonly hours?: number;
      readonly readings: Level2Readings;
      readonly sessions: Level2Sessions;
      readonly wallNow: number;
    }
  | { readonly type: 'arm' }
  | { readonly type: 'stop' }
  | { readonly type: 'extend'; readonly hours: number }
  | { readonly type: 'enabled' }
  | { readonly type: 'enable-failed'; readonly reason: Level2EnableFailure }
  | { readonly type: 'disabled' }
  | { readonly type: 'disable-failed' }
  | { readonly type: 'heartbeat-failed' }
  | { readonly type: 'hub-exit' };

/** What the controller writes to `REMIHOME/keep-awake/state.json` (L2-CORE adds `version`). */
export interface Level2Persisted {
  readonly armed: boolean;
  readonly disarmReason: Level2DisarmReason | null;
  readonly cleanExit: boolean;
  /** Epoch seconds of the automatic starts and resumes in the last `level2_window_hours`. */
  readonly resumes: readonly number[];
  /** Epoch seconds of the breaker failures in the last `level2_window_hours`. */
  readonly failures: readonly number[];
  /** `[start, end]` epoch seconds of the on-time runs in the last `level2_window_hours`. */
  readonly runs: readonly (readonly [number, number])[];
}

export interface Level2Startup {
  readonly leaseFound: boolean;
  /** `SleepDisabled` as read at startup, after the controller's reconcile. */
  readonly flag: 'yes' | 'no' | 'unknown';
  /** Monotonic milliseconds. */
  readonly now: number;
  /** Epoch seconds. */
  readonly wallNow: number;
}

export type Level2Target =
  | { readonly name: 'armed'; readonly reason: 'no-session' | 'no-work' | null }
  | { readonly name: 'paused'; readonly reason: Level2Condition }
  | { readonly name: 'disarmed'; readonly reason: Level2DisarmReason };

export interface Level2Run {
  /** Monotonic time the `enable` effect was emitted. */
  readonly enableAt: number;
  /** Monotonic time the switch reported `enabled`; null while starting. */
  readonly startMono: number | null;
  /** Epoch seconds at `enabled`. */
  readonly startWall: number | null;
  /** Monotonic time the run ends. */
  readonly end: number;
  /** The end was set by the on-time left under `level2_cap_hours`. */
  readonly cutByCap: boolean;
}

export interface Level2State {
  readonly name: Level2StateName;
  /** Kept so `level2Status` needs no settings argument; settings are read once at hub start. */
  readonly settings: Level2Settings;
  /**
   * `disarmed`: its reason; `paused`: the condition that blocks it now; `armed`:
   * `no-session` or `no-work`; `reverting`: why it reverts; otherwise null.
   */
  readonly reason: Level2Reason | null;
  /** The process names behind a `foreign-holder` reason. */
  readonly reasonProcesses: readonly string[];
  readonly origin: Level2Origin | null;
  readonly target: Level2Target | null;
  readonly run: Level2Run | null;
  /** The arming kept unchanged while `disabled`. */
  readonly disabledArming: {
    readonly armed: boolean;
    readonly disarmReason: Level2DisarmReason | null;
  } | null;
  readonly cleanExit: boolean;
  readonly exiting: boolean;
  readonly resumes: readonly number[];
  readonly failures: readonly number[];
  readonly runs: readonly (readonly [number, number])[];
  /** Monotonic time of the last completed revert. */
  readonly pausedAt: number | null;
  /** Why the last completed revert happened (it keeps a moderate-held pause from flapping). */
  readonly lastPauseReason: Level2RevertReason | null;
  /** Monotonic time since every condition has been clear at each beat, without a gap. */
  readonly clearSince: number | null;
  readonly lastBeatMono: number | null;
  readonly lastBeatWall: number | null;
  readonly idleSince: number | null;
  readonly moderateSince: number | null;
  readonly foreignSince: number | null;
  readonly sessions: Level2Sessions | null;
  readonly lastObservedAt: number;
  readonly lastWall: number;
  readonly lastWallMono: number;
}

export type Level2Effect =
  /** Write the lease, then turn sleep off; the run ends at `runEnd` (monotonic). */
  | {
      readonly type: 'enable';
      readonly origin: Level2Origin;
      readonly runEnd: number;
      readonly runEndWall: number;
      readonly cutByCap: boolean;
    }
  /** Turn sleep back on and delete the lease; always retried while reverting. */
  | { readonly type: 'disable'; readonly reason: Level2RevertReason }
  /** Delete the lease without touching the flag: someone else cleared it. */
  | { readonly type: 'forget'; readonly reason: 'flag-cleared-by-other' }
  | { readonly type: 'persist'; readonly value: Level2Persisted }
  /** One log line; emitted only when the state, reason, origin or target changes. */
  | {
      readonly type: 'log';
      readonly state: Level2StateName;
      readonly reason: Level2Reason | null;
      readonly origin: Level2Origin | null;
      readonly target: Level2Target | null;
    }
  /** A blocking holder (or an unreadable assertion list) appeared while on. */
  | {
      readonly type: 'notify';
      readonly reason: 'foreign-holder' | 'assertions-unknown';
      readonly processes: readonly string[];
    }
  /** An explicit `start` that a condition blocked: armed, and paused unless no session. */
  | {
      readonly type: 'blocked';
      readonly reason: Level2BlockReason;
      readonly processes: readonly string[];
    }
  | {
      readonly type: 'refused';
      readonly event: 'arm' | 'start' | 'stop' | 'extend';
      readonly reason: Level2Refusal;
    }
  | {
      readonly type: 'extended';
      readonly runEnd: number;
      readonly runEndWall: number;
      readonly cutByCap: boolean;
    };

export interface Level2Result {
  readonly state: Level2State;
  readonly effects: readonly Level2Effect[];
  /**
   * The earliest monotonic time a rule can change, never more than one
   * `heartbeat_seconds` away while level 2 needs beats, so a timer for it
   * always fits; null while `disabled` or `disarmed`.
   */
  readonly nextDeadline: number | null;
}

export interface Level2Status {
  readonly state: Level2StateName;
  readonly reason: Level2Reason | null;
  readonly origin: Level2Origin | null;
  /** Epoch seconds the current run ends, or null. */
  readonly runEnd: number | null;
  /** The run's end was cut by the on-time left under `level2_cap_hours`. */
  readonly runEndCutByCap: boolean;
  /** Seconds of on-time left under `level2_cap_hours` in `level2_window_hours`. */
  readonly onTimeLeftToday: number;
  /** Automatic starts and resumes left in `level2_window_hours`. */
  readonly resumesLeftToday: number;
  readonly failuresToday: number;
  /** What an `armed`, `paused` or `disarmed` level 2 needs to turn on. */
  readonly waitingFor: string | null;
}

/**
 * `Map`s, not object literals: a reading of `'constructor'` or `'toString'`
 * must be `thermal-unknown`, never an inherited member that compares as a level.
 */
const THERMAL_RANK: ReadonlyMap<string, number> = new Map([
  ['nominal', 0],
  ['moderate', 1],
  ['heavy', 2],
  ['trapping', 3],
  ['sleeping', 4],
]);
const MODERATE_RANK = 1;
const RUNNING: ReadonlySet<Level2StateName> = new Set(['starting', 'on', 'reverting']);

function thermalRank(reading: unknown): number | undefined {
  return typeof reading === 'string' ? THERMAL_RANK.get(reading) : undefined;
}

/** A setting's rank; an unknown value (settings that skipped validation) counts as `moderate`, the strictest. */
function settingRank(level: unknown): number {
  return (typeof level === 'string' ? THERMAL_SETTING_RANK.get(level) : undefined) ?? MODERATE_RANK;
}
const DISARM_REASONS: ReadonlySet<string> = new Set<Level2DisarmReason>([
  'stopped',
  'flag-cleared-by-other',
  'switch-failed',
  'revert-not-permitted',
  'sudo-refused',
  'resume-limit',
  'breaker',
  'restart',
]);

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type WorkingState = Mutable<Level2State>;

interface Ctx {
  readonly s: WorkingState;
  readonly settings: Level2Settings;
  readonly now: number;
  readonly actions: Level2Effect[];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isTimeList(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((t) => typeof t === 'number' && Number.isFinite(t));
}

function isRunList(value: unknown): value is readonly (readonly [number, number])[] {
  return (
    Array.isArray(value) &&
    value.every(
      (run) =>
        Array.isArray(run) &&
        run.length === 2 &&
        typeof run[0] === 'number' &&
        typeof run[1] === 'number' &&
        Number.isFinite(run[0]) &&
        Number.isFinite(run[1]) &&
        run[0] <= run[1],
    )
  );
}

function isPersisted(value: unknown): value is Level2Persisted {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p['armed'] === 'boolean' &&
    (p['disarmReason'] === null ||
      (typeof p['disarmReason'] === 'string' && DISARM_REASONS.has(p['disarmReason']))) &&
    typeof p['cleanExit'] === 'boolean' &&
    isTimeList(p['resumes']) &&
    isTimeList(p['failures']) &&
    isRunList(p['runs'])
  );
}

/**
 * A recorded time later than `wall` plus the skew tolerance counts as `wall`
 * (item 9): a backward clock step cannot drop a counted resume or failure, it
 * only keeps it for a full window from the step. A run keeps its length.
 */
function normalizeTimes(
  times: readonly number[],
  wall: number,
  skew: number,
  windowSeconds: number,
): number[] {
  const out: number[] = [];
  for (const t of times) {
    const at = t > wall + skew ? wall : t;
    if (at > wall - windowSeconds) out.push(at);
  }
  return out;
}

function normalizeRuns(
  runs: readonly (readonly [number, number])[],
  wall: number,
  skew: number,
  windowSeconds: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of runs) {
    const shift = end > wall + skew ? end - wall : 0;
    const s = start - shift;
    const e = end - shift;
    if (e > wall - windowSeconds) out.push([s, e]);
  }
  return out;
}

function windowSecondsOf(settings: Level2Settings): number {
  return settings.level2_window_hours * 3_600;
}

function persistedOf(s: Level2State): Level2Persisted {
  let armed = true;
  let disarmReason: Level2DisarmReason | null = null;
  if (s.name === 'disabled' && s.disabledArming !== null) {
    armed = s.disabledArming.armed;
    disarmReason = s.disabledArming.disarmReason;
  } else if (s.name === 'disarmed') {
    armed = false;
    disarmReason = s.reason as Level2DisarmReason;
  } else if (s.name === 'reverting' && s.target?.name === 'disarmed') {
    armed = false;
    disarmReason = s.target.reason;
  }
  const runs: (readonly [number, number])[] = s.runs.map(([a, b]) => [a, b] as const);
  // The run in progress counts too, up to the last observed time, so a crash
  // while on cannot drop its on-time from the cap (a new value at every beat).
  if (s.run !== null && s.run.startMono !== null && s.run.startWall !== null) {
    const seconds = Math.max(0, (s.lastObservedAt - s.run.startMono) / SECOND);
    runs.push([s.run.startWall, s.run.startWall + seconds]);
  }
  return {
    armed,
    disarmReason,
    cleanExit: s.cleanExit,
    resumes: [...s.resumes],
    failures: [...s.failures],
    runs,
  };
}

/** The value the controller writes to the state file. */
export function level2Persisted(state: Level2State): Level2Persisted {
  return persistedOf(state);
}

/**
 * The state a new hub starts in (Q12 (b)): `disabled` when `level2` is false;
 * `disarmed` with `restart` when the persisted state says disarmed or is not
 * valid, the previous hub did not record a clean exit, a lease was found, or
 * the flag does not read `no`; otherwise `armed`, the very first run included.
 * The new state has `cleanExit` false: the controller writes it at once, so a
 * crash from then on is seen by the next hub.
 */
export function initialLevel2State(
  settings: Level2Settings,
  persisted: Level2Persisted | null,
  startup: Level2Startup,
): Level2State {
  const now = finiteOr(startup.now, 0);
  const wall = finiteOr(startup.wallNow, 0);
  const valid = persisted === null || isPersisted(persisted);
  const p = valid ? persisted : null;
  const skew = settings.clock_skew_tolerance_seconds;
  const windowSeconds = windowSecondsOf(settings);
  const base: Level2State = {
    name: 'armed',
    settings,
    reason: null,
    reasonProcesses: [],
    origin: null,
    target: null,
    run: null,
    disabledArming: null,
    cleanExit: false,
    exiting: false,
    resumes: normalizeTimes(p?.resumes ?? [], wall, skew, windowSeconds),
    failures: normalizeTimes(p?.failures ?? [], wall, skew, windowSeconds),
    runs: normalizeRuns(p?.runs ?? [], wall, skew, windowSeconds),
    pausedAt: null,
    lastPauseReason: null,
    clearSince: null,
    lastBeatMono: null,
    lastBeatWall: null,
    idleSince: null,
    moderateSince: null,
    foreignSince: null,
    sessions: null,
    lastObservedAt: now,
    lastWall: wall,
    lastWallMono: now,
  };
  if (!settings.level2) {
    return {
      ...base,
      name: 'disabled',
      disabledArming: valid
        ? { armed: p?.armed ?? true, disarmReason: p?.disarmReason ?? null }
        : { armed: false, disarmReason: 'restart' },
    };
  }
  const restart =
    !valid ||
    (p !== null && (!p.armed || !p.cleanExit)) ||
    startup.leaseFound ||
    startup.flag !== 'no';
  return restart ? { ...base, name: 'disarmed', reason: 'restart' } : base;
}

function wallAt(ctx: Ctx): number {
  return ctx.s.lastWall + (ctx.now - ctx.s.lastWallMono) / SECOND;
}

function onTimeSeconds(
  settings: Level2Settings,
  state: Level2State,
  now: number,
  wall: number,
): number {
  const windowSeconds = windowSecondsOf(settings);
  const from = wall - windowSeconds;
  let total = 0;
  for (const [start, end] of state.runs) {
    total += Math.max(0, Math.min(end, wall) - Math.max(start, from));
  }
  if (state.run !== null && state.run.startMono !== null) {
    total += Math.min(windowSeconds, Math.max(0, (now - state.run.startMono) / SECOND));
  }
  return total;
}

function capLeftMs(ctx: Ctx): number {
  return (
    ctx.settings.level2_cap_hours * HOUR -
    onTimeSeconds(ctx.settings, ctx.s, ctx.now, wallAt(ctx)) * SECOND
  );
}

/** Less on-time left under the cap than the minimum interval (or none at all). */
function capBlocks(ctx: Ctx): boolean {
  const left = capLeftMs(ctx);
  return left <= 0 || left < ctx.settings.level2_resume_min_interval_minutes * MINUTE;
}

function batteryReading(
  battery: Level2Battery,
):
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'ok'; onBattery: boolean; percent: number; remaining: number | null } {
  if (battery?.kind === 'none') return { kind: 'none' };
  if (
    battery?.kind === 'battery' &&
    (battery.source === 'ac' || battery.source === 'battery') &&
    typeof battery.percent === 'number' &&
    Number.isFinite(battery.percent) &&
    (battery.remainingMinutes === null ||
      (typeof battery.remainingMinutes === 'number' && Number.isFinite(battery.remainingMinutes)))
  ) {
    return {
      kind: 'ok',
      onBattery: battery.source === 'battery',
      percent: battery.percent,
      remaining: battery.remainingMinutes,
    };
  }
  return { kind: 'unknown' };
}

interface Block {
  readonly reason: Level2BlockReason;
  readonly processes: readonly string[];
}

function block(reason: Level2BlockReason, processes: readonly string[] = []): Block {
  return { reason, processes };
}

function processNames(foreign: Level2Foreign): string[] {
  if (foreign?.kind !== 'ok' || !Array.isArray(foreign.blocking)) return [];
  return [...new Set(foreign.blocking.map((holder) => holder.process))];
}

/** Item 6 up to the watchdog: everything but the cap and the automatic-only rules. */
function readingsBlock(
  settings: Level2Settings,
  r: Level2Readings,
  sessions: Level2Sessions,
  origin: Level2Origin,
  moderateHeldPause: boolean,
): Block | null {
  if (sessions.live <= 0) return block('no-session');
  if (origin === 'automatic' && sessions.working <= 0) return block('no-work');
  if (r.sleepDisabled !== 'no' && r.sleepDisabled !== 'yes') return block('flag-unknown');
  if (r.sleepDisabled === 'yes') return block('sleep-disabled-by-other');
  const battery = batteryReading(r.battery);
  if (battery.kind === 'none') return block('no-battery');
  if (battery.kind === 'unknown') return block('battery-unknown');
  // Q2: on AC power only the other rails apply.
  if (battery.onBattery && battery.percent < settings.level2_start_battery_percent) {
    return block('battery-low');
  }
  if (
    battery.onBattery &&
    battery.remaining !== null &&
    battery.remaining < settings.level2_min_remaining_minutes
  ) {
    return block('battery-time-low');
  }
  const thermal = thermalRank(r.thermal);
  if (thermal === undefined) return block('thermal-unknown');
  if (thermal >= settingRank(settings.thermal_refuse_level)) return block('thermal');
  // After a moderate-held pause, an automatic resume waits for the level to drop
  // below moderate, whatever the refuse level: otherwise it would resume at
  // moderate and pause again after `thermal_moderate_revert_minutes`, in a loop.
  if (moderateHeldPause && origin === 'automatic' && thermal >= MODERATE_RANK) {
    return block('thermal');
  }
  if (r.foreign?.kind !== 'ok' || !Array.isArray(r.foreign.blocking)) {
    return block('assertions-unknown');
  }
  if (r.foreign.blocking.length > 0) return block('foreign-holder', processNames(r.foreign));
  if (settings.require_password_on_wake) {
    if (r.passwordOnWake === 'off') return block('password-on-wake-off');
    if (r.passwordOnWake !== 'on') return block('password-on-wake-unknown');
  }
  if (r.watchdog === 'missing') return block('watchdog-missing');
  if (r.watchdog === 'mismatch') return block('watchdog-mismatch');
  if (r.watchdog !== 'loaded') return block('watchdog-unknown');
  return null;
}

function sanitizeSessions(sessions: Level2Sessions | undefined): Level2Sessions {
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return { live: count(sessions?.live), working: count(sessions?.working) };
}

function observeSessions(ctx: Ctx, sessions: Level2Sessions | undefined): void {
  const { s, now } = ctx;
  s.sessions = sanitizeSessions(sessions);
  if (s.sessions.working <= 0) s.idleSince = s.idleSince ?? now;
  else s.idleSince = null;
}

/**
 * Count one breaker failure. The list keeps at most `level2_breaker_failures`
 * entries (the newest): once the breaker has tripped more would not change the
 * decision, and a revert that keeps failing would otherwise grow the state file
 * at every beat.
 */
function recordFailure(ctx: Ctx): boolean {
  const { s, settings } = ctx;
  s.failures = [...s.failures, wallAt(ctx)].slice(-settings.level2_breaker_failures);
  return s.failures.length >= settings.level2_breaker_failures;
}

function clearTrackers(s: WorkingState): void {
  s.clearSince = null;
  s.moderateSince = null;
  s.foreignSince = null;
}

function setDisarmed(ctx: Ctx, reason: Level2DisarmReason): void {
  const { s } = ctx;
  s.name = 'disarmed';
  s.reason = reason;
  s.reasonProcesses = [];
  s.origin = null;
  s.target = null;
  s.run = null;
  clearTrackers(s);
}

function setArmedFresh(s: WorkingState): void {
  s.name = 'armed';
  s.reason = null;
  s.reasonProcesses = [];
  s.target = null;
  s.failures = [];
  s.resumes = [];
  s.pausedAt = null;
  s.lastPauseReason = null;
  s.clearSince = null;
}

/** A blocked start leaves `armed` for no session or no work, else `paused`. */
function setBlocked(ctx: Ctx, found: Block): void {
  const { s } = ctx;
  s.name = found.reason === 'no-session' || found.reason === 'no-work' ? 'armed' : 'paused';
  s.reason = found.reason;
  s.reasonProcesses = found.processes;
}

/**
 * Milliseconds from now to the latest end that can still be written (a `Date`
 * and the lease's `lease_integer_max_digits`); the validator refuses hours that
 * go past it, and this keeps a run inside it whatever the settings.
 */
function representableLeftMs(ctx: Ctx): number {
  const wall = wallAt(ctx);
  const latest = representableEndSeconds(ctx.settings.lease_integer_max_digits, wall);
  return Math.max(0, (latest - wall) * SECOND);
}

function beginEnable(ctx: Ctx, origin: Level2Origin, lengthMs: number): void {
  const { s, now } = ctx;
  const capLeft = capLeftMs(ctx);
  const representable = representableLeftMs(ctx);
  const length = Math.min(lengthMs, capLeft, representable);
  const run: Level2Run = {
    enableAt: now,
    startMono: null,
    startWall: null,
    end: now + length,
    cutByCap: capLeft < lengthMs && capLeft <= representable,
  };
  s.run = run;
  s.name = 'starting';
  s.reason = null;
  s.reasonProcesses = [];
  s.origin = origin;
  s.target = null;
  clearTrackers(s);
  ctx.actions.push({
    type: 'enable',
    origin,
    runEnd: run.end,
    runEndWall: wallAt(ctx) + length / SECOND,
    cutByCap: run.cutByCap,
  });
}

function beginRevert(ctx: Ctx, reason: Level2RevertReason, target: Level2Target): void {
  const { s } = ctx;
  s.name = 'reverting';
  s.reason = reason;
  s.reasonProcesses = [];
  s.target = target;
  clearTrackers(s);
  ctx.actions.push({ type: 'disable', reason });
}

function finishRun(ctx: Ctx): void {
  const { s, now } = ctx;
  if (s.run !== null && s.run.startMono !== null && s.run.startWall !== null) {
    const seconds = Math.max(0, (now - s.run.startMono) / SECOND);
    s.runs = [...s.runs, [s.run.startWall, s.run.startWall + seconds]];
  }
  s.run = null;
  s.origin = null;
}

/** `idle` and `no-session` revert to `armed`; a tripped breaker disarms after the revert. */
function pauseTarget(reason: Level2PauseReason, tripped: boolean): Level2Target {
  if (tripped) return { name: 'disarmed', reason: 'breaker' };
  if (reason === 'idle') return { name: 'armed', reason: 'no-work' };
  if (reason === 'no-session') return { name: 'armed', reason: 'no-session' };
  return { name: 'paused', reason };
}

/** Item 7, while `on`. `readings` is null for a `census`, which checks only sessions and time. */
function stepOn(ctx: Ctx, readings: Level2Readings | null): void {
  const { s, settings, now } = ctx;
  const sessions = s.sessions ?? { live: 0, working: 0 };
  if (readings !== null) {
    if (readings.sleepDisabled === 'no') {
      // Someone cleared the flag (possibly the owner's own revert): a person's
      // kill switch. Never `disable`, which would act on a flag remi no longer owns.
      finishRun(ctx);
      ctx.actions.push({ type: 'forget', reason: 'flag-cleared-by-other' });
      setDisarmed(ctx, 'flag-cleared-by-other');
      return;
    }
    const thermal = thermalRank(readings.thermal);
    s.moderateSince =
      thermal !== undefined && thermal >= MODERATE_RANK ? (s.moderateSince ?? now) : null;
    const foreignUnknown =
      readings.foreign?.kind !== 'ok' || !Array.isArray(readings.foreign.blocking);
    const foreignPresent = foreignUnknown || processNames(readings.foreign).length > 0;
    if (foreignPresent && s.foreignSince === null) {
      s.foreignSince = now;
      ctx.actions.push({
        type: 'notify',
        reason: foreignUnknown ? 'assertions-unknown' : 'foreign-holder',
        processes: processNames(readings.foreign),
      });
    } else if (!foreignPresent) {
      s.foreignSince = null;
    }
  }

  let reason: Level2PauseReason | null = null;
  let failure = false;
  if (sessions.live <= 0) {
    reason = 'no-session';
  } else if (readings !== null) {
    const battery = batteryReading(readings.battery);
    const thermal = thermalRank(readings.thermal);
    if (readings.sleepDisabled !== 'yes') {
      reason = 'flag-unknown';
      failure = true;
    } else if (battery.kind === 'none') {
      reason = 'no-battery';
    } else if (battery.kind === 'unknown') {
      reason = 'battery-unknown';
    } else if (battery.onBattery && battery.percent <= settings.level2_revert_battery_percent) {
      reason = 'battery-low';
    } else if (
      battery.onBattery &&
      battery.remaining !== null &&
      battery.remaining < settings.level2_min_remaining_minutes
    ) {
      reason = 'battery-time-low';
    } else if (thermal === undefined) {
      reason = 'thermal-unknown';
    } else if (thermal >= settingRank(settings.thermal_revert_level)) {
      reason = 'thermal';
    } else if (
      s.moderateSince !== null &&
      now - s.moderateSince >= settings.thermal_moderate_revert_minutes * MINUTE
    ) {
      reason = 'thermal-moderate-held';
    } else if (
      s.foreignSince !== null &&
      now - s.foreignSince >= settings.foreign_holder_revert_minutes * MINUTE
    ) {
      reason =
        readings.foreign?.kind !== 'ok' || !Array.isArray(readings.foreign.blocking)
          ? 'assertions-unknown'
          : 'foreign-holder';
    } else if (readings.watchdog === 'missing') {
      reason = 'watchdog-missing';
    } else if (readings.watchdog === 'mismatch') {
      reason = 'watchdog-mismatch';
      failure = true;
    } else if (readings.watchdog !== 'loaded') {
      reason = 'watchdog-unknown';
    }
  }
  if (reason === null && s.run !== null && now >= s.run.end) {
    reason = s.run.cutByCap ? 'daily-cap' : 'run-limit';
  }
  if (
    reason === null &&
    sessions.working <= 0 &&
    s.idleSince !== null &&
    now - s.idleSince >= settings.level2_idle_revert_minutes * MINUTE
  ) {
    reason = 'idle';
  }
  if (reason === null) return;
  const tripped = failure ? recordFailure(ctx) : false;
  beginRevert(ctx, reason, pauseTarget(reason, tripped));
}

/**
 * While `starting`, the switch call is in flight and the controller answers it
 * with `enabled` or `enable-failed`. If that answer is lost, sleep may be off
 * with every rail blind, so a beat or census here is never a no-op: an
 * unreadable flag, the run's end, or no answer within `switch_deadline_ms` plus
 * `switch_sync_deadline_ms` of the `enable` reverts. An answer that comes late
 * still counts the on-time while reverting.
 */
function stepStarting(ctx: Ctx, readings: Level2Readings | null): void {
  const { s, settings, now } = ctx;
  if (s.run === null) return;
  let reason: Level2PauseReason | null = null;
  let failure = false;
  if (readings !== null && readings.sleepDisabled !== 'yes' && readings.sleepDisabled !== 'no') {
    reason = 'flag-unknown';
    failure = true;
  } else if (now >= s.run.end) {
    reason = s.run.cutByCap ? 'daily-cap' : 'run-limit';
  } else if (
    now >=
    s.run.enableAt + settings.switch_deadline_ms + settings.switch_sync_deadline_ms
  ) {
    reason = 'enable-timeout';
    failure = true;
  }
  if (reason === null) return;
  const tripped = failure ? recordFailure(ctx) : false;
  beginRevert(ctx, reason, pauseTarget(reason, tripped));
}

/** Item 6 for an automatic start or resume, on a `beat` while `armed` or `paused`. */
function stepAutomatic(ctx: Ctx, readings: Level2Readings, gap: boolean): void {
  const { s, settings, now } = ctx;
  const sessions = s.sessions ?? { live: 0, working: 0 };
  let found = readingsBlock(
    settings,
    readings,
    sessions,
    'automatic',
    s.lastPauseReason === 'thermal-moderate-held',
  );
  if (found === null && capBlocks(ctx)) found = block('daily-cap');
  // Q13: an automatic start or resume needs the lid open for the whole dwell.
  if (found === null && readings.clamshell !== 'open') found = block('lid-closed');
  if (found !== null) s.clearSince = null;
  else if (gap || s.clearSince === null) s.clearSince = now;

  if (
    found === null &&
    s.pausedAt !== null &&
    now - s.pausedAt < settings.level2_resume_min_interval_minutes * MINUTE
  ) {
    found = block('resume-interval');
  }
  if (
    found === null &&
    (s.clearSince === null || now - s.clearSince < settings.level2_resume_dwell_seconds * SECOND)
  ) {
    found = block('dwell');
  }
  if (found !== null) {
    setBlocked(ctx, found);
    return;
  }
  if (s.resumes.length >= settings.level2_max_resumes_per_day) {
    setDisarmed(ctx, 'resume-limit');
    return;
  }
  s.resumes = [...s.resumes, wallAt(ctx)];
  beginEnable(ctx, 'automatic', settings.level2_default_hours * HOUR);
}

function validHours(hours: unknown): hours is number {
  return (
    typeof hours === 'number' &&
    Number.isFinite(hours) &&
    hours > 0 &&
    Number.isFinite(hours * HOUR)
  );
}

function refuse(ctx: Ctx, event: 'arm' | 'start' | 'stop' | 'extend', reason: Level2Refusal) {
  ctx.actions.push({ type: 'refused', event, reason });
}

function stepStart(ctx: Ctx, event: Extract<Level2Event, { type: 'start' }>): void {
  const { s, settings } = ctx;
  if (s.name === 'disabled') {
    refuse(ctx, 'start', 'disabled');
    return;
  }
  if (event.hours !== undefined && !validHours(event.hours)) {
    refuse(ctx, 'start', 'hours-invalid');
    return;
  }
  if (s.exiting) {
    refuse(ctx, 'start', 'exiting');
    return;
  }
  if (s.name === 'starting' || s.name === 'on') {
    refuse(ctx, 'start', 'already-on');
    return;
  }
  if (s.name === 'reverting') {
    refuse(ctx, 'start', 'reverting');
    return;
  }
  if (s.name === 'disarmed') setArmedFresh(s);
  const sessions = s.sessions ?? { live: 0, working: 0 };
  let found = readingsBlock(settings, event.readings, sessions, 'explicit', false);
  if (found === null && capBlocks(ctx)) found = block('daily-cap');
  if (found !== null) {
    // Armed either way; it then resumes by itself under the automatic rules.
    setBlocked(ctx, found);
    ctx.actions.push({ type: 'blocked', reason: found.reason, processes: found.processes });
    return;
  }
  const hours = event.hours ?? settings.level2_default_hours;
  beginEnable(ctx, 'explicit', hours * HOUR);
}

function stepExtend(ctx: Ctx, hours: unknown): void {
  const { s, now } = ctx;
  if (s.name === 'disabled') {
    refuse(ctx, 'extend', 'disabled');
    return;
  }
  if (!validHours(hours)) {
    refuse(ctx, 'extend', 'hours-invalid');
    return;
  }
  if (s.name !== 'on' || s.run === null) {
    refuse(ctx, 'extend', 'not-on');
    return;
  }
  const wanted = s.run.end + hours * HOUR;
  const capLimit = now + capLeftMs(ctx);
  const representableLimit = now + representableLeftMs(ctx);
  const end = Math.max(s.run.end, Math.min(wanted, capLimit, representableLimit));
  const cutByCap = wanted > capLimit && capLimit <= representableLimit;
  s.run = { ...s.run, end, cutByCap };
  ctx.actions.push({
    type: 'extended',
    runEnd: end,
    runEndWall: wallAt(ctx) + (end - now) / SECOND,
    cutByCap,
  });
}

function beatGap(ctx: Ctx, wall: number | null): boolean {
  const { s, settings, now } = ctx;
  const gap = settings.level2_wake_gap_seconds;
  if (s.lastBeatWall !== null && wall !== null && wall - s.lastBeatWall > gap) return true;
  return s.lastBeatMono !== null && now - s.lastBeatMono > gap * SECOND;
}

function logKey(s: Level2State): string {
  return JSON.stringify([s.name, s.reason, s.origin, s.target]);
}

/**
 * Pure level 2 reducer. Timers use the monotonic `at` (milliseconds), clamped
 * to the last value observed as level 1 does; the window counters use the
 * events' `wallNow` (epoch seconds).
 */
export function stepLevel2Policy(
  settings: Level2Settings,
  current: Level2State,
  event: Level2Event,
  at: number,
): Level2Result {
  const now = Math.max(current.lastObservedAt, Number.isFinite(at) ? at : current.lastObservedAt);
  const s: WorkingState = { ...current, settings, lastObservedAt: now };
  const ctx: Ctx = { s, settings, now, actions: [] };

  const eventWall =
    'wallNow' in event && typeof event.wallNow === 'number' && Number.isFinite(event.wallNow)
      ? event.wallNow
      : null;
  if (eventWall !== null) {
    s.lastWall = eventWall;
    s.lastWallMono = now;
  }
  const wall = wallAt(ctx);
  const skew = settings.clock_skew_tolerance_seconds;
  const windowSeconds = windowSecondsOf(settings);
  s.resumes = normalizeTimes(s.resumes, wall, skew, windowSeconds);
  s.failures = normalizeTimes(s.failures, wall, skew, windowSeconds);
  s.runs = normalizeRuns(s.runs, wall, skew, windowSeconds);
  if ('sessions' in event) observeSessions(ctx, event.sessions);

  switch (event.type) {
    case 'beat': {
      const gap = beatGap(ctx, eventWall);
      if ((s.name === 'armed' || s.name === 'paused') && !s.exiting) {
        stepAutomatic(ctx, event.readings, gap);
      } else if (s.name === 'on') {
        stepOn(ctx, event.readings);
      } else if (s.name === 'starting') {
        stepStarting(ctx, event.readings);
      } else if (s.name === 'reverting') {
        ctx.actions.push({ type: 'disable', reason: s.reason as Level2RevertReason });
      }
      s.lastBeatMono = now;
      s.lastBeatWall = eventWall ?? wall;
      break;
    }
    case 'census': {
      const sessions = s.sessions ?? { live: 0, working: 0 };
      if ((s.name === 'armed' || s.name === 'paused') && !s.exiting) {
        if (sessions.live <= 0) {
          s.clearSince = null;
          setBlocked(ctx, block('no-session'));
        } else if (sessions.working <= 0) {
          s.clearSince = null;
          setBlocked(ctx, block('no-work'));
        }
      } else if (s.name === 'on') {
        stepOn(ctx, null);
      } else if (s.name === 'starting') {
        stepStarting(ctx, null);
      } else if (s.name === 'reverting') {
        ctx.actions.push({ type: 'disable', reason: s.reason as Level2RevertReason });
      }
      break;
    }
    case 'start':
      stepStart(ctx, event);
      break;
    case 'arm':
      if (s.name === 'disabled') refuse(ctx, 'arm', 'disabled');
      else if (s.name === 'disarmed') setArmedFresh(s);
      else if (s.name === 'reverting' && s.target?.name === 'disarmed') {
        s.target = { name: 'armed', reason: null };
        s.failures = [];
        s.resumes = [];
      }
      break;
    case 'stop':
      if (s.name === 'disabled') refuse(ctx, 'stop', 'disabled');
      else if (s.name === 'armed' || s.name === 'paused') setDisarmed(ctx, 'stopped');
      else if (s.name === 'starting' || s.name === 'on') {
        beginRevert(ctx, 'stopped', { name: 'disarmed', reason: 'stopped' });
      } else if (s.name === 'reverting') {
        s.target = { name: 'disarmed', reason: 'stopped' };
        ctx.actions.push({ type: 'disable', reason: 'stopped' });
      }
      break;
    case 'extend':
      stepExtend(ctx, event.hours);
      break;
    case 'enabled':
      if (s.name === 'starting' && s.run !== null) {
        s.name = 'on';
        s.run = { ...s.run, startMono: now, startWall: wall };
        const working = s.sessions?.working ?? 0;
        s.idleSince = working <= 0 ? now : null;
        clearTrackers(s);
      } else if (s.name === 'reverting' && s.run !== null && s.run.startMono === null) {
        // A stop or a breaker reached the revert before the switch reported:
        // sleep was off meanwhile, so the on-time still counts.
        s.run = { ...s.run, startMono: now, startWall: wall };
      }
      break;
    case 'enable-failed':
      if (s.name !== 'starting') break;
      s.run = null;
      s.origin = null;
      if (event.reason === 'lease-write-failed') {
        // No switch call happened: count it and pause; it resumes by itself.
        s.pausedAt = now;
        if (recordFailure(ctx)) {
          setDisarmed(ctx, 'breaker');
        } else {
          s.name = 'paused';
          s.reason = 'lease-write-failed';
          s.reasonProcesses = [];
        }
      } else {
        // A switch failure is never retried automatically.
        const reason: Level2DisarmReason =
          event.reason === 'revert-not-permitted' || event.reason === 'sudo-refused'
            ? event.reason
            : 'switch-failed';
        setDisarmed(ctx, reason);
      }
      break;
    case 'disabled':
      if (s.name === 'reverting' && s.target !== null) {
        finishRun(ctx);
        const target = s.target;
        s.target = null;
        s.pausedAt = now;
        s.lastPauseReason = s.reason as Level2RevertReason;
        clearTrackers(s);
        if (s.exiting) s.cleanExit = true;
        s.name = target.name;
        s.reason = target.reason;
        s.reasonProcesses = [];
      }
      break;
    case 'disable-failed':
      // Reverting is the safe direction: stay, count it, retry on every beat.
      if (s.name === 'reverting' && recordFailure(ctx)) {
        s.target = { name: 'disarmed', reason: 'breaker' };
      }
      break;
    case 'heartbeat-failed': {
      if (s.name === 'disabled') break;
      const tripped = recordFailure(ctx);
      if (s.name === 'on') {
        beginRevert(ctx, 'heartbeat-failed', pauseTarget('heartbeat-failed', tripped));
      } else if (tripped && s.name === 'starting') {
        beginRevert(ctx, 'breaker', { name: 'disarmed', reason: 'breaker' });
      } else if (tripped && s.name === 'reverting') {
        s.target = { name: 'disarmed', reason: 'breaker' };
      } else if (tripped && (s.name === 'armed' || s.name === 'paused')) {
        setDisarmed(ctx, 'breaker');
      }
      break;
    }
    case 'hub-exit':
      s.exiting = true;
      if (s.name === 'starting' || s.name === 'on') {
        beginRevert(ctx, 'hub-exit', { name: 'armed', reason: null });
      } else if (s.name === 'reverting') {
        ctx.actions.push({ type: 'disable', reason: 'hub-exit' });
      } else {
        s.cleanExit = true;
      }
      break;
  }

  const effects: Level2Effect[] = [];
  const persisted = persistedOf(s);
  // Every transition persists, and so does every beat while starting, on or
  // reverting (card item 3): the run in progress moves its end to that beat.
  const runningBeat = event.type === 'beat' && RUNNING.has(current.name);
  if (
    runningBeat ||
    current.name !== s.name ||
    JSON.stringify(persistedOf(current)) !== JSON.stringify(persisted)
  ) {
    effects.push({ type: 'persist', value: persisted });
  }
  if (logKey(current) !== logKey(s)) {
    effects.push({
      type: 'log',
      state: s.name,
      reason: s.reason,
      origin: s.origin,
      target: s.target,
    });
  }
  effects.push(...ctx.actions);
  return { state: s, effects, nextDeadline: deadlineFor(s, now) };
}

function deadlineFor(s: Level2State, now: number): number | null {
  const settings = s.settings;
  if (s.name === 'disabled' || s.name === 'disarmed') return null;
  if (s.exiting && (s.name === 'armed' || s.name === 'paused')) return null;
  const deadlines = [now + settings.heartbeat_seconds * SECOND];
  if (s.name === 'starting' && s.run !== null) {
    deadlines.push(s.run.end);
    deadlines.push(s.run.enableAt + settings.switch_deadline_ms + settings.switch_sync_deadline_ms);
  }
  if (s.name === 'on' && s.run !== null) {
    deadlines.push(s.run.end);
    if (s.idleSince !== null) {
      deadlines.push(s.idleSince + settings.level2_idle_revert_minutes * MINUTE);
    }
    if (s.moderateSince !== null) {
      deadlines.push(s.moderateSince + settings.thermal_moderate_revert_minutes * MINUTE);
    }
    if (s.foreignSince !== null) {
      deadlines.push(s.foreignSince + settings.foreign_holder_revert_minutes * MINUTE);
    }
  }
  if (s.name === 'armed' || s.name === 'paused') {
    if (s.clearSince !== null) {
      deadlines.push(s.clearSince + settings.level2_resume_dwell_seconds * SECOND);
    }
    if (s.pausedAt !== null) {
      deadlines.push(s.pausedAt + settings.level2_resume_min_interval_minutes * MINUTE);
    }
  }
  const future = deadlines.filter((deadline) => deadline > now);
  return future.length > 0 ? Math.min(...future) : null;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / SECOND));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function waitingFor(state: Level2State, now: number): string | null {
  const settings = state.settings;
  if (state.name === 'disarmed') return 'a person to run remi keep-awake arm or start';
  if (state.name === 'armed') {
    return state.reason === 'no-session' ? 'a live session' : 'real work in a session';
  }
  if (state.name !== 'paused') return null;
  const interval = settings.level2_resume_min_interval_minutes * MINUTE;
  switch (state.reason) {
    case 'no-session':
      return 'a live session';
    case 'no-work':
    case 'idle':
      return 'real work in a session';
    case 'flag-unknown':
      return 'a readable sleep flag (SleepDisabled)';
    case 'sleep-disabled-by-other':
      return 'sleep allowed again by whoever disabled it';
    case 'no-battery':
      return 'a battery: level 2 never turns on without one';
    case 'battery-unknown':
      return 'a readable battery level';
    case 'battery-low':
      return `battery at ${settings.level2_start_battery_percent} percent or AC power`;
    case 'battery-time-low':
      return `${settings.level2_min_remaining_minutes} minutes of battery remaining or AC power`;
    case 'thermal-unknown':
      return 'a readable thermal pressure level';
    case 'thermal':
    case 'thermal-moderate-held':
      // After a moderate-held pause an automatic resume needs the level below
      // moderate, whatever `thermal_refuse_level` says.
      return state.reason === 'thermal-moderate-held' ||
        state.lastPauseReason === 'thermal-moderate-held'
        ? 'thermal pressure below moderate'
        : `thermal pressure below ${settings.thermal_refuse_level}`;
    case 'assertions-unknown':
      return 'a readable list of the apps holding the Mac awake';
    case 'foreign-holder':
      return state.reasonProcesses.length > 0
        ? `no other app holding the Mac awake (now: ${state.reasonProcesses.join(', ')})`
        : 'no other app holding the Mac awake';
    case 'password-on-wake-unknown':
      return 'a readable password-on-wake setting';
    case 'password-on-wake-off':
      return 'password on wake turned on';
    case 'watchdog-unknown':
    case 'watchdog-missing':
    case 'watchdog-mismatch':
      return 'the watchdog loaded for this remi home';
    case 'daily-cap':
      return `${formatDuration(Math.max(interval, MINUTE))} of on-time free under the ${settings.level2_cap_hours}-hour cap in ${settings.level2_window_hours} hours`;
    case 'lid-closed':
      return 'lid open';
    case 'dwell': {
      const left =
        state.clearSince === null
          ? settings.level2_resume_dwell_seconds * SECOND
          : state.clearSince + settings.level2_resume_dwell_seconds * SECOND - now;
      return `${formatDuration(left)} without a blocking condition`;
    }
    default: {
      // resume-interval, run-limit and the failure pauses: the minimum interval
      // after a pause, then every condition clear for the dwell.
      const left = state.pausedAt === null ? 0 : state.pausedAt + interval - now;
      return left > 0
        ? `${formatDuration(left)} more since the last pause`
        : `${formatDuration(settings.level2_resume_dwell_seconds * SECOND)} without a blocking condition`;
    }
  }
}

/** What `remi keep-awake status` prints (item 10); `now` monotonic, `wallNow` epoch seconds. */
export function level2Status(state: Level2State, now: number, wallNow: number): Level2Status {
  const settings = state.settings;
  const at = Math.max(state.lastObservedAt, Number.isFinite(now) ? now : state.lastObservedAt);
  const wall = Number.isFinite(wallNow)
    ? wallNow
    : state.lastWall + (at - state.lastWallMono) / SECOND;
  const skew = settings.clock_skew_tolerance_seconds;
  const windowSeconds = windowSecondsOf(settings);
  const view: Level2State = {
    ...state,
    resumes: normalizeTimes(state.resumes, wall, skew, windowSeconds),
    failures: normalizeTimes(state.failures, wall, skew, windowSeconds),
    runs: normalizeRuns(state.runs, wall, skew, windowSeconds),
  };
  const onTime = onTimeSeconds(settings, view, at, wall);
  const running = state.name === 'starting' || state.name === 'on' || state.name === 'reverting';
  return {
    state: state.name,
    reason: state.reason,
    origin: state.origin,
    runEnd: running && state.run !== null ? wall + (state.run.end - at) / SECOND : null,
    runEndCutByCap: running && state.run !== null && state.run.cutByCap,
    onTimeLeftToday: Math.max(0, settings.level2_cap_hours * 3_600 - onTime),
    resumesLeftToday: Math.max(0, settings.level2_max_resumes_per_day - view.resumes.length),
    failuresToday: view.failures.length,
    waitingFor: waitingFor(state, at),
  };
}
