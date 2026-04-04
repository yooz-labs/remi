/**
 * Detach Client - Sends a detach request to a running daemon to detach
 * the active connection from a session without killing it (tmux-style).
 *
 * Connects via WebSocket, resolves the session by name or ID, and sends
 * a detach_session message.
 */

import {
  createDetachSession,
  createHello,
  createSessionListRequest,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import type { DiscoverableSession, ProtocolMessage, UUID } from '@remi/shared';
import { performAuthHandshake } from './auth-helper.ts';
import { resolveSession as sharedResolveSession } from './session-resolver.ts';

export interface DetachClientOptions {
  readonly host: string;
  readonly port: number;
  /** Session name or ID to detach */
  readonly target: string;
  readonly timeout?: number;
}

export async function runDetachClient(opts: DetachClientOptions): Promise<void> {
  const { host, port, target, timeout = 5000 } = opts;
  const url = `ws://${host}:${port}/ws`;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let authInProgress = false;
    let sessions: DiscoverableSession[] | null = null;
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
        reject(new Error(`Timed out connecting to daemon at ${host}:${port}`));
      }
    }, timeout);

    function done(err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve();
    }

    function sendHello(): void {
      const clientId = generateId();
      ws.send(serialize(createHello(clientId, '1.0.0', undefined, undefined, undefined, 'query')));
    }

    function handleMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        // Request session list first to resolve the name
        ws.send(serialize(createSessionListRequest(false)));
      } else if (msg.type === 'session_list_response') {
        sessions = msg.sessions as DiscoverableSession[];
        try {
          const resolved = sharedResolveSession([{ host, port, sessions }], target);
          if (!resolved) {
            done(
              new Error(
                `No session found matching "${target}". Run \`remi ls\` to see live sessions.`,
              ),
            );
            return;
          }
          // Send detach request
          ws.send(serialize(createDetachSession(resolved.session.sessionId as UUID)));
        } catch (err) {
          done(err instanceof Error ? err : new Error(String(err)));
        }
      } else if (msg.type === 'detach_session_ack') {
        if (msg.success) {
          const session =
            sessions?.find((s) => s.sessionId === target) ??
            sessions?.find((s) => s.name === target) ??
            sessions?.find((s) => s.name?.startsWith(target)) ??
            sessions?.find((s) => s.sessionId.startsWith(target));
          const displayName = session?.name ?? target;
          console.log(`Detached from session: ${displayName}`);
          console.log("Use 'remi attach' to reconnect.");
          done();
        } else {
          done(new Error(`Failed to detach session: ${msg.error ?? 'unknown error'}`));
        }
      } else if (msg.type === 'error') {
        if (msg.code === 'AUTH_REQUIRED' && authInProgress) return;
        done(new Error(`Daemon error: ${msg.message}`));
      }
    }

    ws.onopen = () => {
      sendHello();
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) {
        console.error('Warning: received unparsable message from daemon');
        return;
      }

      // Handle auth challenge if needed
      if (msg.type === 'auth_challenge') {
        authInProgress = true;
        performAuthHandshake(ws, msg)
          .then(() => {
            authInProgress = false;
            sendHello();
          })
          .catch((err) => {
            done(err instanceof Error ? err : new Error(String(err)));
          });
        return;
      }

      if (authInProgress) return;
      handleMessage(msg);
    };

    ws.onerror = () => {
      done(new Error(`WebSocket error connecting to daemon at ${host}:${port}`));
    };

    ws.onclose = () => {
      if (!settled) {
        done(new Error('Connection closed before detach completed'));
      }
    };
  });
}
