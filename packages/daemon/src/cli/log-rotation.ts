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
 */

import * as fs from 'node:fs';

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
  } catch {
    return false;
  }

  if (size < maxBytes) return false;

  try {
    fs.unlinkSync(`${filePath}.${keep}`);
  } catch {
    // No existing oldest backup to drop; nothing to do.
  }

  for (let n = keep - 1; n >= 1; n--) {
    try {
      fs.renameSync(`${filePath}.${n}`, `${filePath}.${n + 1}`);
    } catch {
      // No backup at this slot yet; nothing to shift.
    }
  }

  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // Best effort: if this fails, filePath stays in place and the next
    // rotateIfNeeded call will retry.
  }

  return true;
}
