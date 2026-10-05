/** Actual relay/auth files; each identity belongs only to this disposable directory. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIdentity } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { withLegacyPushEligibility } from '../../src/storage/secure-push-activation.ts';

let directory: string;
let trust: IdentityStore;
let devices: RelayDeviceStore;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-push-enrollment-'));
  trust = new IdentityStore(directory);
  devices = new RelayDeviceStore(directory, trust);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function rows(): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(directory, 'relay_devices.json'), 'utf8'));
}
function epoch(): string {
  const value = rows()[0]?.['enrollmentEpoch'];
  expect(value).toBeString();
  if (typeof value !== 'string') throw new Error('missing persisted enrollment generation');
  expect(Buffer.from(value, 'base64url')).toHaveLength(32);
  expect(Buffer.from(value, 'base64url').toString('base64url')).toBe(value);
  return value;
}

test('secure enrollment: actual pairing persists activation and fresh private enrollment generations', async () => {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic enrolled');
  const first = await devices.add(identity.publicKey, 'synthetic first');
  const initial = epoch();
  const activated = JSON.parse(
    fs.readFileSync(path.join(directory, 'secure_push_activation.json'), 'utf8'),
  );
  expect(activated).toEqual({ version: 1, activated: true });
  expect('enrollmentEpoch' in first).toBe(false);
  const listed = devices.list()[0];
  if (!listed) throw new Error('missing public enrollment');
  expect('enrollmentEpoch' in listed).toBe(false);
  await devices.add(identity.publicKey, 'synthetic new pairing');
  expect(epoch()).not.toBe(initial);
  expect(fs.statSync(path.join(directory, 'secure_push_activation.json')).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(directory, 'relay_devices.json')).mode & 0o777).toBe(0o600);
});

test('secure enrollment: actual capture lazily migrates only a present authorized old row and remains stable', async () => {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic old enrollment');
  await devices.add(identity.publicKey, 'synthetic old enrollment');
  const old = rows();
  if (!old[0]) throw new Error('missing fixture row');
  old[0]['enrollmentEpoch'] = undefined;
  fs.writeFileSync(path.join(directory, 'relay_devices.json'), JSON.stringify(old));
  const captured = devices.captureEnrollmentEpoch(identity.publicKey);
  expect(captured).toBeString();
  expect(epoch()).toBe(captured);
  expect(new RelayDeviceStore(directory, trust).captureEnrollmentEpoch(identity.publicKey)).toBe(
    captured,
  );
  const stranger = await createIdentity();
  const bytes = fs.readFileSync(path.join(directory, 'relay_devices.json'));
  expect(devices.captureEnrollmentEpoch(stranger.publicKey)).toBeNull();
  expect(fs.readFileSync(path.join(directory, 'relay_devices.json'))).toEqual(bytes);
  trust.removeAuthorizedKey(identity.fingerprint);
  expect(devices.captureEnrollmentEpoch(identity.publicKey)).toBeNull();
  expect(fs.readFileSync(path.join(directory, 'relay_devices.json'))).toEqual(bytes);
});

test('secure enrollment: present malformed generation refuses without repairing the actual file', async () => {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic malformed enrollment');
  await devices.add(identity.publicKey, 'synthetic malformed enrollment');
  for (const malformed of [null, 'short', `${'A'.repeat(42)}B`]) {
    const records = rows();
    if (!records[0]) throw new Error('missing fixture row');
    records[0]['enrollmentEpoch'] = malformed;
    const bytes = JSON.stringify(records);
    fs.writeFileSync(path.join(directory, 'relay_devices.json'), bytes);
    expect(() => devices.list()).toThrow('RELAY_STORAGE_ERROR');
    expect(fs.readFileSync(path.join(directory, 'relay_devices.json'), 'utf8')).toBe(bytes);
  }
});

test('secure enrollment: activation read failure prevents actual pairing persistence', async () => {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic activation failure');
  // A real directory at the file path causes a real read failure, without substituting storage.
  fs.mkdirSync(path.join(directory, 'secure_push_activation.json'));
  await expect(devices.add(identity.publicKey, 'synthetic refused')).rejects.toThrow(
    'SECURE_PUSH_STORE_ERROR',
  );
  expect(fs.existsSync(path.join(directory, 'relay_devices.json'))).toBe(false);
});

test('secure activation: an untouched machine admits one guarded synchronous invocation', () => {
  let effects = 0;
  const actual = withLegacyPushEligibility(directory, () => ++effects);
  expect(actual).toEqual({ allowed: true, result: 1 });
  expect(effects).toBe(1);
  expect(fs.existsSync(path.join(directory, 'secure_push_activation.json'))).toBe(false);
});

test('secure activation: a revoked raw enrollment bootstraps a durable latch and never permits legacy', async () => {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic revoked');
  await devices.add(identity.publicKey, 'synthetic revoked');
  fs.rmSync(path.join(directory, 'secure_push_activation.json'), { force: true });
  trust.removeAuthorizedKey(identity.fingerprint);
  expect(devices.list()).toHaveLength(0);
  let effects = 0;
  expect(withLegacyPushEligibility(directory, () => ++effects)).toEqual({ allowed: false });
  expect(effects).toBe(0);
  expect(
    JSON.parse(fs.readFileSync(path.join(directory, 'secure_push_activation.json'), 'utf8')),
  ).toEqual({ version: 1, activated: true });
  devices.remove(identity.fingerprint);
  expect(withLegacyPushEligibility(directory, () => ++effects)).toEqual({ allowed: false });
  expect(effects).toBe(0);
});

test('secure activation: corrupt activation or raw enrollment refuses without changing bytes', () => {
  let effects = 0;
  for (const name of ['secure_push_activation.json', 'relay_devices.json']) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, '{');
    expect(withLegacyPushEligibility(directory, () => ++effects)).toEqual({ allowed: false });
    expect(effects).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{');
    fs.rmSync(file);
  }
});
