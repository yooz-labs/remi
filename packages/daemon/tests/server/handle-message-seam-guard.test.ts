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
 */

import { describe, expect, test } from 'bun:test';
import { createPing, createTerminalResize, deserialize, serialize } from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared';
import { Connection } from '../../src/server/connection.ts';

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
});
