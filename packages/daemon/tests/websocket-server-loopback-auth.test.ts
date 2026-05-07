/**
 * Integration tests for the localhost-no-auth path (#257).
 *
 * Verifies that even when the daemon is configured with an authenticator
 * (e.g. running with --auth on a 0.0.0.0 bind), peers connecting from the
 * loopback interface skip the auth challenge entirely. Also exercises the
 * /auth-info HTTP probe used by the web client to surface the passphrase
 * prompt inline in the Connect modal before opening the WebSocket.
 *
 * No mocks: real Bun HTTP/WebSocket server, real Ed25519 keypair, real WS
 * client. Tests are gated to localhost so the loopback exemption applies.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ProtocolMessage,
  type UnlockedIdentity,
  createHello,
  deserialize,
  serialize,
} from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';
import { WebSocketServer } from '../src/server/websocket-server.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-loopback-auth-'));
}

describe('WebSocketServer loopback auth skip (#257)', () => {
  let tmpDir: string;
  let store: IdentityStore;
  let serverIdentity: UnlockedIdentity;
  let authenticator: Authenticator;
  const basePort = 9920;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new IdentityStore(tmpDir);
    await store.generate('serverpass');
    serverIdentity = await store.unlock('serverpass');
    authenticator = new Authenticator({
      identity: serverIdentity,
      identityStore: store,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  test('loopback peer never receives auth_challenge even with authenticator configured', async () => {
    const port = basePort;
    const server = new WebSocketServer({
      port,
      host: '127.0.0.1',
      connection: { authenticator, skipHelloAck: false },
    });
    await server.start();

    try {
      // 127.0.0.1 -> bun -> server.requestIP returns 127.0.0.1
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const received: ProtocolMessage[] = [];

      const helloAckPromise = new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client', '1.0.0')));
        };
        ws.onmessage = (e) => {
          const msg = deserialize(e.data.toString());
          if (msg) received.push(msg);
          if (msg?.type === 'hello_ack') resolve();
        };
        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Timeout waiting for hello_ack')), 3000);
      });

      await helloAckPromise;
      ws.close();

      // No auth_challenge should ever have been sent.
      const types = received.map((m) => m.type);
      expect(types).not.toContain('auth_challenge');
      expect(types).toContain('hello_ack');
    } finally {
      await server.stop();
    }
  });

  test('loopback connections coexist with authenticator on 0.0.0.0 bind', async () => {
    // Bind to all interfaces, but connect via the loopback interface.
    // Real-world: daemon on 0.0.0.0 with --auth, browser at http://localhost.
    const port = basePort + 1;
    const server = new WebSocketServer({
      port,
      host: '0.0.0.0',
      connection: { authenticator, skipHelloAck: false },
    });
    await server.start();

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const received: ProtocolMessage[] = [];

      const helloAckPromise = new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client', '1.0.0')));
        };
        ws.onmessage = (e) => {
          const msg = deserialize(e.data.toString());
          if (msg) received.push(msg);
          if (msg?.type === 'hello_ack') resolve();
        };
        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Timeout waiting for hello_ack')), 3000);
      });

      await helloAckPromise;
      ws.close();

      const types = received.map((m) => m.type);
      expect(types).not.toContain('auth_challenge');
      expect(types).toContain('hello_ack');
    } finally {
      await server.stop();
    }
  });

  test('without authenticator, loopback path is identical', async () => {
    const port = basePort + 2;
    const server = new WebSocketServer({
      port,
      host: '127.0.0.1',
      connection: { skipHelloAck: false },
    });
    await server.start();

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const received: ProtocolMessage[] = [];

      const helloAckPromise = new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(serialize(createHello('test-client', '1.0.0')));
        };
        ws.onmessage = (e) => {
          const msg = deserialize(e.data.toString());
          if (msg) received.push(msg);
          if (msg?.type === 'hello_ack') resolve();
        };
        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Timeout waiting for hello_ack')), 3000);
      });

      await helloAckPromise;
      ws.close();

      const types = received.map((m) => m.type);
      expect(types).not.toContain('auth_challenge');
      expect(types).toContain('hello_ack');
    } finally {
      await server.stop();
    }
  });
});

describe('WebSocketServer /auth-info endpoint (#257)', () => {
  let tmpDir: string;
  let store: IdentityStore;
  let serverIdentity: UnlockedIdentity;
  let authenticator: Authenticator;
  const basePort = 9930;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new IdentityStore(tmpDir);
    await store.generate('serverpass');
    serverIdentity = await store.unlock('serverpass');
    authenticator = new Authenticator({
      identity: serverIdentity,
      identityStore: store,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  test('reports authRequired=false when no authenticator', async () => {
    const port = basePort;
    const server = new WebSocketServer({ port, host: '127.0.0.1' });
    await server.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth-info`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { authRequired: boolean; fingerprint: string | null };
      expect(data.authRequired).toBe(false);
      expect(data.fingerprint).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('reports authRequired=false for loopback caller even with authenticator', async () => {
    // The probe must answer from the same vantage point as the WebSocket
    // upgrade so the modal trusts it: loopback peers skip auth.
    const port = basePort + 1;
    const server = new WebSocketServer({
      port,
      host: '0.0.0.0',
      connection: { authenticator },
    });
    await server.start();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth-info`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { authRequired: boolean; fingerprint: string | null };
      expect(data.authRequired).toBe(false);
      // Fingerprint is exposed so the UI can pin it for TOFU.
      expect(data.fingerprint).toBe(authenticator.serverFingerprint);
    } finally {
      await server.stop();
    }
  });
});
