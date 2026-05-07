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
}

const defaultIO: KillCommandIO = { err: (msg) => console.error(msg) };

export interface KillCommandDeps {
  readonly getLivePorts: () => number[];
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
