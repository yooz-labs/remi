/**
 * Remote New Client - Spawns a new daemon on a remote machine and auto-attaches.
 *
 * Flow:
 * 1. Open temporary WebSocket to existing daemon, authenticate, send create_session_request
 * 2. Remote daemon spawns a new daemon process on a free port
 * 3. Wait for create_session_response with sessionId and port
 * 4. Close temporary WebSocket
 * 5. Call runAttachClient to connect to the NEW daemon's port
 */

import {
  createCreateSessionRequest,
  createHello,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { runAttachClient } from './attach-client.ts';
import { performAuthHandshake } from './auth-helper.ts';

export interface RemoteNewOptions {
  readonly host: string;
  readonly port: number;
  readonly directory?: string | undefined;
  readonly timeout?: number;
}

interface RemoteSessionResult {
  readonly sessionId: UUID;
  readonly port: number;
}

async function createRemoteSession(
  host: string,
  port: number,
  directory?: string,
  timeout = 30000,
): Promise<RemoteSessionResult> {
  const url = `ws://${host}:${port}/ws`;

  return new Promise<RemoteSessionResult>((resolve, reject) => {
    let settled = false;
    let authInProgress = false;
    let ws: WebSocket;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      reject(new Error(`Cannot connect to daemon at ${host}:${port}: ${detail}`));
      return;
    }

    const timer = setTimeout(() => {
      ws.close();
      if (!settled) {
        settled = true;
        reject(new Error(`Timed out creating session on ${host}:${port}`));
      }
    }, timeout);

    function done(result?: RemoteSessionResult, err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else if (result) resolve(result);
      else reject(new Error('No session ID returned'));
    }

    function sendHello(): void {
      const clientId = generateId();
      ws.send(serialize(createHello(clientId, '1.0.0')));
    }

    function handleMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        ws.send(serialize(createCreateSessionRequest(directory)));
      } else if (msg.type === 'create_session_response') {
        if (msg.success && msg.sessionId) {
          // The daemon spawned a new daemon; use the returned port (or original if not present)
          done({ sessionId: msg.sessionId, port: msg.port ?? port });
        } else {
          done(undefined, new Error(`Failed to create session: ${msg.error ?? 'unknown error'}`));
        }
      } else if (msg.type === 'error') {
        if (msg.code === 'AUTH_REQUIRED') return;
        done(undefined, new Error(`Daemon error: ${msg.message}`));
      }
    }

    ws.onopen = () => {
      sendHello();
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
            sendHello();
          })
          .catch((err) => {
            done(undefined, err instanceof Error ? err : new Error(String(err)));
          });
        return;
      }

      if (authInProgress) return;
      handleMessage(msg);
    };

    ws.onerror = (event) => {
      const detail = 'message' in event ? `: ${(event as ErrorEvent).message}` : '';
      done(
        undefined,
        new Error(`WebSocket error connecting to daemon at ${host}:${port}${detail}`),
      );
    };

    ws.onclose = () => {
      if (!settled) {
        done(undefined, new Error('Connection closed before session was created'));
      }
    };
  });
}

export async function runRemoteNew(opts: RemoteNewOptions): Promise<{ exitCode: number }> {
  const { host, port, directory, timeout } = opts;

  console.error(`Creating session on ${host}:${port}...`);
  const result = await createRemoteSession(host, port, directory, timeout);

  if (result.port !== port) {
    console.error(`New daemon spawned on port ${result.port}`);
  }
  console.error(`Session created: ${result.sessionId.slice(0, 8)}`);
  console.error('Attaching...');

  return runAttachClient({ host, port: result.port, sessionId: result.sessionId });
}
