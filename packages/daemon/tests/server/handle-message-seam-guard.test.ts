/**
 * #916: `Connection.handleMessage` had NO enclosing try/catch anywhere on the
 * path from the WebSocket server's bare `message(ws, data)` callback down to
 * an individual handler (verified: `websocket-server.ts:614-620` calls
 * `connection.handleMessage(data)` unguarded; `handleMessage` itself had no
 * try/catch around `routeClientMessage`). Since `isValidMessage` only checks
 * the envelope (type/id/timestamp), not payload shape, a handler that forgets
 * to guard a synchronous throw would escape all the way to Bun's
 * `uncaughtException`, whose policy (`process-guards.ts`) is a fatal
 * `exit(1)` -- correct for real state corruption, wrong for one client's
 * malformed payload on a hub that serves every session on the machine.
 *
 * This constructs the REAL `Connection` (ADR 0014 -- no synthetic stand-in
 * for the class under test) with a real `MockWebSocket` transport, injects a
 * throwing event callback through the class's actual `ConnectionEvents`
 * extension seam (the same seam production wires to `sharedEvents` in
 * cli.ts), and proves the seam contains the throw, replies to the sender,
 * and leaves the connection able to keep routing.
 *
 * Two review-found gaps in the first version of this guard, both covered
 * below:
 *
 * 1. The `state === 'authenticating'` branch (`handlePing` /
 *    `routeAuthResponse` / `sendError('AUTH_REQUIRED', ...)`) ran BEFORE the
 *    try/catch, which only wrapped the connected-state routing call -- so
 *    the pre-handshake window was exactly as unguarded as before this PR.
 *    Fixed by hoisting one try/catch around the whole dispatch region
 *    (authenticating branch + routing) instead of adding a second targeted
 *    one, matching the shape `relay-adapter.ts`'s `handleRelayMessage`
 *    already uses (its single outer try covers its whole body, so new
 *    branches are covered automatically).
 * 2. The catch block's own reporting (`events.onError?.(error)` and
 *    `sendError(...)`) was itself unguarded. `events.onError` is a
 *    caller-supplied callback and `ws.send` can race a closing socket, so in
 *    principle either could throw and escape as the very
 *    `uncaughtException` this guard exists to prevent. NOT currently
 *    reachable in production (`trivial-events.ts`'s wired `onError` only
 *    logs; `send()` guards on `readyState`) -- this is insurance consistent
 *    with the guard's own thesis, not a fix for a live bug.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPing, createTerminalResize, deserialize, serialize } from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { Connection } from '../../src/server/connection.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-handle-message-seam-guard-'));
}

/** Same pattern as connection-unregister-ack-order.test.ts and
 *  connection-auth.test.ts: a real WebSocket-shaped object, not a mock of
 *  Connection itself. */
class MockWebSocket {
  readyState = WebSocket.OPEN;
  sentMessages: ProtocolMessage[] = [];

  send(data: string): void {
    const msg = deserialize(data);
    if (msg) this.sentMessages.push(msg);
  }

  close(): void {}
}

/** Same as MockWebSocket, but its FIRST send of a given message type throws
 *  -- simulating a socket that faults on one particular write (e.g. closing
 *  mid-send) without breaking the constructor's own `send` calls (the
 *  auth_challenge, in the authenticating-state test below) or the seam's own
 *  error-reply send. */
class OnceThrowingWebSocket {
  readyState = WebSocket.OPEN;
  sentMessages: ProtocolMessage[] = [];
  private readonly throwOnceForTypes: Set<string>;

  constructor(throwOnceForTypes: readonly string[]) {
    this.throwOnceForTypes = new Set(throwOnceForTypes);
  }

  send(data: string): void {
    const msg = deserialize(data);
    if (msg && this.throwOnceForTypes.has(msg.type)) {
      this.throwOnceForTypes.delete(msg.type);
      throw new Error(`boom: send() faulted for '${msg.type}'`);
    }
    if (msg) this.sentMessages.push(msg);
  }

  close(): void {}
}

describe('Connection.handleMessage seam guard (#916)', () => {
  test('a handler that throws synchronously is contained, replied to, and does not wedge the connection', () => {
    const ws = new MockWebSocket();
    const onErrorCalls: Error[] = [];

    // terminal_resize's private wrapper has no state gate, so it reaches
    // `onTerminalResize` immediately without a hello handshake -- the
    // simplest real path to a SYNCHRONOUS call into an injected event.
    const conn = new Connection(
      ws as unknown as WebSocket,
      {
        onTerminalResize: () => {
          throw new Error('boom: handler forgot to guard itself');
        },
        onError: (err) => {
          onErrorCalls.push(err);
        },
      },
      {},
    );

    // (1) the throw must not escape handleMessage.
    expect(() => {
      conn.handleMessage(serialize(createTerminalResize(80, 24)));
    }).not.toThrow();

    // Logged via the same onError path the pre-existing auth-response catch
    // uses (connection.ts's routeAuthResponse), not swallowed.
    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]?.message).toContain('boom');

    // (2) the sender receives an error reply naming the failing type.
    const error = ws.sentMessages.find((m) => m.type === 'error') as
      | (ProtocolMessage & { code: string; message: string })
      | undefined;
    expect(error).toBeDefined();
    expect(error?.code).toBe('INTERNAL_ERROR');
    expect(error?.message).toContain('terminal_resize');

    // (3) the connection is not wedged: a later, unrelated message still
    // routes normally on the SAME connection instance.
    ws.sentMessages.length = 0;
    const pingMsg = createPing();
    conn.handleMessage(serialize(pingMsg));
    const pong = ws.sentMessages.find((m) => m.type === 'pong');
    expect(pong).toBeDefined();
  });

  test('a throwing onError callback does not escape handleMessage, and the error reply still lands (gap 2)', () => {
    const ws = new MockWebSocket();

    const conn = new Connection(
      ws as unknown as WebSocket,
      {
        onTerminalResize: () => {
          throw new Error('boom: handler forgot to guard itself');
        },
        onError: () => {
          // The reporting path itself must not be trusted not to throw --
          // it is a caller-supplied callback.
          throw new Error('boom: onError callback also throws');
        },
      },
      {},
    );

    expect(() => {
      conn.handleMessage(serialize(createTerminalResize(80, 24)));
    }).not.toThrow();

    // The reply half of the reporting path is independent of onError's own
    // fault: the sender still gets the INTERNAL_ERROR frame.
    const error = ws.sentMessages.find((m) => m.type === 'error') as
      | (ProtocolMessage & { code: string })
      | undefined;
    expect(error).toBeDefined();
    expect(error?.code).toBe('INTERNAL_ERROR');

    // Not wedged.
    ws.sentMessages.length = 0;
    conn.handleMessage(serialize(createPing()));
    expect(ws.sentMessages.find((m) => m.type === 'pong')).toBeDefined();
  });
});

describe('Connection.handleMessage seam guard: authenticating-state branch (#916 gap 1)', () => {
  let tmpDir: string;
  let authenticator: Authenticator;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    const store = new IdentityStore(tmpDir);
    await store.generate();
    const serverIdentity = await store.unlock();
    authenticator = new Authenticator({ identity: serverIdentity, identityStore: store });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  test('a throw reached via the pre-handshake ping path is contained and the connection survives', () => {
    // Before this fix, the try/catch wrapped only the connected-state
    // routing call; the `state === 'authenticating'` branch -- reachable
    // BEFORE any hello/handshake -- ran outside it entirely. `handlePing`'s
    // `this.send(createPong(...))` is the synchronous throw site here: the
    // FIRST 'pong' send faults (simulating a socket that closes mid-send),
    // while the constructor's own 'auth_challenge' send and this seam's
    // 'error' reply are unaffected.
    const ws = new OnceThrowingWebSocket(['pong']);
    const onErrorCalls: Error[] = [];
    const conn = new Connection(
      ws as unknown as WebSocket,
      { onError: (err) => onErrorCalls.push(err) },
      { authenticator },
    );

    expect(conn.connectionState).toBe('authenticating');

    expect(() => {
      conn.handleMessage(serialize(createPing()));
    }).not.toThrow();

    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]?.message).toContain('boom');

    const error = ws.sentMessages.find((m) => m.type === 'error') as
      | (ProtocolMessage & { code: string })
      | undefined;
    expect(error).toBeDefined();
    expect(error?.code).toBe('INTERNAL_ERROR');

    // The fault did not corrupt the state machine.
    expect(conn.connectionState).toBe('authenticating');

    // Not wedged: the throw-once socket no longer faults 'pong', so a
    // second ping on the SAME connection gets a normal pong back.
    ws.sentMessages.length = 0;
    conn.handleMessage(serialize(createPing()));
    expect(ws.sentMessages.find((m) => m.type === 'pong')).toBeDefined();
  });
});
