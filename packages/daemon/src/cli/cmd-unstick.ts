/**
 * Handler for `remi unstick [port]` — sends SIGUSR2 to live daemon(s), the "just
 * get me out" lever (#617). On receipt each daemon resolves and dismisses every
 * open permission card it tracks, so stale cards clear on every device. (Before
 * #1125 it also released held hooks and aborted the auto-approve eval; neither
 * exists any more.)
 *
 * With no port, every live daemon is unstuck; with a port, only the daemon bound
 * to that WebSocket port. Exits 0 if at least one daemon was signaled, 1 otherwise
 * (no live/matching daemons, or all signal attempts failed). Stale entries (ESRCH)
 * are reported but do not count as success.
 */

import { errorToString } from '@remi/shared';
import { SessionRegistryFile } from '../session/session-registry-file.ts';

export interface UnstickCommandIO {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

const defaultIO: UnstickCommandIO = {
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
};

/** Dependencies the handler needs. Exposed for tests. */
export interface UnstickCommandDeps {
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

/**
 * @param targetPort When set, only the daemon bound to this WebSocket port is
 *   signaled; otherwise every live daemon is.
 */
export function runUnstickCommand(
  targetPort: number | undefined = undefined,
  io: UnstickCommandIO = defaultIO,
  deps: UnstickCommandDeps = {},
): number {
  const listLive = deps.listLive ?? (() => new SessionRegistryFile().listLive());
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));

  const live = listLive();
  const targets = targetPort !== undefined ? live.filter((e) => e.wsPort === targetPort) : live;

  if (targets.length === 0) {
    io.err(
      targetPort !== undefined
        ? `No running daemon found on port ${targetPort}.`
        : 'No running daemons found.',
    );
    return 1;
  }

  let unstuck = 0;
  for (const entry of targets) {
    try {
      kill(entry.pid, 'SIGUSR2');
      io.out(`Sent unstick signal to ${entry.name} (PID ${entry.pid}, port ${entry.wsPort})`);
      unstuck++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        io.err(`Process ${entry.pid} not found (stale session entry)`);
      } else {
        io.err(`Failed to signal PID ${entry.pid}: ${errorToString(err)}`);
      }
    }
  }

  if (unstuck > 0) {
    io.out(`Unstuck ${unstuck} daemon(s): resolved and dismissed open permission cards.`);
    return 0;
  }
  io.err('Failed to unstick any daemons (all matching session entries appear stale).');
  return 1;
}
