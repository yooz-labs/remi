/**
 * Handler for `remi kill <session>` — terminate a session.
 *
 * Localhost + no explicit port: uses the shared resolveLocalSession helper
 * to probe known daemons and map the target name/id to a specific port.
 */

import { errorToString } from '@remi/shared';
import { resolveLocalSession } from './resolve-local-session.ts';
import type { PortQueryResult, ResolvedSession } from './session-resolver.ts';
import type { ResolvedTarget } from './target-resolver.ts';

export interface KillCommandIO {
  readonly err: (msg: string) => void;
  readonly out?: (msg: string) => void;
}

const defaultIO: KillCommandIO = {
  err: (msg) => console.error(msg),
  out: (msg) => console.log(msg),
};

export interface KillCommandDeps {
  readonly getLivePorts: () => number[];
  /**
   * Live-sessions entries, for the unreachable-daemon fallback (#859). Seam so
   * tests never signal a real process.
   */
  readonly listLive?: () => readonly { pid: number; wsPort: number; name: string }[];
  /** Signal a pid. Defaults to the real `process.kill`. */
  readonly signal?: (pid: number, sig: NodeJS.Signals | 0) => void;
  readonly explicitPort: number | undefined;
}

export interface KillCommandHelpers {
  queryMultiplePorts: (args: {
    host: string;
    ports: number[];
    timeoutMs: number;
    logLabel: string;
  }) => Promise<readonly PortQueryResult[]>;
  resolveSession: (results: readonly PortQueryResult[], target: string) => ResolvedSession | null;
  getDefaultPortRange: () => number[];
  runKillClient: (args: { host: string; port: number; target: string }) => Promise<void>;
}

const defaultLoader = async (): Promise<KillCommandHelpers> => {
  const [sessionResolver, lsClient, killClient] = await Promise.all([
    import('./session-resolver.ts'),
    import('./ls-client.ts'),
    import('./kill-client.ts'),
  ]);
  return {
    queryMultiplePorts: sessionResolver.queryMultiplePorts,
    resolveSession: sessionResolver.resolveSession,
    getDefaultPortRange: lsClient.getDefaultPortRange,
    runKillClient: killClient.runKillClient,
  };
};

function printUsage(err: (msg: string) => void): void {
  err('Usage: remi kill <session-name-or-id>');
  err('  Examples: remi kill my-session');
  err('            remi kill host:port/session-name');
  err('            remi kill my-session --host 192.168.1.1');
  err('Run `remi ls` to see live sessions.');
}

export async function runKillCommand(
  target: ResolvedTarget,
  deps: KillCommandDeps,
  io: KillCommandIO = defaultIO,
  loadHelpers: () => Promise<KillCommandHelpers> = defaultLoader,
): Promise<number> {
  if (!target.targetId) {
    printUsage(io.err);
    return 1;
  }

  let resolvedPort = target.port;
  let killTarget = target.targetId;

  const helpers = await loadHelpers();

  try {
    if (deps.explicitPort === undefined && target.host === 'localhost') {
      const resolution = await resolveLocalSession(
        { target: killTarget, logLabel: 'kill' },
        {
          getLivePorts: deps.getLivePorts,
          queryMultiplePorts: helpers.queryMultiplePorts,
          resolveSession: helpers.resolveSession,
          getDefaultPortRange: helpers.getDefaultPortRange,
        },
      );
      if (resolution.status === 'no-daemons') {
        // A daemon that ignores its socket used to be unreachable by every
        // remi command, leaving `pkill` as the only option -- which matches on
        // a name and will happily take down something else (#859). remi
        // recorded this daemon's pid itself, so use it.
        const byPid = killByRecordedPid(killTarget, deps, io);
        if (byPid !== undefined) return byPid;
        io.err(
          `Cannot reach any remi daemon (tried ${resolution.probedCount} port(s)). Is a daemon running?`,
        );
        return 1;
      }
      if (resolution.status === 'resolved') {
        resolvedPort = resolution.port;
        killTarget = resolution.target;
      }
    }

    await helpers.runKillClient({
      host: target.host,
      port: resolvedPort,
      target: killTarget,
    });
    return 0;
  } catch (err) {
    io.err(errorToString(err));
    return 1;
  }
}

/**
 * Stop a daemon by the pid the live-sessions registry recorded, when its socket
 * will not answer.
 *
 * Returns an exit code when it acted, or undefined when no recorded entry
 * matches -- so the caller still prints its own "cannot reach" message rather
 * than this silently swallowing an ordinary typo.
 *
 * Deliberately narrated: this skips the daemon's graceful shutdown, so a user
 * must be able to tell from the output that it happened.
 */
function killByRecordedPid(
  target: string,
  deps: KillCommandDeps,
  io: KillCommandIO,
): number | undefined {
  const entries = deps.listLive?.() ?? [];
  const match = entries.find(
    (e) => e.name === target || String(e.wsPort) === target || e.name.endsWith(`/${target}`),
  );
  if (match === undefined) return undefined;

  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
  const out = io.out ?? ((msg: string) => console.log(msg));

  io.err(`Daemon on port ${match.wsPort} is not answering; stopping PID ${match.pid} directly.`);
  try {
    signal(match.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      out(`PID ${match.pid} was already gone.`);
      return 0;
    }
    io.err(`Could not signal PID ${match.pid}: ${errorToString(err)}`);
    return 1;
  }
  out(`Sent SIGTERM to PID ${match.pid} (${match.name}). Its session was not shut down cleanly.`);
  return 0;
}
