/** Real durable subscription leases, sharing the grant/enrollment lock (#1272). */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIdentity, relayV2 } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { withInterprocessFileLock } from '../../src/storage/interprocess-file-lock.ts';

let directory: string;
let trust: IdentityStore;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-secure-lease-'));
  trust = new IdentityStore(directory);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
const store = (leaseMs = 1000) => new SecurePushStore(directory, trust, 64, { leaseMs });
const file = () => path.join(directory, 'secure_push_subscriptions.json');
function read() {
  return JSON.parse(fs.readFileSync(file(), 'utf8'));
}
function seen(value: unknown) {
  const data = read();
  data.subscriptions[0].lastSeenAt = value;
  fs.writeFileSync(file(), JSON.stringify(data));
}
async function registered() {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned lease recipient');
  await new RelayDeviceStore(directory, trust).add(identity.publicKey, 'owned lease recipient');
  const subscriptions = store();
  const authority = subscriptions.captureAuthority(identity.publicKey);
  if (!authority) throw new Error('missing owned authority');
  const pair = await relayV2.generateEcPair();
  const registration = {
    token: 'ab'.repeat(32),
    environment: 'sandbox' as const,
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  };
  expect(await subscriptions.register(authority, registration)).toMatchObject({ success: true });
  const snapshot = subscriptions.listCurrent()[0];
  if (!snapshot) throw new Error('missing owned subscription');
  return { subscriptions, authority, registration, snapshot, identity };
}

test('secure lease expires durably across stores and refuses a previously captured effect', async () => {
  const { subscriptions, snapshot } = await registered();
  expect(read().subscriptions[0].lastSeenAt).toBeGreaterThan(Date.now() - 1000);
  seen(Date.now() - 1001);
  let effects = 0;
  expect(store().withCurrentSubscription(snapshot, () => ++effects)).toBeNull();
  expect(effects).toBe(0);
  expect(read().subscriptions).toHaveLength(1);
  expect(subscriptions.listCurrent()).toEqual([]);
  expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
});

test('secure lease fan-out excludes expiry; zero never expires', async () => {
  await registered();
  seen(1);
  expect(store(0).listCurrent()).toHaveLength(1);
  expect(store().listCurrent()).toEqual([]);
  expect(read().subscriptions).toHaveLength(1);
});

test('secure lease renewal and identical registration preserve the subscription generation', async () => {
  const { subscriptions, authority, registration, snapshot } = await registered();
  seen(Date.now() - 600);
  expect(subscriptions.renew(authority)).toBe(true);
  expect(read().subscriptions[0].lastSeenAt).toBeGreaterThan(Date.now() - 200);
  expect(store().listCurrent()[0]?.subscriptionEpoch).toBe(snapshot.subscriptionEpoch);
  expect(store().withCurrentSubscription(snapshot, () => 'current')).toBe('current');
  seen(Date.now() - 600);
  expect(await subscriptions.register(authority, registration)).toMatchObject({ success: true });
  expect(read().subscriptions[0].lastSeenAt).toBeGreaterThan(Date.now() - 200);
  expect(store().listCurrent()[0]?.subscriptionEpoch).toBe(snapshot.subscriptionEpoch);
});

test('secure lease expiry and unregister cannot be revived by renewal', async () => {
  const { subscriptions, authority, registration, snapshot } = await registered();
  seen(Date.now() - 1001);
  expect(subscriptions.renew(authority)).toBe(false);
  expect(read().subscriptions).toHaveLength(1);
  expect(await subscriptions.register(authority, registration)).toMatchObject({ success: true });
  expect(subscriptions.listCurrent()[0]?.subscriptionEpoch).not.toBe(snapshot.subscriptionEpoch);
  expect(subscriptions.withCurrentSubscription(snapshot, () => 'late')).toBeNull();
  expect(subscriptions.unregister(authority)).toBe(true);
  expect(subscriptions.renew(authority)).toBe(false);
  expect(subscriptions.listCurrent()).toEqual([]);
});

test('secure lease renewal refuses replaced grants and never waits on a contended lock', async () => {
  const { subscriptions, authority, identity, registration } = await registered();
  seen(Date.now() - 600);
  const before = fs.readFileSync(file(), 'utf8');
  withInterprocessFileLock(path.join(directory, 'authorized_keys.json'), () => {
    const started = performance.now();
    expect(() => subscriptions.renew(authority)).toThrow();
    expect(performance.now() - started).toBeLessThan(200);
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });
  trust.removeAuthorizedKey(identity.fingerprint);
  await trust.addAuthorizedKey(identity.publicKey, 'replacement grant');
  const replacement = subscriptions.captureAuthority(identity.publicKey);
  if (!replacement) throw new Error('missing replacement authority');
  expect(await subscriptions.register(replacement, registration)).toMatchObject({ success: true });
  seen(Date.now() - 600);
  const replacementBytes = fs.readFileSync(file(), 'utf8');
  expect(subscriptions.renew(authority)).toBe(false);
  expect(fs.readFileSync(file(), 'utf8')).toBe(replacementBytes);
  await new RelayDeviceStore(directory, trust).add(identity.publicKey, 'replacement enrollment');
  const enrolled = subscriptions.captureAuthority(identity.publicKey);
  if (!enrolled) throw new Error('missing new enrollment');
  expect(await subscriptions.register(enrolled, registration)).toMatchObject({ success: true });
  seen(Date.now() - 600);
  const enrolledBytes = fs.readFileSync(file(), 'utf8');
  expect(subscriptions.renew(replacement)).toBe(false);
  expect(fs.readFileSync(file(), 'utf8')).toBe(enrolledBytes);
});

test('secure lease migrates untimestamped records once and clamps future sightings durably', async () => {
  const { snapshot } = await registered();
  const data = read();
  data.subscriptions[0].lastSeenAt = undefined;
  fs.writeFileSync(file(), JSON.stringify(data));
  expect(store().listCurrent()[0]?.subscriptionEpoch).toBe(snapshot.subscriptionEpoch);
  const migrated = read().subscriptions[0].lastSeenAt;
  expect(migrated).toBeGreaterThan(Date.now() - 200);
  expect(store().listCurrent()).toHaveLength(1);
  expect(read().subscriptions[0].lastSeenAt).toBe(migrated);
  seen(Date.now() + 10_000_000);
  expect(store().listCurrent()).toHaveLength(1);
  expect(read().subscriptions[0].lastSeenAt).toBeLessThanOrEqual(Date.now());
});

test('secure lease malformed timestamps fail closed without rewriting the file', async () => {
  await registered();
  for (const invalid of [null, 'yesterday', -1, 1.5]) {
    seen(invalid);
    const before = fs.readFileSync(file(), 'utf8');
    expect(() => store().listCurrent()).toThrow('SECURE_PUSH_STORE_ERROR');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  }
});

test('secure lease expiry and restart preserve the push-key version floor', async () => {
  const { subscriptions, authority, registration } = await registered();
  const pair = await relayV2.generateEcPair();
  const rotated = { ...registration, pushPublicKey: relayV2.b64u(pair.publicKey), keyVersion: 2 };
  expect(await subscriptions.register(authority, rotated)).toMatchObject({ success: true });
  const snapshot = subscriptions.listCurrent()[0];
  seen(Date.now() - 1001);
  expect(subscriptions.listCurrent()).toEqual([]);
  const restarted = store();
  for (const stale of [registration, { ...registration, keyVersion: 2 }])
    expect(await restarted.register(authority, stale)).toEqual({
      success: false,
      error: 'STALE_KEY_VERSION',
    });
  expect(restarted.listCurrent()).toEqual([]);
  expect(await restarted.register(authority, rotated)).toMatchObject({ success: true });
  expect(restarted.listCurrent()[0]?.subscriptionEpoch).not.toBe(snapshot?.subscriptionEpoch);
});

test('secure lease malformed dormant markers fail closed without repair', async () => {
  await registered();
  for (const invalid of [false, null, 0, 'expired']) {
    const data = read();
    data.subscriptions[0].leaseExpired = invalid;
    fs.writeFileSync(file(), JSON.stringify(data));
    const before = fs.readFileSync(file(), 'utf8');
    expect(() => store().listCurrent()).toThrow('SECURE_PUSH_STORE_ERROR');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  }
});

test('secure dormant epochs cannot revive after a longer lease, disabling expiry or clock rollback', async () => {
  const { subscriptions, authority, registration, snapshot } = await registered();
  seen(Date.now() - 1001);
  expect(subscriptions.withCurrentSubscription(snapshot, () => 'old effect')).toBeNull();
  expect(read().subscriptions[0].leaseExpired).toBe(true);
  for (const leaseMs of [10_000, 0]) {
    expect(store(leaseMs).listCurrent()).toEqual([]);
    expect(store(leaseMs).withCurrentSubscription(snapshot, () => 'revived')).toBeNull();
    expect(store(leaseMs).renew(authority)).toBe(false);
  }
  seen(Date.now() + 10_000_000);
  const restarted = store(10_000);
  expect(restarted.listCurrent()).toEqual([]);
  expect(read().subscriptions[0].leaseExpired).toBe(true);
  expect(await restarted.register(authority, registration)).toMatchObject({ success: true });
  expect(restarted.listCurrent()[0]?.subscriptionEpoch).not.toBe(snapshot.subscriptionEpoch);
  expect(restarted.withCurrentSubscription(snapshot, () => 'late')).toBeNull();
});

test('secure dormant rows retain the physical 64-row bound without evicting key history', async () => {
  const { subscriptions, registration } = await registered();
  // Real keys, enrollments and registrations; no fabricated persisted authority.
  for (let index = 1; index < 64; index++) {
    const identity = await createIdentity();
    await trust.addAuthorizedKey(identity.publicKey, 'owned dormant recipient');
    await new RelayDeviceStore(directory, trust).add(identity.publicKey, 'owned dormant recipient');
    const authority = subscriptions.captureAuthority(identity.publicKey);
    if (!authority) throw new Error('missing dormant authority');
    expect(await subscriptions.register(authority, registration)).toMatchObject({ success: true });
  }
  const data = read();
  for (const row of data.subscriptions) row.lastSeenAt = 1;
  fs.writeFileSync(file(), JSON.stringify(data));
  expect(store().listCurrent()).toEqual([]);
  const extra = await createIdentity();
  await trust.addAuthorizedKey(extra.publicKey, 'owned overflow recipient');
  await new RelayDeviceStore(directory, trust).add(extra.publicKey, 'owned overflow recipient');
  const authority = subscriptions.captureAuthority(extra.publicKey);
  if (!authority) throw new Error('missing overflow authority');
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: false,
    error: 'CAPACITY',
  });
  expect(read().subscriptions).toHaveLength(64);
  expect(store().listCurrent()).toEqual([]);
});

test('secure dormant rows free active capacity but retain their key floor', async () => {
  const { authority, registration } = await registered();
  const subscriptions = new SecurePushStore(directory, trust, 1, { leaseMs: 1000 });
  seen(Date.now() - 1001);
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned active replacement');
  await new RelayDeviceStore(directory, trust).add(identity.publicKey, 'owned active replacement');
  const other = subscriptions.captureAuthority(identity.publicKey);
  if (!other) throw new Error('missing active replacement authority');
  expect(await subscriptions.register(other, registration)).toMatchObject({ success: true });
  expect(read().subscriptions).toHaveLength(2);
  expect(subscriptions.listCurrent()).toHaveLength(1);
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: false,
    error: 'CAPACITY',
  });
  expect(subscriptions.unregister(other)).toBe(true);
  expect(await subscriptions.register(authority, registration)).toMatchObject({ success: true });
});
