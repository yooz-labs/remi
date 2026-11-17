import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REMI_STOP_WAIT_MS,
  LEVEL2_DEFAULTS,
  LEVEL2_SETTING_KEYS,
  LEVEL2_TIMER_KEYS,
  type Level2Settings,
  TIMER_LIMIT_MS,
  validateLevel2Settings,
} from '../../src/power/level2-settings.ts';

function validate(overrides: Record<string, unknown>, stopWaitMs?: number) {
  return validateLevel2Settings(
    { ...LEVEL2_DEFAULTS, ...overrides },
    stopWaitMs === undefined ? {} : { stopWaitMs },
  );
}

function errorsOf(overrides: Record<string, unknown>): readonly string[] {
  const result = validate(overrides);
  return result.ok ? [] : result.errors;
}

function warningsOf(overrides: Record<string, unknown>, stopWaitMs?: number): readonly string[] {
  const result = validate(overrides, stopWaitMs);
  if (!result.ok) throw new Error(`expected valid settings, got ${result.errors.join('; ')}`);
  return result.warnings;
}

type NumericKind = 'positive-integer' | 'zero-integer' | 'positive-number' | 'percent';

/** Every numeric key with its sanity rule (the card's item 1). */
const NUMERIC: Readonly<Record<string, NumericKind>> = {
  level2_start_battery_percent: 'percent',
  level2_revert_battery_percent: 'percent',
  level2_min_remaining_minutes: 'zero-integer',
  level2_default_hours: 'positive-number',
  level2_cap_hours: 'positive-number',
  level2_window_hours: 'positive-number',
  level2_idle_revert_minutes: 'positive-integer',
  thermal_moderate_revert_minutes: 'positive-integer',
  heartbeat_seconds: 'positive-integer',
  lease_stale_seconds: 'positive-integer',
  watchdog_interval_seconds: 'positive-integer',
  foreign_holder_revert_minutes: 'positive-integer',
  level2_resume_dwell_seconds: 'zero-integer',
  level2_resume_min_interval_minutes: 'zero-integer',
  level2_max_resumes_per_day: 'zero-integer',
  level2_breaker_failures: 'positive-integer',
  level2_wake_gap_seconds: 'positive-integer',
  clock_skew_tolerance_seconds: 'zero-integer',
  switch_deadline_ms: 'positive-integer',
  switch_sync_deadline_ms: 'positive-integer',
  shutdown_budget_ms: 'positive-integer',
  status_file_max_bytes: 'positive-integer',
  process_start_time_deadline_ms: 'positive-integer',
  lease_max_bytes: 'positive-integer',
  lease_start_time_max_length: 'positive-integer',
  endpoint_body_max_bytes: 'positive-integer',
  endpoint_read_deadline_ms: 'positive-integer',
  cli_request_timeout_ms: 'positive-integer',
  watchdog_command_deadline_seconds: 'positive-integer',
  lease_integer_max_digits: 'positive-integer',
  sudoers_user_max_length: 'positive-integer',
};

const BOOLEAN = ['level2', 'require_password_on_wake'];
const THERMAL = ['thermal_refuse_level', 'thermal_revert_level'];

describe('level 2 settings: defaults and keys', () => {
  test('LEVEL2_DEFAULTS validates with no warning', () => {
    const result = validateLevel2Settings(LEVEL2_DEFAULTS);
    expect(result).toEqual({ ok: true, settings: LEVEL2_DEFAULTS, warnings: [] });
  });

  test('every key of Level2Settings has a sanity rule in this test', () => {
    const covered = [...Object.keys(NUMERIC), ...BOOLEAN, ...THERMAL, 'foreign_holder_ignore'];
    expect([...covered].sort()).toEqual([...LEVEL2_SETTING_KEYS].sort());
  });

  test('keys that are not level 2 settings are ignored; a missing level 2 key is an error', () => {
    const withLevel1 = validateLevel2Settings({
      ...LEVEL2_DEFAULTS,
      level1: true,
      ttl_minutes: 20,
    });
    expect(withLevel1.ok).toBe(true);
    if (withLevel1.ok) expect(Object.keys(withLevel1.settings)).not.toContain('level1');

    const { heartbeat_seconds: _omitted, ...missing } = LEVEL2_DEFAULTS;
    expect(validateLevel2Settings(missing)).toEqual({
      ok: false,
      errors: ['awake.heartbeat_seconds is missing'],
    });
    expect(validateLevel2Settings(null)).toEqual({ ok: false, errors: ['awake must be a table'] });
    expect(validateLevel2Settings([])).toEqual({ ok: false, errors: ['awake must be a table'] });
  });

  test('mechanism and format keys pass a non-default value through unchanged', () => {
    const changed: Partial<Level2Settings> = {
      clock_skew_tolerance_seconds: 0,
      switch_deadline_ms: 7000,
      switch_sync_deadline_ms: 4000,
      shutdown_budget_ms: 2000,
      status_file_max_bytes: 1000,
      process_start_time_deadline_ms: 900,
      lease_max_bytes: 2048,
      lease_start_time_max_length: 80,
      endpoint_body_max_bytes: 8192,
      endpoint_read_deadline_ms: 1500,
      cli_request_timeout_ms: 9000,
      watchdog_command_deadline_seconds: 20,
      lease_integer_max_digits: 12,
      sudoers_user_max_length: 40,
      lease_stale_seconds: 300,
      watchdog_interval_seconds: 90,
    };
    const result = validate(changed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings).toEqual({ ...LEVEL2_DEFAULTS, ...changed });
      expect(result.warnings).toEqual([]);
    }
  });
});

describe('level 2 settings: sanity checks', () => {
  test.each(BOOLEAN)('%s refuses a wrong type', (key) => {
    for (const bad of ['true', 1, null]) {
      expect(errorsOf({ [key]: bad })).toEqual([`awake.${key} must be a boolean (true or false)`]);
    }
  });

  test.each(THERMAL)('%s refuses a wrong type or an unknown level', (key) => {
    for (const bad of ['hot', 'nominal', 'Heavy', 2, null]) {
      const errors = errorsOf({ [key]: bad });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toBe(`awake.${key} must be one of "moderate", "heavy" or "trapping"`);
    }
  });

  test.each(Object.entries(NUMERIC))(
    '%s refuses a wrong type and a value below its floor',
    (key, kind) => {
      const wrongTypes: unknown[] = ['30', true, null, [30], Number.NaN, Number.POSITIVE_INFINITY];
      if (kind === 'positive-integer' || kind === 'zero-integer') wrongTypes.push(1.5);
      for (const bad of wrongTypes) {
        const errors = errorsOf({ [key]: bad });
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.startsWith(`awake.${key} must be`)).toBe(true);
      }
      const belowFloor: unknown[] = [-1];
      if (kind === 'positive-integer' || kind === 'positive-number') belowFloor.push(0);
      for (const bad of belowFloor) {
        const errors = errorsOf({ [key]: bad });
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.startsWith(`awake.${key} must be`)).toBe(true);
      }
    },
  );

  test('0 is allowed exactly where it turns a rule off', () => {
    for (const key of [
      'level2_min_remaining_minutes',
      'level2_resume_dwell_seconds',
      'level2_resume_min_interval_minutes',
      'level2_max_resumes_per_day',
      'clock_skew_tolerance_seconds',
    ]) {
      expect(validate({ [key]: 0 }).ok).toBe(true);
    }
  });

  test('a percent is a number from 0 to 100', () => {
    expect(errorsOf({ level2_start_battery_percent: 101 })).toEqual([
      'awake.level2_start_battery_percent must be a number from 0 to 100 (percent)',
    ]);
    expect(
      validate({ level2_start_battery_percent: 100, level2_revert_battery_percent: 0 }).ok,
    ).toBe(true);
  });

  test('hours take decimals', () => {
    expect(validate({ level2_default_hours: 0.5, level2_cap_hours: 1.25 }).ok).toBe(true);
  });

  test.each([...LEVEL2_TIMER_KEYS])(
    '%s, a timer, refuses a value beyond the timer limit',
    (key) => {
      const unit = key.endsWith('_ms') ? 1 : 1000;
      const limit = Math.floor(TIMER_LIMIT_MS / unit);
      expect(validate({ [key]: limit }).ok).toBe(true);
      const errors = errorsOf({ [key]: limit + 1 });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`awake.${key} must be at most ${limit}`);
    },
  );

  test('the timer keys are the heartbeat, the watchdog interval and every deadline', () => {
    expect([...LEVEL2_TIMER_KEYS].sort() as string[]).toEqual(
      [
        'heartbeat_seconds',
        'watchdog_interval_seconds',
        'watchdog_command_deadline_seconds',
        'switch_deadline_ms',
        'switch_sync_deadline_ms',
        'shutdown_budget_ms',
        'process_start_time_deadline_ms',
        'endpoint_read_deadline_ms',
        'cli_request_timeout_ms',
      ].sort(),
    );
  });

  test('a duration the policy only compares with a clock has no upper bound but a finite one', () => {
    expect(validate({ level2_window_hours: 1e6, level2_cap_hours: 1e5 }).ok).toBe(true);
    expect(errorsOf({ level2_window_hours: Number.MAX_VALUE })).toEqual([
      'awake.level2_window_hours must be a positive number of hours (decimals allowed)',
    ]);
  });

  test('no key has a maximum', () => {
    const large = {
      level2_default_hours: 100,
      level2_cap_hours: 100,
      level2_window_hours: 1000,
      level2_idle_revert_minutes: 100_000,
      heartbeat_seconds: 3600,
      lease_stale_seconds: 7200,
      level2_wake_gap_seconds: 7200,
      level2_max_resumes_per_day: 1000,
      level2_breaker_failures: 1000,
      level2_min_remaining_minutes: 100_000,
      foreign_holder_ignore: Array.from({ length: 1000 }, (_, i) => `process-${i}`),
    };
    const result = validate(large);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.level2_default_hours).toBe(100);
      expect(result.settings.level2_window_hours).toBe(1000);
      expect(result.settings.foreign_holder_ignore).toHaveLength(1000);
    }
  });

  test('a control character in foreign_holder_ignore fails without echoing the entry', () => {
    const planted = 'Planted\u0007Name';
    for (const bad of [planted, 'tab\there', 'line\nbreak', 'del\u007f', 'c1\u0085']) {
      const result = validate({ foreign_holder_ignore: ['ok-name', bad] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([
          'awake.foreign_holder_ignore[1] must be a non-empty string with no control character',
        ]);
        expect(JSON.stringify(result.errors)).not.toContain(bad);
      }
    }
    expect(errorsOf({ foreign_holder_ignore: [''] })).toEqual([
      'awake.foreign_holder_ignore[0] must be a non-empty string with no control character',
    ]);
    expect(errorsOf({ foreign_holder_ignore: 'ChatApp' })).toEqual([
      'awake.foreign_holder_ignore must be an array of process names',
    ]);
    expect(errorsOf({ foreign_holder_ignore: [7] })).toEqual([
      'awake.foreign_holder_ignore[0] must be a non-empty string with no control character',
    ]);
  });

  test('validated settings are a copy: a later change to the table does not reach them', () => {
    const ignore = ['ChatApp'];
    const result = validate({ foreign_holder_ignore: ignore });
    ignore.push('Other');
    expect(result.ok && result.settings.foreign_holder_ignore).toEqual(['ChatApp']);
  });
});

describe('level 2 settings: required relations', () => {
  test('the revert percent at or above the start percent is refused, alone', () => {
    for (const revert of [35, 36]) {
      expect(errorsOf({ level2_revert_battery_percent: revert })).toEqual([
        'awake.level2_revert_battery_percent must be below awake.level2_start_battery_percent',
      ]);
    }
    expect(validate({ level2_revert_battery_percent: 34 }).ok).toBe(true);
  });

  test('a thermal revert level below the refuse level is refused, alone', () => {
    expect(errorsOf({ thermal_refuse_level: 'heavy', thermal_revert_level: 'moderate' })).toEqual([
      'awake.thermal_revert_level must be at or above awake.thermal_refuse_level',
    ]);
    expect(errorsOf({ thermal_refuse_level: 'trapping', thermal_revert_level: 'heavy' })).toEqual([
      'awake.thermal_revert_level must be at or above awake.thermal_refuse_level',
    ]);
    expect(validate({ thermal_refuse_level: 'heavy', thermal_revert_level: 'heavy' }).ok).toBe(
      true,
    );
    expect(
      validate({ thermal_refuse_level: 'moderate', thermal_revert_level: 'moderate' }).ok,
    ).toBe(true);
  });
});

interface WarningRow {
  readonly key: string;
  readonly trigger: Record<string, unknown>;
  readonly quiet: Record<string, unknown>;
  readonly text: string;
  readonly stopWaitMs?: number;
}

const WARNINGS: WarningRow[] = [
  {
    key: 'percent gap',
    trigger: { level2_start_battery_percent: 34 },
    quiet: { level2_start_battery_percent: 35 },
    text: 'awake.level2_start_battery_percent is less than 5 above awake.level2_revert_battery_percent',
  },
  {
    key: 'revert below 10',
    trigger: { level2_revert_battery_percent: 9 },
    quiet: { level2_revert_battery_percent: 10 },
    text: 'awake.level2_revert_battery_percent is below 10',
  },
  {
    key: 'heartbeat above 300',
    trigger: { heartbeat_seconds: 301, lease_stale_seconds: 602, level2_wake_gap_seconds: 302 },
    quiet: { heartbeat_seconds: 300, lease_stale_seconds: 600, level2_wake_gap_seconds: 301 },
    text: 'awake.heartbeat_seconds is above 300',
  },
  {
    key: 'stale below twice the heartbeat',
    trigger: { lease_stale_seconds: 59 },
    quiet: { lease_stale_seconds: 60 },
    text: 'awake.lease_stale_seconds is below twice awake.heartbeat_seconds',
  },
  {
    key: 'wake gap at or below the heartbeat',
    trigger: { level2_wake_gap_seconds: 30 },
    quiet: { level2_wake_gap_seconds: 31 },
    text: 'awake.level2_wake_gap_seconds is at or below awake.heartbeat_seconds',
  },
  {
    key: 'run above the cap',
    trigger: { level2_default_hours: 12.5 },
    quiet: { level2_default_hours: 12 },
    text: 'awake.level2_default_hours is above awake.level2_cap_hours',
  },
  {
    key: 'cap at or above the window',
    trigger: { level2_cap_hours: 24 },
    quiet: { level2_cap_hours: 23.5 },
    text: 'awake.level2_cap_hours is at or above awake.level2_window_hours',
  },
  {
    key: 'dwell off',
    trigger: { level2_resume_dwell_seconds: 0 },
    quiet: { level2_resume_dwell_seconds: 1 },
    text: 'awake.level2_resume_dwell_seconds is 0',
  },
  {
    key: 'interval off',
    trigger: { level2_resume_min_interval_minutes: 0 },
    quiet: { level2_resume_min_interval_minutes: 1 },
    text: 'awake.level2_resume_min_interval_minutes is 0',
  },
  {
    key: 'password on wake not required',
    trigger: { require_password_on_wake: false },
    quiet: { require_password_on_wake: true },
    text: 'awake.require_password_on_wake is false',
  },
  {
    key: 'shutdown budget at or above the stop wait',
    trigger: { shutdown_budget_ms: DEFAULT_REMI_STOP_WAIT_MS },
    quiet: { shutdown_budget_ms: DEFAULT_REMI_STOP_WAIT_MS - 1 },
    text: 'awake.shutdown_budget_ms is at or above the 5000 ms that remi stop waits',
  },
  {
    key: 'shutdown budget against a configured stop wait',
    trigger: { shutdown_budget_ms: 8000 },
    quiet: { shutdown_budget_ms: 7999 },
    stopWaitMs: 8000,
    text: 'awake.shutdown_budget_ms is at or above the 8000 ms that remi stop waits',
  },
  {
    key: 'watchdog deadline at or above its interval',
    trigger: { watchdog_command_deadline_seconds: 60 },
    quiet: { watchdog_command_deadline_seconds: 59 },
    text: 'awake.watchdog_command_deadline_seconds is at or above awake.watchdog_interval_seconds',
  },
  {
    key: 'lease digits above 18',
    trigger: { lease_integer_max_digits: 19 },
    quiet: { lease_integer_max_digits: 18 },
    text: 'awake.lease_integer_max_digits is above 18',
  },
  {
    key: 'lease bytes below 1024',
    trigger: { lease_max_bytes: 1023 },
    quiet: { lease_max_bytes: 1024 },
    text: 'awake.lease_max_bytes is below 1024',
  },
];

describe('level 2 settings: warnings, never refusals', () => {
  test.each(WARNINGS)('$key warns for its trigger only, and the settings still validate', (row) => {
    const warnings = warningsOf(row.trigger, row.stopWaitMs);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.startsWith(row.text)).toBe(true);
    expect(warningsOf(row.quiet, row.stopWaitMs)).toEqual([]);
  });

  test('a stop wait longer than the default silences the default budget warning', () => {
    expect(warningsOf({ shutdown_budget_ms: 5000 }, 10_000)).toEqual([]);
  });

  test('several warnings at once are all returned', () => {
    const warnings = warningsOf({
      require_password_on_wake: false,
      level2_resume_dwell_seconds: 0,
      lease_max_bytes: 512,
    });
    expect(warnings).toHaveLength(3);
  });
});
