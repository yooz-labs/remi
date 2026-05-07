import { afterEach, describe, expect, test } from 'bun:test';
import {
  type DiscoverableSession,
  createError,
  createHelloAck,
  createSessionListResponse,
  deserialize,
  generateId,
  now,
  serialize,
} from '@remi/shared';
import {
  fetchSessions,
  formatAge,
  formatDuration,
  getDefaultPortRange,
  getLocalAddresses,
  groupEndpointsByHost,
  parseHostPort,
  parseRemoteTarget,
  runLsClient,
} from '../../src/cli/ls-client.ts';
import type { DiscoveredEndpoint } from '../../src/cli/session-resolver.ts';

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
    canResume: false,
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
    // ls is a utility client; it must declare query mode so the daemon does
    // not auto-attach (which would steal the active slot from a real client).
    expect((hello as { mode?: string } | null)?.mode).toBe('query');
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
    await expect(fetchSessions('localhost', 9876, 1000)).rejects.toThrow(/Cannot connect/);
  });

  test('ignores SESSION_CREATE_FAILED error and returns session list', async () => {
    const sessions = [makeSession({ status: 'idle' })];

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
            // Send error BEFORE hello_ack (tests guard removal)
            ws.send(
              serialize(
                createError(
                  'SESSION_CREATE_FAILED',
                  'Failed to create session: Executable not found in $PATH: "claude"',
                ),
              ),
            );
            ws.send(serialize(createHelloAck('1.0.0', sessionId)));
          } else if (msg.type === 'session_list_request') {
            ws.send(serialize(createSessionListResponse(sessions, msg.id)));
          }
        },
        close() {},
      },
    });

    const result = await fetchSessions('localhost', FETCH_PORT, 3000);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('idle');
  });

  test('ignores NO_SESSION error and returns session list', async () => {
    const sessions = [makeSession({ status: 'active' })];

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
            // Send NO_SESSION error (wrapper mode with no primary session)
            ws.send(serialize(createError('NO_SESSION', 'No active session available')));
            // Then send hello_ack anyway
            ws.send(serialize(createHelloAck('1.0.0', generateId())));
          } else if (msg.type === 'session_list_request') {
            ws.send(serialize(createSessionListResponse(sessions, msg.id)));
          }
        },
        close() {},
      },
    });

    const result = await fetchSessions('localhost', FETCH_PORT, 3000);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('active');
  });

  test('ignores ATTACH_FAILED error after hello_ack', async () => {
    const sessions = [makeSession({ status: 'idle' })];

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
            ws.send(serialize(createHelloAck('1.0.0', generateId())));
          } else if (msg.type === 'session_list_request') {
            // Send error after list request (daemon processing race)
            ws.send(serialize(createError('ATTACH_FAILED', 'Session busy')));
            ws.send(serialize(createSessionListResponse(sessions, msg.id)));
          }
        },
        close() {},
      },
    });

    const result = await fetchSessions('localhost', FETCH_PORT, 3000);
    expect(result).toHaveLength(1);
  });
});

describe('parseRemoteTarget', () => {
  test('parses host:port/session-id', () => {
    const result = parseRemoteTarget('192.168.1.5:18765/abc123', 18765);
    expect(result).toEqual({ host: '192.168.1.5', port: 18765, sessionId: 'abc123' });
  });

  test('parses host/session-id with default port', () => {
    const result = parseRemoteTarget('myhost/abc123', 18765);
    expect(result).toEqual({ host: 'myhost', port: 18765, sessionId: 'abc123' });
  });

  test('parses hostname with dots', () => {
    const result = parseRemoteTarget('my.host.local:9000/sess-id', 18765);
    expect(result).toEqual({ host: 'my.host.local', port: 9000, sessionId: 'sess-id' });
  });

  test('throws on invalid port', () => {
    expect(() => parseRemoteTarget('host:abc/session', 18765)).toThrow(/Invalid port/);
  });

  test('throws on port out of range', () => {
    expect(() => parseRemoteTarget('host:99999/session', 18765)).toThrow(/Invalid port/);
  });

  test('throws on port 0', () => {
    expect(() => parseRemoteTarget('host:0/session', 18765)).toThrow(/Invalid port/);
  });

  test('throws on missing session ID', () => {
    expect(() => parseRemoteTarget('host:1234/', 18765)).toThrow(/Missing session ID/);
  });

  test('throws on input without slash', () => {
    expect(() => parseRemoteTarget('noseparator', 18765)).toThrow(/Invalid remote address/);
  });
});

describe('getLocalAddresses', () => {
  test('includes standard local addresses', () => {
    const addrs = getLocalAddresses('my-host');
    expect(addrs.has('127.0.0.1')).toBe(true);
    expect(addrs.has('::1')).toBe(true);
    expect(addrs.has('localhost')).toBe(true);
    expect(addrs.has('my-host')).toBe(true);
  });

  test('includes at least one network interface address', () => {
    const addrs = getLocalAddresses('test');
    // Should have more than just the 4 hardcoded entries
    expect(addrs.size).toBeGreaterThan(4);
  });

  test('does not include random addresses', () => {
    const addrs = getLocalAddresses('test');
    expect(addrs.has('8.8.8.8')).toBe(false);
    expect(addrs.has('not-a-host')).toBe(false);
  });
});

describe('parseHostPort', () => {
  test('parses valid host:port', () => {
    const result = parseHostPort('100.79.39.98:18767');
    expect(result).toEqual({ host: '100.79.39.98', port: 18767 });
  });

  test('detects trailing alphabetic garbage', () => {
    const result = parseHostPort('100.79.39.98:18767idle');
    expect(result).toEqual({ host: '100.79.39.98', port: 18767, cleaned: 'idle' });
  });

  test('detects multi-word trailing garbage', () => {
    const result = parseHostPort('192.168.1.1:8080active');
    expect(result).toEqual({ host: '192.168.1.1', port: 8080, cleaned: 'active' });
  });

  test('returns null for ports <= 1024', () => {
    expect(parseHostPort('host:80')).toBeNull();
    expect(parseHostPort('host:443')).toBeNull();
    expect(parseHostPort('host:1024')).toBeNull();
  });

  test('returns null for ports > 65535', () => {
    expect(parseHostPort('host:70000')).toBeNull();
  });

  test('returns null for non-host:port strings', () => {
    expect(parseHostPort('just-a-name')).toBeNull();
    expect(parseHostPort('session-id-abc123')).toBeNull();
  });

  test('returns null for session names with colons but no numeric port', () => {
    expect(parseHostPort('hostname:project/branch')).toBeNull();
  });

  test('handles hostname with port', () => {
    const result = parseHostPort('my-server:18765');
    expect(result).toEqual({ host: 'my-server', port: 18765 });
  });

  test('does not match trailing mixed alphanumeric', () => {
    // "idle2" contains digits, so [a-zA-Z]+ won't match it
    expect(parseHostPort('host:18767idle2')).toBeNull();
  });
});

describe('formatAge', () => {
  test('formats seconds ago', () => {
    const ts = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatAge(ts)).toBe('30s ago');
  });

  test('formats minutes ago', () => {
    const ts = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatAge(ts)).toBe('5m ago');
  });

  test('formats hours ago', () => {
    const ts = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatAge(ts)).toBe('2h ago');
  });

  test('formats days ago', () => {
    const ts = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatAge(ts)).toBe('3d ago');
  });

  test('formats 0 seconds for just-now timestamp', () => {
    const ts = new Date().toISOString();
    expect(formatAge(ts)).toBe('0s ago');
  });
});

describe('formatDuration', () => {
  test('returns "-" for undefined', () => {
    expect(formatDuration(undefined)).toBe('-');
  });

  test('formats seconds', () => {
    const ts = new Date(Date.now() - 45 * 1000).toISOString();
    expect(formatDuration(ts)).toBe('45s');
  });

  test('formats minutes', () => {
    const ts = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    expect(formatDuration(ts)).toBe('45m');
  });

  test('formats hours and minutes', () => {
    const ts = new Date(Date.now() - (2 * 60 + 15) * 60 * 1000).toISOString();
    expect(formatDuration(ts)).toBe('2h 15m');
  });

  test('formats exact hours without minutes', () => {
    const ts = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatDuration(ts)).toBe('3h');
  });

  test('formats days and hours', () => {
    const ts = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    expect(formatDuration(ts)).toBe('1d 2h');
  });

  test('formats exact days without hours', () => {
    const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatDuration(ts)).toBe('2d');
  });
});

// ---------------------------------------------------------------------------
// getDefaultPortRange
// ---------------------------------------------------------------------------

describe('getDefaultPortRange', () => {
  test('returns 20 ports starting at 18765', () => {
    const ports = getDefaultPortRange();
    expect(ports).toHaveLength(20);
    expect(ports[0]).toBe(18765);
    expect(ports[19]).toBe(18784);
  });

  test('returns sequential ports with no gaps', () => {
    const ports = getDefaultPortRange();
    for (let i = 1; i < ports.length; i++) {
      const prev = ports[i - 1] ?? 0;
      expect(ports[i]).toBe(prev + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// groupEndpointsByHost
// ---------------------------------------------------------------------------

describe('groupEndpointsByHost', () => {
  function ep(host: string, port: number, source: 'mdns' | 'vpn' = 'mdns'): DiscoveredEndpoint {
    return { host, port, hostname: `host-${host}`, source };
  }

  test('returns empty map for empty input', () => {
    expect(groupEndpointsByHost([])).toEqual(new Map());
  });

  test('keeps one endpoint per unique host', () => {
    const endpoints = [ep('192.168.1.1', 18765), ep('192.168.1.2', 18770)];
    const result = groupEndpointsByHost(endpoints);
    expect(result.size).toBe(2);
    expect(result.get('192.168.1.1')?.port).toBe(18765);
    expect(result.get('192.168.1.2')?.port).toBe(18770);
  });

  test('deduplicates same host on different ports, keeping the first', () => {
    const endpoints = [
      ep('192.168.1.1', 18765, 'mdns'),
      ep('192.168.1.1', 18770, 'vpn'),
      ep('192.168.1.1', 18775, 'mdns'),
    ];
    const result = groupEndpointsByHost(endpoints);
    expect(result.size).toBe(1);
    expect(result.get('192.168.1.1')?.port).toBe(18765);
    expect(result.get('192.168.1.1')?.source).toBe('mdns');
  });

  test('treats different IPs for same hostname as separate hosts', () => {
    const endpoints = [
      { host: '192.168.1.1', port: 18765, hostname: 'myhost', source: 'mdns' as const },
      { host: '100.79.39.98', port: 18765, hostname: 'myhost', source: 'vpn' as const },
    ];
    const result = groupEndpointsByHost(endpoints);
    expect(result.size).toBe(2);
  });
});
