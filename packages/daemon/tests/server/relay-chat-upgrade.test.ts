/** Real loopback upgrades and private enrollment/grant files; no model or owner state. */
import { afterEach, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHello, createIdentity, generateId, serialize } from '@remi/shared';
import { CAPABILITY_HEADER } from '../../src/auth/capability-token';
import { IdentityStore } from '../../src/auth/identity-store';
import { SecurePushStore } from '../../src/notifications/secure-push-store';
import { RelayDeviceStore } from '../../src/remote/relay-device-store';
import type { Connection } from '../../src/server/connection';
import { WebSocketServer } from '../../src/server/websocket-server';
import { findTestPort } from '../integration/hub-test-utils';

const HEADER = 'x-remi-relay-chat';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-chat-upgrade-'));
  const trust = new IdentityStore(root);
  const device = await createIdentity();
  await trust.addAuthorizedKey(device.publicKey, 'owned upgrade');
  await new RelayDeviceStore(root, trust).add(device.publicKey, 'owned upgrade');
  const authority = new SecurePushStore(root, trust).captureAuthority(device.publicKey);
  if (!authority) throw new Error('Actual enrollment authority missing');
  const token = randomBytes(32).toString('hex');
  const port = await findTestPort();
  const connected = Promise.withResolvers<Connection>();
  const server = new WebSocketServer(
    { port, host: '127.0.0.1', capabilityToken: token },
    { onClientConnect: (connection) => connected.resolve(connection) },
  );
  const sockets: WebSocket[] = [];
  cleanup.push(async () => {
    for (const ws of sockets) ws.close();
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  const descriptor = Buffer.from(JSON.stringify(authority)).toString('base64url');
  const open = (headers: Record<string, string>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers } as never);
    sockets.push(ws);
    return ws;
  };
  return { authority, token, descriptor, open, connected };
}

for (const mode of [
  'missing capability',
  'wrong capability',
  'malformed descriptor',
  'extra member',
  'noncanonical descriptor',
] as const) {
  test(`relay descriptor upgrade refuses ${mode}`, async () => {
    const f = await fixture();
    let descriptor = f.descriptor;
    if (mode === 'malformed descriptor') descriptor = 'not-canonical-json';
    if (mode === 'extra member')
      descriptor = Buffer.from(JSON.stringify({ ...f.authority, raw: true })).toString('base64url');
    if (mode === 'noncanonical descriptor') descriptor += '=';
    const ws = f.open({
      [HEADER]: descriptor,
      ...(mode === 'missing capability'
        ? {}
        : {
            [CAPABILITY_HEADER]: mode === 'wrong capability' ? 'wrong' : f.token,
          }),
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve('opened');
      ws.onerror = () => resolve('refused');
    });
    expect(outcome).toBe('refused');
  });
}

test('capability-proved loopback keeps immutable relay authority separate from direct identity', async () => {
  const f = await fixture();
  const ws = f.open({ [HEADER]: f.descriptor, [CAPABILITY_HEADER]: f.token });
  ws.onopen = () => ws.send(serialize(createHello(generateId(), 'owned relay proxy')));
  const connection = await f.connected.promise;
  expect(Reflect.get(connection, 'structuredChatProxyAuthority')).toEqual(f.authority);
  expect(Object.isFrozen(Reflect.get(connection, 'structuredChatProxyAuthority'))).toBe(true);
  expect(connection.connectionClientPublicKey).toBeNull();
  expect(connection.connectionClientFingerprint).toBeNull();
  expect(connection.isConnected).toBe(true);
});
