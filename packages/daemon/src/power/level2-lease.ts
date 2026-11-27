/**
 * The level 2 lease (ADR 0050, "Fail-safe design for level 2" item 1, #1773):
 * the hub's written intent, kept at `REMIHOME/keep-awake/lease.json` while it
 * holds the machine-wide sleep flag. The watchdog script reads the same file
 * with `plutil`, so the values it needs (`staleSeconds`,
 * `revertBatteryPercent`) are copied in and it parses no configuration.
 *
 * Nothing writes a lease yet; the hub's controller (a later slice) will.
 * The lease is crash safety, not a security boundary: any process of the same
 * user can delete or rewrite it.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeRestrictedJson } from '../storage/restricted-json.ts';
import { PS_PATH, keepAwakeDir, positiveIntegerOption } from './level2-commands.ts';

export const LEASE_VERSION = 1;

// The defaults of the options below. Every number is an option (owner rule);
// the configuration keys that set them arrive with the hub and command slices
// (L2-HUB, L2-CLI).
/** `readLease` `maxBytes`: a larger lease file is invalid and never parsed. */
export const DEFAULT_LEASE_MAX_BYTES = 4096;
/** `processStartTime` `timeoutMs`: the deadline of one `ps` run. */
export const DEFAULT_PROCESS_START_TIME_TIMEOUT_MS = 2_000;
/** `startTimeMaxLength`: the longest `hubStartTime` accepted; `ps` prints 24 characters. */
export const DEFAULT_START_TIME_MAX_LENGTH = 64;

export interface Level2Lease {
  version: typeof LEASE_VERSION;
  /** The hub that holds the flag. */
  hubPid: number;
  /** `processStartTime(hubPid)` when the lease was written; a reused pid reads differently. */
  hubStartTime: string;
  /** Integer epoch seconds. */
  startedAt: number;
  /** Integer epoch seconds; at or after it, the watchdog reverts. */
  expiresAt: number;
  /** Integer epoch seconds of the hub's last heartbeat. */
  heartbeatAt: number;
  /** A heartbeat more than this many seconds old (or ahead of the clock) is stale. */
  staleSeconds: number;
  /** On battery power, at or under this percentage the watchdog reverts. */
  revertBatteryPercent: number;
}

export type LeaseRead =
  | { kind: 'none' }
  | { kind: 'valid'; lease: Level2Lease }
  | { kind: 'invalid'; reason: string };

export interface LeaseValidationOptions {
  /** Default `DEFAULT_START_TIME_MAX_LENGTH`. */
  startTimeMaxLength?: number | undefined;
}

export interface LeaseReadOptions extends LeaseValidationOptions {
  /** Default `DEFAULT_LEASE_MAX_BYTES`. */
  maxBytes?: number | undefined;
}

/** The keys of a version 1 lease, in the order the writer emits them. */
export const LEASE_KEYS = [
  'version',
  'hubPid',
  'hubStartTime',
  'startedAt',
  'expiresAt',
  'heartbeatAt',
  'staleSeconds',
  'revertBatteryPercent',
] as const;

/** The integer keys with their smallest allowed value; the largest is `Number.MAX_SAFE_INTEGER`. */
const INTEGER_MINIMUMS = {
  hubPid: 1,
  startedAt: 0,
  expiresAt: 0,
  heartbeatAt: 0,
  staleSeconds: 1,
  revertBatteryPercent: 0,
} as const;

export function leasePath(remiHome: string): string {
  return path.join(keepAwakeDir(remiHome), 'lease.json');
}

/** Why `value` is not a version 1 lease, or the lease. Throws for a non-positive option. */
export function validateLease(
  value: unknown,
  options: LeaseValidationOptions = {},
): { ok: true; lease: Level2Lease } | { ok: false; reason: string } {
  const startTimeMaxLength = positiveIntegerOption(
    'startTimeMaxLength',
    options.startTimeMaxLength,
    DEFAULT_START_TIME_MAX_LENGTH,
  );
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not a JSON object' };
  }
  const record = value as Record<string, unknown>;
  const allowed: ReadonlySet<string> = new Set(LEASE_KEYS);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, reason: `unexpected key ${JSON.stringify(key)}` };
  }
  for (const key of LEASE_KEYS) {
    if (!Object.hasOwn(record, key)) return { ok: false, reason: `missing key ${key}` };
  }
  if (record['version'] !== LEASE_VERSION) {
    return { ok: false, reason: `version is not ${LEASE_VERSION}` };
  }
  for (const [key, minimum] of Object.entries(INTEGER_MINIMUMS)) {
    const field = record[key];
    if (typeof field !== 'number' || !Number.isSafeInteger(field)) {
      return { ok: false, reason: `${key} is not an integer` };
    }
    if (field < minimum) return { ok: false, reason: `${key} is below ${minimum}` };
  }
  // Every integer key was checked above.
  const integer = (key: keyof typeof INTEGER_MINIMUMS): number => record[key] as number;
  const start = record['hubStartTime'];
  if (
    typeof start !== 'string' ||
    start === '' ||
    start.length > startTimeMaxLength ||
    start.trim() !== start ||
    /[\u0000-\u001f\u007f]/.test(start)
  ) {
    return { ok: false, reason: 'hubStartTime is not a trimmed one-line string' };
  }
  const lease: Level2Lease = {
    version: LEASE_VERSION,
    hubPid: integer('hubPid'),
    hubStartTime: start,
    startedAt: integer('startedAt'),
    expiresAt: integer('expiresAt'),
    heartbeatAt: integer('heartbeatAt'),
    staleSeconds: integer('staleSeconds'),
    revertBatteryPercent: integer('revertBatteryPercent'),
  };
  if (lease.revertBatteryPercent > 100) {
    return { ok: false, reason: 'revertBatteryPercent is above 100' };
  }
  return { ok: true, lease };
}

function assertRemiHome(remiHome: string): void {
  if (!path.isAbsolute(remiHome)) throw new Error(`the remi home must be absolute: ${remiHome}`);
}

/**
 * Writes the lease: the directory with mode 0700, the file with mode 0600,
 * through a temporary file in the same directory, `fsync`, then `rename`, so a
 * reader sees the previous lease or this one, never part of one. Throws for a
 * lease `readLease` would call invalid, and for any write failure.
 */
export function writeLease(
  remiHome: string,
  lease: Level2Lease,
  options: LeaseValidationOptions = {},
): void {
  assertRemiHome(remiHome);
  const checked = validateLease(lease, options);
  if (!checked.ok) throw new Error(`refusing to write an invalid lease: ${checked.reason}`);
  const ordered = Object.fromEntries(LEASE_KEYS.map((key) => [key, checked.lease[key]]));
  writeRestrictedJson(leasePath(remiHome), ordered);
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

/**
 * Reads the lease. `none` when there is no file; `invalid` for a symlink, a
 * file that is not regular, not owned by `ownerUid` (the current user unless a
 * test names another), larger than `maxBytes`, not JSON, or not exactly a
 * version 1 lease (an extra or missing key, a wrong type, a non-integer, a
 * value out of range). Throws for a non-positive option.
 */
export function readLease(
  remiHome: string,
  ownerUid: number = currentUid(),
  options: LeaseReadOptions = {},
): LeaseRead {
  assertRemiHome(remiHome);
  const maxBytes = positiveIntegerOption('maxBytes', options.maxBytes, DEFAULT_LEASE_MAX_BYTES);
  // Checked here too, so a bad option throws even when there is no lease to read.
  positiveIntegerOption(
    'startTimeMaxLength',
    options.startTimeMaxLength,
    DEFAULT_START_TIME_MAX_LENGTH,
  );
  const file = leasePath(remiHome);
  let fd: number;
  try {
    // O_NOFOLLOW refuses a symlink; O_NONBLOCK keeps a FIFO from blocking the open.
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'none' };
    if (code === 'ELOOP') return { kind: 'invalid', reason: 'the lease is a symlink' };
    return { kind: 'invalid', reason: `the lease cannot be opened (${code ?? 'unknown error'})` };
  }
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: 'invalid', reason: 'the lease is not a regular file' };
    if (stat.uid !== ownerUid) {
      return { kind: 'invalid', reason: 'the lease is not owned by the current user' };
    }
    if (stat.size > maxBytes) {
      return { kind: 'invalid', reason: `the lease is larger than ${maxBytes} bytes` };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > maxBytes) {
      return { kind: 'invalid', reason: `the lease is larger than ${maxBytes} bytes` };
    }
    text = buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: 'invalid', reason: `the lease cannot be read (${code ?? 'unknown error'})` };
  } finally {
    fs.closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'the lease is not valid JSON' };
  }
  const checked = validateLease(parsed, options);
  return checked.ok
    ? { kind: 'valid', lease: checked.lease }
    : { kind: 'invalid', reason: checked.reason };
}

/** Deletes the lease file; no error when there is none. */
export function deleteLease(remiHome: string): void {
  assertRemiHome(remiHome);
  fs.rmSync(leasePath(remiHome), { force: true });
}

/**
 * The start time of `pid` as `LC_ALL=C TZ=UTC0 ps -o lstart= -p PID` prints it,
 * trimmed, or null when the process does not exist, `ps` fails, or it takes
 * longer than `timeoutMs` (default `DEFAULT_PROCESS_START_TIME_TIMEOUT_MS`).
 * `ps` prints local time, so UTC is pinned: a time-zone change while traveling
 * must not make a live hub look gone. The watchdog script reads the same
 * command the same way. Throws for a non-positive `timeoutMs`.
 */
export function processStartTime(
  pid: number,
  options: { timeoutMs?: number | undefined } = {},
): string | null {
  const timeoutMs = positiveIntegerOption(
    'timeoutMs',
    options.timeoutMs,
    DEFAULT_PROCESS_START_TIME_TIMEOUT_MS,
  );
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const result = spawnSync(PS_PATH, ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', TZ: 'UTC0' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const text = result.stdout.trim();
  if (text === '' || text.includes('\n')) return null;
  return text;
}

/** True when the lease was written by the process `pid` that started at `startTime`. */
export function leaseOwnedBy(lease: Level2Lease, pid: number, startTime: string | null): boolean {
  return startTime !== null && lease.hubPid === pid && lease.hubStartTime === startTime;
}
