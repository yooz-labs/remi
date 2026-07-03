/**
 * Tests for WebSocket server.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type UUID,
  createCreateSessionRequest,
  createHello,
  createIdentity,
  createPing,
  createPong,
  createUserInput,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';
import { WebSocketServer } from '../src/server/websocket-server.ts';

describe('WebSocketServer', () => {
  let server: WebSocketServer;
  const testPort = 9847; // Use a different port for testing

  beforeEach(() => {
    server = new WebSocketServer({ port: testPort });
  });

  afterEach(async () => {
    if (server.running) {
      await server.stop();
    }
  });

  describe('Server lifecycle', () => {
    test('starts and stops correctly', async () => {
      expect(server.running).toBe(false);

      await server.start();
      expect(server.running).toBe(true);
      expect(server.port).toBe(testPort);

      await server.stop();
      expect(server.running).toBe(false);
    });

    test('throws when starting twice', async () => {
      await server.start();

      expect(async () => {
        await server.start();
      }).toThrow('Server already running');
    });

    test('stop is idempotent', async () => {
      await server.start();
      await server.stop();
      await server.stop(); // Should not throw
      expect(server.running).toBe(false);
    });

    test('emits onStart event', async () => {
      let startPort = 0;
      const serverWithEvents = new WebSocketServer(
        { port: testPort + 1 },
        {
          onStart: (port) => {
            startPort = port;
          },
        },
      );

      await serverWithEvents.start();
      expect(startPort).toBe(testPort + 1);
      await serverWithEvents.stop();
    });

    test('emits onStop event', async () => {
      let stopped = false;
      const serverWithEvents = new WebSocketServer(
        { port: testPort + 2 },
        {
          onStop: () => {
            stopped = true;
          },
        },
      );

      await serverWithEvents.start();
      await serverWithEvents.stop();
      expect(stopped).toBe(true);
    });
  });

  describe('Health check endpoint', () => {
    test('returns health status', async () => {
      await server.start();

      const response = await fetch(`http://localhost:${testPort}/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(typeof data.connections).toBe('number');
    });

    test('returns 404 for unknown paths', async () => {
      await server.start();

      const response = await fetch(`http://localhost:${testPort}/unknown`);
      expect(response.status).toBe(404);
    });

    test('/health includes CORS header so cross-origin clients can fetch (#403)', async () => {
      await server.start();
      const response = await fetch(`http://localhost:${testPort}/health`);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });

    test('/auth-info includes CORS header (#403)', async () => {
      await server.start();
      const response = await fetch(`http://localhost:${testPort}/auth-info`);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      const data = await response.json();
      expect(typeof data.authRequired).toBe('boolean');
    });

    test('404 fallthrough includes CORS header (#403)', async () => {
      await server.start();
      const response = await fetch(`http://localhost:${testPort}/nonexistent`);
      expect(response.status).toBe(404);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  describe('Connection management', () => {
    test('starts with zero connections', async () => {
      await server.start();
      expect(server.connectionCount).toBe(0);
      expect(server.allConnections).toEqual([]);
    });

    test('accepts WebSocket connections', async () => {
      let clientConnected = false;
      const serverWithEvents = new WebSocketServer(
        { port: testPort + 3 },
        {
          onClientConnect: () => {
            clientConnected = true;
          },
        },
      );

      await serverWithEvents.start();

      // Connect WebSocket client
      const ws = new WebSocket(`ws://localhost:${testPort + 3}/ws`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          // Send hello message
          ws.send(serialize(createHello('test-client', '1.0.0')));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());
          if (data.type === 'hello_ack') {
            resolve();
          }
        };

        ws.onerror = (_err) => {
          reject(new Error('WebSocket error'));
        };

        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      expect(clientConnected).toBe(true);
      expect(serverWithEvents.connectionCount).toBe(1);

      ws.close();
      await serverWithEvents.stop();
    });

    test('handles client disconnect', async () => {
      let disconnectReason = '';
      const serverWithEvents = new WebSocketServer(
        { port: testPort + 4 },
        {
          onClientDisconnect: (_id, reason) => {
            disconnectReason = reason;
          },
        },
      );

      await serverWithEvents.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 4}/ws`);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client', '1.0.0')));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());
          if (data.type === 'hello_ack') {
            // Close the connection
            ws.close();
          }
        };

        ws.onclose = () => {
          // Wait a bit for server to process
          setTimeout(resolve, 100);
        };
      });

      expect(disconnectReason).toBe('Client disconnected');
      expect(serverWithEvents.connectionCount).toBe(0);

      await serverWithEvents.stop();
    });
  });

  describe('Message handling', () => {
    test('handles user input', async () => {
      const receivedPromise = new Promise<string>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 5 },
          {
            onUserInput: (_connId, _sessionId, content) => {
              resolve(content);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 5}/ws`);

      // Connect and send user input
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client', '1.0.0')));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());

          if (data.type === 'hello_ack') {
            // Send user input
            ws.send(serialize(createUserInput(data.sessionId, 'Hello, Claude!')));
            resolve();
          }
        };

        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      // Wait for the content to be received
      const receivedContent = await Promise.race([
        receivedPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Content not received')), 1000),
        ),
      ]);

      expect(receivedContent).toBe('Hello, Claude!');

      ws.close();
      await server.stop();
    });

    test('responds to ping with pong', async () => {
      const serverWithEvents = new WebSocketServer({ port: testPort + 6 });
      await serverWithEvents.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 6}/ws`);
      let receivedPong = false;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client', '1.0.0')));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());

          if (data.type === 'hello_ack') {
            // Send ping
            const ping = createPing();
            ws.send(serialize(ping));
          } else if (data.type === 'pong') {
            receivedPong = true;
            resolve();
          }
        };

        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      expect(receivedPong).toBe(true);

      ws.close();
      await serverWithEvents.stop();
    });
  });

  describe('Configuration', () => {
    test('uses default configuration', () => {
      const defaultServer = new WebSocketServer();
      expect(defaultServer.port).toBe(3847);
    });

    test('accepts custom port', () => {
      const customServer = new WebSocketServer({ port: 8080 });
      expect(customServer.port).toBe(8080);
    });

    test('limits connections when maxConnections is reached', async () => {
      const limitedServer = new WebSocketServer({
        port: testPort + 7,
        maxConnections: 1,
      });

      await limitedServer.start();

      // First connection should succeed
      const ws1 = new WebSocket(`ws://localhost:${testPort + 7}/ws`);
      await new Promise<void>((resolve) => {
        ws1.onopen = () => {
          ws1.send(serialize(createHello('client1', '1.0.0')));
        };
        ws1.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());
          if (data.type === 'hello_ack') {
            resolve();
          }
        };
      });

      // Second connection should fail with 503
      const response = await fetch(`http://localhost:${testPort + 7}/ws`, {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });

      expect(response.status).toBe(503);

      ws1.close();
      await limitedServer.stop();
    });
  });

  describe('Create session request', () => {
    test('fires onCreateSessionRequest with correct params', async () => {
      const receivedPromise = new Promise<{
        connectionId: UUID;
        directory: string | undefined;
        requestId: UUID;
      }>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 10 },
          {
            onCreateSessionRequest: (connectionId, directory, requestId) => {
              resolve({ connectionId, directory, requestId });
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 10}/ws`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client' as UUID, '1.0.0')));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());
          if (data.type === 'hello_ack') {
            // Send create session request
            ws.send(serialize(createCreateSessionRequest('/test/dir')));
            resolve();
          }
        };

        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 2000),
        ),
      ]);

      expect(received.directory).toBe('/test/dir');
      expect(received.requestId).toBeTruthy();
      expect(received.connectionId).toBeTruthy();

      ws.close();
      await server.stop();
    });

    test('fires onCreateSessionRequest without directory', async () => {
      const receivedPromise = new Promise<{ directory: string | undefined }>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 11 },
          {
            onCreateSessionRequest: (_connectionId, directory) => {
              resolve({ directory });
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 11}/ws`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client' as UUID, '1.0.0')));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data.toString());
          if (data.type === 'hello_ack') {
            ws.send(serialize(createCreateSessionRequest()));
            resolve();
          }
        };

        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 2000),
        ),
      ]);

      expect(received.directory).toBeUndefined();

      ws.close();
      await server.stop();
    });
  });

  describe('Hello with resumeSessionId', () => {
    test('passes resumeSessionId through onClientConnect metadata', async () => {
      const resumeId = 'session-to-resume' as UUID;
      const receivedPromise = new Promise<string | undefined>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 12 },
          {
            onClientConnect: (connection) => {
              resolve(connection.connectionResumeSessionId ?? undefined);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 12}/ws`);

      ws.onopen = () => {
        ws.send(
          serialize(createHello('test-client' as UUID, '1.0.0', { resumeSessionId: resumeId })),
        );
      };

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 5000),
        ),
      ]);

      expect(received).toBe(resumeId);

      ws.close();
      await server.stop();
    });

    test('passes directory through onClientConnect', async () => {
      const receivedPromise = new Promise<string | null>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 13 },
          {
            onClientConnect: (connection) => {
              resolve(connection.connectionDirectory);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 13}/ws`);

      ws.onopen = () => {
        ws.send(
          serialize(createHello('test-client' as UUID, '1.0.0', { directory: '/my/project' })),
        );
      };

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 5000),
        ),
      ]);

      expect(received).toBe('/my/project');

      ws.close();
      await server.stop();
    });

    test('passes mode through onClientConnect for query-mode clients', async () => {
      const receivedPromise = new Promise<'query' | undefined>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 14 },
          {
            onClientConnect: (connection) => {
              resolve(connection.connectionMode);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 14}/ws`);

      ws.onopen = () => {
        ws.send(serialize(createHello('test-client' as UUID, '1.0.0', { mode: 'query' })));
      };

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 5000),
        ),
      ]);

      expect(received).toBe('query');

      ws.close();
      await server.stop();
    });

    test('connectionMode is undefined when hello omits mode', async () => {
      const receivedPromise = new Promise<'query' | undefined>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 15 },
          {
            onClientConnect: (connection) => {
              resolve(connection.connectionMode);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 15}/ws`);

      ws.onopen = () => {
        ws.send(serialize(createHello('test-client' as UUID, '1.0.0')));
      };

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 5000),
        ),
      ]);

      expect(received).toBeUndefined();

      ws.close();
      await server.stop();
    });

    test('passes deviceId through onClientConnect (#662)', async () => {
      const receivedPromise = new Promise<string | null>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 20 },
          {
            onClientConnect: (connection) => {
              resolve(connection.connectionDeviceId);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 20}/ws`);

      ws.onopen = () => {
        ws.send(serialize(createHello('test-client' as UUID, '1.0.0', { deviceId: 'device-A' })));
      };

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 5000),
        ),
      ]);

      expect(received).toBe('device-A');

      ws.close();
      await server.stop();
    });

    test('connectionDeviceId is null when hello omits deviceId (#662)', async () => {
      const receivedPromise = new Promise<string | null>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 21 },
          {
            onClientConnect: (connection) => {
              resolve(connection.connectionDeviceId);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 21}/ws`);

      ws.onopen = () => {
        ws.send(serialize(createHello('test-client' as UUID, '1.0.0')));
      };

      const received = await Promise.race([
        receivedPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Event not received')), 5000),
        ),
      ]);

      expect(received).toBeNull();

      ws.close();
      await server.stop();
    });
  });

  describe('Ping/pong liveness reaper (#662)', () => {
    test('force-closes a connection that stops answering server pings', async () => {
      // Short ping interval so the reaper (2 missed pongs) fires in well
      // under the test timeout. The test client deliberately never replies
      // to the server's app-level pings, simulating a dead socket that never
      // fires the WebSocket 'close' event (iOS background, NAT drop).
      const pingInterval = 40;
      const disconnectPromise = new Promise<string>((resolve) => {
        server = new WebSocketServer(
          { port: testPort + 22, connection: { pingInterval } },
          {
            onClientDisconnect: (_connectionId, reason) => {
              resolve(reason);
            },
          },
        );
      });

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 22}/ws`);
      ws.onopen = () => {
        ws.send(serialize(createHello('test-client' as UUID, '1.0.0')));
      };

      const reason = await Promise.race([
        disconnectPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Reaper did not fire')), 5000),
        ),
      ]);

      expect(reason).toContain('Ping timeout');

      ws.close();
      await server.stop();
    });

    test('a connection that keeps replying with pong is never force-closed', async () => {
      const pingInterval = 40;
      let disconnected = false;
      server = new WebSocketServer(
        { port: testPort + 23, connection: { pingInterval } },
        {
          onClientDisconnect: () => {
            disconnected = true;
          },
        },
      );

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 23}/ws`);
      ws.onopen = () => {
        ws.send(serialize(createHello('test-client' as UUID, '1.0.0')));
      };
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data.toString());
        if (data.type === 'ping') {
          ws.send(serialize(createPong(data.id)));
        }
      };

      // Wait past several ping intervals (well beyond the 2-missed-pong
      // threshold if pongs were NOT being answered).
      await new Promise((resolve) => setTimeout(resolve, pingInterval * 5));

      expect(disconnected).toBe(false);

      ws.close();
      await server.stop();
    });

    test('a connection sending ordinary traffic (never an explicit pong) is never force-closed (#662 review)', async () => {
      // Regression: the real web/mobile client sends its own client-initiated
      // 'ping' (WebSocketClient's internal heartbeat, 15s default, #664) but,
      // before the review fix, never replied with a protocol 'pong' to the
      // SERVER's ping. Gating liveness on 'pong' alone force-closed every
      // healthy client on a ~60-90s cycle. Any successfully-parsed inbound
      // message must count as proof-of-life, not only 'pong'.
      const pingInterval = 40;
      let disconnected = false;
      server = new WebSocketServer(
        { port: testPort + 24, connection: { pingInterval } },
        {
          onClientDisconnect: () => {
            disconnected = true;
          },
        },
      );

      await server.start();

      const ws = new WebSocket(`ws://localhost:${testPort + 24}/ws`);
      let helloAcked = false;
      let trafficTimer: ReturnType<typeof setInterval> | null = null;
      ws.onopen = () => {
        ws.send(serialize(createHello('test-client' as UUID, '1.0.0')));
      };
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data.toString());
        if (data.type === 'hello_ack' && !helloAcked) {
          helloAcked = true;
          // Ordinary protocol traffic, sent faster than the ping interval,
          // that is NEVER a 'pong'. Mirrors the web client's own client-
          // initiated keep-alive ping (createPing(), not a reply to the
          // server's ping).
          trafficTimer = setInterval(() => {
            ws.send(serialize(createPing()));
          }, pingInterval / 2);
        }
        // Deliberately does NOT reply with pong to inbound 'ping' messages.
      };

      // Wait past several ping intervals (well beyond the 2-missed-pong
      // threshold if this traffic didn't count as liveness).
      await new Promise((resolve) => setTimeout(resolve, pingInterval * 5));

      expect(disconnected).toBe(false);

      if (trafficTimer) clearInterval(trafficTimer);
      ws.close();
      await server.stop();
    });
  });

  // Connection-independent answer relay (#575, P4a). Real HTTP requests; real
  // Ed25519 auth via a real IdentityStore + Authenticator (no mocks).
  describe('POST /answer relay', () => {
    // Each startServer() call binds a fresh port so a not-yet-released listener
    // from a prior server in the same/previous test cannot answer this request.
    let nextAnswerPort = testPort + 30;
    let answerPort = nextAnswerPort;

    async function startServer(opts: {
      authenticator?: Authenticator;
      relayResult?: 'delivered' | 'session-not-found' | 'stale-binding' | 'stale';
      captureRelay?: (args: { sessionId: string; questionId: string; answer: string }) => void;
    }): Promise<WebSocketServer> {
      if (server?.running) await server.stop();
      answerPort = nextAnswerPort++;
      const s = new WebSocketServer(
        {
          port: answerPort,
          connection: opts.authenticator ? { authenticator: opts.authenticator } : {},
        },
        {
          onAnswerRelay: async (sessionId, questionId, answer) => {
            opts.captureRelay?.({ sessionId, questionId, answer });
            return opts.relayResult ?? 'delivered';
          },
        },
      );
      await s.start();
      server = s; // so afterEach stops it
      return s;
    }

    function makeAuthDir(): { store: IdentityStore; dir: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-answer-relay-'));
      return { store: new IdentityStore(dir), dir };
    }

    test('routes a loopback (no-auth) answer through onAnswerRelay and returns delivered', async () => {
      const captured: Array<{ sessionId: string; questionId: string; answer: string }> = [];
      await startServer({ captureRelay: (a) => captured.push(a) });

      const res = await fetch(`http://localhost:${answerPort}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sess-1', questionId: 'q-1', answer: 'Yes' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: string };
      expect(body.result).toBe('delivered');
      expect(captured).toEqual([{ sessionId: 'sess-1', questionId: 'q-1', answer: 'Yes' }]);
    });

    test('maps session-not-found to 404 and stale to 409', async () => {
      await startServer({ relayResult: 'session-not-found' });
      const r1 = await fetch(`http://localhost:${answerPort}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's', questionId: 'q', answer: 'Yes' }),
      });
      expect(r1.status).toBe(404);
      expect(((await r1.json()) as { result: string }).result).toBe('session-not-found');

      await startServer({ relayResult: 'stale' });
      const r2 = await fetch(`http://localhost:${answerPort}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's', questionId: 'q', answer: 'Yes' }),
      });
      expect(r2.status).toBe(409);
      expect(((await r2.json()) as { result: string }).result).toBe('stale');
    });

    test('returns 400 for missing fields and bad JSON', async () => {
      await startServer({});
      const bad = await fetch(`http://localhost:${answerPort}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });
      expect(bad.status).toBe(400);

      const missing = await fetch(`http://localhost:${answerPort}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's' }),
      });
      expect(missing.status).toBe(400);
    });

    test('rejects an oversized body with 413 before parsing', async () => {
      await startServer({});
      // 64KiB + 1: just over the guard.
      const huge = 'x'.repeat(64 * 1024 + 1);
      const res = await fetch(`http://localhost:${answerPort}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's', questionId: 'q', answer: huge }),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as { result: string }).result).toBe('payload-too-large');
    });

    test('loopback peer is exempt from auth even when an authenticator is configured', async () => {
      // Mirrors the WebSocket loopback bypass: a same-machine peer is trusted
      // by virtue of the OS, so the route does not require a signature. The test
      // client connects over 127.0.0.1, so this proves the route is reachable
      // (and auth-exempt) for loopback even with auth on.
      const { store, dir } = makeAuthDir();
      try {
        await store.generate();
        const serverIdentity = await store.unlock();
        const authenticator = new Authenticator({ identity: serverIdentity, identityStore: store });
        await startServer({ authenticator });

        const res = await fetch(`http://localhost:${answerPort}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 's', questionId: 'q', answer: 'Yes' }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { result: string }).result).toBe('delivered');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // The route's networked-peer auth gate calls Authenticator.verifyDetachedRequest;
    // since loopback peers (the only peer a local test can present) are exempt,
    // the auth-rejection path is exercised directly against that method — the
    // exact same gate the route uses (verify signature, then require an
    // authorized key). This is the SAME trust model the WebSocket handshake uses.
    test('verifyDetachedRequest rejects a valid signature from an UNAUTHORIZED key', async () => {
      const { store, dir } = makeAuthDir();
      try {
        await store.generate();
        const serverIdentity = await store.unlock();
        const authenticator = new Authenticator({ identity: serverIdentity, identityStore: store });

        const stranger = await createIdentity();
        const strangerUnlocked = await unlockIdentity(stranger);
        const msg = 'sess|q|Yes';
        const data = new TextEncoder().encode(msg).buffer as ArrayBuffer;
        const sig = await sign(strangerUnlocked.privateKey, data);
        // Signature is cryptographically valid, but the key was never authorized.
        expect(
          await authenticator.verifyDetachedRequest(
            msg,
            sig,
            stranger.publicKey,
            stranger.fingerprint,
          ),
        ).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('verifyDetachedRequest accepts an authorized key with a valid signature, rejects a tampered message', async () => {
      const { store, dir } = makeAuthDir();
      try {
        await store.generate();
        const serverIdentity = await store.unlock();
        const authenticator = new Authenticator({ identity: serverIdentity, identityStore: store });

        const client = await createIdentity();
        const clientUnlocked = await unlockIdentity(client);
        await store.addAuthorizedKey(client.publicKey, 'Test Client');

        const msg = 'sess|q|Yes';
        const data = new TextEncoder().encode(msg).buffer as ArrayBuffer;
        const sig = await sign(clientUnlocked.privateKey, data);

        // Authorized key + matching signature => accepted.
        expect(
          await authenticator.verifyDetachedRequest(msg, sig, client.publicKey, client.fingerprint),
        ).toBe(true);

        // Same signature over a DIFFERENT message (replay for another answer) => rejected.
        expect(
          await authenticator.verifyDetachedRequest(
            'sess|q|No',
            sig,
            client.publicKey,
            client.fingerprint,
          ),
        ).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
