/**
 * Real HTTPS/WSS listener and adapter controls (#1170), using an owned OpenSSL
 * CA and native Bun sockets. This is daemon transport coverage, not shipping
 * browser/native client or device acceptance. Wrong-host validation is checked
 * with HTTPS: Bun 1.3.11's native WebSocket does not enforce it reliably.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  type UnlockedIdentity,
  createAuthResponse,
  createHello,
  createHelloAck,
  createIdentity,
  createSessionListRequest,
  createSessionListResponse,
  deserialize,
  fromBase64,
  generateId,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter.ts';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { CAPABILITY_HEADER, loadOrCreateCapabilityToken } from '../../src/auth/capability-token.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import {
  type ServerConfig,
  type ServerEvents,
  WebSocketServer,
} from '../../src/server/websocket-server.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const HOST = '127.0.0.1';
const ALLOWED_ORIGIN = 'https://remi.yooz.live';
const REFUSED_ORIGIN = 'https://refused.example';
const TIMEOUT_MS = 3000;
// lib.dom selects a browser constructor, and the installed Bun declarations
// omit the native CA option exercised here on both pinned runtimes.
const NativeWebSocket = WebSocket as unknown as {
  new (
    url: string,
    options?: { tls?: { ca: string }; headers?: Record<string, string> },
  ): WebSocket;
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for TLS test control');
    await Bun.sleep(5);
  }
}

interface Peer {
  readonly socket: WebSocket;
  readonly messages: ProtocolMessage[];
}

async function receive<T extends ProtocolMessage['type']>(
  peer: Peer,
  type: T,
): Promise<Extract<ProtocolMessage, { type: T }>> {
  await waitFor(() => peer.messages.some((message) => message.type === type));
  const message = peer.messages.find((message) => message.type === type);
  if (!message || message.type !== type) throw new Error(`Missing ${type}`);
  return message as Extract<ProtocolMessage, { type: T }>;
}

describe('optional direct TLS: real daemon server/adapter and native Bun sockets', () => {
  let directory: string;
  let ca: string;
  let tls: NonNullable<ServerConfig['tls']>;
  let otherKey: string;
  let store: IdentityStore;
  let authenticator: Authenticator;
  let known: UnlockedIdentity;
  let unknown: UnlockedIdentity;
  let capabilityToken: string;
  const owners: Array<{ stop(): Promise<void> }> = [];
  const peers: Peer[] = [];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'remi-tls-'));
    chmodSync(directory, 0o700);
    writeFileSync(
      join(directory, 'ca.cnf'),
      '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n' +
        '[dn]\nCN=Remi owned TLS test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\n' +
        'keyUsage=critical,keyCertSign,cRLSign\n',
    );
    writeFileSync(
      join(directory, 'server.cnf'),
      '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=127.0.0.1\n',
    );
    writeFileSync(
      join(directory, 'server.ext'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n' +
        'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
    );
    const openssl = (...args: string[]) =>
      execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
    openssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      'ca.cnf',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
    );
    openssl(
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-config',
      'server.cnf',
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
    );
    openssl(
      'x509',
      '-req',
      '-days',
      '1',
      '-in',
      'server.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-extfile',
      'server.ext',
      '-out',
      'server.pem',
    );
    openssl('genrsa', '-out', 'other.key', '2048');
    for (const file of ['ca.key', 'server.key', 'other.key'])
      chmodSync(join(directory, file), 0o600);
    ca = readFileSync(join(directory, 'ca.pem'), 'utf8');
    tls = {
      key: readFileSync(join(directory, 'server.key'), 'utf8'),
      cert: readFileSync(join(directory, 'server.pem'), 'utf8'),
    };
    otherKey = readFileSync(join(directory, 'other.key'), 'utf8');
    store = new IdentityStore(join(directory, 'identity'));
    await store.generate('owned-local-test');
    authenticator = new Authenticator({
      identity: await store.unlock('owned-local-test'),
      identityStore: store,
    });
    known = await unlockIdentity(await createIdentity('known-test'), 'known-test');
    unknown = await unlockIdentity(await createIdentity('unknown-test'), 'unknown-test');
    await store.addAuthorizedKey(known.publicKeyRaw, 'owned TLS test client');
    capabilityToken = loadOrCreateCapabilityToken(join(directory, 'capability'));
  }, 20_000);

  afterEach(async () => {
    const closing = peers.splice(0);
    for (const peer of closing) peer.socket.close();
    try {
      await Promise.all(
        closing.map((peer) => waitFor(() => peer.socket.readyState === WebSocket.CLOSED)),
      );
    } finally {
      for (const owner of owners.splice(0).reverse()) await owner.stop();
    }
  });

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  async function startServer(
    config: Partial<ServerConfig> = {},
    events: Partial<ServerEvents> = {},
  ): Promise<WebSocketServer> {
    const server = new WebSocketServer(
      { port: 0, host: HOST, tls, connection: { authenticator }, capabilityToken, ...config },
      events,
    );
    owners.push(server);
    await server.start();
    return server;
  }

  async function connect(
    url: string,
    options: { ca?: string; headers?: Record<string, string> } = {},
  ): Promise<Peer> {
    const socket = new NativeWebSocket(url, {
      ...(options.ca !== undefined && { tls: { ca: options.ca } }),
      ...(options.headers && { headers: options.headers }),
    });
    const peer = { socket, messages: [] as ProtocolMessage[] };
    peers.push(peer);
    let failed = false;
    socket.onerror = () => {
      failed = true;
    };
    socket.onmessage = (event) => {
      const message = deserialize(String(event.data));
      if (message) peer.messages.push(message);
    };
    await waitFor(() => failed || socket.readyState !== WebSocket.CONNECTING);
    if (failed || socket.readyState !== WebSocket.OPEN)
      throw new Error('WebSocket transport refused');
    return peer;
  }

  async function authenticate(peer: Peer, identity = known) {
    const challenge = await receive(peer, 'auth_challenge');
    expect(challenge.serverPublicKey).toBe(authenticator.serverPublicKey);
    peer.socket.send(
      serialize(
        createAuthResponse(
          identity.publicKeyRaw,
          await sign(identity.privateKey, fromBase64(challenge.challenge)),
          identity.fingerprint,
        ),
      ),
    );
    return receive(peer, 'auth_result');
  }

  function https(server: WebSocketServer, path: string, headers: Record<string, string> = {}) {
    return fetch(`https://${HOST}:${server.port}${path}`, {
      tls: { ca },
      headers: { Connection: 'close', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  test('owned CA/IP SAN: HTTPS health/auth-info and signed WSS hello/domain round trip', async () => {
    let connected = 0;
    const server = await startServer(
      {},
      {
        onClientConnect: () => {
          connected++;
        },
        onSessionListRequest: (id, requestId) => {
          server.sendTo(id, createSessionListResponse([], requestId));
        },
      },
    );
    expect(await (await https(server, '/health')).json()).toEqual({ status: 'ok', connections: 0 });
    expect(await (await https(server, '/auth-info')).json()).toEqual({
      authRequired: true,
      fingerprint: authenticator.serverFingerprint,
    });
    const peer = await connect(`wss://${HOST}:${server.port}/ws`, { ca });
    expect((await authenticate(peer)).success).toBe(true);
    peer.socket.send(serialize(createHello('owned TLS test', '1.0.0')));
    expect((await receive(peer, 'hello_ack')).sessionId).toBeTruthy();
    const request = createSessionListRequest();
    peer.socket.send(serialize(request));
    expect((await receive(peer, 'session_list_response')).requestId).toBe(request.id);
    expect(connected).toBe(1);
    expect(server.allConnections[0]?.connectionClientFingerprint).toBe(known.fingerprint);
    expect(server.allConnections[0]?.connectionPeerAddress).toBe(HOST);
  });

  test('TLS leaves bare loopback challenged and a signed unknown key pending/refused', async () => {
    let connected = 0;
    const server = await startServer(
      {},
      {
        onClientConnect: () => {
          connected++;
        },
      },
    );
    const bare = await connect(`wss://${HOST}:${server.port}/ws`, { ca });
    await receive(bare, 'auth_challenge');
    expect(server.allConnections[0]?.connectionState).toBe('authenticating');
    expect(bare.messages.some((message) => message.type === 'hello_ack')).toBe(false);
    const stranger = await connect(`wss://${HOST}:${server.port}/ws`, { ca });
    const result = await authenticate(stranger, unknown);
    expect(result.success).toBe(false);
    expect(result.error).toBe('UNKNOWN_KEY');
    await waitFor(() => stranger.socket.readyState === WebSocket.CLOSED);
    expect(store.isAuthorized(unknown.publicKeyRaw, unknown.fingerprint)).toBe(false);
    expect(store.listPendingKeys().map((key) => key.fingerprint)).toEqual([unknown.fingerprint]);
    expect(connected).toBe(0);
  });

  test('actual HTTPS/WSS origins are allowed/refused before capability admission', async () => {
    const notices: string[] = [];
    const server = await startServer({ logFn: (notice) => notices.push(notice) });
    const allowed = await https(server, '/health', { Origin: ALLOWED_ORIGIN });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const refused = await https(server, '/health', { Origin: REFUSED_ORIGIN });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    expect(notices).toHaveLength(1);
    await expect(
      connect(`wss://${HOST}:${server.port}/ws`, {
        ca,
        headers: { Origin: REFUSED_ORIGIN, [CAPABILITY_HEADER]: capabilityToken },
      }),
    ).rejects.toThrow('WebSocket transport refused');
    expect(server.connectionCount).toBe(0);
    const peer = await connect(`wss://${HOST}:${server.port}/ws`, {
      ca,
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect((await authenticate(peer)).success).toBe(true);
    peer.socket.send(serialize(createHello('allowed origin TLS test', '1.0.0')));
    await receive(peer, 'hello_ack');
  });

  test('only the correct capability on actual TCP loopback bypasses signed auth', async () => {
    const server = await startServer();
    for (const token of ['', `${capabilityToken}wrong`]) {
      const headers = { [CAPABILITY_HEADER]: token };
      expect((await (await https(server, '/auth-info', headers)).json()).authRequired).toBe(true);
      const peer = await connect(`wss://${HOST}:${server.port}/ws`, { ca, headers });
      await receive(peer, 'auth_challenge');
      expect(peer.messages.some((message) => message.type === 'hello_ack')).toBe(false);
    }
    const headers = { [CAPABILITY_HEADER]: capabilityToken };
    expect((await (await https(server, '/auth-info', headers)).json()).authRequired).toBe(false);
    const peer = await connect(`wss://${HOST}:${server.port}/ws`, { ca, headers });
    peer.socket.send(serialize(createHello('owned local capability TLS test', '1.0.0')));
    await receive(peer, 'hello_ack');
    expect(peer.messages.some((message) => message.type === 'auth_challenge')).toBe(false);
    const admitted = server.allConnections.find((connection) => connection.isConnected);
    expect(admitted?.connectionPeerAddress).toBe(HOST);
    expect(admitted?.connectionClientFingerprint).toBeNull();
  });

  test('untrusted CA HTTPS/WSS and wrong-host HTTPS fail before handlers', async () => {
    const notices: string[] = [];
    let connected = 0;
    const server = await startServer(
      { logFn: (notice) => notices.push(notice) },
      {
        onClientConnect: () => {
          connected++;
        },
      },
    );
    await expect(
      fetch(`https://${HOST}:${server.port}/health`, {
        headers: { Origin: REFUSED_ORIGIN, Connection: 'close' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    ).rejects.toThrow();
    await expect(
      connect(`wss://${HOST}:${server.port}/ws`, {
        headers: { Origin: REFUSED_ORIGIN },
      }),
    ).rejects.toThrow('WebSocket transport refused');
    await expect(
      fetch(`https://localhost:${server.port}/health`, {
        tls: { ca },
        headers: { Origin: REFUSED_ORIGIN, Connection: 'close' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    ).rejects.toThrow('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(notices).toHaveLength(0);
    expect(connected).toBe(0);
    expect(server.connectionCount).toBe(0);
    // This reaches the same handler with the owned CA and correct IP SAN.
    expect((await https(server, '/health', { Origin: REFUSED_ORIGIN })).status).toBe(403);
    expect(notices).toHaveLength(1);
  });

  test('HTTPS answer relay retains signed-device and actual loopback capability gates', async () => {
    let delivered = 0;
    const server = await startServer(
      {},
      {
        onAnswerRelay: async () => {
          delivered++;
          return 'delivered';
        },
      },
    );
    const body = { sessionId: generateId(), questionId: generateId(), answer: 'yes' };
    const post = (value: unknown, token = '') =>
      fetch(`https://${HOST}:${server.port}/answer`, {
        method: 'POST',
        tls: { ca },
        body: JSON.stringify(value),
        headers: {
          'Content-Type': 'application/json',
          Connection: 'close',
          [CAPABILITY_HEADER]: token,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    expect((await post(body)).status).toBe(401);
    expect((await post(body, `${capabilityToken}wrong`)).status).toBe(401);
    expect(delivered).toBe(0);
    const signed = async (identity: UnlockedIdentity) => ({
      ...body,
      auth: {
        clientPublicKey: identity.publicKeyRaw,
        clientFingerprint: identity.fingerprint,
        signature: await sign(
          identity.privateKey,
          new TextEncoder().encode(`${body.sessionId}|${body.questionId}|${body.answer}`).buffer,
        ),
      },
    });
    expect((await post(await signed(unknown))).status).toBe(401);
    expect(delivered).toBe(0);
    expect(await (await post(await signed(known))).json()).toEqual({ result: 'delivered' });
    expect(await (await post(body, capabilityToken)).json()).toEqual({ result: 'delivered' });
    expect(delivered).toBe(2);
  });

  test('a TLS port refuses plaintext HTTP and WS without a fallback listener', async () => {
    const server = await startServer();
    await expect(
      fetch(`http://${HOST}:${server.port}/health`, {
        headers: { Connection: 'close' },
      }),
    ).rejects.toThrow();
    await expect(connect(`ws://${HOST}:${server.port}/ws`)).rejects.toThrow(
      'WebSocket transport refused',
    );
    expect(server.connectionCount).toBe(0);
    expect((await https(server, '/health')).status).toBe(200);
  });

  test('real adapter forwards TLS, auth and domain events, then stops and restarts', async () => {
    const port = await reserveRange(1, 50, HOST);
    const adapter = new WebSocketAdapter(
      { port, host: HOST, tls, authenticator },
      {
        onConnect: (id) => {
          adapter.sendRaw(id, createHelloAck('test', null));
        },
        onSessionListRequest: (id, requestId) => {
          adapter.sendRaw(id, createSessionListResponse([], requestId));
        },
      },
    );
    owners.push(adapter);
    await adapter.start();
    expect(adapter.isRunning).toBe(true);
    await expect(adapter.start()).rejects.toThrow('already running');
    expect((await fetch(`https://${HOST}:${port}/health`, { tls: { ca } })).status).toBe(200);
    const peer = await connect(`wss://${HOST}:${port}/ws`, { ca });
    expect((await authenticate(peer)).success).toBe(true);
    peer.socket.send(serialize(createHello('adapter TLS test', '1.0.0')));
    await receive(peer, 'hello_ack');
    const request = createSessionListRequest();
    peer.socket.send(serialize(request));
    expect((await receive(peer, 'session_list_response')).requestId).toBe(request.id);
    expect(adapter.connectionCount).toBe(1);
    await adapter.stop();
    await waitFor(() => peer.socket.readyState === WebSocket.CLOSED);
    expect(adapter.isRunning).toBe(false);
    expect(adapter.connectionCount).toBe(0);
    await adapter.stop();
    await adapter.start();
    expect((await fetch(`https://${HOST}:${port}/health`, { tls: { ca } })).status).toBe(200);
  });

  test('TLS server retains repeated-start, socket cleanup and stop/restart behavior', async () => {
    let starts = 0;
    let stops = 0;
    const server = await startServer(
      {},
      {
        onStart: () => {
          starts++;
        },
        onStop: () => {
          stops++;
        },
      },
    );
    await expect(server.start()).rejects.toThrow('already running');
    const peer = await connect(`wss://${HOST}:${server.port}/ws`, { ca });
    expect((await authenticate(peer)).success).toBe(true);
    peer.socket.send(serialize(createHello('lifetime TLS test', '1.0.0')));
    await receive(peer, 'hello_ack');
    const port = server.port;
    await server.stop();
    await waitFor(() => peer.socket.readyState === WebSocket.CLOSED);
    expect(server.running).toBe(false);
    expect(server.connectionCount).toBe(0);
    await expect(fetch(`https://${HOST}:${port}/health`, { tls: { ca } })).rejects.toThrow();
    await server.stop();
    await server.start();
    expect((await https(server, '/health')).status).toBe(200);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
  });

  for (const name of [
    'empty',
    'empty key',
    'empty cert',
    'invalid key',
    'invalid cert',
    'mismatched',
  ] as const) {
    test(`${name} PEM fails server startup without a plaintext fallback`, async () => {
      const invalid = {
        empty: { key: '', cert: '' },
        'empty key': { key: '', cert: tls.cert },
        'empty cert': { key: tls.key, cert: '' },
        'invalid key': { key: 'invalid', cert: tls.cert },
        'invalid cert': { key: tls.key, cert: 'invalid' },
        mismatched: { key: otherKey, cert: tls.cert },
      }[name];
      const port = await reserveRange(1, 50, HOST);
      let starts = 0;
      const server = new WebSocketServer(
        { port, host: HOST, tls: invalid },
        {
          onStart: () => {
            starts++;
          },
        },
      );
      owners.push(server);
      await expect(server.start()).rejects.toThrow();
      expect(server.running).toBe(false);
      expect(starts).toBe(0);
      await expect(fetch(`http://${HOST}:${port}/health`)).rejects.toThrow();
      await server.stop();
    });
  }

  test('the real adapter propagates invalid TLS startup instead of opening plaintext', async () => {
    const port = await reserveRange(1, 50, HOST);
    const adapter = new WebSocketAdapter({
      port,
      host: HOST,
      tls: { key: otherKey, cert: tls.cert },
    });
    owners.push(adapter);
    await expect(adapter.start()).rejects.toThrow();
    expect(adapter.isRunning).toBe(false);
    await expect(fetch(`http://${HOST}:${port}/health`)).rejects.toThrow();
  });

  test('omitting TLS retains the current HTTP/WS listener', async () => {
    const server = new WebSocketServer({ port: 0, host: HOST, connection: { authenticator } });
    owners.push(server);
    await server.start();
    expect((await fetch(`http://${HOST}:${server.port}/health`)).status).toBe(200);
    const peer = await connect(`ws://${HOST}:${server.port}/ws`);
    expect((await authenticate(peer)).success).toBe(true);
    peer.socket.send(serialize(createHello('plaintext compatibility test', '1.0.0')));
    await receive(peer, 'hello_ack');
  });
});
