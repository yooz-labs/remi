/**
 * Wrapper-mode Ctrl+Z (SIGTSTP) suspend / SIGCONT resume support.
 *
 * Why this exists (issue #361):
 * `remi <args>` puts stdin into raw mode while it forwards bytes to the
 * PTY-hosted Claude. In raw mode the kernel does NOT translate Ctrl+Z
 * into SIGTSTP -- it forwards the literal `0x1A` byte to the child, so
 * the user can never drop back to the shell with Ctrl+Z + fg.
 *
 * The fix has two halves:
 *
 *   1. The byte-level scanner (`DetachScanner`) intercepts `0x1A` and
 *      calls `requestSuspend()` here instead of forwarding to the PTY.
 *   2. We tear down raw mode + stdin listeners and self-send SIGSTOP
 *      to suspend ONLY the remi process. The PTY-hosted Claude lives
 *      in its own session (Bun.spawn `terminal:` calls forkpty/setsid)
 *      so it is NOT in our process group and keeps running.
 *
 * SIGTSTP from outside (e.g. `kill -TSTP <pid>`) is also handled: the
 * SIGTSTP listener runs the same teardown + SIGSTOP path.
 *
 * On SIGCONT (after `fg` or `kill -CONT <pid>`), we restore raw mode
 * and resume reading stdin via the caller's `onResume` callback.
 *
 * The module owns ALL signal handler bookkeeping; cli.ts only calls
 * `installSuspendHandler` once and then routes Ctrl+Z bytes into the
 * returned controller.
 */

import { errorToString } from '@remi/shared';
import { log, logError } from './logger.ts';

export interface SuspendHandlerOptions {
  /**
   * Called after SIGCONT, after raw mode is restored. The caller should
   * resume any stdin handling that was paused before suspend (e.g. re-add
   * its `data` listener if it was removed).
   */
  readonly onResume?: () => void;
  /**
   * Optional: invoked when stdin TTY operations (raw mode, pause/resume)
   * fail. Defaults to logger.logError. Useful for tests.
   */
  readonly onError?: (err: unknown) => void;
  /**
   * Override for `process.kill`. Production callers should leave this
   * unset; tests use it to assert which signal would be sent without
   * actually suspending the test runner.
   */
  readonly kill?: (pid: number, signal: NodeJS.Signals | number) => void;
}

export interface SuspendHandlerController {
  /**
   * Drive the Ctrl+Z byte path: tear down raw mode and self-send SIGTSTP.
   * Goes through the SIGTSTP listener, which then issues SIGSTOP for the
   * actual kernel suspend.
   */
  readonly requestSuspend: () => void;
  /**
   * Remove the SIGTSTP and SIGCONT listeners. Useful when the wrapper
   * mode is shutting down before process exit so we don't leak handlers.
   */
  readonly dispose: () => void;
}

/**
 * Install SIGTSTP and SIGCONT handlers for wrapper mode and return a
 * controller for the byte-driven path.
 *
 * Idempotent guard: callers should only invoke this once per wrapper
 * lifecycle. Calling `dispose()` removes the handlers.
 */
export function installSuspendHandler(
  options: SuspendHandlerOptions = {},
): SuspendHandlerController {
  const onError = options.onError ?? ((err) => logError(`[suspend] ${errorToString(err)}`));
  const killFn =
    options.kill ?? ((pid: number, signal: NodeJS.Signals | number) => process.kill(pid, signal));
  let suspending = false;

  function teardownTty(): void {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch (err) {
        onError(err);
      }
    }
    try {
      process.stdin.pause();
    } catch (err) {
      onError(err);
    }
  }

  function restoreTty(): void {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch (err) {
        onError(err);
      }
    }
    try {
      process.stdin.resume();
    } catch (err) {
      onError(err);
    }
  }

  const onSigtstp = (): void => {
    // Re-entrancy guard: if another SIGTSTP arrives while we are still
    // tearing down (Bun delivers signals on the event loop, so this can
    // happen if the user mashes Ctrl+Z), skip the second teardown.
    if (suspending) return;
    suspending = true;
    teardownTty();
    log('[suspend] SIGTSTP received; suspending remi (claude keeps running)');
    try {
      // SIGSTOP is uncatchable: kernel suspends us immediately. The shell
      // sees a stopped job (`[1]+  Stopped  remi ...`). The PTY child is
      // in its own session and is unaffected.
      killFn(process.pid, 'SIGSTOP');
    } catch (err) {
      onError(err);
      // If SIGSTOP fails for some reason, restore so we don't leave the
      // tty in a half-broken state.
      suspending = false;
      restoreTty();
    }
  };

  const onSigcont = (): void => {
    log('[suspend] SIGCONT received; restoring raw mode');
    suspending = false;
    restoreTty();
    try {
      options.onResume?.();
    } catch (err) {
      onError(err);
    }
  };

  process.on('SIGTSTP', onSigtstp);
  process.on('SIGCONT', onSigcont);

  return {
    requestSuspend: () => {
      // Routing through the signal listener keeps the Ctrl+Z byte path
      // and the external `kill -TSTP <pid>` path identical.
      try {
        killFn(process.pid, 'SIGTSTP');
      } catch (err) {
        onError(err);
      }
    },
    dispose: () => {
      process.removeListener('SIGTSTP', onSigtstp);
      process.removeListener('SIGCONT', onSigcont);
    },
  };
}
