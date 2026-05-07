/**
 * Handler for `remi detach <session>` — detach from a session without
 * killing it (tmux-style). The session remains alive and can be re-attached.
 *
 * Localhost + no explicit port: uses the shared resolveLocalSession helper
 * to probe known daemons and map the target name/id to a specific port.
 */

import { errorToString } from '@remi/shared';
import { resolveLocalSession } from './resolve-local-session.ts';
import type { PortQueryResult, ResolvedSession } from './session-resolver.ts';
import type { ResolvedTarget } from './target-resolver.ts';

export interface DetachCommandIO {
  readonly err: (msg: string) => void;
}

const defaultIO: DetachCommandIO = { err: (msg) => console.error(msg) };

export interface DetachCommandDeps {
  /** Caller-side live-port list (usually `liveSessionsRegistry.getLivePorts()`). */
  readonly getLivePorts: () => number[];
  /** Explicit --port flag value; used to skip the multi-port resolution step. */
  readonly explicitPort: number | undefined;
}

/** Injectable helpers; defaults load production modules dynamically. */
export interface DetachCommandHelpers {
  queryMultiplePorts: (args: {
    host: string;
    ports: number[];
    timeoutMs: number;
    logLabel: string;
  }) => Promise<readonly PortQueryResult[]>;
  resolveSession: (results: readonly PortQueryResult[], target: string) => ResolvedSession | null;
  getDefaultPortRange: () => number[];
  runDetachClient: (args: { host: string; port: number; target: string }) => Promise<void>;
}

const defaultLoader = async (): Promise<DetachCommandHelpers> => {
  const [sessionResolver, lsClient, detachClient] = await Promise.all([
    import('./session-resolver.ts'),
    import('./ls-client.ts'),
    import('./detach-client.ts'),
  ]);
  return {
    queryMultiplePorts: sessionResolver.queryMultiplePorts,
    resolveSession: sessionResolver.resolveSession,
    getDefaultPortRange: lsClient.getDefaultPortRange,
    runDetachClient: detachClient.runDetachClient,
  };
};

function printUsage(err: (msg: string) => void): void {
  err('Usage: remi detach <session-name-or-id>');
  err('  Detach from a session without killing it (tmux-style).');
  err('  The session remains alive and can be re-attached with `remi attach`.');
  err('  Examples: remi detach my-session');
  err('            remi detach host:port/session-name');
  err('  Tip: When attached interactively, press Ctrl+B d to detach.');
  err('Run `remi ls` to see live sessions.');
}

export async function runDetachCommand(
  target: ResolvedTarget,
  deps: DetachCommandDeps,
  io: DetachCommandIO = defaultIO,
  loadHelpers: () => Promise<DetachCommandHelpers> = defaultLoader,
): Promise<number> {
  if (!target.targetId) {
    printUsage(io.err);
    return 1;
  }

  let resolvedPort = target.port;
  let detachTarget = target.targetId;

  const helpers = await loadHelpers();

  if (deps.explicitPort === undefined && target.host === 'localhost') {
    const resolution = await resolveLocalSession(
      { target: detachTarget, logLabel: 'detach' },
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
      detachTarget = resolution.target;
    }
    // 'no-ports' and 'unresolved' both fall through to the original target.
  }

  try {
    await helpers.runDetachClient({
      host: target.host,
      port: resolvedPort,
      target: detachTarget,
    });
    return 0;
  } catch (err) {
    io.err(errorToString(err));
    return 1;
  }
}
