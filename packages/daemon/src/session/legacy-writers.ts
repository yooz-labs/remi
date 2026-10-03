/**
 * The older-daemon gate (#1165 D, epic #1175, phase 2 #1176).
 *
 * A daemon older than the identity shim rebuilds each `sessions.json` record
 * from the keys it knows, so it drops `harness` and `harnessSessionId` the next
 * time it writes the file (ADR 0032, consequences), and even a read can write:
 * `list()` and `getMostRecent()` rewrite the file whenever a purge changes
 * something. A non-Claude record written while such a daemon is running would
 * then read as a Claude record. The decided policy is a refusal,
 * not a second store file: before the first non-Claude record is written,
 * `findLegacyWriters` lists every live process that could rewrite the file
 * without the shim, and the launch refuses to start while there is one.
 *
 * It looks in three places: the live-sessions entries (every session daemon,
 * and a wrapper, registers one with its `version`), the hub's
 * `daemon-status.json`, and each session daemon's `status-<PORT>.json`. A
 * process is a legacy writer when its pid is alive, is not the caller's own,
 * and its version is absent or older than `IDENTITY_SHIM_MIN_VERSION`.
 *
 * What it cannot see (risk R12 in the epic plan): an older binary run from
 * another install path that registered in none of those places, or one whose
 * status file is unreadable. Those slip through; the fallback if the gate
 * proves leaky is a sidecar identity file that only this build writes.
 *
 * No production caller until the Codex launch (phase 3), which calls it before
 * `preAssign`; the exports are tested against real files until then.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isProcessAlive } from './process-alive.ts';
import type { SessionRegistryFile } from './session-registry-file.ts';

/**
 * The version of the first build that carries the identity shim: the tolerant
 * parse in `parseStoredSession` (ADR 0032, decision 4). The shim merged to
 * `develop` with #1173 while the version read `0.7.16-dev.6`, and the bump to
 * `0.7.16-dev.7` followed the merge, so `dev.7` is the first version a CI-built
 * binary reports with it. It is in no tagged release (v0.7.15 is the newest
 * tag). A binary built from the merge commit itself reports `dev.6` and so is
 * treated as old: a false refusal, never a missed legacy writer.
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
 * than any dev build of the same `X.Y.Z`. A version that does not parse (a
 * PR build such as `0.7.16-p292.1`, a prerelease tag, an empty string) makes
 * the result -1, on either side: the gate must treat what it cannot read as
 * old, never as new.
 */
export function compareRemiVersion(a: string, b: string): number {
  const left = parseRemiVersion(a);
  const right = parseRemiVersion(b);
  if (left === null || right === null) return -1;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.dev === right.dev) return 0;
  if (left.dev === null) return 1;
  if (right.dev === null) return -1;
  return left.dev < right.dev ? -1 : 1;
}

/** A live process that could rewrite `sessions.json` without the identity shim. */
export interface LegacyWriter {
  /** Where it was found: a live-sessions entry, the hub's status file, or a session daemon's. */
  readonly source: 'live-session' | 'hub' | 'session-daemon';
  readonly pid: number;
  /** The version it recorded; undefined when it recorded none (older than the field itself). */
  readonly version: string | undefined;
}

/** One status file as `readStatusFiles` reports it. */
export interface StatusFileEntry {
  readonly file: string;
  readonly pid?: number | undefined;
  readonly version?: string | undefined;
}

export interface FindLegacyWritersDeps {
  readonly liveSessions: Pick<SessionRegistryFile, 'listLive'>;
  /** The hub's `daemon-status.json` and each `status-<PORT>.json` (see `readStatusFiles`). */
  readonly statusFiles: () => readonly StatusFileEntry[];
  /** Liveness probe; defaults to a signal-0 check of the pid. */
  readonly isAlive?: (pid: number) => boolean;
  /** The caller's own pid, which is never a legacy writer. */
  readonly selfPid: number;
}

const HUB_STATUS_FILE = 'daemon-status.json';

/**
 * Every live process, other than the caller, that is older than
 * `IDENTITY_SHIM_MIN_VERSION` or records no version. A process that appears in
 * several places (a session daemon has a live-sessions entry and a status
 * file) is reported once, by the first place that names it. An entry with no
 * pid, or a dead one, is ignored: a stale file is not a writer.
 */
export function findLegacyWriters(deps: FindLegacyWritersDeps): LegacyWriter[] {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const found = new Map<number, LegacyWriter>();

  const consider = (
    source: LegacyWriter['source'],
    pid: number | undefined,
    version: string | undefined,
  ): void => {
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
    if (pid === deps.selfPid || found.has(pid)) return;
    if (version !== undefined && compareRemiVersion(version, IDENTITY_SHIM_MIN_VERSION) >= 0) {
      return;
    }
    if (!isAlive(pid)) return;
    found.set(pid, { source, pid, version });
  };

  for (const entry of deps.liveSessions.listLive()) {
    consider('live-session', entry.pid, entry.version);
  }
  for (const status of deps.statusFiles()) {
    const source = path.basename(status.file) === HUB_STATUS_FILE ? 'hub' : 'session-daemon';
    consider(source, status.pid, status.version);
  }
  return [...found.values()];
}

const STATUS_FILE_NAME = /^(?:daemon-status|status-\d+)\.json$/;

/**
 * The status files under remi's state directory: the hub's
 * `daemon-status.json` and each session daemon's `status-<PORT>.json`, with
 * the `pid` and `version` each holds. A file that is unreadable or not JSON is
 * reported with neither (so `findLegacyWriters` ignores it); a missing
 * directory is an empty list.
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
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const record = typeof parsed === 'object' && parsed !== null ? parsed : {};
      const pid = (record as { pid?: unknown }).pid;
      const version = (record as { version?: unknown }).version;
      entries.push({
        file,
        pid: typeof pid === 'number' ? pid : undefined,
        version: typeof version === 'string' ? version : undefined,
      });
    } catch {
      entries.push({ file });
    }
  }
  return entries;
}
