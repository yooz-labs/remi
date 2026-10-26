import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, relayV2 } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { NotificationDeviceStore } from '../../src/remote/notification-device-store.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';

let directory: string;
let trust: IdentityStore;
let store: NotificationDeviceStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'remi-notification-scope-'));
  trust = new IdentityStore(directory);
  store = new NotificationDeviceStore(directory, trust);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function enrolled() {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned notification device');
  const epoch = trust.captureAuthorizationEpoch(identity.publicKey);
  if (!epoch) throw new Error('OWNED_GRANT_MISSING');
  const row = await store.add(identity.publicKey, epoch, 'owned notification device');
  return { identity, epoch, row };
}

test('notification enrollment is idempotent and invisible to every legacy full-relay reader', async () => {
  const { identity, epoch, row } = await enrolled();
  expect(await store.add(identity.publicKey, epoch, 'owned notification device')).toEqual(row);
  expect(store.list()).toEqual([row]);
  expect(store.isEnrolled(identity.publicKey)).toBe(true);
  expect(new RelayDeviceStore(directory, trust).isEnrolled(identity.publicKey)).toBe(false);
  expect(existsSync(join(directory, 'relay_devices.json'))).toBe(false);
  expect(existsSync(join(directory, 'secure_push_activation.json'))).toBe(true);
  expect(statSync(join(directory, 'notification_devices.json')).mode & 0o777).toBe(0o600);
});

test('a direct grant is necessary but insufficient, and a regrant cannot revive the old scope', async () => {
  const identity = await createIdentity();
  await expect(store.add(identity.publicKey, 'missing', 'owned')).rejects.toThrow(
    'NOTIFICATION_NOT_AUTHORIZED',
  );
  expect(existsSync(join(directory, 'notification_devices.json'))).toBe(false);
  const { identity: granted, epoch, row } = await enrolled();
  expect(trust.removeAuthorizedKey(granted.fingerprint)).toBe(true);
  expect(store.isEnrolled(granted.publicKey)).toBe(false);
  await trust.addAuthorizedKey(granted.publicKey, 'new grant');
  expect(store.isEnrolled(granted.publicKey)).toBe(false);
  await expect(store.add(granted.publicKey, epoch, 'old request')).rejects.toThrow(
    'NOTIFICATION_NOT_AUTHORIZED',
  );
  const current = trust.captureAuthorizationEpoch(granted.publicKey);
  if (!current) throw new Error('OWNED_GRANT_MISSING');
  expect((await store.add(granted.publicKey, current, 'new request')).enrollmentEpoch).not.toBe(
    row.enrollmentEpoch,
  );
});

test('secure subscription capture and final rechecks retain notification scope epochs', async () => {
  const { identity, row } = await enrolled();
  const subscriptions = new SecurePushStore(directory, trust);
  const authority = subscriptions.captureAuthority(identity.publicKey);
  if (!authority) throw new Error('OWNED_NOTIFICATION_AUTHORITY_MISSING');
  expect(authority.enrollmentEpoch).toBe(row.enrollmentEpoch);
  const pair = await relayV2.generateEcPair();
  expect(
    await subscriptions.register(authority, {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    }),
  ).toEqual({ success: true, keyVersion: 1 });
  const snapshot = subscriptions.listCurrent()[0];
  if (!snapshot) throw new Error('OWNED_SUBSCRIPTION_MISSING');
  expect(subscriptions.withCurrentSubscription(snapshot, () => 'current')).toBe('current');
  store.remove(identity.fingerprint);
  expect(subscriptions.isCurrentAuthority(authority)).toBe(false);
  expect(subscriptions.withCurrentSubscription(snapshot, () => 'must not run')).toBeNull();
});

test('upgrading to full relay enrollment retires a captured notification channel authority', async () => {
  const { identity } = await enrolled();
  const subscriptions = new SecurePushStore(directory, trust);
  const notification = subscriptions.captureAuthority(identity.publicKey);
  if (!notification) throw new Error('OWNED_NOTIFICATION_AUTHORITY_MISSING');
  await new RelayDeviceStore(directory, trust).add(identity.publicKey, 'explicit full enrollment');
  expect(subscriptions.isCurrentAuthority(notification)).toBe(false);
  expect(subscriptions.captureAuthority(identity.publicKey)?.enrollmentEpoch).not.toBe(
    notification.enrollmentEpoch,
  );
});

test('malformed notification storage refuses with a fixed class and no parser text', async () => {
  const { identity } = await enrolled();
  writeFileSync(join(directory, 'notification_devices.json'), 'PRIVATE_PARSER_SENTINEL');
  expect(() => store.isEnrolled(identity.publicKey)).toThrow('NOTIFICATION_STORAGE_ERROR');
  expect(() => new SecurePushStore(directory, trust).captureAuthority(identity.publicKey)).toThrow(
    'NOTIFICATION_STORAGE_ERROR',
  );
});

test('revoked notification generations do not consume the next pairing budget', async () => {
  const old = await enrolled();
  trust.removeAuthorizedKey(old.identity.fingerprint);
  const fresh = await enrolled();
  const rows = JSON.parse(readFileSync(join(directory, 'notification_devices.json'), 'utf8'));
  expect(rows).toHaveLength(1);
  expect(rows[0].publicKey).toBe(fresh.identity.publicKey);
});
