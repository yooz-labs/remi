/**
 * SessionStore - Persistent JSON storage for session metadata.
 *
 * Stores session records at ~/.remi/sessions.json so that
 * `remi --resume` can look up Claude session IDs across process restarts.
 *
 * Sessions track the remi wrapper PID so that stale "running" entries
 * (from crashed/killed processes) can be detected and auto-cleaned.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_HARNESS, errorToString, identityFromClaudeId, isHarnessId } from '@remi/shared';
import type { HarnessId, SessionIdentity, UUID } from '@remi/shared';
import { normalizeProjectPath } from '../cli/path-resolver.ts';
import { remiHome } from '../config/remi-home.ts';
import { isProcessAlive } from './process-alive.ts';
import { shellQuote } from './shell-quote.ts';

export interface StoredSession {
  remiSessionId: UUID;
  /**
   * For a Claude record this column is the single source of the harness
   * identity (ADR 0032); `harness` and `harnessSessionId` are never consulted
   * for Claude.
   */
  claudeSessionId: string | null;
  projectPath: string;
  port: number;
  pid: number | null;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  /**
   * The harness this record belongs to (#1162, ADR 0032). ABSENT on every
   * Claude record: nothing writes it today, and absence means Claude, so an
   * older daemon that rewrites this file loses nothing. Kept as a plain string,
   * not `HarnessId`, so a record naming a harness STRING this build does not
   * know still round-trips through a rewrite instead of being dropped or
   * rejected. A value that is not a string at all (number, object, array,
   * boolean, null) is treated as absent: it reads as Claude and is dropped on
   * the next rewrite. Read it through `SessionBindingStore.getIdentity`, which
   * interprets it.
   */
  harness?: string | undefined;
  /**
   * The harness's own session id (#1162, ADR 0032). Absent on every Claude
   * record, whose id is `claudeSessionId`. Round-tripped untouched; it is
   * meaningful only together with `harness`.
   */
  harnessSessionId?: string | null | undefined;
}

interface SessionsFile {
  version: 1;
  sessions: StoredSession[];
}

const REMI_DIR = remiHome();
const SESSIONS_FILE = path.join(REMI_DIR, 'sessions.json');
const MAX_SESSIONS = 100;
const STALE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LOCK_SUFFIX = '.lock';
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 2_000;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

interface SessionStoreLockOwner {
  version: 1;
  ownerId: string;
  pid: number;
  host: string;
  acquiredAt: number;
}

interface SessionStoreLockSnapshot {
  owner: SessionStoreLockOwner;
  mtimeMs: number;
}

interface SessionStoreLockHandle {
  lockPath: string;
  owner: SessionStoreLockOwner;
}

export class MalformedSessionStoreError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Malformed session store ${filePath}: ${reason}`);
    this.name = 'MalformedSessionStoreError';
  }
}

export class InterprocessFileLockError extends Error {
  readonly lockPath: string;
  readonly retryable: boolean;

  constructor(lockPath: string, reason: string, options: { readonly retryable?: boolean } = {}) {
    super(`Could not acquire interprocess lock ${lockPath}: ${reason}`);
    this.name = 'InterprocessFileLockError';
    this.lockPath = lockPath;
    this.retryable = options.retryable ?? false;
  }
}

/** Backward-compatible name for callers/tests that specifically mention the session store. */
export { InterprocessFileLockError as SessionStoreLockError };

export class AmbiguousSessionIdentityError extends Error {
  /** 'Remi', 'Claude', or a non-Claude harness id ('codex'). */
  readonly identity: string;
  readonly value: string;
  readonly matchCount: number;

  constructor(identity: string, value: string, matchCount: number) {
    super(
      // A Claude or remi id is random throughout, so its first eight characters name it; a
      // non-Claude harness id (a Codex thread, a UUIDv7) starts with a timestamp, so its last do.
      `Ambiguous ${identity} session ID ${identity === 'Claude' || identity === 'Remi' ? value.slice(0, 8) : value.slice(-8)}: ${matchCount} records; refusing to choose one`,
    );
    this.name = 'AmbiguousSessionIdentityError';
    this.identity = identity;
    this.value = value;
    this.matchCount = matchCount;
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, milliseconds);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The harness a stored record belongs to: absence means Claude (ADR 0032), so
 * a record with no `harness` and one naming `claude` read the same. An
 * unrecognized string is returned as is, never coerced to Claude.
 */
export function storedHarness(session: Pick<StoredSession, 'harness'>): string {
  return session.harness ?? DEFAULT_HARNESS;
}

/** True for a Claude record (no `harness`, or `claude`). */
export function isClaudeRecord(session: Pick<StoredSession, 'harness'>): boolean {
  return storedHarness(session) === DEFAULT_HARNESS;
}

/**
 * The harness-neutral identity of a stored record (ADR 0032, #1179): a Claude
 * record's is derived from `claudeSessionId` alone, so the two cannot differ;
 * another known harness reports its stored `harnessSessionId`, or null before it
 * has one. Null for a harness this build does not know, never a guess.
 */
export function identityOfRecord(stored: StoredSession): SessionIdentity | null {
  if (stored.harness === undefined) return identityFromClaudeId(stored.claudeSessionId);
  if (!isHarnessId(stored.harness)) return null;
  if (stored.harness === 'claude') return identityFromClaudeId(stored.claudeSessionId);
  return { harness: stored.harness, harnessSessionId: stored.harnessSessionId ?? null };
}

function parseStoredSession(value: unknown, index: number, filePath: string): StoredSession {
  if (!isRecord(value)) {
    throw new MalformedSessionStoreError(filePath, `session ${index} is not an object`);
  }

  const pid = value['pid'];
  const parsed: StoredSession = {
    remiSessionId: value['remiSessionId'] as UUID,
    claudeSessionId: value['claudeSessionId'] as string | null,
    projectPath: value['projectPath'] as string,
    port: value['port'] as number,
    pid: pid === undefined ? null : (pid as number | null),
    startedAt: value['startedAt'] as string,
    exitedAt: value['exitedAt'] as string | null,
    exitCode: value['exitCode'] as number | null,
  };

  const validPid = parsed.pid === null || (Number.isInteger(parsed.pid) && parsed.pid >= 0);
  const validExitCode = parsed.exitCode === null || typeof parsed.exitCode === 'number';
  const valid =
    typeof parsed.remiSessionId === 'string' &&
    (parsed.claudeSessionId === null || typeof parsed.claudeSessionId === 'string') &&
    typeof parsed.projectPath === 'string' &&
    Number.isFinite(parsed.port) &&
    validPid &&
    typeof parsed.startedAt === 'string' &&
    (parsed.exitedAt === null || typeof parsed.exitedAt === 'string') &&
    validExitCode;

  if (!valid) {
    throw new MalformedSessionStoreError(filePath, `session ${index} has invalid fields`);
  }

  // Harness identity (#1162). parseStoredSession rebuilds each record from the
  // keys it knows, so any key it does not copy here is dropped on the next
  // rewrite by whichever daemon writes. Copy these two when they are
  // well-typed; ignore them otherwise rather than throw, because one bad
  // optional field must not make the whole file unreadable. A key is only set
  // when present, so a legacy record stays an eight-key object.
  const harness = value['harness'];
  if (typeof harness === 'string') {
    parsed.harness = harness;
  }
  const harnessSessionId = value['harnessSessionId'];
  if (typeof harnessSessionId === 'string' || harnessSessionId === null) {
    parsed.harnessSessionId = harnessSessionId;
  }
  return parsed;
}

function assertUniqueSessionIdentities(sessions: readonly StoredSession[]): void {
  const remiIds = new Map<string, number>();
  const activeClaudeIds = new Map<string, number>();
  // Two simultaneous active owners of one non-Claude (harness, id) pair are as
  // unsafe as two of a Claude id: an answer or a resume could reach either.
  const activeHarnessIds = new Map<string, { harness: string; id: string; count: number }>();

  for (const session of sessions) {
    remiIds.set(session.remiSessionId, (remiIds.get(session.remiSessionId) ?? 0) + 1);

    if (
      !isClaudeRecord(session) &&
      typeof session.harnessSessionId === 'string' &&
      session.exitedAt === null
    ) {
      const key = `${storedHarness(session)}\0${session.harnessSessionId}`;
      const entry = activeHarnessIds.get(key) ?? {
        harness: storedHarness(session),
        id: session.harnessSessionId,
        count: 0,
      };
      entry.count += 1;
      activeHarnessIds.set(key, entry);
    }

    // A resumed Claude transcript legitimately has one exited historical Remi
    // row and one current active row. Only simultaneous active owners are an
    // unsafe ambiguity; findByClaudeSessionId handles the historical case.
    if (session.claudeSessionId !== null && session.exitedAt === null) {
      activeClaudeIds.set(
        session.claudeSessionId,
        (activeClaudeIds.get(session.claudeSessionId) ?? 0) + 1,
      );
    }
  }

  for (const [remiSessionId, count] of remiIds) {
    if (count > 1) {
      throw new AmbiguousSessionIdentityError('Remi', remiSessionId, count);
    }
  }
  for (const [claudeSessionId, count] of activeClaudeIds) {
    if (count > 1) {
      throw new AmbiguousSessionIdentityError('Claude', claudeSessionId, count);
    }
  }
  for (const { harness, id, count } of activeHarnessIds.values()) {
    if (count > 1) {
      throw new AmbiguousSessionIdentityError(harness, id, count);
    }
  }
}

function selectSessionMatch(
  matches: readonly StoredSession[],
  identity: string,
  sessionId: string,
): StoredSession | null {
  if (matches.length <= 1) return matches[0] ?? null;

  // A normal `--resume` creates a new active Remi row for the same harness
  // session while retaining the exited historical row. Prefer the single
  // active owner; multiple active owners remain an unsafe ambiguity.
  const active = matches.filter((session) => session.exitedAt === null);
  if (active.length === 1) return active[0] ?? null;

  throw new AmbiguousSessionIdentityError(identity, sessionId, matches.length);
}

function selectClaudeSessionMatch(
  matches: readonly StoredSession[],
  claudeSessionId: string,
): StoredSession | null {
  return selectSessionMatch(matches, 'Claude', claudeSessionId);
}

/**
 * A resume query named a session that ran under another harness (#1176).
 * `message` is what the CLI prints before exiting 1. For a Codex record with a
 * thread id it names the command that resumes it, `remi codex resume <thread
 * id>` (#1177), with the whole id; every other record gets no pointer, because
 * no other command exists in this build.
 */
export class SessionHarnessMismatchError extends Error {
  constructor(session: StoredSession) {
    const harness = storedHarness(session);
    super(
      harness === 'codex' && session.harnessSessionId
        ? `this session ran under codex; resume it with \`remi codex resume ${shellQuote(session.harnessSessionId)}\``
        : `this session ran under ${harness}; this build cannot resume it`,
    );
    this.name = 'SessionHarnessMismatchError';
  }
}

/**
 * Resolve a CLI resume query without ever choosing the first ambiguous row.
 *
 * `opts.harness` is the harness the caller resumes; only `claude` (`remi --resume`) has a caller
 * (#1179 removed the branch that matched another harness's own session id: `remi --sessions`
 * prints the whole resume command, and `remi codex resume <thread id>` takes a whole thread id,
 * so nothing resolves a Codex record by remi id or prefix). An exact or prefix Remi id that
 * names a record of another harness throws `SessionHarnessMismatchError`, so a Codex session is
 * never resumed as a Claude one. The fallback matches `claudeSessionId` of Claude records only,
 * so a non-Claude record can never be found by a Claude id. Without `opts.harness` a Remi id
 * resolves whatever the record's harness.
 */
export function resolveStoredSession(
  sessions: readonly StoredSession[],
  query: string,
  opts: { readonly harness?: 'claude' } = {},
): StoredSession | null {
  const { harness } = opts;
  // The type already refuses another harness; a cast around it must not get a Claude record back.
  if (harness !== undefined && harness !== DEFAULT_HARNESS) {
    throw new Error(`resolveStoredSession resolves ${DEFAULT_HARNESS} sessions only`);
  }
  const checked = (session: StoredSession | null): StoredSession | null => {
    if (session && harness !== undefined && storedHarness(session) !== harness) {
      throw new SessionHarnessMismatchError(session);
    }
    return session;
  };

  const exactRemi = sessions.filter((session) => session.remiSessionId === query);
  if (exactRemi.length > 1) {
    throw new AmbiguousSessionIdentityError('Remi', query, exactRemi.length);
  }
  if (exactRemi.length === 1) return checked(exactRemi[0] ?? null);

  const prefixRemi = sessions.filter((session) => session.remiSessionId.startsWith(query));
  if (prefixRemi.length > 1) {
    throw new AmbiguousSessionIdentityError('Remi', query, prefixRemi.length);
  }
  if (prefixRemi.length === 1) return checked(prefixRemi[0] ?? null);

  return selectClaudeSessionMatch(
    sessions.filter((session) => isClaudeRecord(session) && session.claudeSessionId === query),
    query,
  );
}

function parseLockOwner(raw: string, lockPath: string): SessionStoreLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InterprocessFileLockError(lockPath, 'owner metadata is not valid JSON');
  }

  if (!isRecord(value)) {
    throw new InterprocessFileLockError(lockPath, 'owner metadata is not an object');
  }

  const owner: SessionStoreLockOwner = {
    version: value['version'] as 1,
    ownerId: value['ownerId'] as string,
    pid: value['pid'] as number,
    host: value['host'] as string,
    acquiredAt: value['acquiredAt'] as number,
  };
  if (
    owner.version !== 1 ||
    typeof owner.ownerId !== 'string' ||
    owner.ownerId.length === 0 ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.host !== 'string' ||
    owner.host.length === 0 ||
    !Number.isFinite(owner.acquiredAt)
  ) {
    throw new InterprocessFileLockError(lockPath, 'owner metadata has invalid fields');
  }
  return owner;
}

function ensureLockDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Read and validate a lock without ever treating an unknown lock as free. */
function readLockSnapshot(lockPath: string): SessionStoreLockSnapshot | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw new InterprocessFileLockError(
      lockPath,
      `cannot inspect owner metadata: ${errorToString(err)}`,
    );
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new InterprocessFileLockError(lockPath, 'owner metadata is not a regular file');
  }

  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf-8');
  } catch (err) {
    // The owner may release the lock between lstatSync and readFileSync.
    // That is an ordinary unlocked state, not malformed metadata.
    if (errorCode(err) === 'ENOENT') return null;
    throw new InterprocessFileLockError(
      lockPath,
      `cannot read owner metadata: ${errorToString(err)}`,
    );
  }
  return { owner: parseLockOwner(raw, lockPath), mtimeMs: stat.mtimeMs };
}

/**
 * A lock is reclaimable only when all evidence agrees: same host, both the
 * owner timestamp and file mtime are old, and the recorded PID is dead.
 * Unknown hosts, future timestamps, malformed metadata, and live PIDs stay
 * locked. This bias prevents a filesystem or clock anomaly from creating
 * overlapping writers.
 */
function isStaleLock(snapshot: SessionStoreLockSnapshot): boolean {
  const now = Date.now();
  return (
    snapshot.owner.host === os.hostname() &&
    now - snapshot.owner.acquiredAt >= LOCK_STALE_AFTER_MS &&
    now - snapshot.mtimeMs >= LOCK_STALE_AFTER_MS &&
    !isProcessAlive(snapshot.owner.pid)
  );
}

/** Restore a lock moved during a raced stale-recovery attempt, without replace semantics. */
function restoreReclaimedLock(quarantinePath: string, lockPath: string): void {
  try {
    // A hard link gives us an exclusive restore: never overwrite a lock that
    // another process acquired while the old lock was quarantined.
    fs.linkSync(quarantinePath, lockPath);
    fs.unlinkSync(quarantinePath);
  } catch (err) {
    if (errorCode(err) === 'EEXIST') {
      // A new owner won while the old lock was quarantined. The old lock is no
      // longer needed, and deleting the quarantine cannot affect that owner.
      try {
        fs.unlinkSync(quarantinePath);
      } catch (cleanupErr) {
        if (errorCode(cleanupErr) !== 'ENOENT') {
          console.warn(
            `[sessions] Could not remove raced lock quarantine ${quarantinePath}: ${errorToString(cleanupErr)}`,
          );
        }
      }
      return;
    }
    console.warn(
      `[sessions] Could not restore raced lock ${quarantinePath}: ${errorToString(err)}`,
    );
  }
}

/**
 * Move a stale lock aside, verify its owner token did not change, then
 * remove it. The quarantine prevents a concurrent new owner from being
 * deleted by a stale-recovery cleanup.
 */
function reclaimStaleLock(lockPath: string, expected: SessionStoreLockOwner): boolean {
  const quarantinePath = `${lockPath}.recovery-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw new InterprocessFileLockError(lockPath, `stale recovery failed: ${errorToString(err)}`);
  }

  try {
    const recovered = readLockSnapshot(quarantinePath);
    if (!recovered || recovered.owner.ownerId !== expected.ownerId) {
      restoreReclaimedLock(quarantinePath, lockPath);
      throw new InterprocessFileLockError(lockPath, 'lock owner changed during stale recovery');
    }
    fs.unlinkSync(quarantinePath);
    return true;
  } catch (err) {
    if (err instanceof InterprocessFileLockError) {
      // If validation failed after the move, put the exact lock back when it
      // is still safe to do so. Never delete an owner we cannot identify.
      if (fs.existsSync(quarantinePath)) restoreReclaimedLock(quarantinePath, lockPath);
      throw err;
    }
    throw new InterprocessFileLockError(
      lockPath,
      `stale recovery cleanup failed: ${errorToString(err)}`,
    );
  }
}

/** Acquire the bounded cross-process lock used by the durable JSON stores. */
function acquireInterprocessFileLock(filePath: string): SessionStoreLockHandle {
  ensureLockDirectory(filePath);
  const lockPath = `${filePath}${LOCK_SUFFIX}`;
  const owner: SessionStoreLockOwner = {
    version: 1,
    ownerId: randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: Date.now(),
  };
  const deadline = performance.now() + LOCK_WAIT_TIMEOUT_MS;

  while (performance.now() < deadline) {
    const candidatePath = `${lockPath}.${owner.ownerId}.tmp`;
    try {
      // Write the complete metadata to a unique sibling first. Linking that
      // file into the well-known path is the ownership decision: contenders
      // cannot observe a partially-written JSON document between O_EXCL
      // creation and the metadata write.
      fs.writeFileSync(candidatePath, JSON.stringify(owner), {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      });
      try {
        fs.linkSync(candidatePath, lockPath);
        return { lockPath, owner };
      } catch (err) {
        if (errorCode(err) !== 'EEXIST') {
          throw new InterprocessFileLockError(
            lockPath,
            `cannot publish owner metadata: ${errorToString(err)}`,
          );
        }
      } finally {
        // The hard link (when successful) keeps the published copy alive;
        // when another writer won, this candidate was never visible as the
        // lock. Either way it must not survive the attempt.
        try {
          fs.unlinkSync(candidatePath);
        } catch (err) {
          if (errorCode(err) !== 'ENOENT') {
            console.warn(
              `[sessions] Could not remove lock candidate ${candidatePath}: ${errorToString(err)}`,
            );
          }
        }
      }
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        throw new InterprocessFileLockError(
          lockPath,
          `cannot create lock candidate: ${errorToString(err)}`,
        );
      }
    }

    const snapshot = readLockSnapshot(lockPath);
    if (snapshot && isStaleLock(snapshot)) {
      if (reclaimStaleLock(lockPath, snapshot.owner)) continue;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    sleepSync(Math.min(LOCK_RETRY_DELAY_MS, remaining));
  }

  throw new InterprocessFileLockError(lockPath, `timed out after ${LOCK_WAIT_TIMEOUT_MS}ms`, {
    retryable: true,
  });
}

/** Release only our own lock; never unlink a replacement owner. */
function releaseInterprocessFileLock(handle: SessionStoreLockHandle): void {
  let snapshot: SessionStoreLockSnapshot | null;
  try {
    snapshot = readLockSnapshot(handle.lockPath);
  } catch (err) {
    console.warn(`[sessions] Could not inspect lock during release: ${errorToString(err)}`);
    return;
  }
  if (!snapshot || snapshot.owner.ownerId !== handle.owner.ownerId) return;

  try {
    fs.unlinkSync(handle.lockPath);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      console.warn(`[sessions] Could not remove lock ${handle.lockPath}: ${errorToString(err)}`);
    }
  }
}

/** Serialize one complete read-modify-write transaction across processes. */
export function withInterprocessFileLock<T>(filePath: string, operation: () => T): T {
  const lock = acquireInterprocessFileLock(filePath);
  try {
    return operation();
  } finally {
    releaseInterprocessFileLock(lock);
  }
}

export class SessionStore {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? SESSIONS_FILE;
  }

  /** Ensure the ~/.remi directory exists. */
  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Read sessions file, returning an empty list only when it is missing.
   * I/O errors (permissions, disk) are propagated so callers that
   * write back (purgeStale, save) do not overwrite with empty data. Malformed
   * JSON and invalid records are also errors: treating them as an empty store
   * would erase durable ownership evidence on the next write.
   */
  private read(): StoredSession[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return [];
      throw err;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new MalformedSessionStoreError(this.filePath, 'file is not valid JSON');
    }

    if (!isRecord(data) || data['version'] !== 1 || !Array.isArray(data['sessions'])) {
      throw new MalformedSessionStoreError(
        this.filePath,
        'expected version 1 with a sessions array',
      );
    }

    return data['sessions'].map((value, index) => {
      const session = parseStoredSession(value, index, this.filePath);
      // Self-heal a tilde-form or otherwise unnormalized projectPath (#680):
      // every read re-normalizes so a legacy entry (or one written by an
      // older binary) becomes safe to `chdir`/compare against without a
      // dedicated migration. Mirrors SessionRegistryFile's persist-side fix
      // for #674; not written back to disk here, but any subsequent write()
      // (save/markExited/updateClaudeSessionId/purge) persists the fix.
      session.projectPath = normalizeProjectPath(session.projectPath);
      return session;
    });
  }

  /** Serialize one complete read-modify-write transaction across processes. */
  private withWriteLock<T>(operation: () => T): T {
    return withInterprocessFileLock(this.filePath, operation);
  }

  /**
   * Write sessions to file (atomic via tmp + rename).
   *
   * Callers hold the sibling lock for the complete read-modify-write
   * transaction. Atomic rename protects readers from torn JSON, but cannot
   * prevent two processes from overwriting each other's updates.
   */
  private write(sessions: StoredSession[]): void {
    this.ensureDir();
    const data: SessionsFile = { version: 1, sessions };
    // Per-writer-unique tmp path. A fixed `${filePath}.tmp` shared across
    // processes is a multi-writer race (#461): when two daemons in the same
    // ~/.remi write concurrently, both target the same tmp file and whichever
    // renames second hits ENOENT because the first already moved it away.
    // The pid scopes the tmp per process; the synchronous write+rename
    // serialize within a process, so the pid alone makes collisions impossible.
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    try {
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      // Don't leave our tmp file behind if the rename fails.
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // best-effort cleanup; surface the original error
      }
      throw err;
    }
  }

  /**
   * Save or update a session record. Trims to MAX_SESSIONS. Normalizes
   * `projectPath` (expands `~`, resolves to absolute) before persisting, so a
   * caller passing a raw, unexpanded path never writes a malformed entry that
   * `--resume` would later `chdir` into (#680). Mirrors SessionRegistryFile's
   * `register()` fix for the live-sessions registry (#674).
   *
   * Returns the normalized record so a caller that mirrors it elsewhere (e.g.
   * `SessionBindingStore.preAssign` seeding `TranscriptIndex`) uses the same
   * normalized `projectPath` this store actually persisted, instead of
   * silently diverging from it (#680 review).
   */
  save(session: StoredSession): StoredSession {
    const normalized: StoredSession = {
      ...session,
      projectPath: normalizeProjectPath(session.projectPath),
    };
    return this.withWriteLock(() => {
      const sessions = this.read();
      assertUniqueSessionIdentities(sessions);
      const idx = sessions.findIndex((s) => s.remiSessionId === normalized.remiSessionId);
      if (idx >= 0) {
        sessions[idx] = normalized;
      } else {
        sessions.push(normalized);
      }
      // Trim oldest exited sessions if over limit
      if (sessions.length > MAX_SESSIONS) {
        const exited = sessions.filter((s) => s.exitedAt !== null);
        exited.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
        const toRemove = sessions.length - MAX_SESSIONS;
        const removeIds = new Set(exited.slice(0, toRemove).map((s) => s.remiSessionId));
        const trimmed = sessions.filter((s) => !removeIds.has(s.remiSessionId));
        assertUniqueSessionIdentities(trimmed);
        this.write(trimmed);
        return normalized;
      }
      assertUniqueSessionIdentities(sessions);
      this.write(sessions);
      return normalized;
    });
  }

  /**
   * Purge stale sessions: mark dead "running" sessions as exited,
   * and remove exited sessions older than STALE_AGE_MS.
   * Returns whether changes were written and the (possibly updated) session list.
   *
   * Note: PID recycling could cause a false "alive" result for a stale session
   * whose PID was reused by an unrelated process. This is acceptable because
   * the 7-day age pruning will eventually clean it, and PID collisions for
   * short-lived CLI processes are rare in practice.
   */
  private doPurge(): { changed: boolean; sessions: StoredSession[] } {
    return this.withWriteLock(() => {
      const sessions = this.read();
      assertUniqueSessionIdentities(sessions);
      let changed = false;
      const now = Date.now();

      for (const s of sessions) {
        if (s.exitedAt !== null) continue;
        // No PID stored (legacy entry) or PID is dead: mark as exited
        if (s.pid === null || !isProcessAlive(s.pid)) {
          s.exitedAt = new Date().toISOString();
          s.exitCode = null;
          changed = true;
        }
      }

      // Remove exited sessions older than 7 days
      const before = sessions.length;
      const kept = sessions.filter((s) => {
        if (s.exitedAt === null) return true;
        const exitedTime = new Date(s.exitedAt).getTime();
        if (Number.isNaN(exitedTime)) return true; // keep entries with invalid dates
        return now - exitedTime < STALE_AGE_MS;
      });

      if (kept.length !== before) changed = true;

      if (changed) {
        assertUniqueSessionIdentities(kept);
        this.write(kept);
      }
      return { changed, sessions: kept };
    });
  }

  /** Purge stale sessions. Returns true if any changes were written. */
  purgeStale(): boolean {
    return this.doPurge().changed;
  }

  /** List all stored sessions, most recent first. Best-effort purge of stale entries. */
  list(): StoredSession[] {
    try {
      const { sessions } = this.doPurge();
      return sessions.sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
    } catch (purgeErr) {
      if (!(purgeErr instanceof InterprocessFileLockError && purgeErr.retryable)) throw purgeErr;
      console.warn(`[sessions] Purge failed: ${errorToString(purgeErr)}`);
      return this.read().sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
    }
  }

  /** Find a session by its Claude session ID. */
  findByClaudeSessionId(claudeSessionId: string): StoredSession | null {
    const sessions = this.read();
    // Claude records only: a record of another harness never answers to a
    // Claude id, whatever its `claudeSessionId` column holds (#1176).
    const matches = sessions.filter(
      (s) => isClaudeRecord(s) && s.claudeSessionId === claudeSessionId,
    );
    return selectClaudeSessionMatch(matches, claudeSessionId);
  }

  /** Find a session by its Remi session ID. */
  findByRemiSessionId(remiSessionId: UUID): StoredSession | null {
    const sessions = this.read();
    const matches = sessions.filter((s) => s.remiSessionId === remiSessionId);
    if (matches.length > 1) {
      throw new AmbiguousSessionIdentityError('Remi', remiSessionId, matches.length);
    }
    return matches[0] ?? null;
  }

  /**
   * Get the most recent session (by startedAt). With `harness`, the most
   * recent record of that harness (#1176): `remi --resume` asks for `claude`,
   * so a newer Codex session is not picked as the one to resume. Without it,
   * the newest record of any harness.
   */
  getMostRecent(harness?: HarnessId): StoredSession | null {
    const sessions = this.list();
    if (harness === undefined) return sessions[0] ?? null;
    return sessions.find((s) => storedHarness(s) === harness) ?? null;
  }

  /** Mark a session as exited. */
  markExited(remiSessionId: UUID, exitCode: number | null): void {
    this.withWriteLock(() => {
      const sessions = this.read();
      assertUniqueSessionIdentities(sessions);
      const session = sessions.find((s) => s.remiSessionId === remiSessionId);
      if (session) {
        session.exitedAt = new Date().toISOString();
        session.exitCode = exitCode;
        assertUniqueSessionIdentities(sessions);
        this.write(sessions);
      }
    });
  }

  /**
   * Update the Claude session ID (extracted from transcript after startup).
   * Returns the updated record (already in memory from the read-modify-write) so
   * callers that mirror the binding elsewhere don't need a second disk read — a
   * separate read could race a concurrent purgeStale() and observe a null record
   * mid-rotation (#577). Returns null when no record exists (a no-op, as before).
   * Throws for a record of another harness: its identity is not a Claude id.
   */
  updateClaudeSessionId(remiSessionId: UUID, claudeSessionId: string): StoredSession | null {
    return this.withWriteLock(() => {
      const sessions = this.read();
      assertUniqueSessionIdentities(sessions);
      const session = sessions.find((s) => s.remiSessionId === remiSessionId);
      if (session && !isClaudeRecord(session)) {
        // A non-Claude record keeps its own identity in `harnessSessionId`
        // (`updateHarnessIdentity`); a Claude id written onto it would make
        // it answer to both (#1176).
        throw new Error(
          `updateClaudeSessionId: session ${remiSessionId} belongs to harness ${storedHarness(session)}, not claude`,
        );
      }
      if (session) {
        session.claudeSessionId = claudeSessionId;
        assertUniqueSessionIdentities(sessions);
        this.write(sessions);
        return session;
      }
      return null;
    });
  }

  /**
   * Record a non-Claude harness's own session id on a session (#1176), the
   * counterpart of `updateClaudeSessionId`: it sets `harness` and
   * `harnessSessionId` together, returns the updated record, and returns null
   * when no record exists. Two things are refused, by throwing. `claude`: its
   * record stores neither field (ADR 0032) and its id is `claudeSessionId`, so
   * writing `harness: 'claude'` would give Claude records two shapes. A record
   * that names a different harness: a record is created naming its own
   * (`preAssign`), and this only fills in the id. It also rejects a second
   * active record holding the same pair, before writing.
   */
  updateHarnessIdentity(
    remiSessionId: UUID,
    harness: Exclude<HarnessId, 'claude'>,
    harnessSessionId: string,
  ): StoredSession | null {
    if ((harness as string) === DEFAULT_HARNESS) {
      throw new Error(
        'updateHarnessIdentity does not take claude: a Claude identity is claudeSessionId (use updateClaudeSessionId)',
      );
    }
    return this.withWriteLock(() => {
      const sessions = this.read();
      assertUniqueSessionIdentities(sessions);
      const session = sessions.find((s) => s.remiSessionId === remiSessionId);
      if (!session) return null;
      if (storedHarness(session) !== harness) {
        // The record is created naming its harness (`preAssign`); this only
        // fills in the id. Re-labeling a record would leave a Claude row
        // carrying another harness's id, or the reverse.
        throw new Error(
          `updateHarnessIdentity: session ${remiSessionId} belongs to harness ${storedHarness(session)}, not ${harness}`,
        );
      }
      session.harness = harness;
      session.harnessSessionId = harnessSessionId;
      assertUniqueSessionIdentities(sessions);
      this.write(sessions);
      return session;
    });
  }
}
