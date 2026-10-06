/** Real authority/subscription files and crypto, with only disposable device identities. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type SecurePushRegistration, createIdentity, relayV2 } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';

let directory: string;
let trust: IdentityStore;
let devices: RelayDeviceStore;
let subscriptions: SecurePushStore;
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-secure-subscriptions-'));
  trust = new IdentityStore(directory);
  devices = new RelayDeviceStore(directory, trust);
  subscriptions = new SecurePushStore(directory, trust);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
async function recipient() {
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic secure recipient');
  await devices.add(identity.publicKey, 'synthetic secure recipient');
  const authority = subscriptions.captureAuthority(identity.publicKey);
  expect(authority).not.toBeNull();
  if (!authority) throw new Error('missing captured secure authority');
  const pair = await relayV2.generateEcPair();
  const registration: SecurePushRegistration = {
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  };
  return { identity, authority, pair, registration };
}
function state() {
  const bytes = fs.readFileSync(path.join(directory, 'secure_push_subscriptions.json'), 'utf8');
  return {
    bytes,
    file: JSON.parse(bytes) as { version: number; subscriptions: Array<Record<string, unknown>> },
  };
}

test('secure subscription: actual registration persists bound private generations and exact idempotence', async () => {
  const { authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const original = subscriptions.listCurrent()[0];
  expect(original).toBeDefined();
  if (!original) throw new Error('missing durable subscription');
  expect(original.authorizationEpoch).toBe(authority.authorizationEpoch);
  expect(original.enrollmentEpoch).toBe(authority.enrollmentEpoch);
  expect(Buffer.from(original.subscriptionEpoch, 'base64url')).toHaveLength(32);
  const bytes = state().bytes;
  expect(
    await subscriptions.register(authority, { ...registration, pushPrefs: { questions: true } }),
  ).toEqual({ success: true, keyVersion: 1 });
  expect(state().bytes).toBe(bytes);
  expect(new SecurePushStore(directory, trust).listCurrent()).toEqual([original]);
  expect(fs.statSync(path.join(directory, 'secure_push_subscriptions.json')).mode & 0o777).toBe(
    0o600,
  );
});

test('secure subscription: token/preferences change rotates generation; lower or conflicting push key version refuses', async () => {
  const { authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const original = subscriptions.listCurrent()[0];
  if (!original) throw new Error('missing durable subscription');
  const changed = { ...registration, token: 'cd'.repeat(32), pushPrefs: { questions: false } };
  expect(await subscriptions.register(authority, changed)).toEqual({
    success: true,
    keyVersion: 1,
  });
  expect(subscriptions.listCurrent()[0]?.subscriptionEpoch).not.toBe(original.subscriptionEpoch);
  const freshKey = await relayV2.generateEcPair();
  expect(
    await subscriptions.register(authority, {
      ...changed,
      pushPublicKey: relayV2.b64u(freshKey.publicKey),
    }),
  ).toEqual({ success: false, error: 'STALE_KEY_VERSION' });
  const rotated = { ...changed, pushPublicKey: relayV2.b64u(freshKey.publicKey), keyVersion: 2 };
  expect(await subscriptions.register(authority, rotated)).toEqual({
    success: true,
    keyVersion: 2,
  });
  expect(await subscriptions.register(authority, changed)).toEqual({
    success: false,
    error: 'STALE_KEY_VERSION',
  });
  expect(subscriptions.listCurrent()[0]?.pushPublicKey).toBe(rotated.pushPublicKey);
});

test('secure subscription: unregister and registration never revive a previously captured send', async () => {
  const { authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const snapshot = subscriptions.listCurrent()[0];
  if (!snapshot) throw new Error('missing durable subscription');
  let effects = 0;
  expect(subscriptions.withCurrentSubscription(snapshot, () => ++effects)).toBe(1);
  expect(subscriptions.unregister(authority)).toBe(true);
  expect(subscriptions.unregister(authority)).toBe(true);
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  expect(subscriptions.withCurrentSubscription(snapshot, () => ++effects)).toBeNull();
  expect(effects).toBe(1);
});

test('secure subscription: durable grant revoke purges recipients and same-key reauthorization cannot revive snapshots', async () => {
  const { identity, authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const snapshot = subscriptions.listCurrent()[0];
  if (!snapshot) throw new Error('missing durable subscription');
  expect(trust.removeAuthorizedKey(identity.fingerprint)).toBe(true);
  expect(state().file.subscriptions).toHaveLength(0);
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic new grant');
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: false,
    error: 'NOT_AUTHORIZED',
  });
  let effects = 0;
  expect(subscriptions.withCurrentSubscription(snapshot, () => ++effects)).toBeNull();
  expect(effects).toBe(0);
});

test('secure subscription: a new real pairing invalidates captured enrollment and old send authority', async () => {
  const { identity, authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const snapshot = subscriptions.listCurrent()[0];
  if (!snapshot) throw new Error('missing durable subscription');
  await devices.add(identity.publicKey, 'synthetic new pairing');
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: false,
    error: 'NOT_ENROLLED',
  });
  let effects = 0;
  expect(subscriptions.withCurrentSubscription(snapshot, () => ++effects)).toBeNull();
  expect(effects).toBe(0);
  expect(subscriptions.listCurrent()).toHaveLength(0);
});

test('secure subscription: strict token/environment/point/preferences refuse without a persisted registration', async () => {
  const { authority, registration } = await recipient();
  for (const invalid of [
    { ...registration, token: 'AB'.repeat(32) },
    { ...registration, token: 'a' },
    { ...registration, token: 'aa'.repeat(257) },
    { ...registration, environment: 'guessed' },
    { ...registration, keyVersion: 0 },
    { ...registration, keyVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...registration, pushPublicKey: relayV2.b64u(new Uint8Array(65).fill(4)) },
    { ...registration, devicePublicKey: authority.publicKey },
  ]) {
    expect(await subscriptions.register(authority, invalid as SecurePushRegistration)).toEqual({
      success: false,
      error: 'INVALID_SUBSCRIPTION',
    });
    expect(fs.existsSync(path.join(directory, 'secure_push_subscriptions.json'))).toBe(false);
  }
});

test('secure subscription: malformed or unknown preferences fail toward delivering, never refuse (#1200, B7)', async () => {
  const { authority, registration } = await recipient();
  const everything = { questions: true, turnComplete: true, harnessDenied: true, turnFailed: true };
  for (const [given, stored] of [
    [{ questions: 'false' }, everything],
    [
      { questions: 0, turnFailed: false },
      { ...everything, turnFailed: false },
    ],
    [
      { bogus: false, harnessDenied: false },
      { ...everything, harnessDenied: false },
    ],
    ['junk', everything],
    [null, everything],
    [[], everything],
  ] as const) {
    expect(
      await subscriptions.register(authority, {
        ...registration,
        pushPrefs: given,
      } as unknown as SecurePushRegistration),
    ).toEqual({ success: true, keyVersion: 1 });
    expect(subscriptions.listCurrent()[0]?.pushPrefs).toEqual(stored);
  }
});

test('secure subscription: real cancellation and stale authority fail after actual crypto preparation', async () => {
  const { identity, authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration, () => false)).toEqual({
    success: false,
    error: 'NOT_AUTHORIZED',
  });
  const pending = subscriptions.register(authority, registration);
  trust.removeAuthorizedKey(identity.fingerprint);
  await trust.addAuthorizedKey(identity.publicKey, 'synthetic replaced during preparation');
  expect(await pending).toEqual({ success: false, error: 'NOT_AUTHORIZED' });
  expect(subscriptions.listCurrent()).toHaveLength(0);
});

test('secure subscription: bounded capacity and corrupt file refuse without evicting or repairing existing state', async () => {
  subscriptions = new SecurePushStore(directory, trust, 1);
  const first = await recipient();
  expect(await subscriptions.register(first.authority, first.registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const before = state().bytes;
  const second = await recipient();
  expect(await subscriptions.register(second.authority, second.registration)).toEqual({
    success: false,
    error: 'CAPACITY',
  });
  expect(state().bytes).toBe(before);
  const file = path.join(directory, 'secure_push_subscriptions.json');
  fs.writeFileSync(file, '{');
  expect(await subscriptions.register(first.authority, first.registration)).toEqual({
    success: false,
    error: 'STORE_ERROR',
  });
  expect(() => subscriptions.listCurrent()).toThrow('SECURE_PUSH_STORE_ERROR');
  expect(fs.readFileSync(file, 'utf8')).toBe('{');
});

test('secure subscription: cleanup failure is visible after durable grant invalidation', async () => {
  const { identity, authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  fs.writeFileSync(path.join(directory, 'secure_push_subscriptions.json'), '{');
  expect(() => trust.removeAuthorizedKey(identity.fingerprint)).toThrow('SECURE_PUSH_STORE_ERROR');
  expect(trust.isAuthorized(identity.publicKey, identity.fingerprint)).toBe(false);
  expect(fs.readFileSync(path.join(directory, 'secure_push_subscriptions.json'), 'utf8')).toBe('{');
});

test('secure subscription: corrupt persisted curve point refuses without changing or returning the stored recipient', async () => {
  const { authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const file = state().file;
  const row = file.subscriptions[0];
  if (!row) throw new Error('missing persisted fixture recipient');
  row['pushPublicKey'] = relayV2.b64u(new Uint8Array(65).fill(4));
  const bytes = JSON.stringify(file);
  fs.writeFileSync(path.join(directory, 'secure_push_subscriptions.json'), bytes);
  expect(() => subscriptions.listCurrent()).toThrow('SECURE_PUSH_STORE_ERROR');
  expect(fs.readFileSync(path.join(directory, 'secure_push_subscriptions.json'), 'utf8')).toBe(
    bytes,
  );
});

test('secure subscription: caller field replacement during real preparation cannot replace the captured registration', async () => {
  const { authority, registration } = await recipient();
  const mutable = { ...registration, pushPrefs: { questions: true } };
  const captured = { ...authority };
  const pending = subscriptions.register(captured, mutable);
  mutable.token = 'ef'.repeat(32);
  mutable.environment = 'production';
  mutable.pushPrefs.questions = false;
  captured.authorizationEpoch = 'A'.repeat(43);
  expect(await pending).toEqual({ success: true, keyVersion: 1 });
  expect(subscriptions.listCurrent()[0]?.token).toBe(registration.token);
  expect(subscriptions.listCurrent()[0]?.environment).toBe('sandbox');
  expect(subscriptions.listCurrent()[0]?.pushPrefs?.questions).toBe(true);
});

test('secure subscription: a snapshot with changed delivery fields cannot enter the actual invocation boundary', async () => {
  const { authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const snapshot = subscriptions.listCurrent()[0];
  if (!snapshot) throw new Error('missing captured subscription');
  const another = await relayV2.generateEcPair();
  let effects = 0;
  for (const changed of [
    { ...snapshot, token: 'ef'.repeat(32) },
    { ...snapshot, environment: 'production' as const },
    { ...snapshot, keyVersion: 2 },
    { ...snapshot, pushPublicKey: relayV2.b64u(another.publicKey) },
    { ...snapshot, pushPrefs: { ...snapshot.pushPrefs, questions: false } },
  ])
    expect(subscriptions.withCurrentSubscription(changed, () => ++effects)).toBeNull();
  expect(effects).toBe(0);
});

test('secure subscription: actual revoke in another process cannot interleave with a current send invocation', async () => {
  const { identity, authority, registration } = await recipient();
  expect(await subscriptions.register(authority, registration)).toEqual({
    success: true,
    keyVersion: 1,
  });
  const snapshot = subscriptions.listCurrent()[0];
  if (!snapshot) throw new Error('missing captured subscription');
  const attempted = path.join(directory, 'revoke-attempted');
  const finished = path.join(directory, 'revoke-finished');
  const module = new URL('../../src/auth/identity-store.ts', import.meta.url).href;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const actual = subscriptions.withCurrentSubscription(snapshot, () => {
    const script = `import { writeFileSync } from 'node:fs';
      import { IdentityStore } from ${JSON.stringify(module)};
      writeFileSync(${JSON.stringify(attempted)}, 'attempted');
      new IdentityStore(${JSON.stringify(directory)}).removeAuthorizedKey(${JSON.stringify(identity.fingerprint)});
      writeFileSync(${JSON.stringify(finished)}, 'finished');`;
    child = Bun.spawn([process.execPath, '-e', script], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 1000;
    while (!fs.existsSync(attempted)) {
      if (Date.now() >= deadline) throw new Error('owned secure revoker did not start');
      Atomics.wait(sleep, 0, 0, 5);
    }
    Atomics.wait(sleep, 0, 0, 100);
    expect(fs.existsSync(finished)).toBe(false);
    expect(trust.isAuthorized(identity.publicKey, identity.fingerprint)).toBe(true);
    return 'invoked-before-revoke';
  });
  expect(actual).toBe('invoked-before-revoke');
  if (!child || !(child.stderr instanceof ReadableStream))
    throw new Error('missing owned secure revoker');
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe('');
  expect(fs.existsSync(finished)).toBe(true);
  expect(subscriptions.withCurrentSubscription(snapshot, () => 'late')).toBeNull();
}, 10000);
