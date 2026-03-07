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
  localPort: number;
  timeout?: number;
  mdnsTimeout?: number;
}

interface DaemonSessions {
  daemon: { name: string; host: string; port: number; hostname: string };
  sessions: DiscoverableSession[];
}

export async function runNetworkLs(opts: NetworkLsOptions): Promise<void> {
  const { localPort, timeout = 5000, mdnsTimeout = 3000 } = opts;

  // Try local daemon first
  let localSessions: DiscoverableSession[] = [];
  try {
    localSessions = await fetchSessions('localhost', localPort, timeout);
  } catch {
    // Local daemon not running; that's OK when scanning network
  }

  console.error('Scanning network for Remi daemons...');
  const { discoverDaemons } = await import('../mdns/mdns-browser.ts');
  const daemons = await discoverDaemons({ timeout: mdnsTimeout });

  const results: DaemonSessions[] = [];
  const myHostname = os.hostname();

  if (localSessions.length > 0) {
    results.push({
      daemon: { name: 'local', host: 'localhost', port: localPort, hostname: myHostname },
      sessions: localSessions,
    });
  }

  // Query remote daemons in parallel, filtering out self
  const remotePromises = daemons
    .filter((d) => !(d.port === localPort && isLocalAddress(d.host, myHostname)))
    .map(async (daemon) => {
      try {
        const sessions = await fetchSessions(daemon.host, daemon.port, timeout);
        results.push({
          daemon: {
            name: daemon.name,
            host: daemon.host,
            port: daemon.port,
            hostname: daemon.hostname,
          },
          sessions,
        });
      } catch {
        // Could not reach this daemon; skip
      }
    });

  await Promise.all(remotePromises);

  renderNetworkSessionList(results);
}

function isLocalAddress(addr: string, hostname: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr === hostname;
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

    const header = `  ${'ID'.padEnd(10)}${'STATUS'.padEnd(12)}${'PROJECT'.padEnd(30)}${'AGE'.padStart(10)}${'MSGS'.padStart(6)}`;
    console.log(header);
    console.log(`  ${'-'.repeat(header.length - 2)}`);

    for (const s of sessions) {
      const id = s.sessionId.slice(0, 8);
      const project = path.basename(s.projectPath).slice(0, 28);
      const age = formatAge(s.lastActivity);
      const mark = s.canAttach ? ' *' : '';

      console.log(
        `  ${id.padEnd(10)}${s.status.padEnd(12)}${project.padEnd(30)}${age.padStart(10)}${String(s.messageCount).padStart(6)}${mark}`,
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
      const id = a.sessionId.slice(0, 8);
      if (a.daemon.host === 'localhost') {
        console.log(`  * ${id}: remi attach ${id}`);
      } else {
        console.log(`  * ${id}: remi attach ${a.daemon.host}:${a.daemon.port}/${id}`);
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

  const header = `${'ID'.padEnd(10)}${'STATUS'.padEnd(12)}${'PROJECT'.padEnd(30)}${'AGE'.padStart(10)}${'MSGS'.padStart(6)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const s of sessions) {
    const id = s.sessionId.slice(0, 8);
    const project = path.basename(s.projectPath).slice(0, 28);
    const age = formatAge(s.lastActivity);
    const mark = s.canAttach ? ' *' : '';

    console.log(
      `${id.padEnd(10)}${s.status.padEnd(12)}${project.padEnd(30)}${age.padStart(10)}${String(s.messageCount).padStart(6)}${mark}`,
    );
  }

  const attachable = sessions.filter((s) => s.canAttach);
  if (attachable.length > 0) {
    console.log('');
    console.log(
      `${attachable.length} session(s) available to attach (* marked). Use: remi attach <id>`,
    );
  }
}

function formatAge(timestamp: Timestamp): string {
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
