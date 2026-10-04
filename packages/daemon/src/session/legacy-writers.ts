/**
 * The older-daemon gate (#1165 D, epic #1175, phase 2 #1176). It NARROWS the
 * older-daemon hazard; it does not close it.
 *
 * A daemon older than the identity shim rebuilds each `sessions.json` record
 * from the keys it knows, so it drops `harness` and `harnessSessionId` the next
 * time it writes the file (ADR 0032, consequences), and even a read can write:
 * `list()` and `getMostRecent()` rewrite the file whenever a purge changes
 * something. A non-Claude record written while such a daemon is running would
 * then read as a Claude record. The decided policy is a refusal, not a second
 * store file: before the first non-Claude record is written, `findLegacyWriters`
 * lists every live process that could rewrite the file without the shim, and
 * the Codex launch (#1177) refuses to start while there is one.
 *
 * It looks in three places: the live-sessions entries (every session daemon,
 * and a wrapper, registers one with its `version`), the hub's
 * `daemon-status.json`, and each session daemon's `status-<PORT>.json`. A
 * process is a legacy writer when its pid is alive, is not the caller's own
 * (nor one the caller excludes: a hub-spawned child excludes its parent hub, the
 * same build, whose version may not parse), and its version is absent, unparsable,
 * or older than `IDENTITY_SHIM_MIN_VERSION`.
 *
 * What it cannot see, so what still erases a Codex identity:
 *
 * - The "starts later" window. It sees only older processes alive when
 *   `remi codex` launches. An older binary started afterwards (`remi
 *   --sessions`, `--resume`, any wrapper start, a LaunchAgent hub restarting
 *   on its old binary) can still purge and rewrite `sessions.json` and drop
 *   `harness` and `harnessSessionId` from a Codex record (reproduced on
 *   `b8c7b096~1`, the commit before the shim). The Codex launch must tell the
 *   user so; no sidecar identity file is planned.
 * - Risk R12 in the epic plan: an older binary run from another install path
 *   that registered in none of the three places, or one whose status file is
 *   unreadable.
 *
 * Fail-safe refusals: EVERY commit of the harness seam epic branch carries the
 * shim at `0.7.16-dev.6` (only develop's later bump to `dev.7` made it
 * `dev.7`), so a locally built seam-era binary, and any PR-stamped build such
 * as `0.7.16-p1182.1`, reads as older than the minimum and is refused. A false
 * refusal costs a restart; a missed writer costs a record.
 *
 * A recycled pid must not refuse a launch. A status file survives its daemon
 * unless it exits gracefully, and `remi stop --all` does not remove it
 * (`listSessionDaemons` reads only live-sessions), so the pid it names may now
 * belong to an unrelated process. A record is ignored when it was written
 * before the process that now holds its pid started (`ps -o lstart=`): the
 * live-sessions entry's `startedAt`, else the status file's modification time.
 * When either time cannot be determined the writer is kept and reported
 * `pidIdentity: 'unverified'`, with its `file`, so the refusal can say
 * `delete <file>` if the file is stale.
 *
 * Not read-only: `SessionRegistryFile.listLive()` deletes entries whose pid is
 * dead or whose JSON is invalid. Recovery by hand when a refusal is wrong:
 * delete the named `file` (a `status-<PORT>.json` or `daemon-status.json` under
 * the remi state directory, or an entry of its `live-sessions` directory).
 *
 * The Codex launch calls it (`cli.ts` wires it into `CodexHarness`, whose
 * `checkCodexLaunch` runs before `preAssign`, #1177), and so does the hub's
 * refusal of a Codex `create_session_request` (`HarnessRegistry`, #1179). It is
 * tested against real files and real processes.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isProcessAlive } from './process-alive.ts';
import type { SessionRegistryFile } from './session-registry-file.ts';

/**
 * The version of the first build that carries the identity shim: the tolerant
 * parse in `parseStoredSession` (ADR 0032, decision 4). The shim merged to
 * `develop` with #1173 while the version read `0.7.16-dev.6`, and the bump to
 * `0.7.16-dev.7` followed the merge, so `dev.7` is the first version a CI-built
 * develop binary reports with it. It is in no tagged release (v0.7.15 is the
 * newest tag). See the file header for what this makes the gate refuse.
 *
 * Exported because the Codex launch's refusal names it (#1177).
 */
export const IDENTITY_SHIM_MIN_VERSION = '0.7.16-dev.7';

interface RemiVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The `-dev.N` counter; null for a release. */
  readonly dev: number | null;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/;

function parseRemiVersion(version: string): RemiVersion | null {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  const dev = match[4] === undefined ? null : Number(match[4]);
  const numbers = [major, minor, patch, dev];
  if (numbers.some((n) => n !== null && !Number.isSafeInteger(n))) return null;
  return { major: major as number, minor: minor as number, patch: patch as number, dev };
}

/**
 * Order two remi versions, `X.Y.Z` or `X.Y.Z-dev.N`: negative when `a` is
 * older than `b`, zero when equal, positive when newer. Numbers compare as
 * numbers, not text (`dev.10` is newer than `dev.9`), and a release is newer
 * than any dev build of the same `X.Y.Z`. `null` when either version does not
 * parse (a PR build such as `0.7.16-p292.1`, a prerelease tag, an empty
 * string): there is no order to report, and the gate reads it as older.
 *
 * Exported because the ordering rule is what decides a refusal, so its
 * boundary cases are asserted directly.
 */
export function compareRemiVersion(a: string, b: string): number | null {
  const left = parseRemiVersion(a);
  const right = parseRemiVersion(b);
  if (left === null || right === null) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.dev === right.dev) return 0;
  if (left.dev === null) return 1;
  if (right.dev === null) return -1;
  return left.dev < right.dev ? -1 : 1;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART_PATTERN =
  /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/**
 * Read `ps -o lstart=` output as a Date, or null: `Sat Oct  3 13:50:12 2026`,
 * the same shape on macOS and Linux, whitespace padded, read as UTC (`psStartTime`
 * asks `ps` for UTC). It has one-second granularity.
 *
 * Exported because it is the one place the OS format is interpreted, and it is
 * tested against the shapes both platforms print.
 */
export function parsePsStartTime(text: string): Date | null {
  const match = LSTART_PATTERN.exec(text.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1] as string);
  if (month === -1) return null;
  const [day, hour, minute, second, year] = [match[2], match[3], match[4], match[5], match[6]].map(
    Number,
  );
  const date = new Date(
    Date.UTC(
      year as number,
      month,
      day as number,
      hour as number,
      minute as number,
      second as number,
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** When the process holding `pid` started, from `ps`, or null when it cannot be told. */
function psStartTime(pid: number): Date | null {
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    // LC_ALL=C pins the English month and day names `parsePsStartTime` reads,
    // and TZ=UTC makes `ps` print UTC, which that function reads as UTC. Not
    // the local zone: a runtime may override its own (`bun test` pins UTC for
    // itself without exporting it), and the two would disagree by the
    // machine's UTC offset.
    const result = spawnSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' },
    });
    if (result.error) continue;
    return result.status === 0 ? parsePsStartTime(result.stdout) : null;
  }
  return null;
}

/** A live process that could rewrite `sessions.json` without the identity shim. */
export interface LegacyWriter {
  /** Where it was found: a live-sessions entry, the hub's status file, or a session daemon's. */
  readonly source: 'live-session' | 'hub' | 'session-daemon';
  readonly pid: number;
  /** The version it recorded; undefined when it recorded none (older than the field itself). */
  readonly version: string | undefined;
  /** The file that named it, so a stale one can be deleted by hand. */
  readonly file?: string;
  /**
   * `verified` when its record was written no earlier than the process now
   * holding the pid started, so they are the same process; `unverified` when
   * either time could not be determined (the writer is kept, since a refusal is
   * the safe side).
   */
  readonly pidIdentity: 'verified' | 'unverified';
}

/** One status file as `readStatusFiles` reports it. */
export interface StatusFileEntry {
  readonly file: string;
  readonly pid?: number | undefined;
  readonly version?: string | undefined;
  /** The file's modification time in ms: when its writer last wrote it. */
  readonly recordedAtMs?: number | undefined;
}

export interface FindLegacyWritersDeps {
  /** `dirPath` names an entry's file in a `LegacyWriter`. */
  readonly liveSessions: Pick<SessionRegistryFile, 'listLive' | 'dirPath'>;
  /** The hub's `daemon-status.json` and each `status-<PORT>.json` (see `readStatusFiles`). */
  readonly statusFiles: () => readonly StatusFileEntry[];
  /**
   * Liveness probe; defaults to a signal-0 check of the pid. Injectable because
   * `listLive()` already drops a dead pid's live-sessions entry, so this is the
   * only way to exercise the filter on that path.
   */
  readonly isAlive?: (pid: number) => boolean;
  /**
   * When the process holding a pid started, or null if unknown; defaults to
   * `ps -o lstart=`. Injectable to simulate a missing or unreadable `ps`.
   */
  readonly processStartTime?: (pid: number) => Date | null;
  /** The caller's own pid, which is never a legacy writer. */
  readonly selfPid: number;
  /**
   * Other pids that are never legacy writers. A hub-spawned child names its parent hub: the
   * hub runs the same build as the child (it spawned it from its own command), but a build whose
   * version does not parse, such as a PR-stamped one, would read as older and the hub would
   * refuse its own child.
   */
  readonly excludePids?: readonly number[];
}

const HUB_STATUS_FILE = 'daemon-status.json';

/**
 * Every live process, other than the caller (and `excludePids`), that is older than
 * `IDENTITY_SHIM_MIN_VERSION` or records no usable version, and whose record
 * is not stale (see the file header on recycled pids). A process named by
 * several records is reported once, by the first record that names it and
 * passes every check. An entry with no pid, or a dead one, is ignored: a
 * stale file is not a writer. Not read-only: `listLive()` deletes dead or
 * invalid live-sessions entries.
 */
export function findLegacyWriters(deps: FindLegacyWritersDeps): LegacyWriter[] {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const processStartTime = deps.processStartTime ?? psStartTime;
  const found = new Map<number, LegacyWriter>();

  const consider = (
    source: LegacyWriter['source'],
    pid: number | undefined,
    version: string | undefined,
    file: string,
    recordedAtMs: number | undefined,
  ): void => {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
    if (pid === deps.selfPid || deps.excludePids?.includes(pid) || found.has(pid)) return;
    if (version !== undefined) {
      const order = compareRemiVersion(version, IDENTITY_SHIM_MIN_VERSION);
      if (order !== null && order >= 0) return;
    }
    if (!isAlive(pid)) return;

    // A record older than the process now holding the pid belongs to a dead
    // process whose pid was recycled. `ps` has one-second granularity and
    // truncates, so a record of the real owner is never earlier than it.
    const startedAt = processStartTime(pid);
    let pidIdentity: LegacyWriter['pidIdentity'] = 'unverified';
    if (startedAt !== null && recordedAtMs !== undefined && Number.isFinite(recordedAtMs)) {
      if (recordedAtMs < startedAt.getTime()) return;
      pidIdentity = 'verified';
    }
    found.set(pid, { source, pid, version, file, pidIdentity });
  };

  for (const entry of deps.liveSessions.listLive()) {
    consider(
      'live-session',
      entry.pid,
      entry.version,
      path.join(deps.liveSessions.dirPath, `${entry.sessionId}.json`),
      // NaN for an unreadable `startedAt`; `consider` treats it as no time.
      Date.parse(entry.startedAt),
    );
  }
  for (const status of deps.statusFiles()) {
    const source = path.basename(status.file) === HUB_STATUS_FILE ? 'hub' : 'session-daemon';
    consider(source, status.pid, status.version, status.file, status.recordedAtMs);
  }
  return [...found.values()];
}

const STATUS_FILE_NAME = /^(?:daemon-status|status-\d+)\.json$/;

/**
 * The status files under remi's state directory: the hub's
 * `daemon-status.json` and each session daemon's `status-<PORT>.json`, with
 * the `pid` and `version` each holds and the file's modification time. A file
 * that is unreadable or not JSON is reported with no pid and no version (so
 * `findLegacyWriters` ignores it); a missing directory is an empty list.
 */
export function readStatusFiles(remiDir: string): StatusFileEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(remiDir);
  } catch {
    return [];
  }
  const entries: StatusFileEntry[] = [];
  for (const name of names.filter((n) => STATUS_FILE_NAME.test(n)).sort()) {
    const file = path.join(remiDir, name);
    try {
      const recordedAtMs = fs.statSync(file).mtimeMs;
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const record = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const pid = (record as { pid?: unknown }).pid;
      const version = (record as { version?: unknown }).version;
      entries.push({
        file,
        pid: typeof pid === 'number' ? pid : undefined,
        version: typeof version === 'string' ? version : undefined,
        recordedAtMs,
      });
    } catch {
      entries.push({ file });
    }
  }
  return entries;
}
