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
import { PS_PATH, keepAwakeDir } from './level2-commands.ts';

export const LEASE_VERSION = 1;
/** A lease file larger than this is invalid and never parsed. */
export const LEASE_MAX_BYTES = 4096;
/** The deadline of one `ps` run in `processStartTime`. */
export const PROCESS_START_TIME_TIMEOUT_MS = 2_000;

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

/** The keys of a version 1 lease, in the order the writer emits them. */
const LEASE_KEYS = [
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

/** The longest `hubStartTime` accepted; `ps` prints 24 characters. */
const START_TIME_MAX_LENGTH = 64;

export function leasePath(remiHome: string): string {
  return path.join(keepAwakeDir(remiHome), 'lease.json');
}

/** Why `value` is not a version 1 lease, or the lease. */
export function validateLease(
  value: unknown,
): { ok: true; lease: Level2Lease } | { ok: false; reason: string } {
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
    start.length > START_TIME_MAX_LENGTH ||
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
export function writeLease(remiHome: string, lease: Level2Lease): void {
  assertRemiHome(remiHome);
  const checked = validateLease(lease);
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
 * test names another), larger than 4 KiB, not JSON, or not exactly a version 1
 * lease (an extra or missing key, a wrong type, a non-integer).
 */
export function readLease(remiHome: string, ownerUid: number = currentUid()): LeaseRead {
  assertRemiHome(remiHome);
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
    if (stat.size > LEASE_MAX_BYTES) {
      return { kind: 'invalid', reason: `the lease is larger than ${LEASE_MAX_BYTES} bytes` };
    }
    const buffer = Buffer.alloc(LEASE_MAX_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > LEASE_MAX_BYTES) {
      return { kind: 'invalid', reason: `the lease is larger than ${LEASE_MAX_BYTES} bytes` };
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
  const checked = validateLease(parsed);
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
 * longer than 2 seconds. `ps` prints local time, so UTC is pinned: a time-zone
 * change while traveling must not make a live hub look gone. The watchdog
 * script reads the same command the same way.
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const result = spawnSync(PS_PATH, ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { LC_ALL: 'C', TZ: 'UTC0' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PROCESS_START_TIME_TIMEOUT_MS,
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
