/**
 * Handler for `remi reload` — sends SIGUSR1 to every live daemon so it picks
 * up an updated binary/config without dropping its PTY session.
 *
 * Exits 0 if at least one daemon was successfully signaled, 1 otherwise (no
 * live daemons OR all signal attempts failed).
 *
 * Stale session entries (ESRCH) are reported but do not count as success.
 */

import { errorToString } from '@remi/shared';
import { SessionRegistryFile } from '../session/session-registry-file.ts';

export interface ReloadCommandIO {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

const defaultIO: ReloadCommandIO = {
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
};

/** Dependencies the handler needs. Exposed for tests. */
export interface ReloadCommandDeps {
  /** Lists currently-live daemons. Defaults to the production SessionRegistryFile. */
  readonly listLive?: () => ReadonlyArray<{
    name: string;
    pid: number;
    wsPort: number;
  }>;
  /** Sends a signal to a pid. Defaults to `process.kill`. Must throw with
   *  `code: 'ESRCH'` on NodeJS.ErrnoException when the pid is gone. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export function runReloadCommand(
  io: ReloadCommandIO = defaultIO,
  deps: ReloadCommandDeps = {},
): number {
  const listLive = deps.listLive ?? (() => new SessionRegistryFile().listLive());
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));

  const liveSessions = listLive();
  if (liveSessions.length === 0) {
    io.err('No running daemons found.');
    return 1;
  }

  let reloaded = 0;
  for (const entry of liveSessions) {
    try {
      kill(entry.pid, 'SIGUSR1');
      io.out(`Sent reload signal to ${entry.name} (PID ${entry.pid}, port ${entry.wsPort})`);
      reloaded++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        io.err(`Process ${entry.pid} not found (stale session entry)`);
      } else {
        io.err(`Failed to signal PID ${entry.pid}: ${errorToString(err)}`);
      }
    }
  }

  if (reloaded > 0) {
    io.out(`Reloaded ${reloaded} daemon(s).`);
    return 0;
  }
  io.err('Failed to reload any daemons (all session entries appear stale).');
  return 1;
}
