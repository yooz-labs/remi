/**
 * Verifies the deliberate ack-ordering exception for unregister_device_token
 * (#690): the ack fires AFTER the domain event, not before like every other
 * message type. The web client awaits this exact ack (correlated by message
 * id) before re-registering with sibling connections, so the daemon must
 * only send it once the tombstone is actually committed to disk — otherwise
 * the ack would just mean "received", and the re-register race the tombstone
 * design depends on winning would be unguaranteed.
 */

import { describe, expect, test } from 'bun:test';
import {
  createRegisterDeviceToken,
  createUnregisterDeviceToken,
  deserialize,
  serialize,
} from '@remi/shared';
import type { ProtocolMessage } from '@remi/shared';
import { Connection } from '../src/server/connection.ts';

/** Mock WebSocket that captures sent messages (same pattern as connection-auth.test.ts). */
class MockWebSocket {
  readyState = WebSocket.OPEN;
  sentMessages: ProtocolMessage[] = [];

  send(data: string): void {
    const msg = deserialize(data);
    if (msg) this.sentMessages.push(msg);
  }

  close(): void {}
}

/** Patches `ws.send` to append 'ack' to `order` at the exact moment an ack is
 *  sent, so `order` reflects the real send/event interleaving regardless of
 *  which happens first. */
function recordAckOrder(ws: MockWebSocket, order: string[]): void {
  const originalSend = ws.send.bind(ws);
  ws.send = (data: string): void => {
    const before = ws.sentMessages.length;
    originalSend(data);
    if (ws.sentMessages.length > before && ws.sentMessages.at(-1)?.type === 'ack') {
      order.push('ack');
    }
  };
}

describe('Connection ack ordering for device-token messages (#690)', () => {
  test('unregister_device_token: the domain event fires BEFORE the ack', () => {
    const ws = new MockWebSocket();
    const order: string[] = [];
    recordAckOrder(ws, order);
    const conn = new Connection(
      ws as unknown as WebSocket,
      {
        onUnregisterDeviceToken: () => {
          order.push('event');
        },
      },
      {},
    );

    conn.handleMessage(serialize(createUnregisterDeviceToken('tok-x')));

    expect(order).toEqual(['event', 'ack']);
  });

  test('register_device_token: the ack fires BEFORE the domain event (unchanged pattern)', () => {
    const ws = new MockWebSocket();
    const order: string[] = [];
    recordAckOrder(ws, order);
    const conn = new Connection(
      ws as unknown as WebSocket,
      {
        onRegisterDeviceToken: () => {
          order.push('event');
        },
      },
      {},
    );

    conn.handleMessage(serialize(createRegisterDeviceToken('tok-y', 'ios')));

    expect(order).toEqual(['ack', 'event']);
  });

  test('unregister_device_token: the ack is still sent and correlates by message id', () => {
    const ws = new MockWebSocket();
    const conn = new Connection(ws as unknown as WebSocket, {}, {});

    const msg = createUnregisterDeviceToken('tok-z');
    conn.handleMessage(serialize(msg));

    const ack = ws.sentMessages.find((m) => m.type === 'ack') as
      | (ProtocolMessage & { ack: { messageId: string } })
      | undefined;
    expect(ack).toBeDefined();
    expect(ack?.ack.messageId).toBe(msg.id);
  });
});
