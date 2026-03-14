/**
 * Remote New Client - Creates a session on a remote daemon and auto-attaches.
 *
 * Flow:
 * 1. Open temporary WebSocket, authenticate, send create_session_request
 * 2. Wait for create_session_response with sessionId
 * 3. Close temporary WebSocket
 * 4. Call runAttachClient for the full attach lifecycle
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

async function createRemoteSession(
  host: string,
  port: number,
  directory?: string,
  timeout = 10000,
): Promise<UUID> {
  const url = `ws://${host}:${port}/ws`;

  return new Promise<UUID>((resolve, reject) => {
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

    function done(sessionId?: UUID, err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else if (sessionId) resolve(sessionId);
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
          done(msg.sessionId);
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
  const sessionId = await createRemoteSession(host, port, directory, timeout);
  console.error(`Session created: ${sessionId.slice(0, 8)}`);
  console.error('Attaching...');

  return runAttachClient({ host, port, sessionId });
}
