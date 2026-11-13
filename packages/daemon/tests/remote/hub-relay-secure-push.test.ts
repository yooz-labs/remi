/** The hub's secure subscription branch over a real READY channel, Worker and stores (#1200). */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PushPreferences, createSecurePushRegisterRequest, relayV2 } from '@remi/shared';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { resumedHub } from './hub-relay-fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
async function start(config: Parameters<typeof resumedHub>[0] = {}) {
  const hub = await resumedHub(config);
  cleanup.push(hub.cleanup);
  const pair = await relayV2.generateEcPair();
  const register = (pushPrefs?: unknown) =>
    hub.exchange(
      createSecurePushRegisterRequest({
        token: 'ab'.repeat(32),
        environment: 'sandbox',
        pushPublicKey: relayV2.b64u(pair.publicKey),
        keyVersion: 1,
        ...(pushPrefs === undefined ? {} : { pushPrefs: pushPrefs as PushPreferences }),
      }),
    );
  const stored = () => new SecurePushStore(hub.dir, hub.trust).listCurrent();
  return { hub, register, stored };
}

for (const [label, prefs, expected] of [
  [
    'a non-boolean value',
    { questions: 'false' },
    { questions: true, turnComplete: true, harnessDenied: true, turnFailed: true },
  ],
  [
    'an unknown key beside a real mute',
    { turnComplete: false, bogus: false },
    { questions: true, turnComplete: false, harnessDenied: true, turnFailed: true },
  ],
  [
    'a string',
    'junk',
    { questions: true, turnComplete: true, harnessDenied: true, turnFailed: true },
  ],
  ['null', null, { questions: true, turnComplete: true, harnessDenied: true, turnFailed: true }],
  ['an array', [], { questions: true, turnComplete: true, harnessDenied: true, turnFailed: true }],
] as const) {
  test(`malformed preferences fail toward delivering: ${label} registers (#1200, B7)`, async () => {
    const { register, stored } = await start();
    expect(await register(prefs)).toMatchObject({
      type: 'secure_push_register_response',
      success: true,
      keyVersion: 1,
    });
    expect(stored()[0]?.pushPrefs).toEqual(expected);
  }, 15000);
}

test('a hub with no secure push sender refuses registration with UNSUPPORTED and stores nothing (#1200, B5)', async () => {
  const { hub, register, stored } = await start({ securePushSender: () => false });
  expect(await register()).toMatchObject({
    type: 'secure_push_register_response',
    success: false,
    error: 'UNSUPPORTED',
  });
  expect(stored()).toEqual([]);
  expect(hub.logs.join('\n')).toContain('Secure push registration refused: no secure push sender');
}, 15000);

test('source hub renews secure leases while connected and on close, then stops renewing', async () => {
  const leaseMs = 6000;
  const { hub, register } = await start({ pushLeaseMs: leaseMs });
  expect(await register()).toMatchObject({ success: true });
  const file = join(hub.dir, 'secure_push_subscriptions.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const recorded = read();
  const epoch = recorded.subscriptions[0].subscriptionEpoch;
  const age = Date.now() - leaseMs / 2;
  recorded.subscriptions[0].lastSeenAt = age;
  writeFileSync(file, JSON.stringify(recorded));
  const deadline = Date.now() + leaseMs / 2;
  while (read().subscriptions[0].lastSeenAt === age && Date.now() < deadline) await Bun.sleep(10);
  const renewed = read().subscriptions[0].lastSeenAt;
  expect(renewed).toBeGreaterThan(age);
  expect(read().subscriptions[0].subscriptionEpoch).toBe(epoch);
  // Force a known old sighting to distinguish the close stamp from the periodic renewal.
  const beforeClose = read();
  beforeClose.subscriptions[0].lastSeenAt = Date.now() - leaseMs / 2;
  writeFileSync(file, JSON.stringify(beforeClose));
  hub.disconnect();
  const closeDeadline = Date.now() + 2000;
  while (hub.relay.connectionCount > 0 && Date.now() < closeDeadline) await Bun.sleep(10);
  expect(hub.relay.connectionCount).toBe(0);
  expect(read().subscriptions[0].lastSeenAt).toBeGreaterThan(
    beforeClose.subscriptions[0].lastSeenAt,
  );
  const disconnected = read();
  disconnected.subscriptions[0].lastSeenAt = Date.now() - leaseMs - 1;
  writeFileSync(file, JSON.stringify(disconnected));
  const sibling = new SecurePushStore(hub.dir, hub.trust, 64, { leaseMs });
  expect(sibling.listCurrent()).toEqual([]);
  expect(read().subscriptions).toHaveLength(1);
}, 15000);

test('sender availability is read per request: registration succeeds once a sender exists (#1200, B5)', async () => {
  let sender = false;
  const { register, stored } = await start({ securePushSender: () => sender });
  expect(await register()).toMatchObject({ success: false, error: 'UNSUPPORTED' });
  sender = true;
  expect(await register()).toMatchObject({ success: true, keyVersion: 1 });
  expect(stored()).toHaveLength(1);
}, 15000);
