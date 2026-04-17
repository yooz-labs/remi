/**
 * Handler for `remi attach [<session>]` — attach terminal to an orphaned
 * session. This is the biggest subcommand handler in the CLI: it covers
 * three resolution modes plus network discovery.
 *
 * Resolution modes (mutually exclusive):
 *
 *   A. Explicit remote target (`host:port` without session id, OR
 *      non-localhost host): auto-attach to the single session on that
 *      port. Ambiguity → disambiguation hint and exit 1.
 *
 *   B. No target id at all: auto-attach to the most recent live session
 *      from the registry, falling back to the persisted session store.
 *
 *   C. Target id/name provided: try in order
 *        1. live registry name lookup
 *        2. queryMultiplePorts + resolveSession on local ports
 *        3. prefix-match in local session store
 *        4. network discovery (mDNS + VPN) when target has `hostname:…`
 *           shape and no explicit `--host`
 *
 * Once a target is resolved, runAttachClient takes over and this handler
 * returns the client's exit code.
 */

import { errorToString } from '@remi/shared';
import type { DiscoverableSession } from '@remi/shared';
import type { SessionRegistryFile } from '../session/session-registry-file.ts';
import type { SessionStore } from '../session/session-store.ts';
import type {
  AmbiguousSessionError as AmbiguousSessionErrorCtor,
  DiscoveredEndpoint,
  NetworkDiscoveryResult,
  PortQueryResult,
  QueryErrorClass,
  ResolvedSession,
} from './session-resolver.ts';
import type { ResolvedTarget } from './target-resolver.ts';

export interface AttachCommandIO {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
  /** Wrapper-mode logger for diagnostic-only messages (typically console.log). */
  readonly log: (msg: string) => void;
}

const defaultIO: AttachCommandIO = {
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
  log: (msg) => console.log(msg),
};

export interface AttachCommandFlags {
  readonly port?: number;
  readonly host?: string;
  /** The raw arg after `attach` (used to detect `host:port/session` syntax). */
  readonly subcommandArg?: string;
}

export interface AttachCommandDeps {
  readonly store: SessionStore;
  readonly registry: SessionRegistryFile;
}

/** Helpers injected for testability; defaults load production modules. */
export interface AttachCommandHelpers {
  fetchSessions: (host: string, port: number, timeout?: number) => Promise<DiscoverableSession[]>;
  queryMultiplePorts: (args: {
    host: string;
    ports: number[];
    timeoutMs: number;
    logLabel: string;
  }) => Promise<readonly PortQueryResult[]>;
  resolveSession: (results: readonly PortQueryResult[], target: string) => ResolvedSession | null;
  classifyQueryError: (reason: string) => QueryErrorClass;
  discoverNetworkDaemons: (args: {
    defaultPort: number;
    logLabel: string;
  }) => Promise<NetworkDiscoveryResult>;
  findEndpointsByHostname: (
    discovery: NetworkDiscoveryResult,
    hostname: string,
  ) => DiscoveredEndpoint[];
  getDefaultPortRange: () => number[];
  runAttachClient: (args: {
    host: string;
    port: number;
    sessionId: string;
  }) => Promise<{ exitCode: number }>;
  AmbiguousSessionError: typeof AmbiguousSessionErrorCtor;
  FETCH_SESSIONS_TIMEOUT_MS: number;
}

const defaultLoader = async (): Promise<AttachCommandHelpers> => {
  const [sessionResolver, lsClient, attachClient] = await Promise.all([
    import('./session-resolver.ts'),
    import('./ls-client.ts'),
    import('./attach-client.ts'),
  ]);
  return {
    fetchSessions: lsClient.fetchSessions,
    queryMultiplePorts: sessionResolver.queryMultiplePorts,
    resolveSession: sessionResolver.resolveSession,
    classifyQueryError: sessionResolver.classifyQueryError,
    discoverNetworkDaemons: sessionResolver.discoverNetworkDaemons,
    findEndpointsByHostname: sessionResolver.findEndpointsByHostname,
    getDefaultPortRange: lsClient.getDefaultPortRange,
    runAttachClient: attachClient.runAttachClient,
    AmbiguousSessionError: sessionResolver.AmbiguousSessionError,
    FETCH_SESSIONS_TIMEOUT_MS: sessionResolver.FETCH_SESSIONS_TIMEOUT_MS,
  };
};

export async function runAttachCommand(
  target: ResolvedTarget,
  flags: AttachCommandFlags,
  deps: AttachCommandDeps,
  io: AttachCommandIO = defaultIO,
  loadHelpers: () => Promise<AttachCommandHelpers> = defaultLoader,
): Promise<number> {
  const helpers = await loadHelpers();

  let targetSessionId: string | undefined = target.targetId;
  let resolvedPort = target.port;
  let resolvedHost = target.host;

  const hasExplicitRemoteTarget =
    resolvedHost !== 'localhost' ||
    (resolvedHost === 'localhost' && !!flags.subcommandArg?.includes(':'));

  if (!targetSessionId && hasExplicitRemoteTarget) {
    // A. host:port without session id — auto-attach
    try {
      const sessions = await helpers.fetchSessions(resolvedHost, resolvedPort, 5000);
      if (sessions.length === 0) {
        io.err(`No sessions found at ${resolvedHost}:${resolvedPort}.`);
        return 1;
      }
      if (sessions.length === 1) {
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        targetSessionId = sessions[0]!.sessionId;
      } else {
        const attachable = sessions.filter((s) => s.canAttach);
        if (attachable.length === 1) {
          // biome-ignore lint/style/noNonNullAssertion: length checked above
          targetSessionId = attachable[0]!.sessionId;
        } else {
          io.err(`Multiple sessions at ${resolvedHost}:${resolvedPort}:`);
          for (const s of sessions) {
            io.err(`  ${s.name ?? s.sessionId.slice(0, 8)}`);
          }
          io.err(
            `Specify the session: remi attach ${resolvedHost}:${resolvedPort}/${sessions[0]?.name ?? sessions[0]?.sessionId.slice(0, 8)}`,
          );
          return 1;
        }
      }
    } catch (err) {
      io.err(`Cannot connect to ${resolvedHost}:${resolvedPort}: ${errorToString(err)}`);
      return 1;
    }
  } else if (!targetSessionId) {
    // B. No target id — auto-pick latest live session
    const liveSessions = deps.registry.listLive();
    if (liveSessions.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      const latest = liveSessions[0]!; // Already sorted by startedAt desc
      targetSessionId = latest.sessionId;
      resolvedPort = flags.port ?? latest.wsPort;
    } else {
      const sessions = deps.store.list();
      const active = sessions.filter((s) => s.exitedAt === null);
      if (active.length === 0) {
        io.err('No active sessions found. Run `remi ls` to see live sessions.');
        return 1;
      }
      const latest = active.reduce((a, b) =>
        new Date(b.startedAt).getTime() > new Date(a.startedAt).getTime() ? b : a,
      );
      targetSessionId = latest.remiSessionId;
      resolvedPort = flags.port ?? latest.port;
    }
  } else {
    // C. Target id/name provided — try multiple resolution strategies
    let resolvedByName = false;

    const liveMatch = deps.registry.findByName(targetSessionId);
    if (liveMatch) {
      resolvedPort = flags.port ?? liveMatch.wsPort;
    }

    const portsToQuery = flags.port || flags.host ? [resolvedPort] : deps.registry.getLivePorts();
    if (portsToQuery.length === 0) portsToQuery.push(resolvedPort);

    try {
      const queryResults = await helpers.queryMultiplePorts({
        host: resolvedHost,
        ports: portsToQuery,
        timeoutMs: helpers.FETCH_SESSIONS_TIMEOUT_MS,
        logLabel: 'attach',
      });
      const resolved = helpers.resolveSession(queryResults, targetSessionId);
      if (resolved) {
        targetSessionId = resolved.session.sessionId;
        resolvedPort = flags.port ?? resolved.port;
        resolvedByName = true;
      }
    } catch (err) {
      if (err instanceof helpers.AmbiguousSessionError) {
        io.err(err.message);
        return 1;
      }
      const msg = errorToString(err);
      if (helpers.classifyQueryError(msg) === 'unexpected') {
        io.log(`[Attach] Failed to query daemon for name resolution: ${msg}`);
      }
    }

    if (!resolvedByName) {
      const all = deps.store.list();
      const matches = all.filter(
        (s) =>
          s.remiSessionId === targetSessionId ||
          s.remiSessionId.startsWith(targetSessionId as string),
      );
      if (matches.length === 1) {
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        const match = matches[0]!;
        resolvedPort = flags.port ?? match.port;
        targetSessionId = match.remiSessionId;
      } else if (matches.length > 1) {
        io.err(`Ambiguous session ID "${targetSessionId}" matches ${matches.length} sessions:`);
        for (const m of matches) {
          io.err(`  ${m.remiSessionId.slice(0, 8)}  port=${m.port}`);
        }
        io.err('Provide a longer prefix to disambiguate.');
        return 1;
      } else if (!flags.host) {
        // Network discovery (mDNS + VPN). Session names look like "hostname:dir/branch";
        // the first colon separates the hostname.
        const targetName = targetSessionId as string;
        let foundRemote = false;
        const nameColonIdx = targetName.indexOf(':');
        if (nameColonIdx > 0) {
          const targetHostname = targetName.slice(0, nameColonIdx);
          try {
            io.err(`Resolving "${targetName}" via network discovery...`);
            const discovery = await helpers.discoverNetworkDaemons({
              defaultPort: resolvedPort,
              logLabel: 'attach',
            });
            if (discovery.endpoints.length > 0) {
              const hosts = [...new Set(discovery.endpoints.map((e) => e.hostname))];
              io.err(
                `\x1b[2mFound ${discovery.endpoints.length} daemon(s); hosts: [${hosts.join(', ')}]\x1b[0m`,
              );
            } else {
              io.err('No daemons discovered (0 mDNS, 0 VPN). Is Tailscale running?');
            }
            const hostEndpoints = helpers.findEndpointsByHostname(discovery, targetHostname);
            if (hostEndpoints.length > 0) {
              const discoveredPorts = hostEndpoints.map((e) => e.port);
              const allHostPorts = [
                ...new Set([...helpers.getDefaultPortRange(), ...discoveredPorts]),
              ].sort((a, b) => a - b);
              const remoteHost = hostEndpoints[0]?.host ?? targetHostname;
              const remoteHostname = hostEndpoints[0]?.hostname ?? targetHostname;
              const portResults = await helpers.queryMultiplePorts({
                host: remoteHost,
                ports: allHostPorts,
                timeoutMs: helpers.FETCH_SESSIONS_TIMEOUT_MS,
                logLabel: 'attach',
              });
              if (portResults.length === 0) {
                io.err(
                  `Daemon found on ${remoteHostname} but could not query any port. Check connectivity to ${remoteHost}.`,
                );
                return 1;
              }
              try {
                const remoteResolved = helpers.resolveSession(portResults, targetName);
                if (remoteResolved) {
                  targetSessionId = remoteResolved.session.sessionId;
                  resolvedHost = remoteResolved.host;
                  resolvedPort = remoteResolved.port;
                  foundRemote = true;
                  io.err(
                    `Found on ${remoteHostname} (${remoteResolved.host}:${remoteResolved.port})`,
                  );
                } else {
                  io.err(
                    `Daemon found on ${remoteHostname} but no session matches "${targetName}".`,
                  );
                  const available = portResults
                    .flatMap((r) => r.sessions)
                    .map((s) => s.name ?? s.sessionId.slice(0, 8))
                    .join(', ');
                  if (available) io.err(`  Available sessions: ${available}`);
                }
              } catch (resolveErr) {
                if (resolveErr instanceof helpers.AmbiguousSessionError) {
                  io.err(
                    `Ambiguous: ${resolveErr.matches.length} sessions match on ${remoteHostname}`,
                  );
                  for (const m of resolveErr.matches) {
                    io.err(`  ${m.name} (port ${m.port})`);
                  }
                  return 1;
                }
                throw resolveErr;
              }
            } else {
              io.err(`No daemon found for hostname "${targetHostname}" on the network or VPN.`);
            }
          } catch (err) {
            if (err instanceof helpers.AmbiguousSessionError) {
              throw err; // handled above
            }
            const reason = errorToString(err);
            io.log(`[Attach] Network discovery error for "${targetHostname}": ${reason}`);
            io.err(`Network discovery failed: ${reason}`);
          }
        }
        if (!foundRemote) {
          io.err(
            `No session found matching "${targetName}". Run \`remi ls --network\` to see available sessions.`,
          );
          return 1;
        }
      } else {
        io.err(
          `No session found matching "${targetSessionId}". Run \`remi ls\` to see live sessions.`,
        );
        return 1;
      }
    }
  }

  if (!targetSessionId) {
    io.err('No session to attach to. Run `remi ls` to see live sessions.');
    return 1;
  }

  try {
    const result = await helpers.runAttachClient({
      host: resolvedHost,
      port: resolvedPort,
      sessionId: targetSessionId,
    });
    return result.exitCode;
  } catch (err) {
    io.err(errorToString(err));
    return 1;
  }
}
