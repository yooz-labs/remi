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
import { errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { normalizeProjectPath } from '../cli/path-resolver.ts';
import { isProcessAlive } from './process-alive.ts';

export interface StoredSession {
  remiSessionId: UUID;
  claudeSessionId: string | null;
  projectPath: string;
  port: number;
  pid: number | null;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
}

interface SessionsFile {
  version: 1;
  sessions: StoredSession[];
}

const REMI_DIR = path.join(os.homedir(), '.remi');
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

export class SessionStoreLockError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, reason: string) {
    super(`Could not acquire session store lock ${lockPath}: ${reason}`);
    this.name = 'SessionStoreLockError';
    this.lockPath = lockPath;
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
  return parsed;
}

function parseLockOwner(raw: string, lockPath: string): SessionStoreLockOwner {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SessionStoreLockError(lockPath, 'owner metadata is not valid JSON');
  }

  if (!isRecord(value)) {
    throw new SessionStoreLockError(lockPath, 'owner metadata is not an object');
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
    throw new SessionStoreLockError(lockPath, 'owner metadata has invalid fields');
  }
  return owner;
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
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf-8');

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

  /** Read and validate the lock without ever treating an unknown lock as free. */
  private readLockSnapshot(lockPath: string): SessionStoreLockSnapshot | null {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lockPath);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return null;
      throw new SessionStoreLockError(
        lockPath,
        `cannot inspect owner metadata: ${errorToString(err)}`,
      );
    }

    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SessionStoreLockError(lockPath, 'owner metadata is not a regular file');
    }

    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, 'utf-8');
    } catch (err) {
      // The owner may release the lock between lstatSync and readFileSync.
      // That is an ordinary unlocked state, not malformed metadata.
      if (errorCode(err) === 'ENOENT') return null;
      throw new SessionStoreLockError(
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
  private isStaleLock(snapshot: SessionStoreLockSnapshot): boolean {
    const now = Date.now();
    return (
      snapshot.owner.host === os.hostname() &&
      now - snapshot.owner.acquiredAt >= LOCK_STALE_AFTER_MS &&
      now - snapshot.mtimeMs >= LOCK_STALE_AFTER_MS &&
      !isProcessAlive(snapshot.owner.pid)
    );
  }

  /** Restore a lock moved during a raced stale-recovery attempt, without replace semantics. */
  private restoreReclaimedLock(quarantinePath: string, lockPath: string): void {
    try {
      // A hard link gives us an exclusive restore: never overwrite a lock that
      // another process acquired while the old lock was quarantined.
      fs.linkSync(quarantinePath, lockPath);
      fs.unlinkSync(quarantinePath);
    } catch (err) {
      if (errorCode(err) === 'EEXIST') return;
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
  private reclaimStaleLock(lockPath: string, expected: SessionStoreLockOwner): boolean {
    const quarantinePath = `${lockPath}.recovery-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, quarantinePath);
    } catch (err) {
      if (errorCode(err) === 'ENOENT') return false;
      throw new SessionStoreLockError(lockPath, `stale recovery failed: ${errorToString(err)}`);
    }

    try {
      const recovered = this.readLockSnapshot(quarantinePath);
      if (!recovered || recovered.owner.ownerId !== expected.ownerId) {
        this.restoreReclaimedLock(quarantinePath, lockPath);
        throw new SessionStoreLockError(lockPath, 'lock owner changed during stale recovery');
      }
      fs.unlinkSync(quarantinePath);
      return true;
    } catch (err) {
      if (err instanceof SessionStoreLockError) {
        // If validation failed after the move, put the exact lock back when it
        // is still safe to do so. Never delete an owner we cannot identify.
        if (fs.existsSync(quarantinePath)) this.restoreReclaimedLock(quarantinePath, lockPath);
        throw err;
      }
      throw new SessionStoreLockError(
        lockPath,
        `stale recovery cleanup failed: ${errorToString(err)}`,
      );
    }
  }

  /** Acquire the bounded cross-process lock used by every write transaction. */
  private acquireWriteLock(): SessionStoreLockHandle {
    this.ensureDir();
    const lockPath = `${this.filePath}${LOCK_SUFFIX}`;
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
            throw new SessionStoreLockError(
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
          throw new SessionStoreLockError(
            lockPath,
            `cannot create lock candidate: ${errorToString(err)}`,
          );
        }
      }

      const snapshot = this.readLockSnapshot(lockPath);
      if (snapshot && this.isStaleLock(snapshot)) {
        if (this.reclaimStaleLock(lockPath, snapshot.owner)) continue;
      }

      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      sleepSync(Math.min(LOCK_RETRY_DELAY_MS, remaining));
    }

    throw new SessionStoreLockError(lockPath, `timed out after ${LOCK_WAIT_TIMEOUT_MS}ms`);
  }

  /** Release only our own lock; never unlink a replacement owner. */
  private releaseWriteLock(handle: SessionStoreLockHandle): void {
    let snapshot: SessionStoreLockSnapshot | null;
    try {
      snapshot = this.readLockSnapshot(handle.lockPath);
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
  private withWriteLock<T>(operation: () => T): T {
    const lock = this.acquireWriteLock();
    try {
      return operation();
    } finally {
      this.releaseWriteLock(lock);
    }
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
        this.write(trimmed);
        return normalized;
      }
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

      if (changed) this.write(kept);
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
      console.warn(`[sessions] Purge failed: ${errorToString(purgeErr)}`);
      try {
        return this.read().sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
      } catch {
        return [];
      }
    }
  }

  /** Find a session by its Claude session ID. */
  findByClaudeSessionId(claudeSessionId: string): StoredSession | null {
    const sessions = this.read();
    const matches = sessions.filter((s) => s.claudeSessionId === claudeSessionId);
    if (matches.length > 1) {
      console.warn(
        `[sessions] Ambiguous Claude session ID ${claudeSessionId.slice(0, 8)}: ${matches.length} records; refusing to select one`,
      );
      return null;
    }
    return matches[0] ?? null;
  }

  /** Find a session by its Remi session ID. */
  findByRemiSessionId(remiSessionId: UUID): StoredSession | null {
    const sessions = this.read();
    const matches = sessions.filter((s) => s.remiSessionId === remiSessionId);
    if (matches.length > 1) {
      console.warn(
        `[sessions] Ambiguous Remi session ID ${remiSessionId.slice(0, 8)}: ${matches.length} records; refusing to select one`,
      );
      return null;
    }
    return matches[0] ?? null;
  }

  /** Get the most recent session (by startedAt). */
  getMostRecent(): StoredSession | null {
    const sessions = this.list();
    return sessions[0] ?? null;
  }

  /** Mark a session as exited. */
  markExited(remiSessionId: UUID, exitCode: number | null): void {
    this.withWriteLock(() => {
      const sessions = this.read();
      const session = sessions.find((s) => s.remiSessionId === remiSessionId);
      if (session) {
        session.exitedAt = new Date().toISOString();
        session.exitCode = exitCode;
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
   */
  updateClaudeSessionId(remiSessionId: UUID, claudeSessionId: string): StoredSession | null {
    return this.withWriteLock(() => {
      const sessions = this.read();
      const session = sessions.find((s) => s.remiSessionId === remiSessionId);
      if (session) {
        session.claudeSessionId = claudeSessionId;
        this.write(sessions);
        return session;
      }
      return null;
    });
  }
}
