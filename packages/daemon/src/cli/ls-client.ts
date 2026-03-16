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
import {
  FETCH_SESSIONS_TIMEOUT_MS,
  MDNS_BROWSE_TIMEOUT_MS,
  discoverNetworkDaemons,
  queryMultiplePorts,
} from './session-resolver.ts';

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

// ---------------------------------------------------------------------------
// Host-based multi-port discovery (remi ls --host <addr>)
// ---------------------------------------------------------------------------

export interface HostLsOptions {
  readonly host: string;
  readonly ports: readonly number[];
  readonly timeout?: number;
}

/**
 * Query a specific host across a range of ports, rendering all discovered sessions.
 * Used when --host is specified without --port.
 */
export async function runHostLs(opts: HostLsOptions): Promise<void> {
  const { host, ports, timeout = FETCH_SESSIONS_TIMEOUT_MS } = opts;

  const results = await queryMultiplePorts({
    host,
    ports,
    timeoutMs: timeout,
    logLabel: 'ls',
  });

  if (results.length === 0) {
    // No port responded at all — host is unreachable or has no daemons
    const lo = ports[0];
    const hi = ports[ports.length - 1];
    console.error(`Cannot reach any remi daemon on ${host} (ports ${lo}-${hi}).`);
    console.error('Check that the host is reachable and a remi daemon is running.');
    return;
  }

  const allSessions = results.flatMap((r) => r.sessions);
  if (allSessions.length === 0) {
    console.log(`No active sessions on ${host}.`);
    return;
  }

  // Single port: render flat list (same as --host --port)
  if (results.length === 1) {
    renderSessionList(allSessions);
    return;
  }

  // Multiple ports: show port column
  const header = `${'NAME'.padEnd(28)}${'PORT'.padEnd(8)}${'STATUS'.padEnd(12)}${'DURATION'.padStart(10)}${'LAST ACTIVITY'.padStart(16)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    for (const s of r.sessions) {
      const name = (s.name ?? path.basename(s.projectPath)).slice(0, 26);
      const port = String(r.port);
      const duration = formatDuration(s.createdAt);
      const lastAct = formatAge(s.lastActivity);
      const mark = s.canAttach ? ' *' : '';

      console.log(
        `${name.padEnd(28)}${port.padEnd(8)}${s.status.padEnd(12)}${duration.padStart(10)}${lastAct.padStart(16)}${mark}`,
      );
    }
  }

  const attachable = results.flatMap((r) =>
    r.sessions.filter((s) => s.canAttach).map((s) => ({ ...s, port: r.port })),
  );
  if (attachable.length > 0) {
    console.log('');
    for (const a of attachable) {
      const name = a.name ?? a.sessionId.slice(0, 8);
      console.log(`  * ${name}: remi attach ${host}:${a.port}/${name}`);
    }
  }
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
        // Ignore session-creation errors — ls only cares about the session list.
        // These can arrive at any point (before or after hello_ack) depending on
        // daemon timing, so we unconditionally ignore them.
        if (
          msg.code === 'SESSION_CREATE_FAILED' ||
          msg.code === 'ATTACH_FAILED' ||
          msg.code === 'INVALID_DIRECTORY' ||
          msg.code === 'NO_SESSION'
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
  const {
    localPort,
    fetchTimeoutMs: timeout = FETCH_SESSIONS_TIMEOUT_MS,
    browseTimeoutMs: mdnsTimeout = MDNS_BROWSE_TIMEOUT_MS,
  } = opts;

  // Query all local daemons (multi-port support)
  const allLocalPorts = [...new Set([localPort, ...(opts.localPorts ?? [])])];
  const localResults = await queryMultiplePorts({
    host: 'localhost',
    ports: allLocalPorts,
    timeoutMs: timeout,
    logLabel: 'ls',
  });

  const localSessions: DiscoverableSession[] = localResults.flatMap((r) => r.sessions);
  const results: DaemonSessions[] = [];
  const myHostname = os.hostname();

  if (localSessions.length > 0) {
    results.push({
      daemon: { name: 'local', host: 'localhost', port: localPort, hostname: myHostname },
      sessions: localSessions,
    });
  }

  console.error('Scanning network for Remi daemons...');
  const discovery = await discoverNetworkDaemons({
    defaultPort: localPort,
    browseTimeoutMs: mdnsTimeout,
    probeTimeoutMs: timeout,
    logLabel: 'ls',
  });

  // Query all discovered endpoints in parallel
  const endpointResults = await Promise.allSettled(
    discovery.endpoints.map(async (endpoint) => {
      const portResults = await queryMultiplePorts({
        host: endpoint.host,
        ports: [endpoint.port],
        timeoutMs: timeout,
        logLabel: 'ls',
      });
      return { endpoint, portResults };
    }),
  );
  for (const er of endpointResults) {
    if (er.status === 'fulfilled') {
      for (const r of er.value.portResults) {
        results.push({
          daemon: {
            name:
              er.value.endpoint.name ?? `${er.value.endpoint.source}:${er.value.endpoint.hostname}`,
            host: er.value.endpoint.host,
            port: er.value.endpoint.port,
            hostname: er.value.endpoint.hostname,
          },
          sessions: r.sessions,
        });
      }
    }
  }

  renderNetworkSessionList(results);
}

// Re-export from session-resolver for backward compatibility
export { getLocalAddresses } from './session-resolver.ts';

function renderNetworkSessionList(results: DaemonSessions[]): void {
  if (results.length === 0) {
    console.log('No daemons found on the network.');
    console.log('Tip: run `remi ls` for local sessions, or ensure a remi daemon is running');
    return;
  }

  // Group by machine hostname so multiple daemons on the same host share one table
  const machineGroups = new Map<
    string,
    {
      label: string;
      host: string;
      entries: Array<{ daemon: DaemonSessions['daemon']; session: DiscoverableSession }>;
    }
  >();

  for (const { daemon, sessions } of results) {
    const key = daemon.host === 'localhost' ? 'localhost' : daemon.hostname;
    let group = machineGroups.get(key);
    if (!group) {
      const label = daemon.host === 'localhost' ? 'local' : `${daemon.hostname} (${daemon.host})`;
      group = { label, host: daemon.host, entries: [] };
      machineGroups.set(key, group);
    }
    for (const s of sessions) {
      group.entries.push({ daemon, session: s });
    }
  }

  let totalSessions = 0;
  const machineCount = machineGroups.size;

  for (const [, group] of machineGroups) {
    console.log(`\n== ${group.label} ==`);

    if (group.entries.length === 0) {
      console.log('  No active sessions');
      continue;
    }

    totalSessions += group.entries.length;

    const header = `  ${'NAME'.padEnd(28)}${'PORT'.padEnd(8)}${'STATUS'.padEnd(12)}${'DURATION'.padStart(10)}${'LAST ACTIVITY'.padStart(16)}`;
    console.log(header);
    console.log(`  ${'-'.repeat(header.length - 2)}`);

    for (const { daemon, session: s } of group.entries) {
      const name = (s.name ?? path.basename(s.projectPath)).slice(0, 26);
      const port = String(daemon.port);
      const duration = formatDuration(s.createdAt);
      const lastAct = formatAge(s.lastActivity);
      const mark = s.canAttach ? ' *' : '';

      console.log(
        `  ${name.padEnd(28)}${port.padEnd(8)}${s.status.padEnd(12)}${duration.padStart(10)}${lastAct.padStart(16)}${mark}`,
      );
    }
  }

  const daemonCount = results.length;
  if (machineCount === 1) {
    const machineName = machineGroups.values().next().value?.label ?? 'unknown';
    console.log(`\n${totalSessions} session(s) on ${machineName}`);
  } else {
    console.log(
      `\n${totalSessions} session(s) across ${daemonCount} daemon(s) on ${machineCount} machine(s)`,
    );
  }

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
  const { registry, timeout = FETCH_SESSIONS_TIMEOUT_MS } = opts;

  const ports = registry.getLivePorts();

  if (ports.length === 0) {
    console.log('No active sessions. Start one with: remi [claude-args...]');
    return;
  }

  const results = await queryMultiplePorts({
    host: 'localhost',
    ports,
    timeoutMs: timeout,
    logLabel: 'ls',
  });

  const allSessions: DiscoverableSession[] = results.flatMap((r) => r.sessions);
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
