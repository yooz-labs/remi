/**
 * Detect when the running remi binary has been rebuilt on disk.
 *
 * Long-lived wrapper processes load their code at startup, so a fresh
 * `dist/remi` build does NOT take effect until the user kills + restarts
 * the session. Issue #287 calls this out as the single most frustrating
 * thing about iterating on remi: every shipped fix is invisible to
 * already-running wrappers. We can't safely hot-swap the running PTY,
 * but we CAN tell the user so they know to restart.
 *
 * On startup, record the inode + mtime of `process.execPath`. Poll
 * every `intervalMs`; when the inode or mtime changes from what we
 * recorded, fire `onUpdateDetected(currentMtime)` exactly once and
 * stop polling. The caller decides what to do with the signal — today
 * cli.ts logs and sends a `daemon_update_available` protocol message
 * so attached clients can surface a "restart to pick up update" banner.
 *
 * Pure file-system poll, no signal-handling, no exec — small and
 * testable. Real fs writes drive the test.
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';

export interface UpdateWatcherDeps {
  /** Path of the binary to watch — typically `process.execPath`. */
  readonly binaryPath: string;
  /** Poll cadence. */
  readonly intervalMs: number;
  /** Called once when a newer mtime / different inode is observed. */
  readonly onUpdateDetected: (newMtimeMs: number) => void;
  /**
   * Called for unexpected stat errors. Errors do not stop the watcher
   * (transient I/O hiccups happen); only ENOENT during shutdown does.
   * Defaults to a no-op so tests don't have to wire it up.
   */
  readonly onError?: (err: Error) => void;
}

export interface UpdateWatcher {
  /** Stop polling and release the timer. Idempotent. */
  stop(): void;
  /**
   * Initial baseline. `null` if the binary was missing or unreadable
   * at start; in that case the watcher will never fire (we have no
   * baseline to compare against).
   */
  readonly baselineMtimeMs: number | null;
}

/** Start watching. Returns an UpdateWatcher with a `stop()` method. */
export function startUpdateWatcher(deps: UpdateWatcherDeps): UpdateWatcher {
  const onError = deps.onError ?? (() => {});

  let baseline: { mtimeMs: number; ino: number } | null = null;
  try {
    const st = fs.statSync(deps.binaryPath);
    baseline = { mtimeMs: st.mtimeMs, ino: st.ino };
  } catch (err) {
    onError(new Error(`update-watcher: cannot stat ${deps.binaryPath}: ${errorToString(err)}`));
  }

  let fired = false;
  const timer = setInterval(() => {
    if (fired || !baseline) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(deps.binaryPath);
    } catch (err) {
      // ENOENT: binary was removed (during a build that swaps the file).
      // The next iteration will see the new file. Don't escalate.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') onError(new Error(errorToString(err)));
      return;
    }

    // mtime moves backwards on a tar restore but never matters for us;
    // any change away from the baseline (forward OR inode swap) means
    // the file has been rewritten. Inode change covers atomic-rename
    // builds where mtime might be older than the previous file's.
    if (st.mtimeMs !== baseline.mtimeMs || st.ino !== baseline.ino) {
      fired = true;
      try {
        deps.onUpdateDetected(st.mtimeMs);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(errorToString(err)));
      }
      clearInterval(timer);
    }
  }, deps.intervalMs);

  // Don't keep the event loop alive just for the watcher.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    baselineMtimeMs: baseline?.mtimeMs ?? null,
    stop(): void {
      clearInterval(timer);
    },
  };
}
