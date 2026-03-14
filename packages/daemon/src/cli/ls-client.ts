import * as os from 'node:os';
import path from 'node:path';
import {
  createHello,
  createSessionListRequest,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import type { DiscoverableSession, ProtocolMessage, Timestamp } from '@remi/shared';
import type { SessionRegistryFile } from '../session/session-registry-file.ts';
import { performAuthHandshake } from './auth-helper.ts';

export interface RemoteTarget {
  readonly host: string;
  readonly port: number;
  readonly sessionId: string;
}

export function parseRemoteTarget(input: string, defaultPort: number): RemoteTarget {
  const slashIdx = input.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`Invalid remote address "${input}". Expected: host:port/session-id`);
  }
  const hostPort = input.slice(0, slashIdx);
  const sessionId = input.slice(slashIdx + 1);
  if (!sessionId) {
    throw new Error(`Missing session ID in "${input}". Expected: host:port/session-id`);
  }

  const colonIdx = hostPort.lastIndexOf(':');
  if (colonIdx > 0) {
    const host = hostPort.slice(0, colonIdx);
    const portStr = hostPort.slice(colonIdx + 1);
    const port = Number.parseInt(portStr);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port "${portStr}" in remote address. Must be 1-65535.`);
    }
    return { host, port, sessionId };
  }
  return { host: hostPort, port: defaultPort, sessionId };
}

/**
 * Parse a host:port string, optionally stripping trailing alphabetic garbage
 * from copy-paste (e.g., "100.79.39.98:18767idle").
 * Returns null if the input doesn't look like host:port.
 * Returns { host, port, cleaned } if matched; `cleaned` is the trailing text that was stripped, or undefined.
 */
export function parseHostPort(
  input: string,
): { host: string; port: number; cleaned?: string } | null {
  const match = input.match(/^(.+):(\d+)([a-zA-Z]+)?$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (port <= 1024 || port > 65535) return null;
  const host = match[1] as string;
  if (match[3]) return { host, port, cleaned: match[3] };
  return { host, port };
}

export interface LsClientOptions {
  host: string;
  port: number;
  timeout?: number;
}

export async function runLsClient(opts: LsClientOptions): Promise<void> {
  const sessions = await fetchSessions(opts.host, opts.port, opts.timeout);
  renderSessionList(sessions);
}

export async function fetchSessions(
  host: string,
  port: number,
  timeout = 5000,
): Promise<DiscoverableSession[]> {
  const url = `ws://${host}:${port}/ws`;

  return new Promise<DiscoverableSession[]>((resolve, reject) => {
    let settled = false;
    let authInProgress = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      reject(new Error(`Cannot connect to daemon at ${host}:${port}. Is remi running?`));
      return;
    }

    const timer = setTimeout(() => {
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out connecting to daemon at ${host}:${port}`));
      }
    }, timeout);

    function sendHelloAndRequestList(): void {
      const clientId = generateId();
      ws.send(serialize(createHello(clientId, '1.0.0')));
    }

    let sentListRequest = false;

    function handleProtocolMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        if (!sentListRequest) {
          sentListRequest = true;
          ws.send(serialize(createSessionListRequest(false)));
        }
        // Subsequent hello_acks (with real session ID after session creation) are expected
      } else if (msg.type === 'session_list_response') {
        clearTimeout(timer);
        settled = true;
        ws.close();
        resolve(msg.sessions as DiscoverableSession[]);
      } else if (msg.type === 'error') {
        if (msg.code === 'AUTH_REQUIRED' && authInProgress) return;
        // After first hello_ack, ignore session-creation errors (we only care about the list)
        if (
          sentListRequest &&
          (msg.code === 'SESSION_CREATE_FAILED' ||
            msg.code === 'ATTACH_FAILED' ||
            msg.code === 'INVALID_DIRECTORY')
        ) {
          return;
        }
        clearTimeout(timer);
        settled = true;
        ws.close();
        reject(new Error(`Daemon error: ${msg.message}`));
      }
    }

    ws.onopen = () => {
      sendHelloAndRequestList();
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) return;

      if (msg.type === 'auth_challenge') {
        if (authInProgress) return;
        authInProgress = true;
        performAuthHandshake(ws, msg)
          .then(() => {
            authInProgress = false;
            sendHelloAndRequestList();
          })
          .catch((err) => {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
        return;
      }

      if (authInProgress) return;
      handleProtocolMessage(msg);
    };

    ws.onclose = () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error('Connection to daemon closed unexpectedly. Is remi running?'));
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Cannot connect to daemon at ${host}:${port}. Is remi running?`));
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Network discovery
// ---------------------------------------------------------------------------

export interface NetworkLsOptions {
  readonly localPort: number;
  /** Additional local ports to query (from live sessions registry). */
  readonly localPorts?: readonly number[];
  /** Timeout for WebSocket session fetches, in ms. Default: 5000 */
  readonly fetchTimeoutMs?: number | undefined;
  /** Timeout for mDNS network browse, in ms. Default: 3000 */
  readonly browseTimeoutMs?: number | undefined;
}

interface DaemonSessions {
  readonly daemon: {
    readonly name: string;
    readonly host: string;
    readonly port: number;
    readonly hostname: string;
  };
  readonly sessions: readonly DiscoverableSession[];
}

export async function runNetworkLs(opts: NetworkLsOptions): Promise<void> {
  const { localPort, fetchTimeoutMs: timeout = 5000, browseTimeoutMs: mdnsTimeout = 3000 } = opts;

  // Try all local daemons (multi-port support)
  const allLocalPorts = new Set([localPort, ...(opts.localPorts ?? [])]);
  const localSessions: DiscoverableSession[] = [];
  const localResults = await Promise.allSettled(
    [...allLocalPorts].map(async (port) => {
      const sessions = await fetchSessions('localhost', port, timeout);
      return { port, sessions };
    }),
  );
  const localPortsArr = [...allLocalPorts];
  for (let i = 0; i < localResults.length; i++) {
    const result = localResults[i];
    if (result?.status === 'fulfilled') {
      localSessions.push(...result.value.sessions);
    } else if (result?.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      if (!reason.includes('Cannot connect') && !reason.includes('closed unexpectedly')) {
        const isExpected =
          reason.includes('not found') ||
          reason.includes('ENOENT') ||
          reason.includes('SESSION_CREATE_FAILED');
        if (isExpected) {
          console.error(`\x1b[2m[ls] local port ${localPortsArr[i]}: ${reason}\x1b[0m`);
        } else {
          console.error(`[ls] Failed to query local port ${localPortsArr[i]}: ${reason}`);
        }
      }
    }
  }

  console.error('Scanning network for Remi daemons...');
  const { discoverDaemons } = await import('../mdns/mdns-browser.ts');
  const { discoverVpnPeers } = await import('../mdns/vpn-discovery.ts');

  // Run mDNS and VPN discovery in parallel
  const [daemons, vpnPeers] = await Promise.all([
    discoverDaemons({ timeoutMs: mdnsTimeout }),
    discoverVpnPeers({ port: localPort, probeTimeoutMs: timeout }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ls] VPN discovery failed: ${msg}`);
      return [] as {
        peer: import('../mdns/vpn-discovery.ts').VpnPeer;
        host: string;
        port: number;
      }[];
    }),
  ]);

  const results: DaemonSessions[] = [];
  const myHostname = os.hostname();

  if (localSessions.length > 0) {
    results.push({
      daemon: { name: 'local', host: 'localhost', port: localPort, hostname: myHostname },
      sessions: localSessions,
    });
  }

  // Query remote daemons (mDNS) in parallel, filtering out self
  const localAddrs = getLocalAddresses(myHostname);
  const remoteDaemons = daemons.filter((d) => !(d.port === localPort && localAddrs.has(d.host)));

  // Track hosts already discovered via mDNS to deduplicate VPN results
  const discoveredHosts = new Set(remoteDaemons.map((d) => d.host));

  const remoteResults = await Promise.allSettled(
    remoteDaemons.map(async (daemon) => {
      const sessions = await fetchSessions(daemon.host, daemon.port, timeout);
      return {
        daemon: {
          name: daemon.name,
          host: daemon.host,
          port: daemon.port,
          hostname: daemon.hostname,
        },
        sessions,
      } satisfies DaemonSessions;
    }),
  );

  for (let i = 0; i < remoteResults.length; i++) {
    const r = remoteResults[i];
    if (r?.status === 'fulfilled') {
      results.push(r.value);
    } else if (r?.status === 'rejected') {
      const daemon = remoteDaemons[i];
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      const label = `${daemon?.name ?? 'unknown'} at ${daemon?.host ?? '?'}:${daemon?.port ?? '?'}`;
      const isTimeout = reason.includes('Timed out') || reason.includes('timeout');
      if (isTimeout) {
        console.error(`\x1b[2m[ls] ${label}: ${reason}\x1b[0m`);
      } else {
        console.error(`[ls] Failed to query ${label}: ${reason}`);
      }
    }
  }

  // Query VPN peers not already found via mDNS
  const newVpnPeers = vpnPeers.filter(
    (v) => !localAddrs.has(v.host) && !discoveredHosts.has(v.host),
  );
  if (newVpnPeers.length > 0) {
    const vpnResults = await Promise.allSettled(
      newVpnPeers.map(async ({ peer, host, port }) => {
        const sessions = await fetchSessions(host, port, timeout);
        return {
          daemon: {
            name: `vpn:${peer.hostname}`,
            host,
            port,
            hostname: peer.hostname,
          },
          sessions,
        } satisfies DaemonSessions;
      }),
    );
    for (let i = 0; i < vpnResults.length; i++) {
      const r = vpnResults[i];
      if (r?.status === 'fulfilled') {
        results.push(r.value);
      } else if (r?.status === 'rejected') {
        // Connection refused is expected (peer has no remi); log other errors
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        if (!reason.includes('Cannot connect') && !reason.includes('closed unexpectedly')) {
          const vpnPeer = newVpnPeers[i];
          console.error(
            `[ls] VPN peer ${vpnPeer?.peer.hostname ?? 'unknown'} at ${vpnPeer?.host ?? '?'}:${vpnPeer?.port ?? '?'}: ${reason}`,
          );
        }
      }
    }
  }

  renderNetworkSessionList(results);
}

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

function renderNetworkSessionList(results: DaemonSessions[]): void {
  if (results.length === 0) {
    console.log('No daemons found on the network.');
    console.log('Tip: run `remi ls` for local sessions, or ensure a remi daemon is running');
    return;
  }

  for (const { daemon, sessions } of results) {
    const label =
      daemon.host === 'localhost'
        ? `local (port ${daemon.port})`
        : `${daemon.hostname} (${daemon.host}:${daemon.port})`;
    console.log(`\n== ${label} ==`);

    if (sessions.length === 0) {
      console.log('  No active sessions');
      continue;
    }

    const header = `  ${'NAME'.padEnd(28)}${'HOST'.padEnd(24)}${'STATUS'.padEnd(12)}${'DURATION'.padStart(10)}${'LAST ACTIVITY'.padStart(16)}`;
    console.log(header);
    console.log(`  ${'-'.repeat(header.length - 2)}`);

    for (const s of sessions) {
      const name = (s.name ?? path.basename(s.projectPath)).slice(0, 26);
      const host = `${daemon.host}:${daemon.port}`;
      const duration = formatDuration(s.createdAt);
      const lastAct = formatAge(s.lastActivity);
      const mark = s.canAttach ? ' *' : '';

      console.log(
        `  ${name.padEnd(28)}${host.padEnd(24)}${s.status.padEnd(12)}${duration.padStart(10)}${lastAct.padStart(16)}${mark}`,
      );
    }
  }

  const totalSessions = results.reduce((sum, r) => sum + r.sessions.length, 0);
  console.log(`\n${totalSessions} session(s) across ${results.length} daemon(s)`);

  const attachable = results.flatMap((r) =>
    r.sessions.filter((s) => s.canAttach).map((s) => ({ ...s, daemon: r.daemon })),
  );
  if (attachable.length > 0) {
    console.log('');
    for (const a of attachable) {
      const name = a.name ?? a.sessionId.slice(0, 8);
      if (a.daemon.host === 'localhost') {
        console.log(`  * ${name}: remi attach ${name}`);
      } else {
        console.log(`  * ${name}: remi attach ${a.daemon.host}:${a.daemon.port}/${name}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderSessionList(sessions: readonly DiscoverableSession[]): void {
  if (sessions.length === 0) {
    console.log('No active sessions. Start one with: remi [claude-args...]');
    return;
  }

  const header = `${'NAME'.padEnd(28)}${'STATUS'.padEnd(12)}${'DURATION'.padStart(10)}${'LAST ACTIVITY'.padStart(16)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const s of sessions) {
    const name = (s.name ?? path.basename(s.projectPath)).slice(0, 26);
    const duration = formatDuration(s.createdAt);
    const lastAct = formatAge(s.lastActivity);
    const mark = s.canAttach ? ' *' : '';

    console.log(
      `${name.padEnd(28)}${s.status.padEnd(12)}${duration.padStart(10)}${lastAct.padStart(16)}${mark}`,
    );
  }

  const attachable = sessions.filter((s) => s.canAttach);
  if (attachable.length > 0) {
    console.log('');
    console.log(
      `${attachable.length} session(s) available to attach (* marked). Use: remi attach <name-or-id>`,
    );
  }
}

/**
 * Format a timestamp as relative time: "30s ago", "5m ago", "2h ago", "3d ago".
 */
export function formatAge(timestamp: Timestamp): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Multi-port local discovery
// ---------------------------------------------------------------------------

export interface MultiPortLsOptions {
  readonly registry: SessionRegistryFile;
  readonly timeout?: number;
}

/**
 * Discover all local remi sessions by reading the live sessions registry
 * and querying each unique port.
 */
export async function runMultiPortLs(opts: MultiPortLsOptions): Promise<void> {
  const { registry, timeout = 5000 } = opts;

  const ports = registry.getLivePorts();

  if (ports.length === 0) {
    console.log('No active sessions. Start one with: remi [claude-args...]');
    return;
  }

  // Query each port in parallel
  const results = await Promise.allSettled(
    ports.map(async (port) => {
      const sessions = await fetchSessions('localhost', port, timeout);
      return { port, sessions };
    }),
  );

  const allSessions: DiscoverableSession[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'fulfilled') {
      allSessions.push(...result.value.sessions);
    } else if (result?.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      // Connection refused is expected (process may have just exited); log others
      if (!reason.includes('Cannot connect') && !reason.includes('closed unexpectedly')) {
        const isExpected =
          reason.includes('not found') ||
          reason.includes('ENOENT') ||
          reason.includes('SESSION_CREATE_FAILED');
        if (isExpected) {
          console.error(`\x1b[2m[ls] local port ${ports[i]}: ${reason}\x1b[0m`);
        } else {
          console.error(`[ls] Failed to query local port ${ports[i]}: ${reason}`);
        }
      }
    }
  }

  renderSessionList(allSessions);
}

/**
 * Format a timestamp as a duration from creation to now: "30s", "45m", "2h 15m", "3d 2h".
 * If createdAt is undefined, returns "-".
 */
export function formatDuration(createdAt: Timestamp | undefined): string {
  if (createdAt === undefined) return '-';

  const diff = Date.now() - new Date(createdAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(diff / 1000));

  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}
