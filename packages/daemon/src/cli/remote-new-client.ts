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
import { errorToString, escapeUnsafeText } from '@remi/shared';
import type { HarnessId, ProtocolMessage, UUID } from '@remi/shared';
import { runAttachClient } from './attach-client.ts';
import { performAuthHandshake } from './auth-helper.ts';
import { capabilityWsOptions } from './capability-client.ts';

export interface RemoteNewOptions {
  readonly host: string;
  readonly port: number;
  readonly directory?: string | undefined;
  readonly timeout?: number;
  /**
   * The harness to start there (#1179). Absent sends the plain request an older daemon
   * understands. A named one is only sent to a daemon whose hello_ack lists it in `harnesses`:
   * an older daemon ignores the field and would start Claude.
   */
  readonly harness?: HarnessId | undefined;
  /** The harness's arguments (what follows `--`); the remote daemon checks them against its own allowlist. */
  readonly args?: readonly string[] | undefined;
}

interface RemoteSessionResult {
  readonly sessionId: UUID;
  readonly port: number;
  /**
   * What the daemon says its success does not (#1179): shown to the person, never acted on. It is
   * text a daemon chose and that this client trusts only on first use, so it arrives escaped
   * (`escapeUnsafeText`): a terminal sequence or a bidi override in it cannot act on the screen.
   */
  readonly notice?: string;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a success the daemon sent can be used: a session id that is a UUID and a port that is an
 * integer from 1 to 65535 (or none). Both are printed and the port is attached to, and the wire
 * carries whatever JSON a daemon chose, so a value of another shape (a terminal sequence in the
 * first eight characters of the id, a string for the port) is refused, not shown (#1179 review, G10).
 */
function isUsableAnswer(sessionId: unknown, port: unknown): boolean {
  if (typeof sessionId !== 'string' || !UUID_SHAPE.test(sessionId)) return false;
  return (
    port === undefined ||
    (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535)
  );
}

export async function createRemoteSession(
  host: string,
  port: number,
  directory?: string,
  timeout = 30000,
  harness?: HarnessId,
  args: readonly string[] = [],
): Promise<RemoteSessionResult> {
  const url = `ws://${host}:${port}/ws`;

  return new Promise<RemoteSessionResult>((resolve, reject) => {
    let settled = false;
    let authInProgress = false;
    let ws: WebSocket;

    try {
      ws = new WebSocket(url, capabilityWsOptions() as never);
    } catch (err) {
      const detail = errorToString(err);
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
        // Arguments without a harness are Claude's. Either one asks for something an older daemon
        // would silently drop, starting a plain Claude session, so it is sent only to a daemon
        // that says it offers the harness.
        const wanted = harness ?? (args.length > 0 ? 'claude' : undefined);
        if (wanted !== undefined && msg.harnesses?.includes(wanted) !== true) {
          done(
            undefined,
            new Error(
              `The daemon at ${host}:${port} does not offer ${wanted} (it is an older remi, or has no ${wanted} installed); nothing was started.`,
            ),
          );
          return;
        }
        ws.send(
          serialize(
            createCreateSessionRequest(directory, {
              harness,
              args: args.length > 0 ? args : undefined,
            }),
          ),
        );
      } else if (msg.type === 'create_session_response') {
        if (msg.success && msg.sessionId) {
          if (!isUsableAnswer(msg.sessionId, msg.port)) {
            done(
              undefined,
              new Error(
                'Failed to create session: the daemon sent an answer this client cannot read',
              ),
            );
            return;
          }
          // The daemon spawned a new daemon; use the returned port (or original if not present)
          done({
            sessionId: msg.sessionId,
            port: msg.port ?? port,
            ...(msg.notice !== undefined && { notice: escapeUnsafeText(msg.notice) }),
          });
        } else {
          done(
            undefined,
            new Error(
              `Failed to create session: ${escapeUnsafeText(msg.error ?? 'unknown error')}`,
            ),
          );
        }
      } else if (msg.type === 'error') {
        if (msg.code === 'AUTH_REQUIRED') return;
        done(undefined, new Error(`Daemon error: ${escapeUnsafeText(msg.message)}`));
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

/** What `runRemoteNew` does outside the create itself; a test replaces both. */
export interface RemoteNewDeps {
  readonly attach?: typeof runAttachClient;
  /** Where the progress lines go: stderr. */
  readonly err?: (line: string) => void;
}

export async function runRemoteNew(
  opts: RemoteNewOptions,
  deps: RemoteNewDeps = {},
): Promise<{ exitCode: number }> {
  const { host, port, directory, timeout, harness, args } = opts;
  const attach = deps.attach ?? runAttachClient;
  const err = deps.err ?? ((line: string) => console.error(line));

  err(`Creating session on ${host}:${port}...`);
  const result = await createRemoteSession(host, port, directory, timeout, harness, args);

  if (result.port !== port) {
    err(`New daemon spawned on port ${result.port}`);
  }
  err(`Session created: ${result.sessionId.slice(0, 8)}`);
  // The notice's first line is the condition, the rest what to do about it, which for a person
  // here is `remi attach`: this command attaches next, so it prints the condition only.
  if (result.notice !== undefined) err(result.notice.split('\n', 1)[0] as string);
  err('Attaching...');

  return attach({ host, port: result.port, sessionId: result.sessionId });
}
