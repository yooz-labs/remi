/**
 * Kill Client - Sends a kill request to a running daemon to terminate a session.
 *
 * Connects via WebSocket, resolves the session by name or ID, and sends
 * a kill_session_request message.
 */

import {
  createHello,
  createKillSessionRequest,
  createSessionListRequest,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import type { DiscoverableSession, ProtocolMessage, UUID } from '@remi/shared';
import { performAuthHandshake } from './auth-helper.ts';

export interface KillClientOptions {
  readonly host: string;
  readonly port: number;
  /** Session name or ID to kill */
  readonly target: string;
  readonly timeout?: number;
}

export async function runKillClient(opts: KillClientOptions): Promise<void> {
  const { host, port, target, timeout = 5000 } = opts;
  const url = `ws://${host}:${port}/ws`;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let authInProgress = false;
    let sessions: DiscoverableSession[] | null = null;
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
      ws.send(serialize(createHello(clientId, '1.0.0')));
    }

    function resolveSession(
      sessionList: DiscoverableSession[],
      nameOrId: string,
    ): DiscoverableSession | null {
      // Exact name match
      const byName = sessionList.filter((s) => s.name === nameOrId);
      if (byName.length === 1) return byName[0] ?? null;

      // Prefix name match
      const byPrefix = sessionList.filter((s) => s.name?.startsWith(nameOrId));
      if (byPrefix.length === 1) return byPrefix[0] ?? null;
      if (byPrefix.length > 1) {
        const names = byPrefix.map((s) => `  ${s.name ?? s.sessionId.slice(0, 8)}`).join('\n');
        throw new Error(
          `Ambiguous session name "${nameOrId}" matches ${byPrefix.length} sessions:\n${names}\nProvide a longer name to disambiguate.`,
        );
      }

      // Exact ID match
      const byId = sessionList.filter((s) => s.sessionId === nameOrId);
      if (byId.length === 1) return byId[0] ?? null;

      // Prefix ID match
      const byIdPrefix = sessionList.filter((s) => s.sessionId.startsWith(nameOrId));
      if (byIdPrefix.length === 1) return byIdPrefix[0] ?? null;
      if (byIdPrefix.length > 1) {
        const ids = byIdPrefix.map((s) => `  ${s.sessionId.slice(0, 8)}`).join('\n');
        throw new Error(
          `Ambiguous session ID "${nameOrId}" matches ${byIdPrefix.length} sessions:\n${ids}\nProvide a longer prefix to disambiguate.`,
        );
      }

      return null;
    }

    function handleMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        // Request session list first to resolve the name
        ws.send(serialize(createSessionListRequest(false)));
      } else if (msg.type === 'session_list_response') {
        sessions = msg.sessions as DiscoverableSession[];
        try {
          const session = resolveSession(sessions, target);
          if (!session) {
            done(
              new Error(
                `No session found matching "${target}". Run \`remi ls\` to see live sessions.`,
              ),
            );
            return;
          }
          // Send kill request
          ws.send(serialize(createKillSessionRequest(session.sessionId as UUID)));
        } catch (err) {
          done(err instanceof Error ? err : new Error(String(err)));
        }
      } else if (msg.type === 'kill_session_response') {
        if (msg.success) {
          // Find the session name for a nice message
          const session =
            sessions?.find((s) => s.sessionId === target) ??
            sessions?.find((s) => s.name === target) ??
            sessions?.find((s) => s.name?.startsWith(target)) ??
            sessions?.find((s) => s.sessionId.startsWith(target));
          const displayName = session?.name ?? target;
          console.log(`Killed session: ${displayName}`);
          done();
        } else {
          done(new Error(`Failed to kill session: ${msg.error ?? 'unknown error'}`));
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
        console.error('Warning: received unparseable message from daemon');
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

      handleMessage(msg);
    };

    ws.onerror = () => {
      done(new Error(`WebSocket error connecting to daemon at ${host}:${port}`));
    };

    ws.onclose = () => {
      if (!settled) {
        done(new Error('Connection closed before kill completed'));
      }
    };
  });
}
