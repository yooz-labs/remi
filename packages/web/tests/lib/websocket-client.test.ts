/**
 * Tests for WebSocketClient reconnect behavior (#435 Phase 1 / P3).
 *
 * Real WebSocket connections against real Bun servers (and real refused
 * ports); no mocks. Exercises the finite reconnect ceiling, the
 * onReconnectExhausted escalation hook, and reconnectWithUrl recovery.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_RECONNECT_ATTEMPTS, WebSocketClient } from '../../src/lib/websocket-client';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real WebSocket server that accepts upgrades. */
function liveWsServer() {
  return Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response('no upgrade', { status: 400 });
    },
    websocket: {
      open() {},
      message() {},
      close() {},
    },
  });
}

/**
 * A real WebSocket server that accepts the upgrade (the transport opens, so the
 * client reaches 'authenticating') but closes the socket shortly after without
 * ever letting it reach 'connected'. Models an auth fail / post-open drop, the
 * #586 reconnect-storm trigger.
 */
function openThenCloseServer() {
  return Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response('no upgrade', { status: 400 });
    },
    websocket: {
      open(ws) {
        // Close right after open: the transport opened but auth never completes,
        // so the client never reaches 'connected'.
        ws.close();
      },
      message() {},
      close() {},
    },
  });
}

/** A loopback port with nothing listening (connections are refused). */
const DEAD_URL_A = 'ws://127.0.0.1:49250/ws';
const DEAD_URL_B = 'ws://127.0.0.1:49251/ws';

const clients: WebSocketClient[] = [];
function track(c: WebSocketClient): WebSocketClient {
  clients.push(c);
  return c;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

describe('WebSocketClient reconnect ceiling', () => {
  test('default max reconnect attempts is finite (not Infinity)', () => {
    expect(Number.isFinite(DEFAULT_MAX_RECONNECT_ATTEMPTS)).toBe(true);
    expect(DEFAULT_MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0);
  });

  test('fires onReconnectExhausted after the ceiling on a dead port', async () => {
    let exhausted = false;
    const client = track(
      new WebSocketClient(
        {
          url: DEAD_URL_A,
          autoReconnect: true,
          maxReconnectAttempts: 2,
          reconnectDelay: 10,
          connectionTimeout: 200,
          heartbeatInterval: 0,
        },
        {
          onReconnectExhausted: () => {
            exhausted = true;
          },
        },
      ),
    );

    client.connect();
    const start = Date.now();
    while (!exhausted && Date.now() - start < 5000) await wait(25);
    expect(exhausted).toBe(true);
  });

  test('does NOT fire onReconnectExhausted after an intentional disconnect', async () => {
    let exhausted = false;
    const client = track(
      new WebSocketClient(
        {
          url: DEAD_URL_A,
          autoReconnect: true,
          maxReconnectAttempts: 2,
          reconnectDelay: 10,
          connectionTimeout: 200,
          heartbeatInterval: 0,
        },
        {
          onReconnectExhausted: () => {
            exhausted = true;
          },
        },
      ),
    );
    client.connect();
    client.disconnect();
    await wait(300);
    expect(exhausted).toBe(false);
  });
});

describe('WebSocketClient open-but-not-connected (#586 reconnect storm)', () => {
  test('reconnect counter grows across opens and exhaustion fires (not pinned)', async () => {
    const server = openThenCloseServer();
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const MAX = 3;
    let authenticatingCount = 0;
    let exhausted = false;

    const client = track(
      new WebSocketClient(
        {
          url,
          autoReconnect: true,
          maxReconnectAttempts: MAX,
          reconnectDelay: 10,
          connectionTimeout: 500,
          heartbeatInterval: 0,
        },
        {
          onStatusChange: (s) => {
            // Each successful transport open lands here. The owner never calls
            // setConnected(), so the connection never reaches 'connected'.
            if (s === 'authenticating') authenticatingCount++;
          },
          onReconnectExhausted: () => {
            exhausted = true;
          },
        },
      ),
    );

    try {
      client.connect();
      const start = Date.now();
      while (!exhausted && Date.now() - start < 6000) await wait(25);

      // Exhaustion proves the loop is bounded: the counter survived each open
      // and climbed to the ceiling. Before the fix, handleOpen reset it to 0 on
      // every open, so the ceiling was never reached and this never fired.
      expect(exhausted).toBe(true);
      // The client opened (reached 'authenticating') more than once: it is not
      // pinned at a single attempt, and it stopped at the ceiling rather than
      // looping forever (initial connect + MAX reconnects = MAX + 1 opens).
      expect(authenticatingCount).toBeGreaterThan(1);
      expect(authenticatingCount).toBe(MAX + 1);
    } finally {
      server.stop();
    }
  });

  test('reaching connected resets the reconnect counter', async () => {
    const server = openThenCloseServer();
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const MAX = 3;
    let authenticatingCount = 0;
    let exhausted = false;

    const client = track(
      new WebSocketClient(
        {
          url,
          autoReconnect: true,
          maxReconnectAttempts: MAX,
          reconnectDelay: 10,
          connectionTimeout: 500,
          heartbeatInterval: 0,
        },
        {
          onStatusChange: (s) => {
            if (s === 'authenticating') {
              authenticatingCount++;
              // Simulate the owner completing auth on every open: each open
              // becomes a fully-established connection, so the counter resets.
              client.setConnected();
            }
          },
          onReconnectExhausted: () => {
            exhausted = true;
          },
        },
      ),
    );

    try {
      client.connect();
      // Let it churn well past MAX opens. Because every open reaches 'connected'
      // and resets the counter, the ceiling is never hit.
      const start = Date.now();
      while (authenticatingCount <= MAX + 2 && Date.now() - start < 6000) await wait(25);

      expect(authenticatingCount).toBeGreaterThan(MAX + 1);
      expect(exhausted).toBe(false);
    } finally {
      server.stop();
    }
  });
});

describe('WebSocketClient reconnectWithUrl', () => {
  test('recovers onto a live server after exhaustion (rediscover path)', async () => {
    const server = liveWsServer();
    const liveUrl = `ws://127.0.0.1:${server.port}/ws`;
    let recovered = false;
    const client = track(
      new WebSocketClient(
        {
          url: DEAD_URL_B,
          autoReconnect: true,
          maxReconnectAttempts: 2,
          reconnectDelay: 10,
          connectionTimeout: 200,
          heartbeatInterval: 0,
        },
        {
          onStatusChange: (s) => {
            if (s === 'authenticating' || s === 'connected') recovered = true;
          },
          onReconnectExhausted: () => {
            // Simulates the manager's escalation: a moved daemon was rediscovered.
            client.reconnectWithUrl(liveUrl);
          },
        },
      ),
    );

    try {
      client.connect();
      const start = Date.now();
      while (!recovered && Date.now() - start < 6000) await wait(25);
      expect(recovered).toBe(true);
      expect(client.url).toBe(liveUrl);
    } finally {
      server.stop();
    }
  });
});
