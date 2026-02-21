import { describe, expect, test } from 'bun:test';
import { DeviceRoom } from '../src/device-room.ts';

/**
 * DeviceRoom Durable Object tests.
 *
 * Tests message handling by calling webSocketMessage directly.
 * Uses minimal mocks for WebSocket and DurableObjectState since
 * the Cloudflare Workers runtime is not available in test.
 */

class MockWebSocket {
  sent: string[] = [];
  closed = false;
  closeCode?: number;

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, _reason?: string) {
    this.closed = true;
    this.closeCode = code;
  }

  get lastMessage(): Record<string, unknown> | null {
    if (this.sent.length === 0) return null;
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }

  get allMessages(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function createMockState() {
  const tagMap = new Map<object, string[]>();

  return {
    acceptWebSocket: (ws: object, tags?: string[]) => {
      tagMap.set(ws, tags ?? []);
    },
    getTags: (ws: object) => tagMap.get(ws) ?? [],
    getWebSockets: () => [...tagMap.keys()],
    storage: {
      setAlarm: () => {},
      deleteAlarm: () => {},
      deleteAll: async () => {},
    },
  };
}

function createRoom() {
  const state = createMockState();
  const env = { DEVICE_IDLE_TIMEOUT_MS: '3600000' };
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const room = new DeviceRoom(state as any, env as any);
  return { room, state };
}

describe('DeviceRoom message handling', () => {
  test('device_register assigns host and sends confirmation', () => {
    const { room, state } = createRoom();
    const ws = new MockWebSocket();
    state.acceptWebSocket(ws, ['127.0.0.1']);

    room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    expect(ws.lastMessage?.type).toBe('device_registered');
    expect(ws.lastMessage?.deviceId).toBe('brave-purple-fox');
  });

  test('second device_register is rejected', () => {
    const { room, state } = createRoom();

    const ws1 = new MockWebSocket();
    state.acceptWebSocket(ws1, ['127.0.0.1']);
    room.webSocketMessage(
      ws1,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    const ws2 = new MockWebSocket();
    state.acceptWebSocket(ws2, ['10.0.0.1']);
    room.webSocketMessage(
      ws2,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    expect(ws2.lastMessage?.type).toBe('error');
    expect(ws2.lastMessage?.code).toBe('ALREADY_REGISTERED');
  });

  test('connect_device notifies host and sends peer-connected', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );
    hostWs.sent = []; // clear registration message

    const clientWs = new MockWebSocket();
    state.acceptWebSocket(clientWs, ['192.168.1.1']);
    room.webSocketMessage(
      clientWs,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'test-client',
      }),
    );

    // Host should receive client_connect_request and peer-connected
    const hostMsgs = hostWs.allMessages;
    expect(
      hostMsgs.some((m) => m.type === 'client_connect_request' && m.clientId === 'test-client'),
    ).toBe(true);
    expect(hostMsgs.some((m) => m.type === 'peer-connected')).toBe(true);

    // Client should receive peer-connected
    expect(clientWs.allMessages.some((m) => m.type === 'peer-connected')).toBe(true);
  });

  test('connect_device without host sends DEVICE_OFFLINE error', () => {
    const { room, state } = createRoom();

    const clientWs = new MockWebSocket();
    state.acceptWebSocket(clientWs, ['192.168.1.1']);
    room.webSocketMessage(
      clientWs,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'test-client',
      }),
    );

    expect(clientWs.lastMessage?.type).toBe('error');
    expect(clientWs.lastMessage?.code).toBe('DEVICE_OFFLINE');
  });

  test('connect_device when room is full sends ROOM_FULL error', () => {
    const { room, state } = createRoom();

    // Host
    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    // Client 1
    const client1 = new MockWebSocket();
    state.acceptWebSocket(client1, ['192.168.1.1']);
    room.webSocketMessage(
      client1,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'client-1',
      }),
    );

    // Client 2 - should be rejected
    const client2 = new MockWebSocket();
    state.acceptWebSocket(client2, ['192.168.1.2']);
    room.webSocketMessage(
      client2,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'client-2',
      }),
    );

    expect(client2.lastMessage?.type).toBe('error');
    expect(client2.lastMessage?.code).toBe('ROOM_FULL');
  });

  test('relay from client forwards to host', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    const clientWs = new MockWebSocket();
    state.acceptWebSocket(clientWs, ['192.168.1.1']);
    room.webSocketMessage(
      clientWs,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'test-client',
      }),
    );
    hostWs.sent = [];

    // Client sends relay
    room.webSocketMessage(
      clientWs,
      JSON.stringify({
        type: 'relay',
        payload: '{"type":"auth_response","hmac":"abc123"}',
      }),
    );

    const relayMsg = hostWs.allMessages.find((m) => m.type === 'relay');
    expect(relayMsg).toBeTruthy();
    expect(relayMsg?.payload).toBe('{"type":"auth_response","hmac":"abc123"}');
  });

  test('relay from host forwards to client', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    const clientWs = new MockWebSocket();
    state.acceptWebSocket(clientWs, ['192.168.1.1']);
    room.webSocketMessage(
      clientWs,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'test-client',
      }),
    );
    clientWs.sent = [];

    // Host sends relay
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'relay',
        payload: '{"type":"auth_challenge","nonce":"xyz"}',
      }),
    );

    const relayMsg = clientWs.allMessages.find((m) => m.type === 'relay');
    expect(relayMsg).toBeTruthy();
    expect(relayMsg?.payload).toBe('{"type":"auth_challenge","nonce":"xyz"}');
  });

  test('relay without peer sends NO_PEER error', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );
    hostWs.sent = [];

    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'relay',
        payload: '{"data":"hello"}',
      }),
    );

    expect(hostWs.lastMessage?.type).toBe('error');
    expect(hostWs.lastMessage?.code).toBe('NO_PEER');
  });

  test('invalid JSON sends INVALID_MESSAGE error', () => {
    const { room, state } = createRoom();

    const ws = new MockWebSocket();
    state.acceptWebSocket(ws, ['127.0.0.1']);
    room.webSocketMessage(ws, 'not json');

    expect(ws.lastMessage?.type).toBe('error');
    expect(ws.lastMessage?.code).toBe('INVALID_MESSAGE');
  });

  test('unknown message type sends error', () => {
    const { room, state } = createRoom();

    const ws = new MockWebSocket();
    state.acceptWebSocket(ws, ['127.0.0.1']);
    room.webSocketMessage(ws, JSON.stringify({ type: 'bogus_type' }));

    expect(ws.lastMessage?.type).toBe('error');
  });
});

describe('DeviceRoom rate limiting', () => {
  test('allows connections under the limit', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    // 10 connections from same IP (at the limit)
    for (let i = 0; i < 10; i++) {
      const ws = new MockWebSocket();
      state.acceptWebSocket(ws, ['10.0.0.1']);
      room.webSocketMessage(
        ws,
        JSON.stringify({
          type: 'connect_device',
          deviceId: 'brave-purple-fox',
          clientId: `client-${i}`,
        }),
      );

      // First one connects, rest get ROOM_FULL (not rate limited)
      if (i === 0) {
        expect(ws.allMessages.some((m) => m.type === 'peer-connected')).toBe(true);
        expect(ws.closed).toBe(false);
      } else {
        // After first client, room is full, but not rate limited
        const hasRateLimit = ws.allMessages.some(
          (m) => (m as Record<string, unknown>).code === 'RATE_LIMITED',
        );
        expect(hasRateLimit).toBe(false);
      }
    }
  });

  test('blocks the 11th connection attempt from same IP', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    // 11 attempts
    for (let i = 0; i < 11; i++) {
      const ws = new MockWebSocket();
      state.acceptWebSocket(ws, ['10.0.0.1']);
      room.webSocketMessage(
        ws,
        JSON.stringify({
          type: 'connect_device',
          deviceId: 'brave-purple-fox',
          clientId: `client-${i}`,
        }),
      );

      if (i === 10) {
        const hasRateLimit = ws.allMessages.some(
          (m) => (m as Record<string, unknown>).code === 'RATE_LIMITED',
        );
        expect(hasRateLimit).toBe(true);
        expect(ws.closed).toBe(true);
      }
    }
  });

  test('different IPs have independent rate limits', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    // 5 from IP A
    for (let i = 0; i < 5; i++) {
      const ws = new MockWebSocket();
      state.acceptWebSocket(ws, ['10.0.0.1']);
      room.webSocketMessage(
        ws,
        JSON.stringify({
          type: 'connect_device',
          deviceId: 'brave-purple-fox',
          clientId: `a-${i}`,
        }),
      );
      const hasRateLimit = ws.allMessages.some(
        (m) => (m as Record<string, unknown>).code === 'RATE_LIMITED',
      );
      expect(hasRateLimit).toBe(false);
    }

    // 5 from IP B - should also pass
    for (let i = 0; i < 5; i++) {
      const ws = new MockWebSocket();
      state.acceptWebSocket(ws, ['10.0.0.2']);
      room.webSocketMessage(
        ws,
        JSON.stringify({
          type: 'connect_device',
          deviceId: 'brave-purple-fox',
          clientId: `b-${i}`,
        }),
      );
      const hasRateLimit = ws.allMessages.some(
        (m) => (m as Record<string, unknown>).code === 'RATE_LIMITED',
      );
      expect(hasRateLimit).toBe(false);
    }
  });
});

describe('DeviceRoom disconnect handling', () => {
  test('notifies client when host disconnects', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    const clientWs = new MockWebSocket();
    state.acceptWebSocket(clientWs, ['192.168.1.1']);
    room.webSocketMessage(
      clientWs,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'test-client',
      }),
    );
    clientWs.sent = [];

    room.webSocketClose(hostWs);

    expect(clientWs.lastMessage?.type).toBe('peer-disconnected');
  });

  test('notifies host when client disconnects', () => {
    const { room, state } = createRoom();

    const hostWs = new MockWebSocket();
    state.acceptWebSocket(hostWs, ['127.0.0.1']);
    room.webSocketMessage(
      hostWs,
      JSON.stringify({
        type: 'device_register',
        deviceId: 'brave-purple-fox',
      }),
    );

    const clientWs = new MockWebSocket();
    state.acceptWebSocket(clientWs, ['192.168.1.1']);
    room.webSocketMessage(
      clientWs,
      JSON.stringify({
        type: 'connect_device',
        deviceId: 'brave-purple-fox',
        clientId: 'test-client',
      }),
    );
    hostWs.sent = [];

    room.webSocketClose(clientWs);

    expect(hostWs.lastMessage?.type).toBe('peer-disconnected');
  });
});
