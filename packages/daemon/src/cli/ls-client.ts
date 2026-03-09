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

    function handleProtocolMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        ws.send(serialize(createSessionListRequest(false)));
      } else if (msg.type === 'session_list_response') {
        clearTimeout(timer);
        settled = true;
        ws.close();
        resolve(msg.sessions as DiscoverableSession[]);
      } else if (msg.type === 'error') {
        if (msg.code === 'AUTH_REQUIRED' && authInProgress) return;
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

  // Try local daemon first
  let localSessions: DiscoverableSession[] = [];
  try {
    localSessions = await fetchSessions('localhost', localPort, timeout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Connection refused is expected when no local daemon is running
    if (!msg.includes('Cannot connect') && !msg.includes('closed unexpectedly')) {
      console.error(`Warning: local daemon error: ${msg}`);
    }
  }

  console.error('Scanning network for Remi daemons...');
  const { discoverDaemons } = await import('../mdns/mdns-browser.ts');
  const daemons = await discoverDaemons({ timeoutMs: mdnsTimeout });

  const results: DaemonSessions[] = [];
  const myHostname = os.hostname();

  if (localSessions.length > 0) {
    results.push({
      daemon: { name: 'local', host: 'localhost', port: localPort, hostname: myHostname },
      sessions: localSessions,
    });
  }

  // Query remote daemons in parallel, filtering out self
  const localAddrs = getLocalAddresses(myHostname);
  const remoteDaemons = daemons.filter((d) => !(d.port === localPort && localAddrs.has(d.host)));

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
      console.error(
        `[ls] Failed to query daemon ${daemon?.name ?? 'unknown'} at ${daemon?.host ?? '?'}:${daemon?.port ?? '?'}: ${reason}`,
      );
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
    console.log('Tip: run `remi ls` for local sessions, or start a daemon with `--bind 0.0.0.0`');
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

    const header = `  ${'NAME'.padEnd(28)}${'HOST'.padEnd(18)}${'STATUS'.padEnd(12)}${'DURATION'.padStart(10)}${'LAST ACTIVITY'.padStart(16)}`;
    console.log(header);
    console.log(`  ${'-'.repeat(header.length - 2)}`);

    for (const s of sessions) {
      const name = (s.name ?? path.basename(s.projectPath)).slice(0, 26);
      const host = `${daemon.host}:${daemon.port}`;
      const duration = formatDuration(s.createdAt);
      const lastAct = formatAge(s.lastActivity);
      const mark = s.canAttach ? ' *' : '';

      console.log(
        `  ${name.padEnd(28)}${host.padEnd(18)}${s.status.padEnd(12)}${duration.padStart(10)}${lastAct.padStart(16)}${mark}`,
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
