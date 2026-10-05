// Shared durable-store transaction lock (#873). Extracted without changing ownership semantics.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';
import { isProcessAlive } from '../session/process-alive.ts';
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
