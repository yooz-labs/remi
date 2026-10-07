/**
 * Log rotation for `~/.remi/remi.log`, `~/.remi/daemon.log`, the LaunchAgent's
 * `remi-stdout.log` / `remi-stderr.log`, and the opt-in debug sinks. None was
 * ever rotated (#726); on a long-running machine they grew unbounded (85MB /
 * 24MB observed in the wild).
 *
 * COPY, THEN TRUNCATE IN PLACE (#729). The live file keeps its inode, so every
 * process that holds it open keeps writing to the live file: the hub's own
 * stdout, launchd's descriptor for `remi-stdout.log`, and each sibling daemon
 * spawned onto `daemon.log`. The rename this replaced could not retarget a
 * held descriptor: a hub kept writing to `.1`, then `.2`, then an unlinked
 * file, so its log vanished two rotations in.
 *
 * It needs every writer to have opened the file for append (`O_APPEND`), so
 * the next write lands at the new end. A writer without it keeps its own
 * offset, and the file fills with NUL bytes up to it. remi opens its logs with
 * `'a'`, `appendFileSync` appends, and launchd opens `StandardOutPath` and
 * `StandardErrorPath` for append (verified with `lsof +fg`: `R,W,AP`). What
 * remi cannot see is someone else's descriptor: a daemon started with
 * `> ~/.remi/daemon.log` checks its own stdout (`planStdioLogGuard`) and
 * leaves that file alone, but another remi process rotating `daemon.log` would
 * still pad it. Use `>>`.
 *
 * One rotation at a time (#1262 review): a rotation holds `<file>.lock`
 * (created exclusively), re-checks the size under it, copies to a temp file,
 * and only then shifts the backups, renames the copy to `.1` and truncates.
 * Without the lock a second process copied the just-emptied file over the
 * first one's `.1`; without the copy-first order a copy that kept failing
 * dropped a backup on every retry. A lock older than `STALE_ROTATION_LOCK_MS`
 * is a crashed rotation's and is cleared; so is its temp copy.
 *
 * Two ways in:
 * - `rotateIfNeeded` before an open (a wrapper's log session, a daemon spawn)
 *   and before each append to a debug sink (`appendBounded`);
 * - `guardLogFiles` for a process that never reopens: it checks the files it
 *   writes to every `LOG_GUARD_INTERVAL_MS`, so a file can pass the bound by
 *   up to that much output before it is rotated.
 *
 * Lines written between the copy and the truncate are lost (a window of one
 * file copy).
 */

import { FFIType, dlopen } from 'bun:ffi';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';

/** Default rotation threshold: 10MB. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Default number of rotated backups to retain (`.1` through `.keep`). */
export const LOG_KEEP = 2;

/** How often `guardLogFiles` checks the files a long-lived process writes to. */
export const LOG_GUARD_INTERVAL_MS = 5 * 60 * 1000;

/** A rotation lock older than this was left by a crashed rotation (one takes
 *  well under a second) and is cleared. */
export const STALE_ROTATION_LOCK_MS = 10 * 60 * 1000;

export interface RotateOptions {
  /** Rotate once the file reaches this size in bytes. Default `LOG_MAX_BYTES`. */
  readonly maxBytes?: number;
  /** Number of rotated backups to retain. Default `LOG_KEEP`. */
  readonly keep?: number;
}

/**
 * Rotate `filePath` if it has reached `maxBytes`: under its lock, copy it to a
 * temp file, drop the oldest backup and shift the rest (`.1` -> `.2` -> ...
 * up to `keep`), rename the copy to `.1`, and truncate `filePath` in place.
 * Nothing is shifted or truncated unless the copy succeeded, so a failed
 * rotation loses nothing. Never throws: a rotation failure must never break
 * logging for the caller.
 *
 * Returns `true` only when this call rotated the file. `false` when it is
 * missing, not a regular file, under the bound, being rotated by another
 * process (or was just rotated by one), or a step failed (logged).
 */
export function rotateIfNeeded(filePath: string, opts?: RotateOptions): boolean {
  const maxBytes = opts?.maxBytes ?? LOG_MAX_BYTES;
  const keep = opts?.keep ?? LOG_KEEP;

  if (!reachedBound(filePath, maxBytes)) return false;
  const lock = `${filePath}.lock`;
  if (!takeLock(lock)) return false;
  try {
    // Another process may have rotated it between the check and the lock.
    if (!reachedBound(filePath, maxBytes)) return false;
    removeAbandonedCopies(filePath);

    const copy = `${filePath}.rotating-${process.pid}`;
    try {
      fs.copyFileSync(filePath, copy);
    } catch (err) {
      warn(`copy ${filePath}`, err);
      removeQuietly(copy);
      return false;
    }

    try {
      fs.unlinkSync(`${filePath}.${keep}`);
    } catch (err) {
      warnUnlessMissing(err, `drop oldest backup ${filePath}.${keep}`);
    }
    for (let n = keep - 1; n >= 1; n--) {
      try {
        fs.renameSync(`${filePath}.${n}`, `${filePath}.${n + 1}`);
      } catch (err) {
        warnUnlessMissing(err, `shift backup ${filePath}.${n} -> .${n + 1}`);
      }
    }
    try {
      fs.renameSync(copy, `${filePath}.1`);
    } catch (err) {
      warn(`rename ${copy} -> ${filePath}.1`, err);
      removeQuietly(copy);
      return false;
    }

    try {
      fs.truncateSync(filePath, 0);
    } catch (err) {
      warn(`truncate ${filePath}`, err);
      return false;
    }
    return true;
  } finally {
    removeQuietly(lock);
  }
}

/** Whether `filePath` is a regular file of at least `maxBytes`. */
function reachedBound(filePath: string, maxBytes: number): boolean {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size >= maxBytes;
  } catch (err) {
    warnUnlessMissing(err, `stat ${filePath}`);
    return false;
  }
}

/**
 * Create `lock` exclusively. When it already exists another process is
 * rotating, unless the lock is older than `STALE_ROTATION_LOCK_MS`: then a
 * rotation crashed holding it, and it is cleared so the next check rotates.
 */
function takeLock(lock: string): boolean {
  try {
    fs.closeSync(fs.openSync(lock, 'wx'));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      warn(`lock ${lock}`, err);
      return false;
    }
  }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > STALE_ROTATION_LOCK_MS) fs.unlinkSync(lock);
  } catch {
    // Released or cleared meanwhile: the next check takes it.
  }
  return false;
}

/** Remove temp copies a crashed rotation left. Only the lock holder copies, so
 *  any that exist while it holds the lock are abandoned. */
function removeAbandonedCopies(filePath: string): void {
  const prefix = `${path.basename(filePath)}.rotating-`;
  const dir = path.dirname(filePath);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix)) removeQuietly(path.join(dir, name));
    }
  } catch (err) {
    warn(`list ${dir}`, err);
  }
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    warnUnlessMissing(err, `remove ${file}`);
  }
}

/**
 * Keep `paths` bounded for as long as this process runs (#729): every
 * `intervalMs` (default `LOG_GUARD_INTERVAL_MS`) each one is rotated if it
 * reached the bound. For a process that holds its log open and never reopens
 * it (a hub, a session daemon, a long wrapper session). The timer does not
 * keep the process alive. Returns a function that stops it; with no paths it
 * starts nothing.
 */
export function guardLogFiles(
  paths: readonly string[],
  opts?: RotateOptions & { readonly intervalMs?: number },
): () => void {
  if (paths.length === 0) return () => {};
  const timer = setInterval(() => {
    for (const p of paths) rotateIfNeeded(p, opts);
  }, opts?.intervalMs ?? LOG_GUARD_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** `O_APPEND` and `F_GETFL`, which differ by platform. */
const O_APPEND_DARWIN = 0x8;
const O_APPEND_LINUX = 0o2000;
const F_GETFL = 3;

let fcntl: ((fd: number, cmd: number) => number) | null | undefined;

/**
 * Whether descriptor `fd` was opened for append (#1262 review), so a file
 * behind it can be truncated in place safely. Read from the kernel: on Linux
 * from `/proc/self/fdinfo`, on macOS with `fcntl(F_GETFL)`. `null` when it
 * cannot be read, which callers treat as "do not truncate".
 */
export function fdAppends(fd: number): boolean | null {
  if (process.platform === 'linux') {
    try {
      const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
      const flags = /^flags:\s*([0-7]+)$/m.exec(info)?.[1];
      return flags === undefined ? null : (Number.parseInt(flags, 8) & O_APPEND_LINUX) !== 0;
    } catch {
      return null;
    }
  }
  if (process.platform !== 'darwin') return null;
  if (fcntl === undefined) {
    try {
      // `F_GETFL` takes no third argument, so the two fixed arguments are the
      // whole call even though `fcntl` is variadic.
      const lib = dlopen('/usr/lib/libSystem.B.dylib', {
        fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      fcntl = (d, cmd) => lib.symbols.fcntl(d, cmd) as number;
    } catch {
      fcntl = null;
    }
  }
  if (fcntl === null) return null;
  const flags = fcntl(fd, F_GETFL);
  return flags < 0 ? null : (flags & O_APPEND_DARWIN) !== 0;
}

export interface StdioLogPlan {
  /** The candidate files this process writes to, every descriptor on each in append mode. */
  readonly guarded: string[];
  /** One line per descriptor file left alone, saying why. */
  readonly notices: string[];
}

/**
 * Which of `candidates` this process may keep bounded (#729): the ones its
 * descriptors `fds` (stdout and stderr) write to, matched by device and inode.
 * A daemon's stdout and stderr are whatever its launcher opened (launchd's
 * `remi-stdout.log`, `remi start`'s `daemon.log`, a terminal, a pipe).
 *
 * A file is guarded only when every one of those descriptors on it appends:
 * truncating under a descriptor that does not (a `>` redirect) would pad the
 * file with NUL bytes (#1262 review). A file left alone for that reason, or
 * because it is not one of `candidates`, gets a notice; a terminal, a pipe or
 * a descriptor that is not open is skipped quietly.
 */
export function planStdioLogGuard(
  fds: readonly number[],
  candidates: readonly string[],
): StdioLogPlan {
  const byFile = new Map<string, number[]>();
  for (const fd of fds) {
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) continue;
      const key = `${st.dev}:${st.ino}`;
      byFile.set(key, [...(byFile.get(key) ?? []), fd]);
    } catch {
      // Not open: nothing to guard.
    }
  }
  const known = new Map<string, string>();
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      known.set(`${st.dev}:${st.ino}`, candidate);
    } catch {
      // Not there: nothing writes to it.
    }
  }

  const guarded: string[] = [];
  const notices: string[] = [];
  for (const [key, held] of byFile) {
    const names = held.map(descriptorName).join(' and ');
    const file = known.get(key);
    if (file === undefined) {
      notices.push(`Not rotating ${names}: a file remi does not manage.`);
      continue;
    }
    const modes = held.map(fdAppends);
    if (modes.every((m) => m === true)) {
      guarded.push(file);
      continue;
    }
    const why = modes.includes(false)
      ? 'was opened without append (a > redirect?)'
      : 'could not be checked for append mode';
    notices.push(
      `Not rotating ${path.basename(file)}: ${names} ${why}, and truncating it would pad it with NUL bytes. Open it with >> to have it rotated.`,
    );
  }
  return { guarded, notices };
}

function descriptorName(fd: number): string {
  if (fd === 1) return 'stdout';
  if (fd === 2) return 'stderr';
  return `descriptor ${fd}`;
}

/**
 * Append `text` to `filePath`, rotating it first once it reached the bound
 * (#729): for the opt-in debug sinks (`hook-diag.jsonl`, `question-trace.jsonl`,
 * the PTY capture), which a long debug session would otherwise grow forever.
 * A failed append throws, as `appendFileSync` does, so the caller can report it.
 */
export function appendBounded(filePath: string, text: string, opts?: RotateOptions): void {
  rotateIfNeeded(filePath, opts);
  fs.appendFileSync(filePath, text);
}

/** Logs unexpected fs errors; ENOENT ("nothing there yet") is expected and silent. */
function warnUnlessMissing(err: unknown, op: string): void {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
  warn(op, err);
}

/** Best-effort stderr notice. Never throws: a rotation failure must never break logging. */
function warn(op: string, err: unknown): void {
  try {
    console.error(`[remi] log rotation failed (${op}): ${errorToString(err)}`);
  } catch {
    // stderr may be unavailable; nothing more to do.
  }
}
