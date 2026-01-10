/**
 * Tests for WebSocket server.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { WebSocketServer } from '../src/server/websocket-server.ts';
import { serialize, createHello, createUserInput, createPing } from '@remi/shared';

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
        { onStart: (port) => { startPort = port; } },
      );

      await serverWithEvents.start();
      expect(startPort).toBe(testPort + 1);
      await serverWithEvents.stop();
    });

    test('emits onStop event', async () => {
      let stopped = false;
      const serverWithEvents = new WebSocketServer(
        { port: testPort + 2 },
        { onStop: () => { stopped = true; } },
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
        { onClientConnect: () => { clientConnected = true; } },
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

        ws.onerror = (err) => {
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
        { onClientDisconnect: (id, reason) => { disconnectReason = reason; } },
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
            onUserInput: (connId, sessionId, content) => {
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
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });

      expect(response.status).toBe(503);

      ws1.close();
      await limitedServer.stop();
    });
  });
});
