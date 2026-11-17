/**
 * Level 2 settings (ADR 0050, #1773): the `[awake]` keys of the lid-closed
 * mode, their defaults and a pure validator.
 *
 * Nothing reads these from `config.toml` yet: L2-HUB adds every key to the
 * `[awake]` table in one commit and calls `validateLevel2Settings` from
 * `validateAwake`. Until then an `[awake]` line naming one of these keys is an
 * unsupported key, which stops every `remi` command at config load.
 *
 * The owner's rule of 2026-11-17: every number is a setting with a default, and
 * validation is sanity only (the type; positive, or 0 where 0 turns a rule off;
 * a percent from 0 to 100; a duration whose value in milliseconds is a safe
 * integer; an hours value that is representable as a time; and two order
 * relations). No key has a maximum a person cannot raise: where a value is
 * unwise, the validator returns a warning and the value is used.
 */

export type Level2ThermalSetting = 'moderate' | 'heavy' | 'trapping';

/** Uses the configuration key names, so L2-HUB can pass the `[awake]` values unchanged. */
export interface Level2Settings {
  readonly level2: boolean;
  readonly level2_start_battery_percent: number;
  readonly level2_revert_battery_percent: number;
  readonly level2_min_remaining_minutes: number;
  readonly level2_default_hours: number;
  readonly level2_cap_hours: number;
  readonly level2_window_hours: number;
  readonly level2_idle_revert_minutes: number;
  readonly thermal_refuse_level: Level2ThermalSetting;
  readonly thermal_revert_level: Level2ThermalSetting;
  readonly thermal_moderate_revert_minutes: number;
  readonly heartbeat_seconds: number;
  readonly lease_stale_seconds: number;
  readonly watchdog_interval_seconds: number;
  readonly foreign_holder_revert_minutes: number;
  readonly foreign_holder_ignore: readonly string[];
  readonly require_password_on_wake: boolean;
  readonly level2_resume_dwell_seconds: number;
  readonly level2_resume_min_interval_minutes: number;
  readonly level2_max_resumes_per_day: number;
  readonly level2_breaker_failures: number;
  readonly level2_wake_gap_seconds: number;
  // Mechanism and format bounds (owner, Q16 (b)): validated here, read by
  // L2-CORE, L2-HUB and L2-CLI once each has a caller.
  readonly clock_skew_tolerance_seconds: number;
  readonly switch_deadline_ms: number;
  readonly switch_sync_deadline_ms: number;
  readonly shutdown_budget_ms: number;
  readonly status_file_max_bytes: number;
  readonly process_start_time_deadline_ms: number;
  readonly lease_max_bytes: number;
  readonly lease_start_time_max_length: number;
  readonly endpoint_body_max_bytes: number;
  readonly endpoint_read_deadline_ms: number;
  readonly cli_request_timeout_ms: number;
  readonly watchdog_command_deadline_seconds: number;
  readonly lease_integer_max_digits: number;
  readonly sudoers_user_max_length: number;
}

export const LEVEL2_DEFAULTS: Readonly<Level2Settings> = Object.freeze({
  level2: false,
  level2_start_battery_percent: 35,
  level2_revert_battery_percent: 30,
  level2_min_remaining_minutes: 20,
  level2_default_hours: 3,
  level2_cap_hours: 12,
  level2_window_hours: 24,
  level2_idle_revert_minutes: 30,
  thermal_refuse_level: 'moderate',
  thermal_revert_level: 'heavy',
  thermal_moderate_revert_minutes: 5,
  heartbeat_seconds: 30,
  lease_stale_seconds: 120,
  watchdog_interval_seconds: 60,
  foreign_holder_revert_minutes: 2,
  foreign_holder_ignore: Object.freeze([]) as readonly string[],
  require_password_on_wake: true,
  level2_resume_dwell_seconds: 120,
  level2_resume_min_interval_minutes: 10,
  level2_max_resumes_per_day: 12,
  level2_breaker_failures: 3,
  level2_wake_gap_seconds: 90,
  clock_skew_tolerance_seconds: 60,
  switch_deadline_ms: 5000,
  switch_sync_deadline_ms: 3000,
  shutdown_budget_ms: 3000,
  status_file_max_bytes: 65536,
  process_start_time_deadline_ms: 2000,
  lease_max_bytes: 4096,
  lease_start_time_max_length: 64,
  endpoint_body_max_bytes: 4096,
  endpoint_read_deadline_ms: 2000,
  cli_request_timeout_ms: 5000,
  watchdog_command_deadline_seconds: 10,
  lease_integer_max_digits: 16,
  sudoers_user_max_length: 32,
} satisfies Level2Settings);

/**
 * The latest time a JavaScript `Date` can hold, in epoch seconds (the
 * ECMAScript time range is 8.64e15 ms either side of 1970). A platform bound,
 * not a setting: a run's end beyond it has no `Date`, so no lease or status.
 */
export const DATE_MAX_EPOCH_SECONDS = 8_640_000_000_000;

/**
 * The latest epoch second a run can end at and still be written: it must fit
 * a `Date` and the lease's integers of at most `leaseIntegerMaxDigits` digits.
 * When those digits cannot hold `wallNow` itself, no lease can be written at
 * all (a warning says so) and only the `Date` bound applies here.
 */
export function representableEndSeconds(leaseIntegerMaxDigits: number, wallNow: number): number {
  const digitsMax = 10 ** leaseIntegerMaxDigits - 1;
  return digitsMax >= wallNow
    ? Math.min(DATE_MAX_EPOCH_SECONDS, digitsMax)
    : DATE_MAX_EPOCH_SECONDS;
}

/**
 * How long `remi stop` waits for the hub before SIGKILL (`cli/daemon-manager.ts`,
 * `timeout = 5000`). L2-HUB makes it `[daemon] stop_timeout_seconds` (Q17) and
 * passes the configured value as `stopWaitMs`.
 */
export const DEFAULT_REMI_STOP_WAIT_MS = 5000;

// Warning thresholds (the card's numbers; each only prints a warning).
export const WARN_MIN_PERCENT_GAP = 5;
export const WARN_REVERT_PERCENT_BELOW = 10;
export const WARN_HEARTBEAT_SECONDS_ABOVE = 300;
export const WARN_LEASE_INTEGER_DIGITS_ABOVE = 18;
export const WARN_LEASE_MAX_BYTES_BELOW = 1024;

export const LEVEL2_THERMAL_SETTINGS: readonly Level2ThermalSetting[] = [
  'moderate',
  'heavy',
  'trapping',
];
/**
 * A `Map`, not an object literal: a lookup of `'constructor'` or `'toString'`
 * must find nothing rather than an inherited member.
 */
export const THERMAL_SETTING_RANK: ReadonlyMap<string, number> = new Map([
  ['moderate', 1],
  ['heavy', 2],
  ['trapping', 3],
]);

type Unit = 'ms' | 'seconds' | 'minutes' | 'hours';
const UNIT_MS: Readonly<Record<Unit, number>> = {
  ms: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

type KeySpec =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'percent' }
  | { readonly kind: 'thermal' }
  | { readonly kind: 'names' }
  /** A whole number: a count, a size, or a duration in `unit`. */
  | {
      readonly kind: 'integer';
      /** 0 allowed (the rule is off at 0) or 1 (positive). */
      readonly min: 0 | 1;
      readonly noun: string;
      readonly unit?: Unit;
    }
  /** A positive number with decimals allowed, in `unit`. */
  | { readonly kind: 'number'; readonly unit: Unit };

/**
 * Every key with a unit is a duration. No duration has a timer ceiling (lead
 * ruling of 2026-11-17 on this card): its only bound is that its value in
 * milliseconds is a safe integer, a check that the number can be represented.
 * The code that arms a timer from a setting chains delays longer than a single
 * `setTimeout` can wait (`power/long-timeout.ts`, G2), and `stepLevel2Policy`'s
 * `nextDeadline` is never more than one `heartbeat_seconds` away.
 */
const KEY_SPECS: Readonly<Record<keyof Level2Settings, KeySpec>> = {
  level2: { kind: 'boolean' },
  level2_start_battery_percent: { kind: 'percent' },
  level2_revert_battery_percent: { kind: 'percent' },
  level2_min_remaining_minutes: { kind: 'integer', min: 0, noun: 'minutes', unit: 'minutes' },
  level2_default_hours: { kind: 'number', unit: 'hours' },
  level2_cap_hours: { kind: 'number', unit: 'hours' },
  level2_window_hours: { kind: 'number', unit: 'hours' },
  level2_idle_revert_minutes: { kind: 'integer', min: 1, noun: 'minutes', unit: 'minutes' },
  thermal_refuse_level: { kind: 'thermal' },
  thermal_revert_level: { kind: 'thermal' },
  thermal_moderate_revert_minutes: { kind: 'integer', min: 1, noun: 'minutes', unit: 'minutes' },
  heartbeat_seconds: { kind: 'integer', min: 1, noun: 'seconds', unit: 'seconds' },
  lease_stale_seconds: { kind: 'integer', min: 1, noun: 'seconds', unit: 'seconds' },
  watchdog_interval_seconds: {
    kind: 'integer',
    min: 1,
    noun: 'seconds',
    unit: 'seconds',
  },
  foreign_holder_revert_minutes: { kind: 'integer', min: 1, noun: 'minutes', unit: 'minutes' },
  foreign_holder_ignore: { kind: 'names' },
  require_password_on_wake: { kind: 'boolean' },
  level2_resume_dwell_seconds: { kind: 'integer', min: 0, noun: 'seconds', unit: 'seconds' },
  level2_resume_min_interval_minutes: {
    kind: 'integer',
    min: 0,
    noun: 'minutes',
    unit: 'minutes',
  },
  level2_max_resumes_per_day: { kind: 'integer', min: 0, noun: 'automatic starts' },
  level2_breaker_failures: { kind: 'integer', min: 1, noun: 'failures' },
  level2_wake_gap_seconds: { kind: 'integer', min: 1, noun: 'seconds', unit: 'seconds' },
  clock_skew_tolerance_seconds: { kind: 'integer', min: 0, noun: 'seconds', unit: 'seconds' },
  switch_deadline_ms: { kind: 'integer', min: 1, noun: 'milliseconds', unit: 'ms' },
  switch_sync_deadline_ms: {
    kind: 'integer',
    min: 1,
    noun: 'milliseconds',
    unit: 'ms',
  },
  shutdown_budget_ms: { kind: 'integer', min: 1, noun: 'milliseconds', unit: 'ms' },
  status_file_max_bytes: { kind: 'integer', min: 1, noun: 'bytes' },
  process_start_time_deadline_ms: {
    kind: 'integer',
    min: 1,
    noun: 'milliseconds',
    unit: 'ms',
  },
  lease_max_bytes: { kind: 'integer', min: 1, noun: 'bytes' },
  lease_start_time_max_length: { kind: 'integer', min: 1, noun: 'characters' },
  endpoint_body_max_bytes: { kind: 'integer', min: 1, noun: 'bytes' },
  endpoint_read_deadline_ms: {
    kind: 'integer',
    min: 1,
    noun: 'milliseconds',
    unit: 'ms',
  },
  cli_request_timeout_ms: {
    kind: 'integer',
    min: 1,
    noun: 'milliseconds',
    unit: 'ms',
  },
  watchdog_command_deadline_seconds: {
    kind: 'integer',
    min: 1,
    noun: 'seconds',
    unit: 'seconds',
  },
  lease_integer_max_digits: { kind: 'integer', min: 1, noun: 'digits' },
  sudoers_user_max_length: { kind: 'integer', min: 1, noun: 'characters' },
};

export const LEVEL2_SETTING_KEYS = Object.freeze(
  Object.keys(KEY_SPECS) as (keyof Level2Settings)[],
);

/** The numeric keys (counts, sizes, percents and durations). */
export const LEVEL2_NUMERIC_KEYS: readonly (keyof Level2Settings)[] = Object.freeze(
  LEVEL2_SETTING_KEYS.filter((key) => {
    const kind = KEY_SPECS[key].kind;
    return kind === 'integer' || kind === 'number' || kind === 'percent';
  }),
);

/** Milliseconds per unit of a duration key, or null for a key that is not a duration. */
export function level2DurationUnitMs(key: keyof Level2Settings): number | null {
  const spec = KEY_SPECS[key];
  if (spec.kind === 'number') return UNIT_MS[spec.unit];
  if (spec.kind === 'integer' && spec.unit !== undefined) return UNIT_MS[spec.unit];
  return null;
}

/** The hours keys, which must also be representable as a time (see `representableEndSeconds`). */
const HOURS_KEYS: readonly (keyof Level2Settings)[] = [
  'level2_default_hours',
  'level2_cap_hours',
  'level2_window_hours',
];

export type Level2SettingsValidation =
  | {
      readonly ok: true;
      readonly settings: Readonly<Level2Settings>;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface Level2ValidationOptions {
  /** How long `remi stop` waits before SIGKILL; default `DEFAULT_REMI_STOP_WAIT_MS`. */
  readonly stopWaitMs?: number;
  /** Epoch seconds the hours keys are checked from; default the current time. */
  readonly wallNow?: number;
}

// C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** A duration's value in milliseconds must be a safe integer: representable, not a limit. */
function safeMilliseconds(
  name: string,
  value: number,
  unit: Unit,
  noun: string,
  errors: string[],
): number | undefined {
  if (!(value * UNIT_MS[unit] <= Number.MAX_SAFE_INTEGER)) {
    const most = Math.floor(Number.MAX_SAFE_INTEGER / UNIT_MS[unit]);
    errors.push(
      `${name} must be at most ${most} ${noun}: its value in milliseconds must be a safe integer`,
    );
    return undefined;
  }
  return value;
}

function checkKey(key: keyof Level2Settings, value: unknown, errors: string[]): unknown {
  const spec = KEY_SPECS[key];
  const name = `awake.${key}`;
  if (value === undefined) {
    errors.push(`${name} is missing`);
    return undefined;
  }
  switch (spec.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${name} must be a boolean (true or false)`);
        return undefined;
      }
      return value;
    case 'percent':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        errors.push(`${name} must be a number from 0 to 100 (percent)`);
        return undefined;
      }
      return value;
    case 'thermal':
      if (
        typeof value !== 'string' ||
        !(LEVEL2_THERMAL_SETTINGS as readonly string[]).includes(value)
      ) {
        errors.push(`${name} must be one of "moderate", "heavy" or "trapping"`);
        return undefined;
      }
      return value;
    case 'names': {
      if (!Array.isArray(value)) {
        errors.push(`${name} must be an array of process names`);
        return undefined;
      }
      let ok = true;
      value.forEach((entry: unknown, index: number) => {
        // Never echo the entry: it is the person's text and may carry anything.
        if (typeof entry !== 'string' || entry.length === 0 || CONTROL_CHARACTER.test(entry)) {
          errors.push(`${name}[${index}] must be a non-empty string with no control character`);
          ok = false;
        }
      });
      return ok ? Object.freeze([...(value as string[])]) : undefined;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        errors.push(`${name} must be a positive number of ${spec.unit} (decimals allowed)`);
        return undefined;
      }
      return safeMilliseconds(name, value, spec.unit, spec.unit, errors);
    }
    case 'integer': {
      const floorText =
        spec.min === 0 ? 'an integer of 0 or more (0 turns the rule off)' : 'a positive integer';
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < spec.min) {
        errors.push(`${name} must be ${floorText} (${spec.noun})`);
        return undefined;
      }
      if (spec.unit !== undefined)
        return safeMilliseconds(name, value, spec.unit, spec.noun, errors);
      return value;
    }
  }
}

function warningsFor(settings: Level2Settings, stopWaitMs: number, wallNow: number): string[] {
  const warnings: string[] = [];
  const s = settings;
  if (s.level2_start_battery_percent - s.level2_revert_battery_percent < WARN_MIN_PERCENT_GAP) {
    warnings.push(
      `awake.level2_start_battery_percent is less than ${WARN_MIN_PERCENT_GAP} above awake.level2_revert_battery_percent: level 2 may pause and resume in turn as the battery level moves`,
    );
  }
  if (s.level2_revert_battery_percent < WARN_REVERT_PERCENT_BELOW) {
    warnings.push(
      `awake.level2_revert_battery_percent is below ${WARN_REVERT_PERCENT_BELOW}: whether a Mac with sleep disabled still makes its emergency low-battery sleep is unverified (ADR 0050)`,
    );
  }
  if (s.heartbeat_seconds > WARN_HEARTBEAT_SECONDS_ABOVE) {
    warnings.push(
      `awake.heartbeat_seconds is above ${WARN_HEARTBEAT_SECONDS_ABOVE}: the battery and thermal pauses are only as prompt as the heartbeat`,
    );
  }
  if (s.lease_stale_seconds < 2 * s.heartbeat_seconds) {
    warnings.push(
      'awake.lease_stale_seconds is below twice awake.heartbeat_seconds: the watchdog may revert a healthy level 2 period',
    );
  }
  if (s.level2_wake_gap_seconds <= s.heartbeat_seconds) {
    warnings.push(
      'awake.level2_wake_gap_seconds is at or below awake.heartbeat_seconds: every beat counts as a wake from sleep, so level 2 never resumes by itself',
    );
  }
  if (s.level2_default_hours > s.level2_cap_hours) {
    warnings.push(
      'awake.level2_default_hours is above awake.level2_cap_hours: the longer run has no effect, the cap ends it first',
    );
  }
  if (s.level2_cap_hours >= s.level2_window_hours) {
    warnings.push(
      'awake.level2_cap_hours is at or above awake.level2_window_hours: the cap has no effect, the window holds no more on-time than that',
    );
  }
  if (s.level2_resume_dwell_seconds === 0) {
    warnings.push(
      'awake.level2_resume_dwell_seconds is 0: nothing but awake.level2_max_resumes_per_day protects against level 2 turning on and off in turn',
    );
  }
  if (s.level2_resume_min_interval_minutes === 0) {
    warnings.push(
      'awake.level2_resume_min_interval_minutes is 0: nothing but awake.level2_max_resumes_per_day protects against level 2 turning on and off in turn',
    );
  }
  if (!s.require_password_on_wake) {
    warnings.push(
      'awake.require_password_on_wake is false: with level 2 on, the Mac stays awake and unlocked with the lid closed',
    );
  }
  if (s.shutdown_budget_ms >= stopWaitMs) {
    warnings.push(
      `awake.shutdown_budget_ms is at or above the ${stopWaitMs} ms that remi stop waits before SIGKILL: a stop can kill the hub before its revert, and sleep stays disabled until the watchdog acts`,
    );
  }
  if (s.watchdog_command_deadline_seconds >= s.watchdog_interval_seconds) {
    warnings.push(
      'awake.watchdog_command_deadline_seconds is at or above awake.watchdog_interval_seconds: launchd skips a run while the previous one is still running, so a revert can be late',
    );
  }
  if (s.lease_integer_max_digits > WARN_LEASE_INTEGER_DIGITS_ABOVE) {
    warnings.push(
      `awake.lease_integer_max_digits is above ${WARN_LEASE_INTEGER_DIGITS_ABOVE}: the watchdog's shell arithmetic overflows at 19 digits and could misjudge a lease`,
    );
  }
  if (10 ** s.lease_integer_max_digits - 1 < wallNow) {
    warnings.push(
      'awake.lease_integer_max_digits is too few to hold the current time in epoch seconds: no lease can be written, so level 2 would never stay on',
    );
  }
  if (s.lease_max_bytes < WARN_LEASE_MAX_BYTES_BELOW) {
    warnings.push(
      `awake.lease_max_bytes is below ${WARN_LEASE_MAX_BYTES_BELOW}: the hub's own lease may no longer fit, and every level 2 period would then be reverted`,
    );
  }
  return warnings;
}

/**
 * Validate the level 2 keys of an `[awake]` table. Keys that are not level 2
 * settings (level 1's, for example) are ignored here: refusing unknown keys is
 * `validateAwakeTable`'s job. A missing level 2 key is an error, because
 * `deepMerge` fills every supported key from the defaults before this runs.
 * Errors and warnings name the key and the rule, never a string value of
 * `foreign_holder_ignore`.
 */
export function validateLevel2Settings(
  value: unknown,
  options: Level2ValidationOptions = {},
): Level2SettingsValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['awake must be a table'] };
  }
  const table = value as Record<string, unknown>;
  const errors: string[] = [];
  const settings: Record<string, unknown> = {};
  for (const key of LEVEL2_SETTING_KEYS) {
    const checked = checkKey(key, Object.hasOwn(table, key) ? table[key] : undefined, errors);
    if (checked !== undefined) settings[key] = checked;
  }
  const start = settings['level2_start_battery_percent'];
  const revert = settings['level2_revert_battery_percent'];
  if (typeof start === 'number' && typeof revert === 'number' && revert >= start) {
    errors.push(
      'awake.level2_revert_battery_percent must be below awake.level2_start_battery_percent',
    );
  }
  const refuse = THERMAL_SETTING_RANK.get(String(settings['thermal_refuse_level']));
  const revertLevel = THERMAL_SETTING_RANK.get(String(settings['thermal_revert_level']));
  if (refuse !== undefined && revertLevel !== undefined && revertLevel < refuse) {
    errors.push('awake.thermal_revert_level must be at or above awake.thermal_refuse_level');
  }
  const wallNow =
    typeof options.wallNow === 'number' && Number.isFinite(options.wallNow)
      ? options.wallNow
      : Date.now() / 1000;
  const digits = settings['lease_integer_max_digits'];
  if (typeof digits === 'number') {
    // Representable, not a maximum: a run's end must have a `Date` and fit the
    // lease's integers, or no lease and no status can be written for it.
    const latest = representableEndSeconds(digits, wallNow);
    for (const key of HOURS_KEYS) {
      const hours = settings[key];
      if (typeof hours === 'number' && wallNow + hours * 3_600 > latest) {
        const most = Math.max(0, Math.floor((latest - wallNow) / 3_600));
        errors.push(
          `awake.${key} must be representable as a time: now plus ${hours} hours must fit a JavaScript Date and awake.lease_integer_max_digits digits (at most ${most} hours from now)`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const validated = Object.freeze(settings as unknown as Level2Settings);
  const stopWaitMs = options.stopWaitMs ?? DEFAULT_REMI_STOP_WAIT_MS;
  return {
    ok: true,
    settings: validated,
    warnings: warningsFor(validated, stopWaitMs, wallNow),
  };
}
