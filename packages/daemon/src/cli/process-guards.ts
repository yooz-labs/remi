/**
 * Process-level error guards (issue #534).
 *
 * Before this module existed the daemon installed zero `unhandledRejection`
 * / `uncaughtException` handlers. On Bun 1.3.11 either one is fatal by
 * default -- a single unhandled promise rejection anywhere in the process
 * (a stray adapter call, a forgotten `.catch`, a WebSocket send racing a
 * closed socket) kills the daemon and every attached session with it, with
 * no supervisor watching for it.
 *
 * The two events are handled differently on purpose:
 *
 * - `unhandledRejection` is survivable. A rejected promise nobody awaited
 *   does not, by itself, mean process state is corrupt -- it means some
 *   async path forgot a `.catch`. We log it and keep serving; killing every
 *   session over a missed `.catch` would be a worse outcome than the bug
 *   itself.
 * - `uncaughtException` means a synchronous throw escaped every try/catch
 *   on the call stack. At that point we can no longer reason about what
 *   state the process is in (a lock could be held, a map left half
 *   mutated), so continuing to serve risks corrupting sessions instead of
 *   just losing one. We attempt a best-effort `onFatal()` teardown (close
 *   sockets, flush state), bounded by a timeout so a hung teardown can't
 *   wedge the process, then exit.
 *
 * `exit(1)` is deliberate, not incidental: a non-zero exit lets a process
 * supervisor (launchd `KeepAlive`, systemd `Restart=on-failure`) restart the
 * daemon automatically. Exiting 0 would look like a clean shutdown and most
 * supervisors would not restart on that.
 */

import { errorToString } from '@remi/shared';

export interface ProcessGuardsDeps {
  /** Sink for guard log lines. Production wires this to cli/logger.ts logError. */
  readonly logError: (msg: string) => void;
  /**
   * Best-effort teardown invoked once, on the first `uncaughtException`.
   * Races against `fatalTimeoutMs`; a rejection or a slow resolve does not
   * delay the exit past the timeout.
   */
  readonly onFatal: () => Promise<void>;
  /** Override for `process.exit`. Tests inject a recorder instead of a real exit. */
  readonly exit?: (code: number) => never;
  /** Milliseconds to wait for `onFatal()` before exiting anyway. Default 3000. */
  readonly fatalTimeoutMs?: number;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return errorToString(err);
}

/**
 * Install the two process-level guards. Returns an uninstall function that
 * removes both listeners (tests call this in `afterEach` so the runner's
 * own process is left clean).
 */
export function installProcessGuards(deps: ProcessGuardsDeps): () => void {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const fatalTimeoutMs = deps.fatalTimeoutMs ?? 3000;

  let handlingFatal = false;
  let exited = false;

  const doExit = (code: number): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const onUnhandledRejection = (reason: unknown): void => {
    // Survivable: log and keep serving, see module doc comment above.
    deps.logError(`[process-guard] unhandled rejection: ${formatError(reason)}`);
  };

  const onUncaughtException = (err: unknown): void => {
    deps.logError(`[process-guard] uncaught exception: ${formatError(err)}`);

    if (handlingFatal) {
      // A second exception arrived while we were still tearing down from
      // the first; process state is now doubly suspect. Skip onFatal and
      // exit immediately rather than risk a hang or further corruption.
      doExit(1);
      return;
    }
    handlingFatal = true;

    const timer = setTimeout(() => doExit(1), fatalTimeoutMs);
    timer.unref();

    Promise.resolve()
      .then(() => deps.onFatal())
      .catch((fatalErr) => {
        deps.logError(`[process-guard] onFatal failed: ${formatError(fatalErr)}`);
      })
      .finally(() => {
        clearTimeout(timer);
        doExit(1);
      });
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  return () => {
    process.removeListener('unhandledRejection', onUnhandledRejection);
    process.removeListener('uncaughtException', onUncaughtException);
  };
}
