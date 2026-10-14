/** Direct grant removal against real signed clients and held loopback listeners (#1305). */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  type UnlockedIdentity,
  createAuthResponse,
  createHello,
  createIdentity,
  createPong,
  createSessionListRequest,
  createSessionListResponse,
  deserialize,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { CAPABILITY_HEADER } from '../../src/auth/capability-token.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { WebSocketServer } from '../../src/server/websocket-server.ts';

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(5);
  }
}

async function fixture(pingInterval = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), 'remi-revocation-'));
  const store = new IdentityStore(dir);
  await store.generate();
  const identity = await store.unlock();
  const client = await unlockIdentity(await createIdentity());
  await store.addAuthorizedKey(client.publicKeyRaw, 'owned client');
  const authenticator = new Authenticator({ identity, identityStore: store });
  const capability = '0'.repeat(64);
  const queries: string[] = [];
  const disconnects: string[] = [];
  const sockets: WebSocket[] = [];
  const server = new WebSocketServer(
    {
      host: '127.0.0.1',
      port: 0,
      capabilityToken: capability,
      connection: { authenticator, pingInterval },
    },
    {
      onSessionListRequest: (cid, id) => {
        queries.push(id);
        server.sendTo(cid, createSessionListResponse([], id));
      },
      onClientDisconnect: (_cid, reason) => {
        disconnects.push(reason);
      },
    },
  );
  await server.start();
  const connect = async (who: UnlockedIdentity = client, localCapability = false) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws`,
      localCapability ? ({ headers: { [CAPABILITY_HEADER]: capability } } as never) : undefined,
    );
    sockets.push(ws);
    const messages: ProtocolMessage[] = [];
    let tail = Promise.resolve();
    let failure: unknown;
    ws.onmessage = (event) => {
      tail = tail
        .then(async () => {
          const message = deserialize(String(event.data));
          if (!message) throw new Error('OWNED_INVALID_MESSAGE');
          messages.push(message);
          if (message.type === 'auth_challenge')
            ws.send(
              serialize(
                createAuthResponse(
                  who.publicKeyRaw,
                  await sign(who.privateKey, fromBase64(message.challenge)),
                  who.fingerprint,
                ),
              ),
            );
          else if (message.type === 'auth_result' && message.success)
            ws.send(serialize(createHello('revocation-test', '1.0.0')));
          else if (message.type === 'ping' && ws.readyState === WebSocket.OPEN)
            ws.send(serialize(createPong(message.id)));
        })
        .catch((error) => {
          failure = error;
        });
    };
    if (localCapability) {
      await until(() => ws.readyState === WebSocket.OPEN, 'local capability socket');
      ws.send(serialize(createHello('revocation-test', '1.0.0')));
    }
    await until(() => messages.some((message) => message.type === 'hello_ack'), 'signed hello');
    if (failure) throw failure;
    return {
      ws,
      messages,
      settled: async () => {
        await tail;
        if (failure) throw failure;
      },
    };
  };
  return {
    dir,
    store,
    client,
    connect,
    queries,
    disconnects,
    async cleanup() {
      for (const ws of sockets) ws.close();
      try {
        await server.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

for (const stimulus of ['next-frame', 'heartbeat'] as const) {
  test(`removing a grant closes its authenticated ${stimulus} peer (#1305)`, async () => {
    const owned = await fixture(stimulus === 'heartbeat' ? 40 : 60_000);
    try {
      const open = await owned.connect();
      expect(owned.store.removeAuthorizedKey(owned.client.fingerprint)).toBe(true);
      if (stimulus === 'next-frame') open.ws.send(serialize(createSessionListRequest(false)));
      await until(
        () => open.ws.readyState === WebSocket.CLOSED,
        'revoked direct connection closed',
      );
      await open.settled();
      expect(owned.queries).toHaveLength(0);
      expect(owned.disconnects).toEqual(['Device authorization removed; local approval required']);
      expect(
        open.messages.some(
          (message) =>
            message.type === 'error' &&
            message.code === 'CLOSING' &&
            message.message === owned.disconnects[0],
        ),
      ).toBe(true);
    } finally {
      await owned.cleanup();
    }
  }, 10000);
}

test('removing another device keeps the current grant and heartbeat usable (#1305)', async () => {
  const owned = await fixture(40);
  try {
    const other = await unlockIdentity(await createIdentity());
    await owned.store.addAuthorizedKey(other.publicKeyRaw, 'another owned client');
    const open = await owned.connect();
    expect(owned.store.removeAuthorizedKey(other.fingerprint)).toBe(true);
    await Bun.sleep(180);
    const request = createSessionListRequest(false);
    open.ws.send(serialize(request));
    await until(
      () =>
        open.messages.some(
          (message) => message.type === 'session_list_response' && message.requestId === request.id,
        ),
      'authorized peer list',
    );
    expect(owned.queries).toEqual([request.id]);
    expect(owned.disconnects).toHaveLength(0);
    expect(open.ws.readyState).toBe(WebSocket.OPEN);
    await open.settled();
  } finally {
    await owned.cleanup();
  }
}, 10000);

test('an unreadable grant store closes the direct peer with host-free text (#1305)', async () => {
  const owned = await fixture();
  try {
    const open = await owned.connect();
    writeFileSync(join(owned.dir, 'authorized_keys.json'), '{');
    open.ws.send(serialize(createSessionListRequest(false)));
    await until(
      () => open.ws.readyState === WebSocket.CLOSED,
      'unreadable grant connection closed',
    );
    await open.settled();
    expect(owned.queries).toHaveLength(0);
    expect(owned.disconnects).toEqual(['Device authorization unavailable; reconnect required']);
    expect(open.messages.some((message) => JSON.stringify(message).includes(owned.dir))).toBe(
      false,
    );
  } finally {
    await owned.cleanup();
  }
}, 10000);

test('a real loopback capability peer keeps its separate admission after key removal (#1305)', async () => {
  const owned = await fixture(40);
  try {
    const open = await owned.connect(owned.client, true);
    expect(owned.store.removeAuthorizedKey(owned.client.fingerprint)).toBe(true);
    await Bun.sleep(180);
    const request = createSessionListRequest(false);
    open.ws.send(serialize(request));
    await until(
      () =>
        open.messages.some(
          (message) => message.type === 'session_list_response' && message.requestId === request.id,
        ),
      'local capability list',
    );
    expect(open.messages.some((message) => message.type === 'auth_challenge')).toBe(false);
    expect(owned.queries).toEqual([request.id]);
    expect(owned.disconnects).toHaveLength(0);
    await open.settled();
  } finally {
    await owned.cleanup();
  }
}, 10000);
