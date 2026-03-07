import { afterEach, describe, expect, test } from 'bun:test';
import {
  type DiscoverableSession,
  createHelloAck,
  createSessionListResponse,
  deserialize,
  generateId,
  now,
  serialize,
} from '@remi/shared';
import { fetchSessions, runLsClient } from '../../src/cli/ls-client.ts';

const TEST_PORT = 9871;

function makeSession(overrides: Partial<DiscoverableSession> = {}): DiscoverableSession {
  return {
    sessionId: generateId(),
    projectPath: '/tmp/test-project',
    status: 'active',
    lastActivity: now(),
    messageCount: 10,
    source: 'daemon',
    canAttach: false,
    ...overrides,
  };
}

describe('runLsClient', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
  });

  test('connects, sends hello, receives session list', async () => {
    const receivedMessages: string[] = [];
    const sessions = [
      makeSession({ status: 'active', canAttach: false }),
      makeSession({ status: 'idle', canAttach: true }),
    ];

    server = Bun.serve({
      port: TEST_PORT,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          receivedMessages.push(text);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            const sessionId = generateId();
            ws.send(serialize(createHelloAck('1.0.0', sessionId)));
          } else if (msg.type === 'session_list_request') {
            ws.send(serialize(createSessionListResponse(sessions, msg.id)));
          }
        },
        close() {},
      },
    });

    await runLsClient({ host: 'localhost', port: TEST_PORT, timeout: 3000 });

    // Verify it sent a hello and a session_list_request
    expect(receivedMessages.length).toBe(2);
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const hello = deserialize(receivedMessages[0]!);
    expect(hello?.type).toBe('hello');
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const listReq = deserialize(receivedMessages[1]!);
    expect(listReq?.type).toBe('session_list_request');
  });

  test('rejects when no server is running', async () => {
    const unusedPort = 9872;
    await expect(
      runLsClient({ host: 'localhost', port: unusedPort, timeout: 1000 }),
    ).rejects.toThrow();
  });

  test('times out when server does not respond', async () => {
    const timeoutPort = TEST_PORT + 10;
    // Server that never sends hello_ack
    server = Bun.serve({
      port: timeoutPort,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message() {},
        close() {},
      },
    });

    await expect(
      runLsClient({ host: 'localhost', port: timeoutPort, timeout: 500 }),
    ).rejects.toThrow(/Timed out|closed unexpectedly/);
  });
});

describe('fetchSessions', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  const FETCH_PORT = 9875;

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
  });

  test('returns session array without rendering', async () => {
    const sessions = [
      makeSession({ status: 'active', canAttach: true }),
      makeSession({ status: 'idle', canAttach: false }),
    ];

    server = Bun.serve({
      port: FETCH_PORT,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            const sessionId = generateId();
            ws.send(serialize(createHelloAck('1.0.0', sessionId)));
          } else if (msg.type === 'session_list_request') {
            ws.send(serialize(createSessionListResponse(sessions, msg.id)));
          }
        },
        close() {},
      },
    });

    const result = await fetchSessions('localhost', FETCH_PORT, 3000);
    expect(result).toHaveLength(2);
    expect(result[0]?.status).toBe('active');
    expect(result[1]?.status).toBe('idle');
  });

  test('rejects when server is unreachable', async () => {
    await expect(fetchSessions('localhost', 9876, 1000)).rejects.toThrow();
  });
});
