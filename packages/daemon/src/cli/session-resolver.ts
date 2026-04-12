/**
 * Unified session discovery and resolution utilities.
 *
 * Consolidates duplicated logic from ls-client, kill-client, and cli.ts (attach)
 * into composable functions: error classification, multi-port querying,
 * session resolution, and network daemon discovery.
 */

import * as os from 'node:os';
import type { DiscoverableSession } from '@remi/shared';

// ---------------------------------------------------------------------------
// Timeout constants (unified across all commands)
// ---------------------------------------------------------------------------

/** Timeout for fetchSessions WebSocket calls (ms) */
export const FETCH_SESSIONS_TIMEOUT_MS = 5000;
/** Timeout for VPN peer probing (ms) */
export const VPN_PROBE_TIMEOUT_MS = 3000;
/** Timeout for mDNS browsing (ms) */
export const MDNS_BROWSE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type QueryErrorClass = 'connection' | 'expected' | 'unexpected';

/**
 * Classify a query error into one of three categories:
 * - `'connection'`: daemon unreachable (suppressed entirely)
 * - `'expected'`: benign errors like not-found or session-create-failed (dimmed)
 * - `'unexpected'`: everything else (full error)
 */
export function classifyQueryError(reason: string): QueryErrorClass {
  // Connection failures: daemon not running or unreachable
  if (
    reason.includes('Cannot connect') ||
    reason.includes('closed unexpectedly') ||
    reason.includes('ECONNREFUSED') ||
    reason.includes('ECONNRESET')
  ) {
    return 'connection';
  }

  // Expected/benign errors
  if (
    reason.includes('not found') ||
    reason.includes('ENOENT') ||
    reason.includes('SESSION_CREATE_FAILED') ||
    reason.includes('Failed to create session') ||
    reason.includes('No active session')
  ) {
    return 'expected';
  }

  return 'unexpected';
}

// ---------------------------------------------------------------------------
// Multi-port querying
// ---------------------------------------------------------------------------

export interface PortQueryResult {
  readonly port: number;
  readonly host: string;
  readonly sessions: readonly DiscoverableSession[];
}

export interface QueryMultiplePortsOptions {
  readonly host: string;
  readonly ports: readonly number[];
  readonly timeoutMs?: number;
  /** Label prefix for log messages (e.g. "ls", "attach") */
  readonly logLabel?: string;
}

/**
 * Query multiple daemon ports in parallel, returning successful results.
 * Failed queries are classified and logged uniformly.
 */
export async function queryMultiplePorts(
  opts: QueryMultiplePortsOptions,
): Promise<PortQueryResult[]> {
  const { host, ports, timeoutMs = FETCH_SESSIONS_TIMEOUT_MS, logLabel = 'remi' } = opts;

  if (ports.length === 0) return [];

  const { fetchSessions } = await import('./ls-client.ts');

  const results = await Promise.allSettled(
    ports.map(async (port) => {
      const sessions = await fetchSessions(host, port, timeoutMs);
      return { port, host, sessions } satisfies PortQueryResult;
    }),
  );

  const successful: PortQueryResult[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'fulfilled') {
      successful.push(result.value);
    } else if (result?.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      const errorClass = classifyQueryError(reason);

      if (errorClass === 'expected') {
        console.error(`\x1b[2m[${logLabel}] ${host}:${ports[i]}: ${reason}\x1b[0m`);
      } else if (errorClass === 'unexpected') {
        // Suppress timeouts when probing multiple ports (most won't have daemons)
        if (ports.length > 1 && reason.includes('Timed out')) {
          // Normal: timeout on one of many probed ports
        } else {
          console.error(`[${logLabel}] Failed to query ${host}:${ports[i]}: ${reason}`);
        }
      }
      // 'connection' errors are suppressed
    }
  }

  return successful;
}

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

export interface ResolvedSession {
  readonly session: DiscoverableSession;
  readonly port: number;
  readonly host: string;
}

export class AmbiguousSessionError extends Error {
  readonly matches: ReadonlyArray<{ name: string; port: number }>;

  constructor(target: string, matches: ReadonlyArray<{ name: string; port: number }>) {
    const list = matches.map((m) => `  ${m.name} (port ${m.port})`).join('\n');
    super(
      `Ambiguous session "${target}" matches ${matches.length} sessions:\n${list}\nProvide a longer name or ID to disambiguate.`,
    );
    this.name = 'AmbiguousSessionError';
    this.matches = matches;
  }
}

/**
 * Resolve a session by name or ID from query results.
 *
 * Resolution order: exact name -> prefix name -> exact ID -> prefix ID.
 * Throws `AmbiguousSessionError` if multiple matches exist at any resolution
 * level (exact name, prefix name, or prefix ID). Multiple exact ID matches
 * fall through to prefix ID matching (UUID collisions are near-impossible).
 * Returns null if no match found.
 */
export function resolveSession(
  results: readonly PortQueryResult[],
  nameOrId: string,
): ResolvedSession | null {
  // Flatten results into entries with host/port context
  const entries: Array<{ session: DiscoverableSession; host: string; port: number }> = [];
  for (const r of results) {
    for (const session of r.sessions) {
      entries.push({ session, host: r.host, port: r.port });
    }
  }

  function toResult(arr: typeof entries): ResolvedSession | null {
    if (arr.length !== 1) return null;
    const match = arr[0] as (typeof entries)[0];
    return { session: match.session, port: match.port, host: match.host };
  }

  // 1. Exact name match
  const exactName = entries.filter((e) => e.session.name === nameOrId);
  const exactNameResult = toResult(exactName);
  if (exactNameResult) return exactNameResult;
  if (exactName.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      exactName.map((e) => ({
        name: e.session.name ?? e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  // 2. Prefix name match
  const prefixName = entries.filter((e) => e.session.name?.startsWith(nameOrId));
  const prefixNameResult = toResult(prefixName);
  if (prefixNameResult) return prefixNameResult;
  if (prefixName.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      prefixName.map((e) => ({
        name: e.session.name ?? e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  // 3. Exact ID match
  const exactId = entries.filter((e) => e.session.sessionId === nameOrId);
  const exactIdResult = toResult(exactId);
  if (exactIdResult) return exactIdResult;

  // 4. Prefix ID match
  const prefixId = entries.filter((e) => e.session.sessionId.startsWith(nameOrId));
  const prefixIdResult = toResult(prefixId);
  if (prefixIdResult) return prefixIdResult;
  if (prefixId.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      prefixId.map((e) => ({
        name: e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  // 5. Stripped name match (remove hostname: prefix from session names)
  // e.g. user types "remi/develop", matches "yahyas-mcm:remi/develop"
  const strippedExact = entries.filter((e) => {
    if (!e.session.name) return false;
    const colonIdx = e.session.name.indexOf(':');
    if (colonIdx < 0) return false;
    return e.session.name.slice(colonIdx + 1) === nameOrId;
  });
  const strippedExactResult = toResult(strippedExact);
  if (strippedExactResult) return strippedExactResult;
  if (strippedExact.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      strippedExact.map((e) => ({
        name: e.session.name ?? e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  const strippedPrefix = entries.filter((e) => {
    if (!e.session.name) return false;
    const colonIdx = e.session.name.indexOf(':');
    if (colonIdx < 0) return false;
    return e.session.name.slice(colonIdx + 1).startsWith(nameOrId);
  });
  const strippedPrefixResult = toResult(strippedPrefix);
  if (strippedPrefixResult) return strippedPrefixResult;
  if (strippedPrefix.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      strippedPrefix.map((e) => ({
        name: e.session.name ?? e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  // 6. Branch segment match (everything after the last `/` in session name)
  // e.g. user types "develop", matches "yahyas-mcm:remi/develop"
  const branchExact = entries.filter((e) => {
    if (!e.session.name) return false;
    const lastSlash = e.session.name.lastIndexOf('/');
    if (lastSlash < 0) return false;
    return e.session.name.slice(lastSlash + 1) === nameOrId;
  });
  const branchExactResult = toResult(branchExact);
  if (branchExactResult) return branchExactResult;
  if (branchExact.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      branchExact.map((e) => ({
        name: e.session.name ?? e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  const branchPrefix = entries.filter((e) => {
    if (!e.session.name) return false;
    const lastSlash = e.session.name.lastIndexOf('/');
    if (lastSlash < 0) return false;
    return e.session.name.slice(lastSlash + 1).startsWith(nameOrId);
  });
  const branchPrefixResult = toResult(branchPrefix);
  if (branchPrefixResult) return branchPrefixResult;
  if (branchPrefix.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      branchPrefix.map((e) => ({
        name: e.session.name ?? e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  // 7. Contains match (final fallback)
  // e.g. user types "285-bug", matches "yahyas-mcm:remi/285-bug-multiple-sessions..."
  const contains = entries.filter((e) => e.session.name?.includes(nameOrId));
  const containsResult = toResult(contains);
  if (containsResult) return containsResult;
  if (contains.length > 1) {
    throw new AmbiguousSessionError(
      nameOrId,
      contains.map((e) => ({
        name: e.session.name ?? e.session.sessionId.slice(0, 8),
        port: e.port,
      })),
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Network daemon discovery
// ---------------------------------------------------------------------------

export interface DiscoveredEndpoint {
  /** IP address or resolvable network address */
  readonly host: string;
  readonly port: number;
  /** Human-readable machine name (e.g., OS hostname) */
  readonly hostname: string;
  readonly source: 'mdns' | 'vpn';
  readonly name?: string;
}

export interface NetworkDiscoveryResult {
  readonly endpoints: readonly DiscoveredEndpoint[];
}

export interface NetworkDiscoveryOptions {
  readonly defaultPort: number;
  readonly browseTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly logLabel?: string;
}

/**
 * Discover remi daemons on the network via mDNS and VPN.
 * Deduplicates VPN results that overlap with mDNS discoveries.
 * Filters out local addresses.
 */
export async function discoverNetworkDaemons(
  opts: NetworkDiscoveryOptions,
): Promise<NetworkDiscoveryResult> {
  const {
    defaultPort,
    browseTimeoutMs = MDNS_BROWSE_TIMEOUT_MS,
    probeTimeoutMs = VPN_PROBE_TIMEOUT_MS,
    logLabel = 'remi',
  } = opts;

  const { discoverDaemons } = await import('../mdns/mdns-browser.ts');
  const { discoverVpnPeers } = await import('../mdns/vpn-discovery.ts');

  const [daemons, vpnPeers] = await Promise.all([
    discoverDaemons({ timeoutMs: browseTimeoutMs }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${logLabel}] mDNS discovery failed: ${msg}`);
      return [] as import('../mdns/mdns-browser.ts').DiscoveredDaemon[];
    }),
    discoverVpnPeers({ port: defaultPort, probeTimeoutMs }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${logLabel}] VPN discovery failed: ${msg}`);
      return [] as {
        peer: { hostname: string; ip: string; os: string; provider: string };
        host: string;
        port: number;
      }[];
    }),
  ]);

  const myHostname = os.hostname();
  const localAddrs = getLocalAddresses(myHostname);

  // Convert mDNS daemons to endpoints, filtering out self (any local address, any port)
  const mdnsEndpoints: DiscoveredEndpoint[] = daemons
    .filter((d) => !localAddrs.has(d.host))
    .map((d) => ({
      host: d.host,
      port: d.port,
      hostname: d.hostname,
      source: 'mdns' as const,
      name: d.name,
    }));

  const mdnsHosts = new Set(mdnsEndpoints.map((e) => e.host));

  // Convert VPN peers to endpoints, filtering out self and mDNS duplicates
  const vpnEndpoints: DiscoveredEndpoint[] = vpnPeers
    .filter((v) => !localAddrs.has(v.host) && !mdnsHosts.has(v.host))
    .map((v) => ({
      host: v.host,
      port: v.port,
      hostname: v.peer.hostname,
      source: 'vpn' as const,
    }));

  return {
    endpoints: [...mdnsEndpoints, ...vpnEndpoints],
  };
}

/**
 * Filter endpoints matching a given hostname from discovery results.
 */
export function findEndpointsByHostname(
  result: NetworkDiscoveryResult,
  hostname: string,
): DiscoveredEndpoint[] {
  return result.endpoints.filter((e) => e.hostname === hostname);
}

// ---------------------------------------------------------------------------
// Local address helpers
// ---------------------------------------------------------------------------

/**
 * Get all local addresses (for filtering out self in network discovery).
 */
export function getLocalAddresses(hostname: string): Set<string> {
  const addrs = new Set(['127.0.0.1', '::1', 'localhost', hostname]);
  const interfaces = os.networkInterfaces();
  for (const ifaces of Object.values(interfaces)) {
    if (ifaces) {
      for (const iface of ifaces) {
        addrs.add(iface.address);
      }
    }
  }
  return addrs;
}
