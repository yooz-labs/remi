import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyForeignHolders } from '../../src/power/level2-foreign-holders.ts';
import {
  type Level2BlockReason,
  type Level2Effect,
  type Level2EnableFailure,
  type Level2Event,
  type Level2Persisted,
  type Level2Readings,
  type Level2RevertReason,
  type Level2Sessions,
  type Level2State,
  initialLevel2State,
  level2Persisted,
  level2Status,
  stepLevel2Policy,
} from '../../src/power/level2-policy.ts';
import {
  DATE_MAX_EPOCH_SECONDS,
  LEVEL2_DEFAULTS,
  LEVEL2_NUMERIC_KEYS,
  type Level2Settings,
} from '../../src/power/level2-settings.ts';

/** Wall clock at the simulation's start, epoch seconds. */
const W0 = 1_800_000_000;
const MIN = 60;
const HOUR = 3600;

const battery = (percent: number, remainingMinutes: number | null = 240) =>
  ({ kind: 'battery', source: 'battery', percent, remainingMinutes }) as const;
const ac = (percent = 80) =>
  ({ kind: 'battery', source: 'ac', percent, remainingMinutes: null }) as const;
const holders = (...names: string[]) =>
  ({
    kind: 'ok',
    blocking: names.map((process) => ({ process, kind: 'display' as const })),
  }) as const;

/** Every condition passes (the flag comes from the simulated world). */
const CLEAR: Omit<Level2Readings, 'sleepDisabled'> = {
  battery: battery(80),
  thermal: 'nominal',
  foreign: { kind: 'ok', blocking: [] },
  passwordOnWake: 'on',
  watchdog: 'loaded',
  clamshell: 'open',
};
const WORK: Level2Sessions = { live: 1, working: 1 };
const IDLE: Level2Sessions = { live: 1, working: 0 };
const NONE: Level2Sessions = { live: 0, working: 0 };

function settingsWith(overrides: Partial<Level2Settings> = {}): Level2Settings {
  return { ...LEVEL2_DEFAULTS, level2: true, ...overrides };
}

type Over = Partial<Level2Readings> | ((sim: Sim) => Partial<Level2Readings>);

interface SimOptions {
  readonly settings?: Partial<Level2Settings>;
  readonly persisted?: Level2Persisted | null;
  readonly leaseFound?: boolean;
  readonly flag?: 'yes' | 'no' | 'unknown';
  /** Leave `enable` and `disable` unanswered until `ackEnabled` or `ackDisabled`. */
  readonly holdAcks?: boolean;
}

/**
 * Drives the real reducer the way the hub's controller will: it acknowledges
 * each `enable` and `disable` effect with `enabled` and `disabled` (or the
 * failure the test sets) and keeps the simulated `SleepDisabled` flag.
 */
class Sim {
  readonly settings: Level2Settings;
  state: Level2State;
  /** Monotonic seconds. */
  t = 0;
  /** Added to the wall clock only: a clock step. */
  wallShift = 0;
  flag: 'yes' | 'no' | 'unknown';
  enableFailure: Level2EnableFailure | null = null;
  disableFails = false;
  readonly holdAcks: boolean;
  /** Effects left unanswered while `holdAcks` is set. */
  pendingEnable = false;
  pendingDisable = false;
  nextDeadline: number | null = null;
  readonly enables: { t: number; origin: string; runEndWall: number; cutByCap: boolean }[] = [];
  readonly disables: { t: number; reason: string }[] = [];

  constructor(options: SimOptions = {}) {
    this.settings = settingsWith(options.settings);
    this.flag = options.flag ?? 'no';
    this.holdAcks = options.holdAcks ?? false;
    this.state = initialLevel2State(this.settings, options.persisted ?? null, {
      leaseFound: options.leaseFound ?? false,
      flag: this.flag,
      now: 0,
      wallNow: W0,
    });
  }

  wall(): number {
    return W0 + this.t + this.wallShift;
  }

  advance(seconds: number): void {
    this.t += seconds;
  }

  send(event: Level2Event): Level2Effect[] {
    const before = this.state;
    const result = stepLevel2Policy(this.settings, this.state, event, this.t * 1000);
    this.state = result.state;
    this.nextDeadline = result.nextDeadline;
    if (before.name !== result.state.name) {
      // Every transition persists (item 3).
      expect(result.effects.filter((e) => e.type === 'persist')).toHaveLength(1);
    }
    expectDeadlineWithinHeartbeat(result.state, result.nextDeadline, this.t * 1000);
    const all: Level2Effect[] = [...result.effects];
    for (const effect of result.effects) {
      if (effect.type === 'enable') {
        this.enables.push({
          t: this.t,
          origin: effect.origin,
          runEndWall: effect.runEndWall,
          cutByCap: effect.cutByCap,
        });
        if (this.holdAcks) {
          this.pendingEnable = true;
        } else if (this.enableFailure !== null) {
          all.push(...this.send({ type: 'enable-failed', reason: this.enableFailure }));
        } else {
          this.flag = 'yes';
          all.push(...this.send({ type: 'enabled' }));
        }
      } else if (effect.type === 'disable') {
        this.disables.push({ t: this.t, reason: effect.reason });
        if (this.holdAcks) {
          this.pendingDisable = true;
        } else if (this.disableFails) {
          all.push(...this.send({ type: 'disable-failed' }));
        } else {
          this.flag = 'no';
          all.push(...this.send({ type: 'disabled' }));
        }
      }
    }
    return all;
  }

  /** Answer a held `enable` as the switch would after success. */
  ackEnabled(): Level2Effect[] {
    expect(this.pendingEnable).toBe(true);
    this.pendingEnable = false;
    this.flag = 'yes';
    return this.send({ type: 'enabled' });
  }

  /** Answer a held `disable` as the switch would after success. */
  ackDisabled(): Level2Effect[] {
    expect(this.pendingDisable).toBe(true);
    this.pendingDisable = false;
    this.flag = 'no';
    return this.send({ type: 'disabled' });
  }

  readings(over: Over = {}): Level2Readings {
    const extra = typeof over === 'function' ? over(this) : over;
    return { ...CLEAR, sleepDisabled: this.flag, ...extra };
  }

  beat(over: Over = {}, sessions: Level2Sessions = WORK): Level2Effect[] {
    return this.send({
      type: 'beat',
      readings: this.readings(over),
      sessions,
      wallNow: this.wall(),
    });
  }

  census(sessions: Level2Sessions): Level2Effect[] {
    return this.send({ type: 'census', sessions, wallNow: this.wall() });
  }

  start(over: Over = {}, sessions: Level2Sessions = WORK, hours?: number): Level2Effect[] {
    return this.send({
      type: 'start',
      ...(hours === undefined ? {} : { hours }),
      readings: this.readings(over),
      sessions,
      wallNow: this.wall(),
    });
  }

  /** A beat every `every` seconds for `seconds` seconds. */
  run(seconds: number, over: Over = {}, sessions: Level2Sessions = WORK, every = 30) {
    const effects: Level2Effect[] = [];
    for (let elapsed = 0; elapsed < seconds; elapsed += every) {
      this.advance(every);
      effects.push(...this.beat(over, sessions));
    }
    return effects;
  }

  /** Beats every 30 s until `done` holds (checked after each beat) or `limit` seconds pass. */
  runUntil(done: (state: Level2State) => boolean, limit: number, over: Over = {}, sessions = WORK) {
    const effects: Level2Effect[] = [];
    for (let elapsed = 0; elapsed < limit && !done(this.state); elapsed += 30) {
      this.advance(30);
      effects.push(...this.beat(over, sessions));
    }
    return effects;
  }

  status() {
    return level2Status(this.state, this.t * 1000, this.wall());
  }
}

/**
 * While level 2 needs beats (not disabled, not disarmed, not an exiting hub
 * that is off), the next deadline exists, lies ahead, and is at most one
 * heartbeat away, so a timer for it never waits longer than a heartbeat.
 */
function expectDeadlineWithinHeartbeat(state: Level2State, deadline: number | null, now: number) {
  const idle =
    state.name === 'disabled' ||
    state.name === 'disarmed' ||
    (state.exiting && (state.name === 'armed' || state.name === 'paused'));
  if (idle) {
    expect(deadline).toBeNull();
    return;
  }
  expect(deadline).not.toBeNull();
  expect(deadline ?? 0).toBeGreaterThan(now);
  expect(deadline ?? 0).toBeLessThanOrEqual(now + state.settings.heartbeat_seconds * 1000);
}

function label(state: Level2State): string {
  return state.reason === null ? state.name : `${state.name}:${state.reason}`;
}

function ofType<T extends Level2Effect['type']>(effects: readonly Level2Effect[], type: T) {
  return effects.filter((e): e is Extract<Level2Effect, { type: T }> => e.type === type);
}

/** On, explicitly, at the current time. */
function startedSim(options: SimOptions = {}): Sim {
  const sim = new Sim(options);
  sim.start();
  expect(sim.state.name).toBe('on');
  return sim;
}

/** On by itself: work and every condition clear for the dwell. */
function autoOn(sim: Sim): void {
  sim.beat();
  sim.runUntil((s) => s.name === 'on', 30 * MIN);
  expect(sim.state.name).toBe('on');
}

describe('level 2 initial state (Q12 (b))', () => {
  const clean: Level2Persisted = {
    armed: true,
    disarmReason: null,
    cleanExit: true,
    resumes: [],
    failures: [],
    runs: [],
  };
  const start = (
    persisted: Level2Persisted | null,
    extra: { leaseFound?: boolean; flag?: 'yes' | 'no' | 'unknown'; level2?: boolean } = {},
  ) =>
    initialLevel2State(settingsWith({ level2: extra.level2 ?? true }), persisted, {
      leaseFound: extra.leaseFound ?? false,
      flag: extra.flag ?? 'no',
      now: 0,
      wallNow: W0,
    });

  test('disabled when level2 is false, whatever was persisted', () => {
    expect(start(null, { level2: false }).name).toBe('disabled');
    expect(start({ ...clean, cleanExit: false }, { level2: false }).name).toBe('disabled');
  });

  test('armed on the first run and after a clean exit', () => {
    expect(label(start(null))).toBe('armed');
    expect(label(start(clean))).toBe('armed');
  });

  test.each([
    ['no clean exit', { ...clean, cleanExit: false }, {}],
    ['a lease found', clean, { leaseFound: true }],
    ['the flag reads yes', clean, { flag: 'yes' as const }],
    ['the flag is unknown', clean, { flag: 'unknown' as const }],
    [
      'a persisted disarmed state',
      { ...clean, armed: false, disarmReason: 'stopped' as const },
      {},
    ],
    ['a malformed persisted state', { ...clean, resumes: ['x'] } as unknown as Level2Persisted, {}],
  ])('disarmed with restart after %s', (_label, persisted, extra) => {
    expect(label(start(persisted, extra))).toBe('disarmed:restart');
  });

  test('the new state records no clean exit until the hub exits cleanly', () => {
    expect(level2Persisted(start(clean)).cleanExit).toBe(false);
  });

  test('the persisted counters carry over, so a restart cannot reset them', () => {
    const state = start({ ...clean, resumes: [W0 - 60, W0 - 120], failures: [W0 - 30] });
    expect(level2Persisted(state).resumes).toEqual([W0 - 60, W0 - 120]);
    expect(level2Persisted(state).failures).toEqual([W0 - 30]);
  });
});

/** Inputs that each break exactly one rule of item 6 (the field says which input). */
interface Break {
  readonly reason: Level2BlockReason;
  readonly field: string;
  readonly readings?: Partial<Level2Readings>;
  readonly sessions?: Level2Sessions;
  /** The rule applies to an explicit start too. */
  readonly explicit: boolean;
  /** `armed` for no session or no work, else `paused`. */
  readonly state: 'armed' | 'paused';
}

const INPUT_BREAKS: readonly Break[] = [
  { reason: 'no-session', field: 'sessions', sessions: NONE, explicit: true, state: 'armed' },
  { reason: 'no-work', field: 'sessions', sessions: IDLE, explicit: false, state: 'armed' },
  {
    reason: 'flag-unknown',
    field: 'sleepDisabled',
    readings: { sleepDisabled: 'unknown' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'sleep-disabled-by-other',
    field: 'sleepDisabled',
    readings: { sleepDisabled: 'yes' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'no-battery',
    field: 'battery',
    readings: { battery: { kind: 'none' } },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'battery-unknown',
    field: 'battery',
    readings: { battery: { kind: 'unknown' } },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'battery-low',
    field: 'battery',
    readings: { battery: battery(34) },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'battery-time-low',
    field: 'battery',
    readings: { battery: battery(80, 19) },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'thermal-unknown',
    field: 'thermal',
    readings: { thermal: 'unknown' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'thermal',
    field: 'thermal',
    readings: { thermal: 'moderate' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'thermal',
    field: 'thermal',
    readings: { thermal: 'sleeping' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'assertions-unknown',
    field: 'foreign',
    readings: { foreign: { kind: 'unknown' } },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'foreign-holder',
    field: 'foreign',
    readings: { foreign: holders('VideoApp') },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'password-on-wake-unknown',
    field: 'passwordOnWake',
    readings: { passwordOnWake: 'unknown' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'password-on-wake-off',
    field: 'passwordOnWake',
    readings: { passwordOnWake: 'off' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'watchdog-unknown',
    field: 'watchdog',
    readings: { watchdog: 'unknown' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'watchdog-missing',
    field: 'watchdog',
    readings: { watchdog: 'missing' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'watchdog-mismatch',
    field: 'watchdog',
    readings: { watchdog: 'mismatch' },
    explicit: true,
    state: 'paused',
  },
  {
    reason: 'lid-closed',
    field: 'clamshell',
    readings: { clamshell: 'closed' },
    explicit: false,
    state: 'paused',
  },
];

/** A full window of on-time, so the cap blocks. */
const CAP_FULL: Level2Persisted = {
  armed: true,
  disarmReason: null,
  cleanExit: true,
  resumes: [],
  failures: [],
  runs: [[W0 - 12 * HOUR, W0]],
};

describe('level 2 conditions that block turning on (item 6)', () => {
  // The dwell is 0 here, so a row's control (the same beat without the break)
  // turns level 2 on: each row breaks exactly one rule.
  test.each([...INPUT_BREAKS])('automatic start: $reason', (row) => {
    const sim = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    const effects = sim.beat(row.readings ?? {}, row.sessions ?? WORK);
    expect(label(sim.state)).toBe(`${row.state}:${row.reason}`);
    expect(ofType(effects, 'enable')).toEqual([]);
    if (row.reason === 'foreign-holder') expect(sim.state.reasonProcesses).toEqual(['VideoApp']);

    const control = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    control.beat();
    expect(control.state.name).toBe('on');
  });

  test.each(INPUT_BREAKS.filter((row) => row.explicit))('explicit start: $reason', (row) => {
    const sim = new Sim();
    const effects = sim.start(row.readings ?? {}, row.sessions ?? WORK);
    expect(label(sim.state)).toBe(`${row.state}:${row.reason}`);
    expect(ofType(effects, 'enable')).toEqual([]);
    expect(ofType(effects, 'blocked').map((e) => e.reason)).toEqual([row.reason]);

    const control = new Sim();
    control.start();
    expect(control.state.name).toBe('on');
  });

  test('an absent or unknown lid also blocks an automatic start as lid-closed', () => {
    for (const clamshell of ['absent', 'unknown'] as const) {
      const sim = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
      sim.beat({ clamshell });
      expect(label(sim.state)).toBe('paused:lid-closed');
    }
  });

  test('daily-cap: no on-time left under the cap blocks both starts', () => {
    const auto = new Sim({ persisted: CAP_FULL, settings: { level2_resume_dwell_seconds: 0 } });
    auto.beat();
    expect(label(auto.state)).toBe('paused:daily-cap');
    const explicit = new Sim({ persisted: CAP_FULL });
    expect(ofType(explicit.start(), 'blocked').map((e) => e.reason)).toEqual(['daily-cap']);
    expect(label(explicit.state)).toBe('paused:daily-cap');

    const control = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    control.beat();
    expect(control.state.name).toBe('on');
  });

  test('daily-cap: less on-time left than the minimum interval blocks', () => {
    const nineMinutesLeft: Level2Persisted = {
      ...CAP_FULL,
      runs: [[W0 - 12 * HOUR + 9 * MIN, W0]],
    };
    const sim = new Sim({
      persisted: nineMinutesLeft,
      settings: { level2_resume_dwell_seconds: 0 },
    });
    sim.beat();
    expect(label(sim.state)).toBe('paused:daily-cap');
    const elevenLeft: Level2Persisted = { ...CAP_FULL, runs: [[W0 - 12 * HOUR + 11 * MIN, W0]] };
    const control = new Sim({
      persisted: elevenLeft,
      settings: { level2_resume_dwell_seconds: 0 },
    });
    control.beat();
    expect(control.state.name).toBe('on');
  });

  test('resume-interval: an automatic resume waits the minimum interval after a pause', () => {
    const sim = startedSim({ settings: { level2_resume_dwell_seconds: 0 } });
    sim.advance(30);
    sim.beat({ battery: battery(20) });
    expect(label(sim.state)).toBe('paused:battery-low');
    sim.advance(30);
    sim.beat({ battery: ac() });
    expect(label(sim.state)).toBe('paused:resume-interval');
    // The pause was at 30 s: at 599 s the interval still holds, at 630 s it is over.
    sim.advance(539);
    sim.beat({ battery: ac() });
    expect(label(sim.state)).toBe('paused:resume-interval');
    sim.advance(31);
    sim.beat({ battery: ac() });
    expect(sim.state.name).toBe('on');
  });

  test('dwell: the first clear beat waits for the dwell; without a dwell it turns on', () => {
    const sim = new Sim();
    sim.beat();
    expect(label(sim.state)).toBe('paused:dwell');
    const control = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    control.beat();
    expect(control.state.name).toBe('on');
  });

  test('an explicit start ignores work, the lid, the interval and the dwell', () => {
    const noWork = new Sim();
    noWork.start({}, IDLE);
    expect(noWork.state.name).toBe('on');
    const lid = new Sim();
    lid.start({ clamshell: 'closed' });
    expect(lid.state.name).toBe('on');
    const afterPause = startedSim();
    afterPause.advance(30);
    afterPause.beat({ battery: battery(20) });
    afterPause.advance(30);
    afterPause.start({ battery: ac() });
    expect(afterPause.state.name).toBe('on');
    expect(afterPause.enables.map((e) => e.origin)).toEqual(['explicit', 'explicit']);
  });

  test('order: of two failing rules, the earlier one is reported', () => {
    let pairs = 0;
    INPUT_BREAKS.forEach((first, i) => {
      for (const second of INPUT_BREAKS.slice(i + 1)) {
        if (first.field === second.field) continue;
        const sim = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
        sim.beat(
          { ...second.readings, ...first.readings },
          first.sessions ?? second.sessions ?? WORK,
        );
        expect(`${second.reason} after ${label(sim.state)}`).toBe(
          `${second.reason} after ${first.state}:${first.reason}`,
        );
        pairs += 1;
      }
    });
    expect(pairs).toBeGreaterThan(100);

    const capAndLid = new Sim({
      persisted: CAP_FULL,
      settings: { level2_resume_dwell_seconds: 0 },
    });
    capAndLid.beat({ clamshell: 'closed' });
    expect(label(capAndLid.state)).toBe('paused:daily-cap');

    // Two rules on one reading: battery-low comes before battery-time-low, to
    // start and while on. (Other same-field reasons, such as watchdog-unknown,
    // missing and mismatch, are different values of one reading and cannot
    // hold together.)
    const both = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    both.beat({ battery: battery(34, 19) });
    expect(label(both.state)).toBe('paused:battery-low');
    const running = startedSim();
    running.advance(30);
    running.beat({ battery: battery(30, 19) });
    expect(running.disables.map((d) => d.reason)).toEqual(['battery-low']);
  });

  test('Q2: on AC power at 10 percent the battery rules pass; unplugging pauses at the next beat', () => {
    const sim = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    sim.beat({ battery: ac(10) });
    expect(sim.state.name).toBe('on');
    sim.run(5 * MIN, { battery: ac(10) });
    expect(sim.state.name).toBe('on');
    sim.advance(30);
    const effects = sim.beat({ battery: battery(10, 30) });
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual(['battery-low']);
    expect(label(sim.state)).toBe('paused:battery-low');

    const explicit = new Sim();
    explicit.start({ battery: ac(10) });
    expect(explicit.state.name).toBe('on');
  });

  test('a log line only when the condition changes, never per beat', () => {
    const sim = new Sim();
    const first = sim.beat({ battery: battery(20) });
    expect(ofType(first, 'log')).toHaveLength(1);
    const repeated = sim.run(10 * MIN, { battery: battery(20) });
    expect(ofType(repeated, 'log')).toEqual([]);
    sim.advance(30);
    expect(ofType(sim.beat({ thermal: 'heavy', battery: ac() }), 'log')).toHaveLength(1);
  });
});

interface PauseRow {
  readonly reason: Level2RevertReason;
  readonly provoke: (sim: Sim) => Level2Effect[];
  /** The state after the revert, with its reason. */
  readonly after: string;
  readonly options?: SimOptions;
}

const notOn = (state: Level2State) => state.name !== 'on';

const PAUSES: readonly PauseRow[] = [
  {
    reason: 'run-limit',
    provoke: (sim) => sim.runUntil(notOn, 4 * HOUR),
    after: 'paused:run-limit',
  },
  {
    reason: 'daily-cap',
    // Eleven hours used: the run is cut to the hour left under the cap.
    options: { persisted: { ...CAP_FULL, runs: [[W0 - 11 * HOUR, W0]] } },
    provoke: (sim) => sim.runUntil(notOn, 4 * HOUR),
    after: 'paused:daily-cap',
  },
  {
    reason: 'no-battery',
    provoke: (sim) => sim.run(30, { battery: { kind: 'none' } }),
    after: 'paused:no-battery',
  },
  {
    reason: 'battery-unknown',
    provoke: (sim) => sim.run(30, { battery: { kind: 'unknown' } }),
    after: 'paused:battery-unknown',
  },
  {
    reason: 'battery-low',
    provoke: (sim) => sim.run(30, { battery: battery(30) }),
    after: 'paused:battery-low',
  },
  {
    reason: 'battery-time-low',
    provoke: (sim) => sim.run(30, { battery: battery(80, 19) }),
    after: 'paused:battery-time-low',
  },
  {
    reason: 'thermal-unknown',
    provoke: (sim) => sim.run(30, { thermal: 'unknown' }),
    after: 'paused:thermal-unknown',
  },
  {
    reason: 'thermal',
    provoke: (sim) => sim.run(30, { thermal: 'heavy' }),
    after: 'paused:thermal',
  },
  {
    reason: 'thermal-moderate-held',
    provoke: (sim) => sim.runUntil(notOn, 10 * MIN, { thermal: 'moderate' }),
    after: 'paused:thermal-moderate-held',
  },
  {
    reason: 'foreign-holder',
    provoke: (sim) => sim.runUntil(notOn, 10 * MIN, { foreign: holders('VideoApp') }),
    after: 'paused:foreign-holder',
  },
  {
    reason: 'assertions-unknown',
    provoke: (sim) => sim.runUntil(notOn, 10 * MIN, { foreign: { kind: 'unknown' } }),
    after: 'paused:assertions-unknown',
  },
  {
    reason: 'watchdog-missing',
    provoke: (sim) => sim.run(30, { watchdog: 'missing' }),
    after: 'paused:watchdog-missing',
  },
  {
    reason: 'watchdog-mismatch',
    provoke: (sim) => sim.run(30, { watchdog: 'mismatch' }),
    after: 'paused:watchdog-mismatch',
  },
  {
    reason: 'watchdog-unknown',
    provoke: (sim) => sim.run(30, { watchdog: 'unknown' }),
    after: 'paused:watchdog-unknown',
  },
  {
    reason: 'flag-unknown',
    provoke: (sim) => sim.run(30, { sleepDisabled: 'unknown' }),
    after: 'paused:flag-unknown',
  },
  {
    reason: 'heartbeat-failed',
    provoke: (sim) => sim.send({ type: 'heartbeat-failed' }),
    after: 'paused:heartbeat-failed',
  },
  {
    reason: 'idle',
    provoke: (sim) => sim.runUntil(notOn, HOUR, {}, IDLE),
    after: 'armed:no-work',
  },
  {
    reason: 'no-session',
    provoke: (sim) => sim.run(30, {}, NONE),
    after: 'armed:no-session',
  },
];

describe('level 2 conditions that pause a running level 2 (item 7)', () => {
  test.each([...PAUSES])('$reason reverts, then $after', (row) => {
    const sim = startedSim(row.options);
    const effects = row.provoke(sim);
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual([row.reason]);
    expect(ofType(effects, 'forget')).toEqual([]);
    expect(label(sim.state)).toBe(row.after);
  });

  test('lease-write-failed: no switch call happened, so it counts a failure and pauses', () => {
    const sim = new Sim();
    sim.enableFailure = 'lease-write-failed';
    const effects = sim.start();
    expect(ofType(effects, 'disable')).toEqual([]);
    expect(label(sim.state)).toBe('paused:lease-write-failed');
    expect(sim.status().failuresToday).toBe(1);
    sim.enableFailure = null;
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.state.name).toBe('on');
  });

  test('a blocking holder notifies once at the first beat, and reverts after the grace', () => {
    const sim = startedSim();
    sim.advance(30);
    const first = sim.beat({ foreign: holders('VideoApp', 'VideoApp') });
    expect(ofType(first, 'notify')).toEqual([
      { type: 'notify', reason: 'foreign-holder', processes: ['VideoApp'] },
    ]);
    const rest = sim.runUntil(notOn, 10 * MIN, { foreign: holders('VideoApp') });
    expect(ofType(rest, 'notify')).toEqual([]);
    expect(sim.disables).toEqual([{ t: 150, reason: 'foreign-holder' }]);
  });

  test('a running level 2 stays on when the lid closes, and password on wake is not rechecked', () => {
    const sim = startedSim();
    sim.run(30 * MIN, { clamshell: 'closed', passwordOnWake: 'off' });
    expect(sim.state.name).toBe('on');
  });
});

describe('level 2 explicit-only ends (item 8)', () => {
  test('stopped: stop while on disables, then disarms', () => {
    const sim = startedSim();
    const effects = sim.send({ type: 'stop' });
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual(['stopped']);
    expect(label(sim.state)).toBe('disarmed:stopped');
  });

  test('stopped: stop while off (paused or armed) disarms with no disable', () => {
    const paused = new Sim();
    paused.beat({ battery: battery(20) });
    const armed = new Sim();
    armed.census(IDLE);
    expect([label(paused.state), label(armed.state)]).toEqual([
      'paused:battery-low',
      'armed:no-work',
    ]);
    for (const sim of [paused, armed]) {
      const effects = sim.send({ type: 'stop' });
      expect(ofType(effects, 'disable')).toEqual([]);
      expect(label(sim.state)).toBe('disarmed:stopped');
    }
  });

  test('flag-cleared-by-other: forget, never disable, and disarm', () => {
    const sim = startedSim();
    sim.flag = 'no';
    sim.advance(30);
    const effects = sim.beat();
    expect(ofType(effects, 'forget')).toEqual([
      { type: 'forget', reason: 'flag-cleared-by-other' },
    ]);
    expect(ofType(effects, 'disable')).toEqual([]);
    expect(label(sim.state)).toBe('disarmed:flag-cleared-by-other');
    expect(sim.status().onTimeLeftToday).toBe(12 * HOUR - 30);
  });

  test.each(['switch-failed', 'revert-not-permitted', 'sudo-refused'] as const)(
    '%s: a switch failure disarms, and is never retried by itself',
    (reason) => {
      const sim = new Sim();
      sim.enableFailure = reason;
      sim.start();
      expect(label(sim.state)).toBe(`disarmed:${reason}`);
      sim.enableFailure = null;
      sim.run(2 * HOUR);
      expect(sim.enables).toHaveLength(1);
      expect(label(sim.state)).toBe(`disarmed:${reason}`);

      const auto = new Sim();
      auto.enableFailure = reason;
      autoOnAttempt(auto);
      expect(label(auto.state)).toBe(`disarmed:${reason}`);
      auto.enableFailure = null;
      auto.run(2 * HOUR);
      expect(auto.enables).toHaveLength(1);
    },
  );

  test('resume-limit, breaker and restart disarm with their reason', () => {
    const limited = new Sim({ settings: { level2_max_resumes_per_day: 1 } });
    autoOn(limited);
    limited.advance(30);
    limited.beat({ thermal: 'heavy' });
    limited.runUntil((s) => s.name !== 'paused', HOUR);
    expect(label(limited.state)).toBe('disarmed:resume-limit');

    const broken = startedSim();
    broken.send({ type: 'heartbeat-failed' });
    broken.send({ type: 'heartbeat-failed' });
    expect(broken.state.name).toBe('paused');
    broken.send({ type: 'heartbeat-failed' });
    expect(label(broken.state)).toBe('disarmed:breaker');

    const restarted = new Sim({ persisted: { ...CAP_FULL, runs: [], cleanExit: false } });
    expect(label(restarted.state)).toBe('disarmed:restart');
  });

  test('only arm or start leaves disarmed; arm from disabled is refused', () => {
    const sim = startedSim();
    sim.send({ type: 'stop' });
    sim.run(HOUR);
    expect(sim.enables).toHaveLength(1);
    expect(sim.state.name).toBe('disarmed');
    sim.send({ type: 'arm' });
    expect(label(sim.state)).toBe('armed');
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables.map((e) => e.origin)).toEqual(['explicit', 'automatic']);

    const off = new Sim({ settings: { level2: false } });
    expect(off.send({ type: 'arm' })).toEqual([
      { type: 'refused', event: 'arm', reason: 'disabled' },
    ]);
    expect(ofType(off.start(), 'refused')).toEqual([
      { type: 'refused', event: 'start', reason: 'disabled' },
    ]);
    off.run(HOUR);
    expect(off.state.name).toBe('disabled');
    expect(off.enables).toEqual([]);
  });

  test('start from disarmed arms and starts at once', () => {
    const sim = new Sim({ leaseFound: true });
    expect(label(sim.state)).toBe('disarmed:restart');
    sim.start();
    expect(sim.state.name).toBe('on');
  });
});

/** An automatic start attempt (the enable may fail). */
function autoOnAttempt(sim: Sim): void {
  sim.beat();
  sim.runUntil((s) => s.name !== 'paused', 30 * MIN);
}

describe('level 2 pause and resume (item 4)', () => {
  test('a battery pause at 30 does not resume at 31, 32 or 34 on battery power', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ battery: battery(30) });
    expect(label(sim.state)).toBe('paused:battery-low');
    for (const percent of [31, 32, 34]) {
      sim.run(15 * MIN, { battery: battery(percent) });
      expect(label(sim.state)).toBe('paused:battery-low');
    }
    expect(sim.enables).toHaveLength(1);
  });

  test('after plugging in it resumes only once the minimum interval has passed', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ battery: battery(30) });
    sim.run(4 * MIN + 30, { battery: battery(31) });
    expect(sim.t).toBe(300);
    // Plugged in at 330: the dwell ends at 450, the interval (from the pause at 30) at 630.
    sim.runUntil((s) => s.name === 'on', HOUR, { battery: ac(31) });
    expect(sim.enables.map((e) => e.t)).toEqual([0, 630]);
    expect(sim.enables[1]?.origin).toBe('automatic');
  });

  test('after plugging in late it resumes only once the dwell has passed', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ battery: battery(30) });
    sim.run(9 * MIN + 30, { battery: battery(31) });
    expect(sim.t).toBe(600);
    sim.runUntil((s) => s.name === 'on', HOUR, { battery: ac(31) });
    // Plugged in at 630, past the interval: the dwell ends at 750.
    expect(sim.enables.map((e) => e.t)).toEqual([0, 750]);
  });

  test('a battery oscillating 29, 31, 29, 31 every beat pauses once and never resumes', () => {
    const sim = startedSim();
    let percent = 31;
    const effects = sim.run(HOUR, () => {
      percent = percent === 29 ? 31 : 29;
      return { battery: battery(percent) };
    });
    expect(ofType(effects, 'disable')).toHaveLength(1);
    expect(sim.enables).toHaveLength(1);
  });

  test('plugging in and out every beat after a pause never resumes (the dwell)', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ battery: battery(29) });
    let plugged = false;
    sim.run(HOUR, () => {
      plugged = !plugged;
      return { battery: plugged ? ac(29) : battery(29) };
    });
    expect(sim.enables).toHaveLength(1);
    expect(sim.state.name).toBe('paused');
  });

  test('a thermal pause at heavy does not resume at moderate, and resumes at nominal after the dwell', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ thermal: 'heavy' });
    expect(label(sim.state)).toBe('paused:thermal');
    sim.run(20 * MIN, { thermal: 'moderate' });
    expect(label(sim.state)).toBe('paused:thermal');
    expect(sim.enables).toHaveLength(1);
    const nominalFrom = sim.t + 30;
    sim.runUntil((s) => s.name === 'on', HOUR, { thermal: 'nominal' });
    expect(sim.enables.map((e) => e.t)).toEqual([0, nominalFrom + 120]);
  });

  test('a foreign holder that comes and goes every 30 s never resumes (the dwell)', () => {
    const sim = startedSim();
    sim.runUntil(notOn, 10 * MIN, { foreign: holders('VideoApp') });
    expect(label(sim.state)).toBe('paused:foreign-holder');
    let present = true;
    sim.run(HOUR, () => {
      present = !present;
      return { foreign: present ? holders('VideoApp') : { kind: 'ok', blocking: [] } };
    });
    expect(sim.enables).toHaveLength(1);
  });

  test('Q13: lid-closed blocks a resume until the lid has been open for the whole dwell', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ battery: battery(20) });
    sim.run(20 * MIN, { battery: ac(), clamshell: 'closed' });
    expect(label(sim.state)).toBe('paused:lid-closed');
    // Open at T, closed again at T + 60, open from T + 90: the dwell restarts.
    const openAt = sim.t + 30;
    sim.run(60, { battery: ac() });
    sim.run(30, { battery: ac(), clamshell: 'closed' });
    expect(label(sim.state)).toBe('paused:lid-closed');
    sim.runUntil((s) => s.name === 'on', HOUR, { battery: ac() });
    expect(sim.enables.map((e) => e.t)).toEqual([0, openAt + 90 + 120]);
  });

  test('a beat gap longer than level2_wake_gap_seconds (a wake from sleep) restarts the dwell', () => {
    const sim = new Sim();
    sim.beat();
    sim.run(60);
    expect(label(sim.state)).toBe('paused:dwell');
    // Asleep for five minutes: the next beat comes 300 s later.
    sim.advance(300);
    sim.beat();
    expect(label(sim.state)).toBe('paused:dwell');
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables.map((e) => e.t)).toEqual([360 + 120]);
  });

  test('a wall-clock gap alone (the monotonic clock stood still in sleep) also restarts it', () => {
    const sim = new Sim();
    sim.beat();
    sim.run(60);
    sim.wallShift += 270;
    sim.advance(30);
    sim.beat();
    expect(label(sim.state)).toBe('paused:dwell');
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables.map((e) => e.t)).toEqual([90 + 120]);
  });

  test('the automatic start past level2_max_resumes_per_day in the window disarms with resume-limit', () => {
    const sim = new Sim();
    autoOn(sim);
    for (let cycle = 0; cycle < 12; cycle += 1) {
      sim.advance(30);
      sim.beat({ thermal: 'heavy' });
      expect(label(sim.state)).toBe('paused:thermal');
      sim.runUntil((s) => s.name !== 'paused', HOUR);
    }
    expect(sim.enables).toHaveLength(12);
    expect(label(sim.state)).toBe('disarmed:resume-limit');
    expect(sim.status().resumesLeftToday).toBe(0);
  });

  test('level2_max_resumes_per_day = 0 never turns on by itself; an explicit start still does', () => {
    const sim = new Sim({ settings: { level2_max_resumes_per_day: 0 } });
    sim.beat();
    sim.run(HOUR);
    expect(sim.enables).toEqual([]);
    expect(label(sim.state)).toBe('disarmed:resume-limit');
    sim.start();
    expect(sim.state.name).toBe('on');
  });

  test('a run reaching level2_default_hours pauses with run-limit and resumes after the minimum interval', () => {
    const sim = new Sim();
    autoOn(sim);
    expect(sim.enables[0]?.t).toBe(120);
    sim.runUntil(notOn, 4 * HOUR);
    expect(sim.disables).toEqual([{ t: 120 + 3 * HOUR, reason: 'run-limit' }]);
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables.map((e) => e.t)).toEqual([120, 120 + 3 * HOUR + 600]);
  });

  test('on-time reaching level2_cap_hours in the window pauses with daily-cap until enough is free', () => {
    const sim = new Sim({
      settings: { level2_default_hours: 3, level2_cap_hours: 4, level2_window_hours: 8 },
    });
    autoOn(sim);
    sim.runUntil(notOn, 4 * HOUR);
    sim.runUntil((s) => s.name === 'on', HOUR);
    // The second run is cut to the hour left under the cap.
    expect(sim.enables[1]).toMatchObject({ t: 11_520, cutByCap: true });
    expect(sim.enables[1]?.runEndWall).toBe(W0 + 11_520 + HOUR);
    sim.runUntil(notOn, 2 * HOUR);
    expect(sim.disables.map((d) => d.reason)).toEqual(['run-limit', 'daily-cap']);
    expect(sim.t).toBe(15_120);
    // The first run (120 to 10920) slides out of the 8-hour window: 10 minutes
    // are free at 29520, and the dwell restarts there.
    sim.runUntil((s) => s.reason !== 'daily-cap', 10 * HOUR);
    expect(sim.t).toBe(29_520);
    expect(label(sim.state)).toBe('paused:dwell');
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables.map((e) => e.t)).toEqual([120, 11_520, 29_640]);
  });

  test('idle returns to armed, and the next work episode turns it on again', () => {
    const sim = new Sim();
    autoOn(sim);
    sim.runUntil(notOn, 2 * HOUR, {}, IDLE);
    expect(sim.disables).toEqual([{ t: 150 + 30 * MIN, reason: 'idle' }]);
    expect(label(sim.state)).toBe('armed:no-work');
    sim.advance(30);
    sim.census(IDLE);
    expect(label(sim.state)).toBe('armed:no-work');
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables).toHaveLength(2);
  });
});

describe('level 2 failures and the person (item 5)', () => {
  test('disable-failed re-emits disable on every beat, and the breaker waits for the revert', () => {
    const sim = startedSim();
    sim.disableFails = true;
    sim.advance(30);
    sim.beat({ battery: battery(20) });
    expect(sim.state.name).toBe('reverting');
    sim.run(2 * MIN, { battery: battery(20) });
    expect(sim.disables.map((d) => d.t)).toEqual([30, 60, 90, 120, 150]);
    expect(sim.state.name).toBe('reverting');
    expect(sim.state.target).toEqual({ name: 'disarmed', reason: 'breaker' });
    sim.disableFails = false;
    sim.run(30);
    expect(label(sim.state)).toBe('disarmed:breaker');
    sim.run(HOUR);
    expect(sim.enables).toHaveLength(1);
  });

  test('level2_breaker_failures failures in the window disarm with breaker', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ sleepDisabled: 'unknown' });
    expect(label(sim.state)).toBe('paused:flag-unknown');
    sim.runUntil((s) => s.name === 'on', HOUR);
    sim.advance(30);
    sim.beat({ watchdog: 'mismatch' });
    expect(label(sim.state)).toBe('paused:watchdog-mismatch');
    sim.runUntil((s) => s.name === 'on', HOUR);
    sim.send({ type: 'heartbeat-failed' });
    expect(label(sim.state)).toBe('disarmed:breaker');
    expect(sim.disables.map((d) => d.reason)).toEqual([
      'flag-unknown',
      'watchdog-mismatch',
      'heartbeat-failed',
    ]);
  });

  test('a watchdog that is only missing, not mismatched, is not a breaker failure', () => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ watchdog: 'missing' });
    expect(sim.status().failuresToday).toBe(0);
  });

  test('stop while on disables, disarms, and nothing turns it on until arm', () => {
    const sim = new Sim();
    autoOn(sim);
    sim.send({ type: 'stop' });
    expect(sim.disables).toEqual([{ t: 120, reason: 'stopped' }]);
    expect(label(sim.state)).toBe('disarmed:stopped');
    sim.run(3 * HOUR);
    expect(sim.enables).toHaveLength(1);
    sim.send({ type: 'arm' });
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables).toHaveLength(2);
  });

  test('arm clears the failure and resume counters', () => {
    const sim = new Sim();
    autoOn(sim);
    for (let i = 0; i < 3; i += 1) {
      sim.send({ type: 'heartbeat-failed' });
      if (i < 2) sim.runUntil((s) => s.name === 'on', HOUR);
    }
    expect(label(sim.state)).toBe('disarmed:breaker');
    expect(sim.status()).toMatchObject({ failuresToday: 3, resumesLeftToday: 9 });
    const effects = sim.send({ type: 'arm' });
    expect(sim.status()).toMatchObject({ failuresToday: 0, resumesLeftToday: 12 });
    expect(ofType(effects, 'persist')[0]?.value).toMatchObject({
      armed: true,
      failures: [],
      resumes: [],
    });
  });

  test('every transition emits persist, with the new value', () => {
    const sim = new Sim();
    const seen: string[] = [];
    const record = (effects: readonly Level2Effect[]) => {
      for (const p of ofType(effects, 'persist')) {
        seen.push(`${p.value.armed ? 'armed' : `disarmed:${p.value.disarmReason}`}`);
      }
    };
    record(sim.beat());
    record(sim.run(2 * MIN));
    record(sim.send({ type: 'stop' }));
    record(sim.send({ type: 'arm' }));
    record(sim.send({ type: 'hub-exit' }));
    expect(seen).toEqual([
      'armed', // armed -> paused (dwell)
      'armed', // paused -> starting (a resume recorded)
      'armed', // starting -> on
      'disarmed:stopped', // on -> reverting toward disarmed
      'disarmed:stopped', // reverting -> disarmed (the run recorded)
      'armed', // disarmed -> armed
      'armed', // the clean exit
    ]);
  });

  test('a counter recorded in the future does not expire early when the clock steps back', () => {
    const sim = new Sim({ settings: { level2_max_resumes_per_day: 1 } });
    autoOn(sim);
    sim.advance(30);
    sim.beat({ thermal: 'heavy' });
    // The wall clock steps back two hours: the resume now lies in the future.
    sim.wallShift = -2 * HOUR;
    expect(sim.status().resumesLeftToday).toBe(0);
    sim.runUntil((s) => s.name !== 'paused', HOUR);
    expect(label(sim.state)).toBe('disarmed:resume-limit');
    sim.advance(22 * HOUR);
    expect(sim.status().resumesLeftToday).toBe(0);
  });

  test('a crash while on keeps the run so far: the next hub counts it under the cap', () => {
    const sim = startedSim();
    const persists = ofType(sim.run(HOUR), 'persist');
    // The run in progress is persisted at every beat.
    expect(persists).toHaveLength(HOUR / 30);
    const persisted = level2Persisted(sim.state);
    expect(persisted).toMatchObject({ cleanExit: false, runs: [[W0, W0 + HOUR]] });

    const next = new Sim({ persisted });
    next.t = sim.t;
    expect(label(next.state)).toBe('disarmed:restart');
    next.send({ type: 'arm' });
    expect(next.status().onTimeLeftToday).toBe(11 * HOUR);
  });

  test('a clean hub exit keeps the resume counter for the next hub', () => {
    const sim = new Sim({ settings: { level2_max_resumes_per_day: 1 } });
    autoOn(sim);
    sim.send({ type: 'hub-exit' });
    const persisted = level2Persisted(sim.state);
    expect(persisted).toMatchObject({ armed: true, cleanExit: true, resumes: [W0 + 120] });

    const next = new Sim({ settings: { level2_max_resumes_per_day: 1 }, persisted });
    next.t = sim.t;
    expect(label(next.state)).toBe('armed');
    expect(next.status().resumesLeftToday).toBe(0);
    next.beat();
    next.runUntil((s) => s.name !== 'paused', HOUR);
    expect(label(next.state)).toBe('disarmed:resume-limit');
    expect(next.enables).toEqual([]);
  });

  test('hub-exit while on reverts first and records the clean exit only after the revert', () => {
    const sim = startedSim();
    const effects = sim.send({ type: 'hub-exit' });
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual(['hub-exit']);
    expect(level2Persisted(sim.state).cleanExit).toBe(true);
    sim.run(HOUR);
    expect(sim.enables).toHaveLength(1);

    const failing = startedSim();
    failing.disableFails = true;
    failing.send({ type: 'hub-exit' });
    expect(failing.state.name).toBe('reverting');
    expect(level2Persisted(failing.state).cleanExit).toBe(false);
  });

  test('hub-exit while off records a clean exit and changes nothing else', () => {
    const sim = new Sim();
    sim.beat({ battery: battery(20) });
    const effects = sim.send({ type: 'hub-exit' });
    expect(label(sim.state)).toBe('paused:battery-low');
    expect(ofType(effects, 'persist')[0]?.value.cleanExit).toBe(true);
    sim.run(HOUR);
    expect(sim.enables).toEqual([]);
  });
});

describe('level 2 extend, start hours and status (items 8 and 10)', () => {
  test('extend moves the run end later, never past the on-time left under the cap', () => {
    const sim = startedSim();
    sim.advance(HOUR);
    sim.beat();
    const later = sim.send({ type: 'extend', hours: 2 });
    expect(ofType(later, 'extended')).toEqual([
      { type: 'extended', runEnd: 5 * HOUR * 1000, runEndWall: W0 + 5 * HOUR, cutByCap: false },
    ]);
    const capped = sim.send({ type: 'extend', hours: 20 });
    expect(ofType(capped, 'extended')).toEqual([
      { type: 'extended', runEnd: 12 * HOUR * 1000, runEndWall: W0 + 12 * HOUR, cutByCap: true },
    ]);
    expect(sim.status()).toMatchObject({ runEnd: W0 + 12 * HOUR, runEndCutByCap: true });
    sim.runUntil(notOn, 12 * HOUR);
    expect(sim.disables).toEqual([{ t: 12 * HOUR, reason: 'daily-cap' }]);
  });

  test('hours that are not a positive number are refused with hours-invalid', () => {
    const sim = startedSim();
    for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sim.send({ type: 'extend', hours })).toEqual([
        { type: 'refused', event: 'extend', reason: 'hours-invalid' },
      ]);
    }
    const fresh = new Sim();
    expect(ofType(fresh.start({}, WORK, 0), 'refused')).toEqual([
      { type: 'refused', event: 'start', reason: 'hours-invalid' },
    ]);
    expect(fresh.state.name).toBe('armed');
    expect(fresh.send({ type: 'extend', hours: 1 })).toEqual([
      { type: 'refused', event: 'extend', reason: 'not-on' },
    ]);
  });

  test('an explicit start with hours sets the run, also beyond level2_default_hours', () => {
    const sim = new Sim();
    sim.start({}, WORK, 5);
    expect(sim.enables[0]).toMatchObject({ runEndWall: W0 + 5 * HOUR, cutByCap: false });
    expect(sim.start()).toEqual([{ type: 'refused', event: 'start', reason: 'already-on' }]);
  });

  test('status: on, with its origin, end, on-time and resumes left', () => {
    const sim = new Sim();
    autoOn(sim);
    sim.advance(HOUR);
    sim.beat();
    expect(sim.status()).toEqual({
      state: 'on',
      reason: null,
      origin: 'automatic',
      runEnd: W0 + 120 + 3 * HOUR,
      runEndCutByCap: false,
      onTimeLeftToday: 11 * HOUR,
      resumesLeftToday: 11,
      failuresToday: 0,
      waitingFor: null,
    });
  });

  test('status: waitingFor names what a paused or armed level 2 needs', () => {
    const sim = new Sim();
    sim.beat({ battery: battery(20) });
    expect(sim.status().waitingFor).toBe('battery at 35 percent or AC power');
    sim.advance(30);
    sim.beat({ clamshell: 'closed' });
    expect(sim.status().waitingFor).toBe('lid open');
    sim.advance(30);
    sim.beat();
    expect(sim.status().waitingFor).toBe('2 minutes without a blocking condition');
    sim.advance(30);
    sim.beat({ foreign: holders('VideoApp') });
    expect(sim.status().waitingFor).toBe('no other app holding the Mac awake (now: VideoApp)');
    sim.advance(30);
    sim.census(IDLE);
    expect(sim.status()).toMatchObject({ state: 'armed', waitingFor: 'real work in a session' });
    sim.send({ type: 'stop' });
    expect(sim.status().waitingFor).toBe('a person to run remi keep-awake arm or start');
  });
});

/** The observable decision a row's scenario ends in. */
type Scenario = (sim: Sim) => string | number;

interface KeyRow {
  readonly key: keyof Level2Settings;
  readonly base?: Partial<Level2Settings>;
  readonly persisted?: Level2Persisted;
  readonly value: Level2Settings[keyof Level2Settings];
  readonly scenario: Scenario;
  readonly byDefault: string | number;
  readonly changed: string | number;
  /** Leave the switch's answers pending (see `SimOptions.holdAcks`). */
  readonly hold?: boolean;
}

/** Started with the switch's answer held, then a beat `seconds` later. */
const enableTimeoutAfter =
  (seconds: number): Scenario =>
  (sim) => {
    sim.start();
    sim.advance(seconds);
    sim.beat();
    return label(sim.state);
  };

const KEY_ROWS: readonly KeyRow[] = [
  {
    key: 'level2_start_battery_percent',
    value: 33,
    scenario: (sim) => {
      sim.start({ battery: battery(34) });
      return label(sim.state);
    },
    byDefault: 'paused:battery-low',
    changed: 'on',
  },
  {
    key: 'level2_revert_battery_percent',
    value: 32,
    scenario: (sim) => {
      sim.start();
      sim.run(30, { battery: battery(31) });
      return label(sim.state);
    },
    byDefault: 'on',
    changed: 'paused:battery-low',
  },
  {
    key: 'level2_min_remaining_minutes',
    value: 10,
    scenario: (sim) => {
      sim.start({ battery: battery(80, 15) });
      return label(sim.state);
    },
    byDefault: 'paused:battery-time-low',
    changed: 'on',
  },
  {
    key: 'level2_min_remaining_minutes',
    value: 0,
    scenario: (sim) => {
      sim.start({ battery: battery(80, 0) });
      return label(sim.state);
    },
    byDefault: 'paused:battery-time-low',
    changed: 'on',
  },
  {
    key: 'level2_default_hours',
    value: 0.5,
    scenario: (sim) => {
      sim.start();
      sim.run(30 * MIN);
      return label(sim.state);
    },
    byDefault: 'on',
    changed: 'paused:run-limit',
  },
  {
    key: 'level2_cap_hours',
    value: 1,
    scenario: (sim) => {
      sim.start();
      return `${(sim.enables[0]?.runEndWall ?? 0) - W0} ${sim.enables[0]?.cutByCap}`;
    },
    byDefault: `${3 * HOUR} false`,
    changed: `${HOUR} true`,
  },
  {
    key: 'level2_window_hours',
    value: 6,
    base: { level2_max_resumes_per_day: 1, level2_resume_dwell_seconds: 0 },
    persisted: {
      armed: true,
      disarmReason: null,
      cleanExit: true,
      resumes: [W0 - 7 * HOUR],
      failures: [],
      runs: [],
    },
    scenario: (sim) => {
      sim.beat();
      return label(sim.state);
    },
    byDefault: 'disarmed:resume-limit',
    changed: 'on',
  },
  {
    key: 'level2_idle_revert_minutes',
    value: 15,
    scenario: (sim) => {
      sim.start();
      sim.run(20 * MIN, {}, IDLE);
      return label(sim.state);
    },
    byDefault: 'on',
    changed: 'armed:no-work',
  },
  {
    key: 'thermal_moderate_revert_minutes',
    value: 3,
    scenario: (sim) => {
      sim.start();
      sim.runUntil(notOn, 4 * MIN, { thermal: 'moderate' });
      return label(sim.state);
    },
    byDefault: 'on',
    changed: 'paused:thermal-moderate-held',
  },
  {
    key: 'heartbeat_seconds',
    value: 10,
    scenario: (sim) => {
      sim.start();
      return (sim.nextDeadline ?? 0) - sim.t * 1000;
    },
    byDefault: 30_000,
    changed: 10_000,
  },
  {
    key: 'foreign_holder_revert_minutes',
    value: 1,
    scenario: (sim) => {
      sim.start();
      sim.run(90, { foreign: holders('VideoApp') });
      return label(sim.state);
    },
    byDefault: 'on',
    changed: 'paused:foreign-holder',
  },
  {
    key: 'level2_resume_dwell_seconds',
    value: 60,
    scenario: (sim) => {
      sim.beat();
      sim.run(60);
      return label(sim.state);
    },
    byDefault: 'paused:dwell',
    changed: 'on',
  },
  {
    key: 'level2_resume_dwell_seconds',
    value: 0,
    scenario: (sim) => {
      sim.beat();
      return label(sim.state);
    },
    byDefault: 'paused:dwell',
    changed: 'on',
  },
  {
    key: 'level2_resume_min_interval_minutes',
    value: 4,
    scenario: (sim) => {
      sim.start();
      sim.run(30, { battery: battery(20) });
      sim.run(5 * MIN, { battery: ac() });
      return label(sim.state);
    },
    byDefault: 'paused:resume-interval',
    changed: 'on',
  },
  {
    key: 'level2_max_resumes_per_day',
    value: 1,
    base: { level2_resume_dwell_seconds: 0 },
    scenario: (sim) => {
      sim.beat();
      sim.run(30, { thermal: 'heavy' });
      sim.runUntil((s) => s.name !== 'paused', HOUR);
      return label(sim.state);
    },
    byDefault: 'on',
    changed: 'disarmed:resume-limit',
  },
  {
    key: 'level2_breaker_failures',
    value: 2,
    scenario: (sim) => {
      sim.send({ type: 'heartbeat-failed' });
      sim.send({ type: 'heartbeat-failed' });
      return label(sim.state);
    },
    byDefault: 'armed',
    changed: 'disarmed:breaker',
  },
  {
    key: 'level2_wake_gap_seconds',
    value: 600,
    scenario: (sim) => {
      sim.beat();
      sim.advance(5 * MIN);
      sim.beat();
      return label(sim.state);
    },
    byDefault: 'paused:dwell',
    changed: 'on',
  },
  {
    key: 'clock_skew_tolerance_seconds',
    value: 0,
    base: { level2_max_resumes_per_day: 1, level2_resume_dwell_seconds: 0 },
    // A resume recorded 30 s ahead of this hub's clock.
    persisted: {
      armed: true,
      disarmReason: null,
      cleanExit: true,
      resumes: [W0 + 30],
      failures: [],
      runs: [],
    },
    scenario: (sim) => {
      sim.advance(24 * HOUR + 10);
      sim.beat();
      return label(sim.state);
    },
    byDefault: 'disarmed:resume-limit',
    changed: 'on',
  },
  {
    key: 'thermal_refuse_level',
    value: 'heavy',
    scenario: (sim) => {
      sim.start({ thermal: 'moderate' });
      return label(sim.state);
    },
    byDefault: 'paused:thermal',
    changed: 'on',
  },
  {
    key: 'thermal_revert_level',
    value: 'trapping',
    scenario: (sim) => {
      sim.start();
      sim.run(30, { thermal: 'heavy' });
      return label(sim.state);
    },
    byDefault: 'paused:thermal',
    changed: 'on',
  },
  {
    key: 'require_password_on_wake',
    value: false,
    scenario: (sim) => {
      sim.start({ passwordOnWake: 'off' });
      return label(sim.state);
    },
    byDefault: 'paused:password-on-wake-off',
    changed: 'on',
  },
  {
    key: 'foreign_holder_ignore',
    value: ['ChatApp'],
    scenario: (sim) => {
      const classified = classifyForeignHolders(
        [
          {
            pid: 900,
            process: 'ChatApp',
            type: 'NoIdleSleepAssertion',
            name: 'Electron',
            createdForPid: null,
          },
        ],
        [4242],
        sim.settings.foreign_holder_ignore,
      );
      sim.start({ foreign: { kind: 'ok', blocking: classified.blocking } });
      return label(sim.state);
    },
    byDefault: 'paused:foreign-holder',
    changed: 'on',
  },
  {
    key: 'level2',
    value: false,
    scenario: (sim) => {
      sim.start();
      return label(sim.state);
    },
    byDefault: 'on',
    changed: 'disabled',
  },
  {
    // No answer to an `enable` within switch_deadline_ms + switch_sync_deadline_ms
    // (5000 + 3000 by default) reverts with enable-timeout.
    key: 'switch_deadline_ms',
    value: 1000,
    hold: true,
    scenario: enableTimeoutAfter(7),
    byDefault: 'starting',
    changed: 'reverting:enable-timeout',
  },
  {
    key: 'switch_sync_deadline_ms',
    value: 1000,
    hold: true,
    scenario: enableTimeoutAfter(7),
    byDefault: 'starting',
    changed: 'reverting:enable-timeout',
  },
  {
    // A run's end stays representable: 12 lease digits end it at 999999999999.
    // (The validator would refuse these hours with 12 digits; the reducer clamps
    // whatever it is given.)
    key: 'lease_integer_max_digits',
    value: 12,
    base: { level2_default_hours: 3e8, level2_cap_hours: 3e8 },
    scenario: (sim) => {
      sim.start();
      return sim.enables[0]?.runEndWall ?? 0;
    },
    byDefault: W0 + 3e8 * HOUR,
    changed: 999_999_999_999,
  },
];

describe('level 2 per-key decisions (acceptance 1)', () => {
  test.each(KEY_ROWS.map((row) => [`${row.key} = ${JSON.stringify(row.value)}`, row] as const))(
    '%s changes the decision it governs',
    (_name, row) => {
      const byDefault = new Sim({
        settings: row.base ?? {},
        persisted: row.persisted ?? null,
        holdAcks: row.hold ?? false,
      });
      expect(row.scenario(byDefault)).toBe(row.byDefault);
      const changed = new Sim({
        settings: { ...row.base, [row.key]: row.value },
        persisted: row.persisted ?? null,
        holdAcks: row.hold ?? false,
      });
      expect(row.scenario(changed)).toBe(row.changed);
    },
  );

  test('every numeric key the reducer reads has a row', () => {
    // Derived, not typed by hand: the numeric keys of the settings table whose
    // name appears in the reducer's code (comments removed).
    const source = readFileSync(
      fileURLToPath(new URL('../../src/power/level2-policy.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const read = LEVEL2_NUMERIC_KEYS.filter((key) => new RegExp(`\\b${key}\\b`).test(source));
    expect(read.length).toBeGreaterThan(15);
    const covered = new Set(KEY_ROWS.map((row) => row.key));
    expect(read.filter((key) => !covered.has(key))).toEqual([]);
  });

  test('nextDeadline is never more than one heartbeat away while level 2 needs beats', () => {
    const sim = new Sim({ settings: { level2_default_hours: 1000, level2_cap_hours: 2000 } });
    sim.start();
    expect(sim.nextDeadline).toBe(30_000);
    expect(new Sim({ leaseFound: true }).state.name).toBe('disarmed');
  });
});

describe('level 2 monotonic clock', () => {
  test('a time earlier than the last observed one is clamped, so a run cannot be shortened', () => {
    const sim = startedSim();
    sim.advance(HOUR);
    sim.beat();
    const result = stepLevel2Policy(
      sim.settings,
      sim.state,
      { type: 'beat', readings: sim.readings(), sessions: WORK, wallNow: sim.wall() },
      0,
    );
    expect(result.state.lastObservedAt).toBe(HOUR * 1000);
    expect(result.state.name).toBe('on');
  });
});

describe('level 2 thermal lookups ignore inherited names (C3)', () => {
  const inherited: string[] = ['constructor', 'toString'];

  test.each(inherited)('a %s reading blocks an automatic start as thermal-unknown', (name) => {
    const sim = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    sim.beat({ thermal: name as never });
    expect(label(sim.state)).toBe('paused:thermal-unknown');
  });

  test.each(inherited)('a %s reading while on pauses with thermal-unknown', (name) => {
    const sim = startedSim();
    sim.advance(30);
    sim.beat({ thermal: name as never });
    expect(sim.disables.map((d) => d.reason)).toEqual(['thermal-unknown']);
  });

  test.each(inherited)(
    'a %s reading during a held moderate level pauses with thermal-unknown',
    (name) => {
      const sim = startedSim();
      sim.run(4 * MIN, { thermal: 'moderate' });
      expect(sim.state.name).toBe('on');
      sim.advance(30);
      sim.beat({ thermal: name as never });
      expect(sim.disables.map((d) => d.reason)).toEqual(['thermal-unknown']);
    },
  );

  test('a thermal setting that skipped validation counts as moderate, the strictest', () => {
    const refuse = new Sim({ settings: { thermal_refuse_level: 'constructor' as never } });
    refuse.start({ thermal: 'moderate' });
    expect(label(refuse.state)).toBe('paused:thermal');
    const revert = startedSim({ settings: { thermal_revert_level: 'toString' as never } });
    revert.advance(30);
    revert.beat({ thermal: 'moderate' });
    expect(revert.disables.map((d) => d.reason)).toEqual(['thermal']);
  });
});

describe('level 2 after a moderate-held pause (C5)', () => {
  test('it waits for the level to drop below moderate, whatever the refuse level', () => {
    const sim = startedSim({
      settings: { thermal_refuse_level: 'heavy', thermal_revert_level: 'heavy' },
    });
    sim.runUntil(notOn, 10 * MIN, { thermal: 'moderate' });
    expect(sim.disables.map((d) => d.reason)).toEqual(['thermal-moderate-held']);
    sim.run(2 * HOUR, { thermal: 'moderate' });
    expect(sim.enables).toHaveLength(1);
    expect(label(sim.state)).toBe('paused:thermal');
    expect(sim.status().waitingFor).toBe('thermal pressure below moderate');
    const nominalFrom = sim.t + 30;
    sim.runUntil((s) => s.name === 'on', HOUR, { thermal: 'nominal' });
    expect(sim.enables.map((e) => e.t)).toEqual([0, nominalFrom + 120]);
  });

  test('after any other pause, waitingFor names the refuse level', () => {
    const sim = startedSim({ settings: { thermal_refuse_level: 'heavy' } });
    sim.advance(30);
    sim.beat({ thermal: 'heavy' });
    expect(sim.status().waitingFor).toBe('thermal pressure below heavy');
  });
});

describe('level 2 starting is bounded (F1)', () => {
  test('no answer to an enable within the two switch deadlines reverts with enable-timeout', () => {
    const sim = new Sim({ holdAcks: true });
    sim.start();
    expect(sim.state.name).toBe('starting');
    // The deadline is the enable plus 5000 + 3000 ms.
    expect(sim.nextDeadline).toBe(8000);
    sim.advance(8);
    const effects = sim.beat();
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual(['enable-timeout']);
    expect(label(sim.state)).toBe('reverting:enable-timeout');
    expect(sim.status().failuresToday).toBe(1);
    sim.ackDisabled();
    expect(label(sim.state)).toBe('paused:enable-timeout');
  });

  test('a beat before the deadline leaves it starting', () => {
    const sim = new Sim({ holdAcks: true });
    sim.start();
    sim.advance(7);
    const effects = sim.beat();
    expect(ofType(effects, 'disable')).toEqual([]);
    expect(sim.state.name).toBe('starting');
  });

  test('a census while starting also reverts after the deadline', () => {
    const sim = new Sim({ holdAcks: true });
    sim.start();
    sim.advance(30);
    sim.census(WORK);
    expect(label(sim.state)).toBe('reverting:enable-timeout');
  });

  test('a beat while starting checks the flag and the run end too', () => {
    const flag = new Sim({ holdAcks: true });
    flag.start();
    flag.advance(1);
    flag.beat({ sleepDisabled: 'unknown' });
    expect(label(flag.state)).toBe('reverting:flag-unknown');
    expect(flag.status().failuresToday).toBe(1);

    const ended = new Sim({ holdAcks: true, settings: { switch_deadline_ms: 100_000 } });
    ended.start({}, WORK, 1 / 360);
    ended.advance(10);
    ended.beat();
    expect(label(ended.state)).toBe('reverting:run-limit');
  });

  test('an enabled that arrives after the timeout still counts the on-time', () => {
    const sim = new Sim({ holdAcks: true });
    sim.start();
    sim.advance(30);
    sim.beat();
    sim.advance(5);
    sim.ackEnabled();
    expect(sim.state.name).toBe('reverting');
    sim.advance(25);
    sim.ackDisabled();
    expect(sim.status().onTimeLeftToday).toBe(12 * HOUR - 25);
  });
});

describe('level 2 run ends stay representable (F2)', () => {
  test('an enable never sets an end past what a Date holds', () => {
    const sim = new Sim({ settings: { level2_default_hours: 3e9, level2_cap_hours: 3e9 } });
    sim.start();
    expect(sim.enables[0]?.runEndWall).toBe(DATE_MAX_EPOCH_SECONDS);
    expect(Number.isNaN(new Date(DATE_MAX_EPOCH_SECONDS * 1000).getTime())).toBe(false);
  });

  test('an extend never moves the end past what a Date holds', () => {
    const sim = startedSim({ settings: { level2_cap_hours: 3e9 } });
    const effects = sim.send({ type: 'extend', hours: 3e9 });
    expect(ofType(effects, 'extended')[0]?.runEndWall).toBe(DATE_MAX_EPOCH_SECONDS);
  });
});

describe('level 2 failure list (F4)', () => {
  test('a revert that keeps failing stores at most level2_breaker_failures failures', () => {
    const sim = startedSim();
    sim.disableFails = true;
    sim.advance(30);
    sim.beat({ battery: battery(20) });
    const effects = sim.run(HOUR, { battery: battery(20) });
    const sizes = ofType(effects, 'persist').map((p) => p.value.failures.length);
    // Each beat and its failed disable persist: the list stays at three entries.
    expect(sizes.length).toBeGreaterThanOrEqual(HOUR / 30);
    expect(Math.max(...sizes)).toBe(3);
    expect(sim.state.failures).toHaveLength(3);
    expect(sim.state.target).toEqual({ name: 'disarmed', reason: 'breaker' });
  });
});

describe('level 2 nextDeadline lands on each rule (V2)', () => {
  // A long heartbeat and wake gap, so the next deadline is the rule's own.
  const slow = { heartbeat_seconds: 100_000, level2_wake_gap_seconds: 200_000 };
  const jump = (sim: Sim) => {
    expect(sim.nextDeadline).not.toBeNull();
    sim.t = (sim.nextDeadline ?? 0) / 1000;
  };

  test('the dwell end', () => {
    const sim = new Sim({ settings: slow });
    sim.beat();
    expect(sim.nextDeadline).toBe(120_000);
    jump(sim);
    sim.beat();
    expect(sim.state.name).toBe('on');
  });

  test('the end of the minimum interval', () => {
    const sim = startedSim({ settings: { ...slow, level2_resume_dwell_seconds: 0 } });
    sim.advance(30);
    sim.beat({ battery: battery(20) });
    sim.advance(30);
    sim.beat({ battery: ac() });
    expect(label(sim.state)).toBe('paused:resume-interval');
    expect(sim.nextDeadline).toBe(630_000);
    jump(sim);
    sim.beat({ battery: ac() });
    expect(sim.state.name).toBe('on');
  });

  test('the run end', () => {
    const sim = new Sim({ settings: slow });
    sim.start({}, WORK, 0.5);
    expect(sim.nextDeadline).toBe(1_800_000);
    jump(sim);
    sim.beat();
    expect(sim.disables.map((d) => d.reason)).toEqual(['run-limit']);
  });

  test('the idle end', () => {
    const sim = new Sim({ settings: slow });
    sim.start({}, IDLE);
    expect(sim.nextDeadline).toBe(30 * MIN * 1000);
    jump(sim);
    sim.beat({}, IDLE);
    expect(sim.disables.map((d) => d.reason)).toEqual(['idle']);
  });

  test('the end of a held moderate level', () => {
    const sim = startedSim({ settings: slow });
    sim.advance(10);
    sim.beat({ thermal: 'moderate' });
    expect(sim.nextDeadline).toBe((10 + 5 * MIN) * 1000);
    jump(sim);
    sim.beat({ thermal: 'moderate' });
    expect(sim.disables.map((d) => d.reason)).toEqual(['thermal-moderate-held']);
  });

  test('the end of the foreign-holder grace', () => {
    const sim = startedSim({ settings: slow });
    sim.advance(10);
    sim.beat({ foreign: holders('VideoApp') });
    expect(sim.nextDeadline).toBe((10 + 2 * MIN) * 1000);
    jump(sim);
    sim.beat({ foreign: holders('VideoApp') });
    expect(sim.disables.map((d) => d.reason)).toEqual(['foreign-holder']);
  });
});

describe('level 2 window counters after a backward clock step (V3)', () => {
  test('a failure from before the step plus one more trips a breaker of 2, and both expire one window after the step', () => {
    const sim = new Sim({ settings: { level2_breaker_failures: 2 } });
    sim.send({ type: 'heartbeat-failed' });
    expect(label(sim.state)).toBe('armed');
    sim.wallShift = -2 * HOUR;
    sim.advance(60);
    sim.census(IDLE);
    sim.send({ type: 'heartbeat-failed' });
    expect(label(sim.state)).toBe('disarmed:breaker');
    // The step happened at monotonic 60 s: one window later both are gone.
    sim.t = 60 + 24 * HOUR - 30;
    expect(sim.status().failuresToday).toBe(2);
    sim.t = 60 + 24 * HOUR + 30;
    expect(sim.status().failuresToday).toBe(0);
  });

  test('a run that now lies in the future still counts against level2_cap_hours', () => {
    const sim = startedSim({ settings: { level2_cap_hours: 3, level2_default_hours: 3 } });
    sim.run(2 * HOUR - 30);
    sim.advance(30);
    sim.send({ type: 'stop' });
    sim.send({ type: 'arm' });
    // The clock steps back past the whole run.
    sim.wallShift = -(2 * HOUR + 600);
    sim.advance(30);
    sim.census(IDLE);
    sim.start();
    expect(sim.enables[1]).toMatchObject({ cutByCap: true });
    expect(sim.enables[1]?.runEndWall).toBe(sim.wall() + HOUR);
  });

  test('level2Status counts on-time and resumes in level2_window_hours', () => {
    const persisted: Level2Persisted = {
      armed: true,
      disarmReason: null,
      cleanExit: true,
      resumes: [W0 - 5 * HOUR],
      failures: [],
      runs: [[W0 - 5 * HOUR, W0 - 4.5 * HOUR]],
    };
    const sim = new Sim({ settings: { level2_window_hours: 6 }, persisted });
    expect(sim.status()).toMatchObject({ onTimeLeftToday: 11.5 * HOUR, resumesLeftToday: 11 });
    // Two hours later both lie outside the six-hour window.
    sim.t = 2 * HOUR;
    expect(sim.status()).toMatchObject({ onTimeLeftToday: 12 * HOUR, resumesLeftToday: 12 });
  });
});

describe('level 2 battery boundaries (V4)', () => {
  const variants = [
    { name: 'defaults', settings: {} },
    {
      name: 'non-default values',
      settings: {
        level2_start_battery_percent: 50,
        level2_revert_battery_percent: 40,
        level2_min_remaining_minutes: 45,
      },
    },
  ];

  test.each(variants)(
    '$name: exactly at the start percent and the remaining minutes it starts',
    ({ settings }) => {
      const s = settingsWith(settings);
      const atPercent = new Sim({ settings });
      atPercent.start({ battery: battery(s.level2_start_battery_percent) });
      expect(atPercent.state.name).toBe('on');
      const atMinutes = new Sim({ settings });
      atMinutes.start({ battery: battery(80, s.level2_min_remaining_minutes) });
      expect(atMinutes.state.name).toBe('on');
    },
  );

  test.each(variants)(
    '$name: running, it stays on at the remaining minutes and one above the revert percent',
    ({ settings }) => {
      const s = settingsWith(settings);
      const sim = startedSim({ settings });
      sim.run(30, { battery: battery(80, s.level2_min_remaining_minutes) });
      sim.run(30, { battery: battery(s.level2_revert_battery_percent + 1) });
      expect(sim.state.name).toBe('on');
      sim.run(30, { battery: battery(s.level2_revert_battery_percent) });
      expect(sim.disables.map((d) => d.reason)).toEqual(['battery-low']);
    },
  );
});

describe('level 2 starting and reverting with the answers held (V5)', () => {
  test('stop while starting: a late enabled, a beat that disables again, then disarmed with the run counted', () => {
    const sim = new Sim({ holdAcks: true });
    sim.start();
    expect(ofType(sim.send({ type: 'stop' }), 'disable').map((e) => e.reason)).toEqual(['stopped']);
    sim.advance(2);
    sim.ackEnabled();
    sim.advance(28);
    expect(ofType(sim.beat(), 'disable').map((e) => e.reason)).toEqual(['stopped']);
    sim.ackDisabled();
    expect(label(sim.state)).toBe('disarmed:stopped');
    expect(level2Persisted(sim.state).runs).toEqual([[W0 + 2, W0 + 30]]);
  });

  test('hub-exit while starting reverts and then records the clean exit', () => {
    const sim = new Sim({ holdAcks: true });
    sim.start();
    const effects = sim.send({ type: 'hub-exit' });
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual(['hub-exit']);
    expect(level2Persisted(sim.state).cleanExit).toBe(false);
    sim.ackDisabled();
    expect(level2Persisted(sim.state)).toMatchObject({ armed: true, cleanExit: true });
  });

  test('arm while reverting toward disarmed ends armed; stop while reverting ends disarmed', () => {
    const armed = new Sim({ holdAcks: true });
    armed.start();
    armed.ackEnabled();
    armed.send({ type: 'stop' });
    armed.send({ type: 'arm' });
    armed.ackDisabled();
    expect(label(armed.state)).toBe('armed');

    const stopped = new Sim({ holdAcks: true });
    stopped.start();
    stopped.ackEnabled();
    stopped.advance(30);
    stopped.beat({ battery: battery(20) });
    expect(stopped.state.target).toEqual({ name: 'paused', reason: 'battery-low' });
    const effects = stopped.send({ type: 'stop' });
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual(['stopped']);
    stopped.ackDisabled();
    expect(label(stopped.state)).toBe('disarmed:stopped');
  });

  test('heartbeat-failed while starting trips a breaker of 1 and reverts', () => {
    const sim = new Sim({ holdAcks: true, settings: { level2_breaker_failures: 1 } });
    sim.start();
    const effects = sim.send({ type: 'heartbeat-failed' });
    expect(ofType(effects, 'disable').map((e) => e.reason)).toEqual(['breaker']);
    sim.ackDisabled();
    expect(label(sim.state)).toBe('disarmed:breaker');
  });

  test('lease-write-failed with a breaker of 1 disarms at once', () => {
    const sim = new Sim({ settings: { level2_breaker_failures: 1 } });
    sim.enableFailure = 'lease-write-failed';
    sim.start();
    expect(label(sim.state)).toBe('disarmed:breaker');
  });

  test("start is refused with 'reverting' and with 'exiting'", () => {
    const reverting = new Sim({ holdAcks: true });
    reverting.start();
    reverting.ackEnabled();
    reverting.advance(30);
    reverting.beat({ battery: battery(20) });
    expect(ofType(reverting.start(), 'refused')).toEqual([
      { type: 'refused', event: 'start', reason: 'reverting' },
    ]);
    const exiting = new Sim();
    exiting.send({ type: 'hub-exit' });
    expect(ofType(exiting.start(), 'refused')).toEqual([
      { type: 'refused', event: 'start', reason: 'exiting' },
    ]);
    expect(exiting.enables).toEqual([]);
  });

  test('heavy with thermal_revert_level = trapping pauses as thermal-moderate-held after 5 minutes', () => {
    const sim = startedSim({ settings: { thermal_revert_level: 'trapping' } });
    sim.runUntil(notOn, 10 * MIN, { thermal: 'heavy' });
    expect(sim.disables).toEqual([{ t: 330, reason: 'thermal-moderate-held' }]);
  });

  test('a census with no live session while paused returns to armed', () => {
    const sim = new Sim();
    sim.beat({ battery: battery(20) });
    expect(label(sim.state)).toBe('paused:battery-low');
    sim.advance(30);
    sim.census(NONE);
    expect(label(sim.state)).toBe('armed:no-session');
  });
});

describe('level 2 persist order and per-beat persist (card item 3)', () => {
  const indexOf = (effects: readonly Level2Effect[], type: Level2Effect['type']) =>
    effects.findIndex((e) => e.type === type);

  test('persist comes before enable and before disable in a step', () => {
    const sim = new Sim({ holdAcks: true, settings: { level2_resume_dwell_seconds: 0 } });
    const on = sim.beat();
    expect(indexOf(on, 'persist')).toBeGreaterThanOrEqual(0);
    expect(indexOf(on, 'persist')).toBeLessThan(indexOf(on, 'enable'));
    sim.ackEnabled();
    sim.advance(30);
    const off = sim.beat({ battery: battery(20) });
    expect(indexOf(off, 'persist')).toBeGreaterThanOrEqual(0);
    expect(indexOf(off, 'persist')).toBeLessThan(indexOf(off, 'disable'));
  });

  test('every beat while starting, on or reverting persists', () => {
    const sim = new Sim({ holdAcks: true });
    sim.start();
    sim.advance(1);
    expect(ofType(sim.beat(), 'persist')).toHaveLength(1);
    sim.ackEnabled();
    sim.advance(30);
    expect(ofType(sim.beat(), 'persist')).toHaveLength(1);
    sim.advance(30);
    sim.beat({ battery: battery(20) });
    expect(sim.state.name).toBe('reverting');
    sim.advance(30);
    expect(ofType(sim.beat({ battery: battery(20) }), 'persist')).toHaveLength(1);
  });
});

describe('level 2 minimum interval after an idle return (documented)', () => {
  test('the first automatic start after an idle return to armed waits the minimum interval', () => {
    const sim = new Sim({ settings: { level2_resume_dwell_seconds: 0 } });
    sim.beat();
    expect(sim.state.name).toBe('on');
    sim.runUntil(notOn, HOUR, {}, IDLE);
    const idleAt = sim.t;
    expect(label(sim.state)).toBe('armed:no-work');
    sim.advance(60);
    sim.beat();
    expect(label(sim.state)).toBe('paused:resume-interval');
    sim.runUntil((s) => s.name === 'on', HOUR);
    expect(sim.enables.map((e) => e.t)).toEqual([0, idleAt + 600]);
  });
});

describe('level 2 delta review fixes', () => {
  /** On through an explicit start with the switch's answers held, then a battery pause. */
  const revertingSim = (options: SimOptions = {}) => {
    const sim = new Sim({ ...options, holdAcks: true });
    sim.start();
    sim.ackEnabled();
    sim.advance(30);
    sim.beat({ battery: battery(20) });
    expect(label(sim.state)).toBe('reverting:battery-low');
    return sim;
  };

  test('hub-exit while reverting emits one disable, and a failed revert is still retried', () => {
    const sim = revertingSim();
    const effects = sim.send({ type: 'hub-exit' });
    expect(ofType(effects, 'disable')).toEqual([{ type: 'disable', reason: 'hub-exit' }]);
    sim.send({ type: 'disable-failed' });
    expect(sim.state.name).toBe('reverting');
    sim.advance(30);
    expect(ofType(sim.beat({ battery: battery(20) }), 'disable')).toHaveLength(1);
    expect(level2Persisted(sim.state).cleanExit).toBe(false);
  });

  test('heartbeat-failed while reverting trips a breaker of 1: the revert ends disarmed', () => {
    const sim = revertingSim({ settings: { level2_breaker_failures: 1 } });
    expect(sim.state.target).toEqual({ name: 'paused', reason: 'battery-low' });
    sim.send({ type: 'heartbeat-failed' });
    expect(sim.state.target).toEqual({ name: 'disarmed', reason: 'breaker' });
    sim.ackDisabled();
    expect(label(sim.state)).toBe('disarmed:breaker');
  });

  test('enable-failed outside starting changes nothing (while reverting and while on)', () => {
    const reverting = new Sim({ holdAcks: true });
    reverting.start();
    reverting.advance(8);
    reverting.beat();
    expect(label(reverting.state)).toBe('reverting:enable-timeout');
    const before = reverting.state;
    const effects = reverting.send({ type: 'enable-failed', reason: 'switch-failed' });
    expect(effects).toEqual([]);
    expect(label(reverting.state)).toBe('reverting:enable-timeout');
    expect(reverting.state.run).toEqual(before.run);
    expect(reverting.state.target).toEqual(before.target);

    const on = new Sim({ holdAcks: true });
    on.start();
    on.ackEnabled();
    const run = on.state.run;
    expect(on.send({ type: 'enable-failed', reason: 'switch-failed' })).toEqual([]);
    expect(on.state.name).toBe('on');
    expect(on.state.run).toEqual(run);
  });

  test('arm while reverting toward disarmed clears the persisted failures and resumes', () => {
    const sim = new Sim({ holdAcks: true, settings: { level2_resume_dwell_seconds: 0 } });
    sim.beat();
    sim.ackEnabled();
    sim.send({ type: 'heartbeat-failed' });
    sim.send({ type: 'stop' });
    expect(sim.state.target).toEqual({ name: 'disarmed', reason: 'stopped' });
    expect(level2Persisted(sim.state)).toMatchObject({ resumes: [W0], failures: [W0] });
    sim.send({ type: 'arm' });
    expect(sim.state.target).toEqual({ name: 'armed', reason: null });
    expect(level2Persisted(sim.state)).toMatchObject({ resumes: [], failures: [] });
  });

  test('stop and arm are refused on disabled', () => {
    const off = new Sim({ settings: { level2: false } });
    expect(off.send({ type: 'stop' })).toEqual([
      { type: 'refused', event: 'stop', reason: 'disabled' },
    ]);
    expect(off.send({ type: 'arm' })).toEqual([
      { type: 'refused', event: 'arm', reason: 'disabled' },
    ]);
    expect(off.state.name).toBe('disabled');
  });

  test('the enable timeout counts from the enable, also late on the monotonic clock', () => {
    const sim = new Sim({ holdAcks: true });
    sim.t = 1_000_000;
    sim.census(IDLE);
    sim.start();
    expect(sim.state.name).toBe('starting');
    sim.advance(1);
    sim.beat();
    expect(sim.state.name).toBe('starting');
    sim.advance(6);
    sim.beat();
    expect(sim.state.name).toBe('starting');
    sim.advance(1);
    sim.beat();
    expect(label(sim.state)).toBe('reverting:enable-timeout');
  });

  test.each([
    // The monotonic clock jumps 300 s while the wall clock stands still.
    { clock: 'monotonic', mono: 300, wall: 0 },
    // The wall clock jumps 300 s while the monotonic clock moves 60 s.
    { clock: 'wall', mono: 60, wall: 300 },
  ])('a gap on the $clock clock alone restarts the dwell', ({ mono, wall }) => {
    const sim = new Sim();
    sim.beat();
    sim.advance(60);
    sim.beat();
    expect(label(sim.state)).toBe('paused:dwell');
    // Clear since 0: without the gap rule this beat (at 120 s or later) would turn it on.
    sim.advance(mono);
    sim.wallShift += wall - mono;
    sim.beat();
    expect(label(sim.state)).toBe('paused:dwell');
    expect(sim.enables).toEqual([]);

    const control = new Sim();
    control.beat();
    control.advance(60);
    control.beat();
    control.advance(60);
    control.beat();
    expect(control.state.name).toBe('on');
  });
});
