/**
 * Rotate-before-open log rotation for `~/.remi/remi.log` and
 * `~/.remi/daemon.log`. Neither file was ever rotated (#726); on a
 * long-running machine they grow unbounded (85MB / 24MB observed in the
 * wild), which becomes untenable once an always-on hub (#542) keeps a
 * daemon alive indefinitely.
 *
 * This is rotate-BEFORE-open only: call `rotateIfNeeded` immediately before
 * the `fs.openSync(path, 'a')` that starts a new log-file or child-stdio
 * session, never while a fd is already held open. A process that already
 * holds the fd keeps writing to the renamed `.1` file until it restarts —
 * rename-based rotation cannot retarget a live child-stdio fd to a new
 * inode. Growth stays bounded in practice because opens are frequent (every
 * wrapper start, every daemon spawn), so the live file rarely has a chance
 * to grow far past the threshold before the next rotation check.
 *
 * No cross-process locking: two processes racing a rotation of the same
 * file (e.g. concurrent `spawnRemiDaemon` calls) could interleave renames.
 * Accepted for now — same tradeoff the port-selection code already makes
 * elsewhere in this package, and worst case is a lost backup generation,
 * not data loss or a crash.
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';

/** Default rotation threshold: 10MB. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Default number of rotated backups to retain (`.1` through `.keep`). */
export const LOG_KEEP = 2;

export interface RotateOptions {
  /** Rotate once the file reaches this size in bytes. Default `LOG_MAX_BYTES`. */
  readonly maxBytes?: number;
  /** Number of rotated backups to retain. Default `LOG_KEEP`. */
  readonly keep?: number;
}

/**
 * Rotate `filePath` if it has reached `maxBytes`, shifting existing backups
 * (`filePath.1` -> `filePath.2` -> ... -> dropped past `keep`) and renaming
 * `filePath` itself to `filePath.1`. Never throws: every filesystem
 * operation is individually try/caught, since a rotation failure must never
 * break logging for the caller.
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
    fs.renameSync(filePath, `${filePath}.1`);
  } catch (err) {
    // filePath was just confirmed to exist via statSync above, so any
    // failure here (permissions, disk full, cross-device) is unexpected —
    // surface it. filePath stays in place and the next rotateIfNeeded call
    // will retry.
    warn(`rotate ${filePath} -> .1`, err);
  }

  return true;
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
