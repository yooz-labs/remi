/**
 * Log rotation for `~/.remi/remi.log`, `~/.remi/daemon.log`, the LaunchAgent's
 * `remi-stdout.log` / `remi-stderr.log`, and the opt-in debug sinks. None was
 * ever rotated (#726); on a long-running machine they grew unbounded (85MB /
 * 24MB observed in the wild).
 *
 * COPY, THEN TRUNCATE IN PLACE (#729). The live file keeps its inode, so every
 * process that holds it open keeps writing to the live file: the hub's own
 * stdout, launchd's descriptor for `remi-stdout.log`, and each sibling daemon
 * spawned onto `daemon.log`. That needs every writer to have opened the file
 * for append (`O_APPEND`), so the next write lands at the new end: remi opens
 * its logs with `'a'`, `appendFileSync` appends, and launchd opens
 * `StandardOutPath` and `StandardErrorPath` for append (verified with
 * `lsof +fg`: `R,W,AP`). The rename this replaced could not retarget a held
 * descriptor: a hub kept writing to `.1`, then `.2`, then an unlinked file,
 * so its log vanished two rotations in.
 *
 * Two ways in:
 * - `rotateIfNeeded` before an open (a wrapper's log session, a daemon spawn)
 *   and before each append to a debug sink (`appendBounded`);
 * - `guardLogFiles` for a process that never reopens: it checks the files it
 *   writes to every `LOG_GUARD_INTERVAL_MS`.
 *
 * Lines written between the copy and the truncate are lost (a window of one
 * file copy). No cross-process locking: two processes rotating the same file
 * at once can lose a backup generation, not the live file or a crash.
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';

/** Default rotation threshold: 10MB. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Default number of rotated backups to retain (`.1` through `.keep`). */
export const LOG_KEEP = 2;

/** How often `guardLogFiles` checks the files a long-lived process writes to. */
export const LOG_GUARD_INTERVAL_MS = 5 * 60 * 1000;

export interface RotateOptions {
  /** Rotate once the file reaches this size in bytes. Default `LOG_MAX_BYTES`. */
  readonly maxBytes?: number;
  /** Number of rotated backups to retain. Default `LOG_KEEP`. */
  readonly keep?: number;
}

/**
 * Rotate `filePath` if it has reached `maxBytes`, shifting existing backups
 * (`filePath.1` -> `filePath.2` -> ... -> dropped past `keep`), copying
 * `filePath` to `filePath.1`, and then truncating `filePath` in place. It is
 * truncated only when the copy succeeded, so a failed rotation loses nothing.
 * Never throws: every filesystem operation is individually try/caught, since
 * a rotation failure must never break logging for the caller.
 *
 * Returns `false` if `filePath` does not exist, could not be stat'd, or is
 * under the threshold. Returns `true` whenever rotation was warranted (size
 * >= `maxBytes`), regardless of whether every individual shift/rename
 * succeeded.
 */
export function rotateIfNeeded(filePath: string, opts?: RotateOptions): boolean {
  const maxBytes = opts?.maxBytes ?? LOG_MAX_BYTES;
  const keep = opts?.keep ?? LOG_KEEP;

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    warnUnlessMissing(err, `stat ${filePath}`);
    return false;
  }

  if (size < maxBytes) return false;

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
    fs.copyFileSync(filePath, `${filePath}.1`);
  } catch (err) {
    // filePath was just confirmed to exist via statSync above, so any
    // failure here (permissions, disk full) is unexpected; surface it.
    // filePath stays whole and the next rotateIfNeeded call will retry.
    warn(`copy ${filePath} -> .1`, err);
    return true;
  }

  try {
    fs.truncateSync(filePath, 0);
  } catch (err) {
    warn(`truncate ${filePath}`, err);
  }

  return true;
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

/**
 * The `candidates` that the descriptors `fds` write to, matched by device and
 * inode (#729). A daemon's stdout and stderr are whatever its launcher opened
 * (launchd's `remi-stdout.log`, `remi start`'s `daemon.log`, a terminal, a
 * pipe), so it guards only the files it can see it holds. A descriptor that
 * is not open, or a candidate that does not exist, is skipped.
 */
export function logFilesBehind(fds: readonly number[], candidates: readonly string[]): string[] {
  const held: fs.Stats[] = [];
  for (const fd of fds) {
    try {
      const st = fs.fstatSync(fd);
      if (st.isFile()) held.push(st);
    } catch {
      // Not open, or not ours to stat: nothing to guard.
    }
  }
  return candidates.filter((candidate) => {
    try {
      const st = fs.statSync(candidate);
      return held.some((h) => h.dev === st.dev && h.ino === st.ino);
    } catch {
      return false;
    }
  });
}

/**
 * Append `text` to `filePath`, rotating it first once it reached the bound
 * (#729): for the opt-in debug sinks (`hook-diag.jsonl`, the PTY capture),
 * which a long debug session would otherwise grow forever. A failed append
 * throws, as `appendFileSync` does, so the caller can report it.
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

/** Best-effort stderr notice. Never throws — a rotation failure must never break logging. */
function warn(op: string, err: unknown): void {
  try {
    console.error(`[remi] log rotation failed (${op}): ${errorToString(err)}`);
  } catch {
    // stderr may be unavailable; nothing more to do.
  }
}
