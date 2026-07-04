/**
 * Integration test for the #690 ack-gate: proves, against REAL WebSocket
 * connections to two REAL daemon-like Bun servers (no mocks, same pattern as
 * websocket-client.test.ts), that the sequence App.tsx's handleDisconnect
 * uses -- send unregister_device_token, await its ack (ack-waiter.ts), THEN
 * send register_device_token to a sibling connection -- actually delays the
 * sibling send until the ack arrives, and still fires on a bounded timeout
 * when no ack ever comes. This is the exact race the reviewer's
 * counter-example was about: two independent ws.send()s on two separate
 * connections/processes have no happens-before on their own.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  createRegisterDeviceToken,
  createUnregisterDeviceToken,
  deserialize,
  serialize,
} from '@remi/shared/protocol.ts';
import type { AckMessage, ProtocolMessage } from '@remi/shared/protocol.ts';
import { type AckWaiters, awaitAck, resolveAckWaiter } from '../../src/lib/ack-waiter';
import { WebSocketClient } from '../../src/lib/websocket-client';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clients: WebSocketClient[] = [];
function track(c: WebSocketClient): WebSocketClient {
  clients.push(c);
  return c;
}
const servers: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
  for (const s of servers.splice(0)) s.stop();
});

/**
 * A real daemon-like server. `ackDelayMs` controls when (or never, if null)
 * it acks an inbound unregister_device_token -- simulating the slow/idle
 * removed daemon the reviewer's race is about. Every inbound message is
 * recorded with the wall-clock time it arrived, so tests can assert on
 * ordering without any mocking.
 */
function daemonServer(ackDelayMs: number | null) {
  const received: Array<{ message: ProtocolMessage; at: number }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response('no upgrade', { status: 400 });
    },
    websocket: {
      open() {},
      message(ws, data) {
        const raw = typeof data === 'string' ? data : data.toString();
        const msg = deserialize(raw);
        if (!msg) return;
        received.push({ message: msg, at: Date.now() });
        if (msg.type === 'unregister_device_token' && ackDelayMs !== null) {
          const ack: AckMessage = {
            type: 'ack',
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            ack: { messageId: msg.id, state: 'delivered', timestamp: new Date().toISOString() },
          };
          setTimeout(() => ws.send(serialize(ack)), ackDelayMs);
        }
      },
      close() {},
    },
  });
  servers.push(server);
  return { server, received };
}

// The test servers below don't speak the hello/hello_ack handshake, so the
// client never reaches 'connected' on its own (that transition is driven by
// the OWNER calling setConnected() upon a real hello_ack, see
// useConnectionManager). send() only requires the transport to be open
// ('authenticating' or 'connected'), which is all this test needs.
async function waitTransportOpen(client: WebSocketClient): Promise<void> {
  const start = Date.now();
  while (client.connectionStatus === 'connecting' && Date.now() - start < 3000) await wait(10);
  expect(client.connectionStatus).not.toBe('connecting');
}

describe('ack-gated re-register on disconnect (#690)', () => {
  test('the sibling re-register is NOT sent until the unregister ack arrives', async () => {
    const ACK_DELAY_MS = 150;
    const { server: serverA, received: receivedA } = daemonServer(ACK_DELAY_MS);
    const { server: serverB, received: receivedB } = daemonServer(null);

    const waiters: AckWaiters = new Map();
    const clientA = track(
      new WebSocketClient(
        { url: `ws://127.0.0.1:${serverA.port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 },
        {
          onMessage: (m) => {
            if (m.type === 'ack') resolveAckWaiter(waiters, m.ack.messageId);
          },
        },
      ),
    );
    const clientB = track(
      new WebSocketClient({ url: `ws://127.0.0.1:${serverB.port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 }),
    );
    clientA.connect();
    clientB.connect();
    await waitTransportOpen(clientA);
    await waitTransportOpen(clientB);

    const unregisterMsg = createUnregisterDeviceToken('tok-x');
    const sentAt = Date.now();
    clientA.send(unregisterMsg);

    // Mirrors handleDisconnect exactly: await the ack, THEN send the re-register.
    const acked = await awaitAck(waiters, unregisterMsg.id, 2000);
    expect(acked).toBe(true);
    const registerSentAt = Date.now();
    clientB.send(createRegisterDeviceToken('tok-x', 'ios'));

    const deadline = Date.now() + 3000;
    while (receivedB.length === 0 && Date.now() < deadline) await wait(10);

    expect(receivedA.some((r) => r.message.type === 'unregister_device_token')).toBe(true);
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]?.message.type).toBe('register_device_token');
    // The re-register could not have been SENT before the ack delay elapsed,
    // since awaitAck only resolves once serverA's delayed ack arrives.
    expect(registerSentAt).toBeGreaterThanOrEqual(sentAt + ACK_DELAY_MS);
  });

  test('the sibling re-register still fires on timeout when no ack ever arrives', async () => {
    const TIMEOUT_MS = 60;
    const { server: serverA } = daemonServer(null); // never acks
    const { server: serverB, received: receivedB } = daemonServer(null);

    const waiters: AckWaiters = new Map();
    const clientA = track(
      new WebSocketClient({ url: `ws://127.0.0.1:${serverA.port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 }),
    );
    const clientB = track(
      new WebSocketClient({ url: `ws://127.0.0.1:${serverB.port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 }),
    );
    clientA.connect();
    clientB.connect();
    await waitTransportOpen(clientA);
    await waitTransportOpen(clientB);

    const unregisterMsg = createUnregisterDeviceToken('tok-y');
    clientA.send(unregisterMsg);

    const acked = await awaitAck(waiters, unregisterMsg.id, TIMEOUT_MS);
    expect(acked).toBe(false); // no ack ever came -- this is the bounded fallback path
    clientB.send(createRegisterDeviceToken('tok-y', 'ios'));

    const deadline = Date.now() + 3000;
    while (receivedB.length === 0 && Date.now() < deadline) await wait(10);

    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]?.message.type).toBe('register_device_token');
  });
});
