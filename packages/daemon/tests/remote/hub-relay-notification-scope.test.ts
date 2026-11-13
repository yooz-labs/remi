/** Actual encrypted peers, HubRelay and local Worker/DO exercise scope at ingress and egress. */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  createError,
  createPing,
  createSecurePushRegisterRequest,
  createSecurePushUnregisterRequest,
  createSessionListRequest,
  relayV2,
  serialize,
} from '@remi/shared';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { resumedHub } from './hub-relay-fixture.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function start() {
  const hub = await resumedHub({}, { notificationOnly: true });
  cleanup.push(hub.cleanup);
  return hub;
}

test('notification-only encrypted channel registers and unregisters without application Hello', async () => {
  const hub = await start();
  const pair = await relayV2.generateEcPair();
  expect(
    await hub.exchange(
      createSecurePushRegisterRequest({
        token: 'ab'.repeat(32),
        environment: 'sandbox',
        pushPublicKey: relayV2.b64u(pair.publicKey),
        keyVersion: 1,
      }),
    ),
  ).toMatchObject({ type: 'secure_push_register_response', success: true });
  expect(new SecurePushStore(hub.dir, hub.trust).listCurrent()).toHaveLength(1);
  expect(await hub.exchange(createSecurePushUnregisterRequest())).toMatchObject({
    type: 'secure_push_unregister_response',
    success: true,
  });
  expect(new SecurePushStore(hub.dir, hub.trust).listCurrent()).toEqual([]);
}, 15000);

test('notification-only channel receives no machine broadcasts, including general errors', async () => {
  const hub = await start();
  hub.relay.broadcast(createError('OWNED_BROADCAST', 'PRIVATE_BROADCAST_SENTINEL'));
  const question = await Bun.file(
    new URL('../../../shared/tests/fixtures/protocol/question.json', import.meta.url),
  ).json();
  hub.relay.broadcast(question);
  expect(await hub.quiet(150)).toBe(true);
}, 15000);

test('new full-relay clients can decline expired renewal without breaking older omitted flags', async () => {
  const hub = await resumedHub({ pushLeaseMs: 1000 });
  cleanup.push(hub.cleanup);
  const pair = await relayV2.generateEcPair();
  const registration = {
    token: 'ab'.repeat(32),
    environment: 'sandbox' as const,
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  };
  expect(await hub.exchange(createSecurePushRegisterRequest(registration))).toMatchObject({
    success: true,
  });
  const file = join(hub.dir, 'secure_push_subscriptions.json');
  const expire = () => {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.subscriptions[0].lastSeenAt = Date.now() - 2000;
    writeFileSync(file, JSON.stringify(data));
  };
  expire();
  expect(
    await hub.exchange({ ...createSecurePushRegisterRequest(registration), renewExpired: false }),
  ).toMatchObject({ success: false, error: 'RENEWAL_REQUIRED' });
  expect(await hub.exchange(createSecurePushRegisterRequest(registration, true))).toMatchObject({
    success: true,
  });
  expire();
  expect(await hub.exchange(createSecurePushRegisterRequest(registration))).toMatchObject({
    success: true,
  });
}, 15000);

test('encrypted notification registration requires explicit consent after inactive expiry', async () => {
  const hub = await resumedHub({ pushLeaseMs: 1000 }, { notificationOnly: true });
  cleanup.push(hub.cleanup);
  const pair = await relayV2.generateEcPair();
  const registration = {
    token: 'ab'.repeat(32),
    environment: 'sandbox' as const,
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  };
  expect(await hub.exchange(createSecurePushRegisterRequest(registration))).toMatchObject({
    success: true,
  });
  const file = join(hub.dir, 'secure_push_subscriptions.json');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  const epoch = stored.subscriptions[0].subscriptionEpoch;
  stored.subscriptions[0].lastSeenAt = Date.now() - 2000;
  writeFileSync(file, JSON.stringify(stored));
  expect(await hub.exchange(createSecurePushRegisterRequest(registration))).toMatchObject({
    success: false,
    error: 'RENEWAL_REQUIRED',
  });
  expect(JSON.parse(readFileSync(file, 'utf8')).subscriptions[0].leaseExpired).toBe(true);
  expect(await hub.exchange(createSecurePushRegisterRequest(registration, true))).toMatchObject({
    success: true,
  });
  expect(JSON.parse(readFileSync(file, 'utf8')).subscriptions[0].subscriptionEpoch).not.toBe(epoch);
}, 15000);

test('authenticated notification RPCs outlive the normal application Hello deadline', async () => {
  const hub = await start();
  await Bun.sleep(10_100);
  const ping = createPing();
  expect(await hub.exchange(ping)).toMatchObject({ type: 'pong', pingId: ping.id });
}, 15000);

test('damaged notification storage does not disable independently authorized full relay peers', async () => {
  const hub = await resumedHub(
    {},
    {
      prepareDirectory: (directory) => {
        writeFileSync(join(directory, 'notification_devices.json'), 'PRIVATE_PARSER_SENTINEL');
      },
    },
  );
  cleanup.push(hub.cleanup);
  expect(hub.logs).toContain(
    'Notification enrollment store unreadable; notification-only admission unavailable',
  );
  const pair = await relayV2.generateEcPair();
  expect(
    await hub.exchange(
      createSecurePushRegisterRequest({
        token: 'ab'.repeat(32),
        environment: 'sandbox',
        pushPublicKey: relayV2.b64u(pair.publicKey),
        keyVersion: 1,
      }),
    ),
  ).toMatchObject({ success: true });
}, 15000);

test('internal dirty-list refresh cannot bypass a notification channel scope', async () => {
  let requests = 0;
  const hub = await resumedHub(
    {},
    {
      notificationOnly: true,
      events: {
        onSessionListRequest: () => {
          requests++;
        },
      },
    },
  );
  cleanup.push(hub.cleanup);
  // Exercise the real callback's target, not an I/O substitute. A future internal
  // caller must not bypass the same scope boundary enforced on protocol ingress.
  const peers = Reflect.get(hub.relay, 'peers') as Map<string, { listDirty: boolean }>;
  const peer = [...peers.values()][0];
  if (!peer) throw new Error('OWNED_NOTIFICATION_PEER_MISSING');
  peer.listDirty = true;
  Reflect.get(hub.relay, 'refreshSessionList').call(hub.relay, peer);
  await Promise.resolve();
  await expect(
    Reflect.get(hub.relay, 'sessionList').call(hub.relay, peer, createSessionListRequest(false)),
  ).rejects.toThrow('NOTIFICATION_SCOPE');
  expect(requests).toBe(0);
  expect(await hub.quiet(100)).toBe(true);
}, 15000);

for (const name of [
  'hello',
  'session_list_request',
  'user_input',
  'answer',
  'create_session_request',
  'transcript_load_request',
  'session_terminal_open',
]) {
  test(`notification-only channel refuses ${name} before any application effect`, async () => {
    const hub = await start();
    const message: ProtocolMessage = await Bun.file(
      new URL(`../../../shared/tests/fixtures/protocol/${name}.json`, import.meta.url),
    ).json();
    await hub.sendApplication(new TextEncoder().encode(serialize(message)));
    const closed = await Promise.race([
      hub.closed,
      Bun.sleep(3000).then(() => {
        throw new Error('NOTIFICATION_SCOPE_CLOSE_DEADLINE');
      }),
    ]);
    expect(closed.code).toBe(relayV2.FAILURE_CLOSE.code);
    expect(new SecurePushStore(hub.dir, hub.trust).listCurrent()).toEqual([]);
  }, 15000);
}
