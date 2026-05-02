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
 *
 * Failure handling: every TTY/kill operation can fail (broken pipe,
 * EPERM, ENOTTY). The handler treats failures as user-visible: each
 * catch path writes a single line to stderr telling the user what
 * happened and what to do next. We never leave the user with a frozen
 * terminal and only a log file as evidence.
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
  /**
   * Override for the user-visible stderr writer. Tests use this to
   * capture diagnostic messages without polluting the runner's stderr.
   * Defaults to `process.stderr.write`.
   */
  readonly writeStderr?: (msg: string) => void;
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
  const writeStderr =
    options.writeStderr ??
    ((msg: string) => {
      try {
        process.stderr.write(msg);
      } catch {
        // stderr itself is broken; nothing actionable left to do.
      }
    });

  // The wrapper-mode handler must replace any previously-installed SIGTSTP
  // listener (e.g. the daemon-mode no-op ignore in cli.ts). If we left both
  // attached, the no-op would still fire and the kernel default behaviour
  // would never run on its own, but we'd also lose a clean single source of
  // truth for what SIGTSTP does in this process. Strip prior listeners so
  // the wrapper owns SIGTSTP outright while it is installed; `dispose()`
  // removes our listener but does NOT restore the prior one. That is OK in
  // practice because wrapper mode and daemon mode are mutually exclusive
  // (`cliDaemonMode` is set once at startup).
  process.removeAllListeners('SIGTSTP');

  let suspending = false;

  /**
   * Tear down raw mode + pause stdin in preparation for SIGSTOP.
   * Returns true if the terminal was successfully neutralised; false if
   * any step failed. Callers MUST abort the suspend on false to avoid
   * leaving the user wedged with raw mode on and the process suspended.
   */
  function teardownTty(): boolean {
    let ok = true;
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch (err) {
        onError(err);
        ok = false;
      }
    }
    try {
      process.stdin.pause();
    } catch (err) {
      onError(err);
      ok = false;
    }
    return ok;
  }

  /**
   * Restore raw mode + resume stdin after SIGCONT (or after an aborted
   * suspend). Returns a per-op success map so the caller can report
   * exactly which step failed.
   */
  function restoreTty(): { rawMode: boolean; resume: boolean } {
    const result = { rawMode: true, resume: true };
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch (err) {
        onError(err);
        result.rawMode = false;
      }
    }
    try {
      process.stdin.resume();
    } catch (err) {
      onError(err);
      result.resume = false;
    }
    return result;
  }

  const onSigtstp = (): void => {
    // Re-entrancy guard: if another SIGTSTP arrives while we are still
    // tearing down (Bun delivers signals on the event loop, so this can
    // happen if the user mashes Ctrl+Z), skip the second teardown.
    if (suspending) return;
    suspending = true;

    if (!teardownTty()) {
      // Finding 1: if we can't put the terminal back into cooked mode and
      // pause stdin, suspending now would leave the user with a stopped
      // remi AND a raw-mode terminal AND no diagnostic on the screen. Bail
      // out before SIGSTOP, restore best-effort, and tell the user.
      writeStderr(
        'remi: cannot suspend (terminal teardown failed); use Ctrl+B d to detach instead\n',
      );
      suspending = false;
      restoreTty();
      return;
    }

    log('[suspend] SIGTSTP received; suspending remi (claude keeps running)');
    // Finding 4: print resume hint BEFORE SIGSTOP. After SIGSTOP fires we
    // can't write anything (we're frozen), so this is the user's only
    // diagnostic if SIGCONT never arrives or if the shell loses track of
    // the job.
    writeStderr(`remi: suspended. To resume, run 'fg' (pid ${process.pid})\n`);

    try {
      // SIGSTOP is uncatchable: kernel suspends us immediately. The shell
      // sees a stopped job (`[1]+  Stopped  remi ...`). The PTY child is
      // in its own session and is unaffected.
      killFn(process.pid, 'SIGSTOP');
    } catch (err) {
      onError(err);
      // Finding 2: SIGSTOP failed but we already paused stdin and dropped
      // raw mode. The terminal looks frozen to the user. Tell them on
      // stderr, restore the TTY, and resume stdin so they can keep typing.
      writeStderr(`remi: cannot suspend (${errorToString(err)}); staying in foreground\n`);
      suspending = false;
      restoreTty();
      // restoreTty already calls process.stdin.resume(), but be explicit:
      // if resume itself failed inside restoreTty, retry once. Worst case
      // is a second logged error; that beats a wedged terminal.
      try {
        process.stdin.resume();
      } catch (resumeErr) {
        onError(resumeErr);
      }
    }
  };

  const onSigcont = (): void => {
    log('[suspend] SIGCONT received; restoring raw mode');
    suspending = false;
    const restored = restoreTty();
    if (!restored.rawMode || !restored.resume) {
      // Finding 3: partial restore on resume. Tell the user explicitly
      // which way the terminal is broken so they know what to expect
      // (e.g. cooked-mode echo doubling, or unresponsive stdin).
      const failed: string[] = [];
      if (!restored.rawMode) failed.push('raw-mode');
      if (!restored.resume) failed.push('stdin-resume');
      writeStderr(
        `remi: terminal restore failed after resume (${failed.join(', ')}); press Ctrl+B d and re-run remi\n`,
      );
    }
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
