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
  const { host, port, timeout = 5000 } = opts;
  const url = `ws://${host}:${port}/ws`;

  return new Promise<void>((resolve, reject) => {
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
        renderSessionList(msg.sessions);
        resolve();
      } else if (msg.type === 'error') {
        // AUTH_REQUIRED is expected when hello is sent before auth completes
        if (msg.code === 'AUTH_REQUIRED' && authInProgress) return;
        clearTimeout(timer);
        settled = true;
        ws.close();
        reject(new Error(`Daemon error: ${msg.message}`));
      }
    }

    ws.onopen = () => {
      // Send hello immediately. If auth is needed, the daemon will send
      // auth_challenge and reject this hello with AUTH_REQUIRED (benign).
      // After auth succeeds, we re-send hello.
      sendHelloAndRequestList();
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) return;

      // If daemon sends auth_challenge, perform handshake then re-send hello
      if (msg.type === 'auth_challenge') {
        if (authInProgress) return; // duplicate challenge; ignore
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

      // During auth, the auth-helper's addEventListener handles messages;
      // only process in the caller after auth is done
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
    const status = s.status;
    const project = path.basename(s.projectPath).slice(0, 28);
    const age = formatAge(s.lastActivity);
    const mark = s.canAttach ? ' *' : '';

    console.log(
      `${id.padEnd(10)}${status.padEnd(12)}${project.padEnd(30)}${age.padStart(10)}${String(s.messageCount).padStart(6)}${mark}`,
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
