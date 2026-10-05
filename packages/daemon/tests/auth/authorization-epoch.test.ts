/** Real authorization files and locks, using fresh synthetic identities and owned subprocesses. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIdentity } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';

let directory: string;
let store: IdentityStore;
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-push-grant-'));
  store = new IdentityStore(directory);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
function records(): { version: number; keys: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(path.join(directory, 'authorized_keys.json'), 'utf8'));
}
function legacyFile(): void {
  const file = records();
  for (const key of file.keys) key['authorizationEpoch'] = undefined;
  fs.writeFileSync(path.join(directory, 'authorized_keys.json'), JSON.stringify(file));
}

test('secure grant epoch: actual add and pending approval persist fresh canonical generations without exposing them as public grants', async () => {
  const first = await createIdentity();
  const second = await createIdentity();
  const added = await store.addAuthorizedKey(first.publicKey, 'synthetic first');
  await store.registerPendingKey(second.publicKey);
  const approved = await store.authorizePendingKey(second.fingerprint, 'synthetic second');
  const epochs = records().keys.map((key) => key['authorizationEpoch']);
  expect(epochs).toHaveLength(2);
  for (const epoch of epochs) {
    expect(epoch).toBeString();
    if (typeof epoch !== 'string') throw new Error('no persisted generation');
    expect(Buffer.from(epoch, 'base64url').length).toBe(32);
    expect(Buffer.from(epoch, 'base64url').toString('base64url')).toBe(epoch);
  }
  expect(epochs[0]).not.toBe(epochs[1]);
  expect('authorizationEpoch' in added).toBe(false);
  expect('authorizationEpoch' in approved).toBe(false);
});

test('secure grant epoch: legacy capture migrates only a present grant and preserves it through touches and another store', async () => {
  const identity = await createIdentity();
  await store.addAuthorizedKey(identity.publicKey, 'synthetic legacy');
  legacyFile();
  const before = records().keys[0];
  const epoch = store.captureAuthorizationEpoch(identity.publicKey);
  expect(epoch).toBeString();
  expect(records().keys[0]).toEqual({ ...before, authorizationEpoch: epoch });
  store.touchAuthorizedKey(identity.fingerprint);
  expect(new IdentityStore(directory).captureAuthorizationEpoch(identity.publicKey)).toBe(epoch);
  expect(store.withAuthorizationEpoch(identity.publicKey, (current) => current)).toBe(epoch);
  const stranger = await createIdentity();
  const bytes = fs.readFileSync(path.join(directory, 'authorized_keys.json'));
  expect(store.captureAuthorizationEpoch(stranger.publicKey)).toBeNull();
  expect(fs.readFileSync(path.join(directory, 'authorized_keys.json'))).toEqual(bytes);
});

test('secure grant epoch: malformed present generations refuse without repair or file replacement', async () => {
  const identity = await createIdentity();
  await store.addAuthorizedKey(identity.publicKey, 'synthetic malformed');
  for (const malformed of [null, 'short', `${'A'.repeat(42)}B`]) {
    const file = records();
    const key = file.keys[0];
    if (!key) throw new Error('missing fixture grant');
    key['authorizationEpoch'] = malformed;
    const bytes = JSON.stringify(file);
    fs.writeFileSync(path.join(directory, 'authorized_keys.json'), bytes);
    expect(() => store.captureAuthorizationEpoch(identity.publicKey)).toThrow(
      'Authorized keys file has invalid records',
    );
    expect(fs.readFileSync(path.join(directory, 'authorized_keys.json'), 'utf8')).toBe(bytes);
  }
});

test('secure grant epoch: revoke and reauthorize the same public key cannot revive a delayed operation', async () => {
  const identity = await createIdentity();
  await store.addAuthorizedKey(identity.publicKey, 'synthetic original');
  const captured = store.captureAuthorizationEpoch(identity.publicKey);
  expect(captured).toBeString();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let effects = 0;
  const delayed = (async () => {
    await wait;
    return store.withAuthorizationEpoch(identity.publicKey, (current) => {
      if (current !== captured) return false;
      effects += 1;
      return true;
    });
  })();
  expect(store.removeAuthorizedKey(identity.fingerprint)).toBe(true);
  expect(store.withAuthorizationEpoch(identity.publicKey, (current) => current)).toBeNull();
  await store.addAuthorizedKey(identity.publicKey, 'synthetic new grant');
  const fresh = store.captureAuthorizationEpoch(identity.publicKey);
  expect(fresh).toBeString();
  expect(fresh).not.toBe(captured);
  release();
  expect(await delayed).toBe(false);
  expect(effects).toBe(0);
});

test('secure grant epoch: two real processes migrate one legacy grant to one durable generation', async () => {
  const identity = await createIdentity();
  await store.addAuthorizedKey(identity.publicKey, 'synthetic concurrent');
  legacyFile();
  const module = new URL('../../src/auth/identity-store.ts', import.meta.url).href;
  const script = `import { IdentityStore } from ${JSON.stringify(module)};
    const store = new IdentityStore(${JSON.stringify(directory)});
    console.log(store.captureAuthorizationEpoch(${JSON.stringify(identity.publicKey)}));`;
  const processes = [0, 1].map(() => {
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    return child;
  });
  const results = await Promise.all(
    processes.map(async (child) => ({
      code: await child.exited,
      value: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    })),
  );
  for (const result of results) {
    expect(result.code).toBe(0);
    expect(result.error).toBe('');
  }
  const current = store.captureAuthorizationEpoch(identity.publicKey);
  if (typeof current !== 'string') throw new Error('missing concurrent generation');
  expect(results[0]?.value.trim()).toBe(current);
  expect(results[1]?.value).toBe(results[0]?.value);
  expect(fs.statSync(path.join(directory, 'authorized_keys.json')).mode & 0o777).toBe(0o600);
  expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
}, 10000);

test('secure grant epoch: a real second process cannot revoke inside the synchronous authority decision', async () => {
  const identity = await createIdentity();
  await store.addAuthorizedKey(identity.publicKey, 'synthetic serialized');
  const captured = store.captureAuthorizationEpoch(identity.publicKey);
  const attempted = path.join(directory, 'attempted');
  const finished = path.join(directory, 'finished');
  const module = new URL('../../src/auth/identity-store.ts', import.meta.url).href;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  store.withAuthorizationEpoch(identity.publicKey, (current) => {
    expect(current).toBe(captured);
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
      if (Date.now() >= deadline) throw new Error('owned revoker did not start');
      Atomics.wait(sleep, 0, 0, 5);
    }
    // Real time and a real competing process; the callback is deliberately
    // held briefly to expose overlap, rather than substituting the lock.
    Atomics.wait(sleep, 0, 0, 100);
    expect(fs.existsSync(finished)).toBe(false);
    expect(store.isAuthorized(identity.publicKey, identity.fingerprint)).toBe(true);
  });
  if (!child) throw new Error('owned revoker was not launched');
  expect(await child.exited).toBe(0);
  if (!(child.stderr instanceof ReadableStream))
    throw new Error('owned revoker has no stderr pipe');
  expect(await new Response(child.stderr).text()).toBe('');
  expect(fs.existsSync(finished)).toBe(true);
  expect(store.captureAuthorizationEpoch(identity.publicKey)).toBeNull();
}, 10000);
