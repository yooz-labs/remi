/**
 * Real HTTPS/WSS listener and adapter controls (#1170), using an owned OpenSSL
 * CA and native Bun sockets. This is daemon transport coverage, not shipping
 * browser/native client or device acceptance. Wrong-host validation is checked
 * with HTTPS: Bun 1.3.11's native WebSocket does not enforce it reliably.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { HubRelay } from '../../src/remote/hub-relay.ts';
import {
  type ServerConfig,
  type ServerEvents,
  WebSocketServer,
} from '../../src/server/websocket-server.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import {
  type LocalDaemonEndpoint,
  publishLocalDaemonEndpoint,
  readLocalDaemonEndpoint,
  releaseLocalDaemonEndpoint,
} from '../../src/storage/local-daemon-endpoints.ts';
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
  readonly raw: string[];
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
    const peer = { socket, messages: [] as ProtocolMessage[], raw: [] as string[] };
    peers.push(peer);
    let failed = false;
    socket.onerror = () => {
      failed = true;
    };
    socket.onmessage = (event) => {
      peer.raw.push(String(event.data));
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

  function controlHome(): string {
    return join(directory, `control-${randomUUID()}`);
  }

  function record(publicPort: number, home: string): LocalDaemonEndpoint {
    const result = readLocalDaemonEndpoint(publicPort, { home, expectedPid: process.pid });
    if (result.kind !== 'found') throw new Error(`Local endpoint ${result.kind}`);
    return result.endpoint;
  }

  function localFetch(port: number, path: string, init: RequestInit = {}) {
    return fetch(`http://${HOST}:${port}${path}`, {
      ...init,
      headers: { Connection: 'close', ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  test('synchronous publication precedes early public/private requests and duplicate server start', async () => {
    const home = controlHome();
    const server = new WebSocketServer({
      port: 0,
      host: HOST,
      tls,
      localControl: { home },
      capabilityToken,
    });
    owners.push(server);
    const starting = server.start();
    const endpoint = record(server.port, home);
    expect(server.running).toBe(true);
    const early = Promise.all([
      https(server, '/health'),
      localFetch(endpoint.privatePort, '/health', {
        headers: { [CAPABILITY_HEADER]: capabilityToken },
      }),
    ]);
    await expect(server.start()).rejects.toThrow('already running');
    await starting;
    expect((await early).map((response) => response.status)).toEqual([200, 200]);
    expect(record(server.port, home)).toEqual(endpoint);
  });

  test('local control publishes before public onStart and shares real public/private domain output', async () => {
    const home = controlHome();
    let started = false;
    const server = new WebSocketServer(
      {
        port: 0,
        host: HOST,
        tls,
        localControl: { home },
        capabilityToken,
        connection: { authenticator },
      },
      {
        onStart: (port) => {
          expect(server.running).toBe(true);
          expect(server.localControlPort).toBe(record(port, home).privatePort);
          started = true;
        },
        onSessionListRequest: (id, requestId) => {
          server.sendTo(id, createSessionListResponse([], requestId, [server.port]));
        },
      },
    );
    owners.push(server);
    await server.start();
    expect(started).toBe(true);
    const endpoint = record(server.port, home);
    expect(endpoint.publicPort).toBe(server.port);
    expect(endpoint.privatePort).not.toBe(server.port);
    expect((await https(server, '/health')).status).toBe(200);
    expect(
      (
        await localFetch(endpoint.privatePort, '/health', {
          headers: { [CAPABILITY_HEADER]: capabilityToken },
        })
      ).status,
    ).toBe(200);
    const publicPeer = await connect(`wss://${HOST}:${server.port}/ws`, { ca });
    expect((await authenticate(publicPeer)).success).toBe(true);
    const privatePeer = await connect(`ws://${HOST}:${endpoint.privatePort}/ws`, {
      headers: { [CAPABILITY_HEADER]: capabilityToken },
    });
    for (const peer of [publicPeer, privatePeer]) {
      peer.socket.send(serialize(createHello('dual listener test', '1.0.0')));
      await receive(peer, 'hello_ack');
      peer.socket.send(serialize(createSessionListRequest()));
      expect((await receive(peer, 'session_list_response')).daemonPorts).toEqual([server.port]);
      for (const message of peer.messages) {
        expect(Object.keys(message)).not.toContain('privatePort');
        expect(Object.keys(message)).not.toContain('localControlPort');
        expect(Object.values(message)).not.toContain(endpoint.privatePort);
      }
    }
    expect(privatePeer.messages.some((message) => message.type === 'auth_challenge')).toBe(false);
    expect(server.connectionCount).toBe(2);
    await server.stop();
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'absent' });
    expect(server.localControlPort).toBeNull();
  });

  test('all private HTTP/WS routes require capability even with signed identity or public auth off', async () => {
    const body = { sessionId: generateId(), questionId: generateId(), answer: 'yes' };
    const signed = {
      ...body,
      auth: {
        clientPublicKey: known.publicKeyRaw,
        clientFingerprint: known.fingerprint,
        signature: await sign(
          known.privateKey,
          new TextEncoder().encode(`${body.sessionId}|${body.questionId}|${body.answer}`).buffer,
        ),
      },
    };
    for (const auth of [true, false]) {
      const home = controlHome();
      const notices: string[] = [];
      let delivered = 0;
      const server = await startServer(
        {
          localControl: { home },
          connection: auth ? { authenticator } : {},
          logFn: (notice) => notices.push(notice),
        },
        {
          onAnswerRelay: async () => {
            delivered++;
            return 'delivered';
          },
        },
      );
      const port = record(server.port, home).privatePort;
      const routes = ['/health', '/auth-info', '/answer', '/relay-control', '/ws', '/missing'];
      for (const token of ['', `${capabilityToken}wrong`]) {
        const headers = {
          [CAPABILITY_HEADER]: token,
          Host: 'localhost',
          'X-Forwarded-For': '127.0.0.1',
        };
        for (const path of routes)
          expect((await localFetch(port, path, { headers })).status).toBe(403);
        expect((await localFetch(port, '/answer', { method: 'OPTIONS', headers })).status).toBe(
          403,
        );
        expect(
          (
            await localFetch(port, '/answer', {
              method: 'POST',
              headers,
              body: JSON.stringify(signed),
            })
          ).status,
        ).toBe(403);
        await expect(connect(`ws://${HOST}:${port}/ws`, { headers })).rejects.toThrow(
          'WebSocket transport refused',
        );
      }
      expect(server.connectionCount).toBe(0);
      expect(delivered).toBe(0);
      const hostile = await localFetch(port, '/health', { headers: { Origin: REFUSED_ORIGIN } });
      expect(hostile.status).toBe(403);
      expect(await hostile.text()).toBe('Forbidden origin');
      expect(notices).toHaveLength(1);
      const headers = { [CAPABILITY_HEADER]: capabilityToken };
      expect((await localFetch(port, '/health', { headers })).status).toBe(200);
      expect((await (await localFetch(port, '/auth-info', { headers })).json()).authRequired).toBe(
        false,
      );
      expect((await localFetch(port, '/answer', { method: 'OPTIONS', headers })).status).toBe(204);
      expect(
        (await localFetch(port, '/answer', { method: 'POST', headers, body: JSON.stringify(body) }))
          .status,
      ).toBe(200);
      expect((await localFetch(port, '/missing', { headers })).status).toBe(404);
      expect((await localFetch(port, '/ws', { headers })).status).toBe(400);
      expect(delivered).toBe(1);
    }
  });

  test('private relay-control uses the actual HubRelay with capability and refuses bare upgrades', async () => {
    const home = controlHome();
    const relay = new HubRelay({
      relayUrl: 'wss://relay.invalid',
      identity: known,
      trust: store,
      dir: home,
      registry: new SessionRegistryFile(join(home, 'live-sessions')),
    });
    owners.push(relay);
    const server = await startServer({ localControl: { home }, relayControl: relay });
    const port = record(server.port, home).privatePort;
    await expect(connect(`ws://${HOST}:${port}/relay-control`)).rejects.toThrow(
      'WebSocket transport refused',
    );
    const peer = await connect(`ws://${HOST}:${port}/relay-control`, {
      headers: { [CAPABILITY_HEADER]: capabilityToken },
    });
    peer.socket.send(JSON.stringify({ t: 'devices', id: 'owned-local-devices' }));
    await waitFor(() => peer.raw.some((text) => JSON.parse(text).t === 'devices'));
    expect(JSON.parse(peer.raw[0] ?? '')).toEqual({
      t: 'devices',
      id: 'owned-local-devices',
      devices: [],
    });
    expect(server.connectionCount).toBe(0);
  });

  test('public and private WebSocket upgrades share the same connection limit', async () => {
    const home = controlHome();
    const server = await startServer({ localControl: { home }, maxConnections: 1 });
    const port = record(server.port, home).privatePort;
    const local = await connect(`ws://${HOST}:${port}/ws`, {
      headers: { [CAPABILITY_HEADER]: capabilityToken },
    });
    local.socket.send(serialize(createHello('local limit test', '1.0.0')));
    await receive(local, 'hello_ack');
    await expect(connect(`wss://${HOST}:${server.port}/ws`, { ca })).rejects.toThrow(
      'WebSocket transport refused',
    );
    local.socket.close();
    await waitFor(() => server.connectionCount === 0);
    const publicPeer = await connect(`wss://${HOST}:${server.port}/ws`, { ca });
    expect((await authenticate(publicPeer)).success).toBe(true);
    publicPeer.socket.send(serialize(createHello('public limit test', '1.0.0')));
    await receive(publicPeer, 'hello_ack');
    await expect(
      connect(`ws://${HOST}:${port}/ws`, { headers: { [CAPABILITY_HEADER]: capabilityToken } }),
    ).rejects.toThrow('WebSocket transport refused');
    expect(server.connectionCount).toBe(1);
  });

  test('adapter concurrent start and immediate stop cancel only the original instance before restart', async () => {
    const home = controlHome();
    const port = await reserveRange(1, 50, HOST);
    const adapter = new WebSocketAdapter({
      port,
      host: HOST,
      tls,
      localControl: { home },
      capabilityToken,
      authenticator,
    });
    owners.push(adapter);
    const first = adapter.start();
    const firstOutcome = first.then(
      () => 'started',
      (error: Error) => error.message,
    );
    const old = record(port, home);
    expect(adapter.isRunning).toBe(false);
    const duplicate = adapter.start();
    const duplicateOutcome = duplicate.then(
      () => 'started',
      (error: Error) => error.message,
    );
    await adapter.stop();
    expect(readLocalDaemonEndpoint(port, { home })).toEqual({ kind: 'absent' });
    await expect(localFetch(old.privatePort, '/health')).rejects.toThrow();
    const newest = adapter.start();
    await newest;
    const replacement = record(port, home);
    expect(replacement.instanceId).not.toBe(old.instanceId);
    expect(await firstOutcome).toBe('WebSocket adapter start cancelled');
    expect(await duplicateOutcome).toContain('already running');
    expect(adapter.isRunning).toBe(true);
    expect(record(port, home)).toEqual(replacement);
    expect(
      (
        await localFetch(replacement.privatePort, '/health', {
          headers: { [CAPABILITY_HEADER]: capabilityToken },
        })
      ).status,
    ).toBe(200);
    await expect(adapter.start()).rejects.toThrow('already running');
    await adapter.stop();
    await adapter.stop();
    await expect(localFetch(replacement.privatePort, '/health')).rejects.toThrow();
    expect(readLocalDaemonEndpoint(port, { home })).toEqual({ kind: 'absent' });
  });

  test('failed record retirement reports failure but closes both held listeners and allows retry', async () => {
    const home = controlHome();
    const server = await startServer({ localControl: { home } });
    const endpoint = record(server.port, home);
    const file = join(home, 'local-endpoints', `${endpoint.publicPort}.json`);
    writeFileSync(file, '{ corrupt owned record');
    await expect(server.stop()).rejects.toThrow('Local daemon endpoint record operation failed');
    expect(server.running).toBe(false);
    expect(server.localControlPort).toBeNull();
    await expect(
      fetch(`https://${HOST}:${endpoint.publicPort}/health`, {
        tls: { ca },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    ).rejects.toThrow();
    await expect(localFetch(endpoint.privatePort, '/health')).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{ corrupt owned record');
    writeFileSync(file, JSON.stringify(endpoint));
    await server.stop();
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'absent' });
  });

  test('adapter retains a failed retirement owner for an explicit second stop', async () => {
    const home = controlHome();
    const port = await reserveRange(1, 50, HOST);
    const adapter = new WebSocketAdapter({
      port,
      host: HOST,
      tls,
      localControl: { home },
      capabilityToken,
    });
    owners.push(adapter);
    await adapter.start();
    const endpoint = record(port, home);
    const file = join(home, 'local-endpoints', `${port}.json`);
    writeFileSync(file, '{ corrupt owned adapter record');
    await expect(adapter.stop()).rejects.toThrow('Local daemon endpoint record operation failed');
    expect(adapter.isRunning).toBe(false);
    await expect(adapter.start()).rejects.toThrow('already running');
    await expect(fetch(`https://${HOST}:${port}/health`, { tls: { ca } })).rejects.toThrow();
    await expect(localFetch(endpoint.privatePort, '/health')).rejects.toThrow();
    writeFileSync(file, JSON.stringify(endpoint));
    await adapter.stop();
    expect(readLocalDaemonEndpoint(port, { home })).toEqual({ kind: 'absent' });
    await adapter.start();
    expect(adapter.isRunning).toBe(true);
  });

  test('adapter retains a failed startup cleanup owner until the directory fault is repaired', async () => {
    const home = controlHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'local-endpoints'), 'not a directory');
    const port = await reserveRange(1, 50, HOST);
    const adapter = new WebSocketAdapter({
      port,
      host: HOST,
      tls,
      localControl: { home },
      capabilityToken,
    });
    owners.push(adapter);
    await expect(adapter.start()).rejects.toThrow('WebSocket adapter startup cleanup failed');
    expect(adapter.isRunning).toBe(false);
    await expect(adapter.start()).rejects.toThrow('already running');
    await expect(fetch(`https://${HOST}:${port}/health`, { tls: { ca } })).rejects.toThrow();
    rmSync(join(home, 'local-endpoints'));
    await adapter.stop();
    expect(readLocalDaemonEndpoint(port, { home })).toEqual({ kind: 'absent' });
    await adapter.start();
    expect(adapter.isRunning).toBe(true);
    await adapter.stop();
    expect(readLocalDaemonEndpoint(port, { home })).toEqual({ kind: 'absent' });
  });

  test('server retirement preserves a replacement record while closing its own two listeners', async () => {
    const home = controlHome();
    const server = await startServer({ localControl: { home } });
    const endpoint = record(server.port, home);
    releaseLocalDaemonEndpoint(endpoint, home);
    const replacement = { ...endpoint, instanceId: randomUUID() };
    publishLocalDaemonEndpoint(replacement, home);
    await server.stop();
    expect(record(endpoint.publicPort, home)).toEqual(replacement);
    await expect(
      fetch(`https://${HOST}:${endpoint.publicPort}/health`, {
        tls: { ca },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    ).rejects.toThrow();
    await expect(localFetch(endpoint.privatePort, '/health')).rejects.toThrow();
    releaseLocalDaemonEndpoint(replacement, home);
  });

  test('owned record directory fault rolls startup back without onStart or plaintext fallback', async () => {
    const home = controlHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'local-endpoints'), 'not a directory');
    const port = await reserveRange(1, 50, HOST);
    let starts = 0;
    const server = new WebSocketServer(
      { port, host: HOST, tls, localControl: { home }, capabilityToken },
      {
        onStart: () => {
          starts++;
        },
      },
    );
    owners.push(server);
    await expect(server.start()).rejects.toThrow();
    expect(starts).toBe(0);
    expect(server.running).toBe(false);
    expect(server.localControlPort).toBeNull();
    await expect(fetch(`https://${HOST}:${port}/health`, { tls: { ca } })).rejects.toThrow();
    await expect(fetch(`http://${HOST}:${port}/health`)).rejects.toThrow();
    rmSync(join(home, 'local-endpoints'));
    await server.stop();
    await server.start();
    expect(record(port, home).publicPort).toBe(port);
    expect(starts).toBe(1);
  });

  test('a real occupied public port refuses before publishing a private record', async () => {
    const held = Bun.serve({ port: 0, hostname: HOST, fetch: () => new Response('held') });
    const home = controlHome();
    const server = new WebSocketServer({
      port: held.port as number,
      host: HOST,
      tls,
      localControl: { home },
      capabilityToken,
    });
    owners.push(server);
    try {
      await expect(server.start()).rejects.toThrow();
      expect(server.running).toBe(false);
      expect(server.localControlPort).toBeNull();
      expect(existsSync(join(home, 'local-endpoints'))).toBe(false);
    } finally {
      held.stop(true);
    }
  });

  test('a post-publication onStart refusal retires the exact record and closes both listeners', async () => {
    const home = controlHome();
    let endpoint: LocalDaemonEndpoint | undefined;
    const server = new WebSocketServer(
      { port: 0, host: HOST, tls, localControl: { home }, capabilityToken },
      {
        onStart: (port) => {
          endpoint = record(port, home);
          throw new Error('owned start refusal');
        },
      },
    );
    owners.push(server);
    await expect(server.start()).rejects.toThrow('owned start refusal');
    if (!endpoint) throw new Error('Missing published endpoint');
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'absent' });
    expect(server.running).toBe(false);
    await expect(
      fetch(`https://${HOST}:${endpoint.publicPort}/health`, { tls: { ca } }),
    ).rejects.toThrow();
    await expect(localFetch(endpoint.privatePort, '/health')).rejects.toThrow();
  });

  test('local control without TLS or capability is refused before binding', async () => {
    for (const config of [{}, { tls }, { capabilityToken }]) {
      const home = controlHome();
      const server = new WebSocketServer({
        port: 0,
        host: HOST,
        localControl: { home },
        ...config,
      });
      owners.push(server);
      await expect(server.start()).rejects.toThrow(
        'Local control requires TLS and a local capability',
      );
      expect(server.running).toBe(false);
      expect(server.localControlPort).toBeNull();
      expect(existsSync(home)).toBe(false);
    }
  });
});
