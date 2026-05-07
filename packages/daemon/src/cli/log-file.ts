/**
 * Low-level log-file session for wrapper mode.
 *
 * In wrapper mode, Remi overrides stdout/stderr to keep the Claude Code
 * terminal clean. Diagnostics are redirected into `~/.remi/remi.log` via the
 * functions in this module.
 *
 * Lifecycle:
 *   1. `startLogFileSession(primary, fallback?)` - opens the primary log
 *      file; on failure, attempts a fallback in the system tmp directory.
 *   2. `writeToLog(msg)` - appends a line; silent no-op if the session never
 *      opened. Errors are swallowed so a full disk never corrupts the PTY.
 *   3. `endLogFileSession()` - closes the file descriptor. Safe to call
 *      multiple times.
 *
 * The module owns a single global log fd, matching the single log-file-per-
 * process assumption of wrapper mode.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';

let logFd: number | null = null;

/** Result of `startLogFileSession`. */
export interface LogSessionResult {
  /** The fd that's been opened; null if all attempts failed. */
  readonly fd: number | null;
  /** The path that was actually opened (primary or fallback). */
  readonly path: string | null;
  /** True when the fallback path was used because the primary failed. */
  readonly usedFallback: boolean;
  /** Error from the primary open, if any. */
  readonly primaryError?: unknown;
}

/** Options for the fallback log file. Omit to disable fallback. */
export interface FallbackLogOptions {
  /** Directory for the fallback log file (e.g. `os.tmpdir()`). */
  readonly dir: string;
  /** PID suffix so parallel wrapper instances do not collide. */
  readonly pid: number;
}

/**
 * Open the log file, falling back to a tmp path if the primary open fails.
 *
 * On success writes a `--- Remi session started at ... ---` header to the
 * opened fd. On fallback, first writes a note to the fallback log describing
 * the primary failure, then writes a one-line warning to fd 2 so the user
 * sees where diagnostics went before stderr is redirected elsewhere.
 *
 * Never throws. If both primary and fallback fail, the session fd is `null`
 * and future `writeToLog` calls become no-ops.
 */
export function startLogFileSession(
  primary: string,
  fallback?: FallbackLogOptions,
): LogSessionResult {
  try {
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    const fd = fs.openSync(primary, 'a');
    fs.writeSync(fd, `\n--- Remi session started at ${new Date().toISOString()} ---\n`);
    logFd = fd;
    return { fd, path: primary, usedFallback: false };
  } catch (primaryError) {
    if (!fallback) {
      logFd = null;
      return { fd: null, path: null, usedFallback: false, primaryError };
    }
    try {
      const tmpLog = path.join(fallback.dir, `remi-${fallback.pid}.log`);
      const fd = fs.openSync(tmpLog, 'a');
      fs.writeSync(fd, `[remi] Primary log file failed: ${errorToString(primaryError)}\n`);
      // Best-effort notice on the real stderr before it gets redirected.
      try {
        fs.writeSync(2, `[remi] Logging to ${tmpLog} (primary log unavailable)\n`);
      } catch {
        // stderr may already be closed/redirected; swallow.
      }
      logFd = fd;
      return { fd, path: tmpLog, usedFallback: true, primaryError };
    } catch {
      try {
        fs.writeSync(2, '[remi] WARNING: All logging disabled (cannot open any log file)\n');
      } catch {
        // Nothing left to try.
      }
      logFd = null;
      return { fd: null, path: null, usedFallback: true, primaryError };
    }
  }
}

/**
 * Append a line to the currently-open log file.
 * Silent no-op if no session has been started, or if the underlying write
 * fails. In wrapper mode, terminal cleanliness is non-negotiable — never
 * surface IO errors to the user's terminal.
 */
export function writeToLog(msg: string): void {
  if (logFd === null) return;
  try {
    fs.writeSync(logFd, `${msg}\n`);
  } catch {
    // Silently drop.
  }
}

/**
 * Close the log file and reset internal state. Safe to call multiple times.
 * Typical call site: `process.on('exit', endLogFileSession)`.
 */
export function endLogFileSession(): void {
  if (logFd === null) return;
  try {
    fs.closeSync(logFd);
  } catch {
    // Already-closed fd or descriptor exhaustion — nothing to recover.
  }
  logFd = null;
}

/**
 * Returns the current log fd, or null if no session is open.
 * Exposed so callers that need to dup2 onto the log fd can do so without
 * maintaining their own reference.
 */
export function getLogFd(): number | null {
  return logFd;
}
