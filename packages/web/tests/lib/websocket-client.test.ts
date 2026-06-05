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
