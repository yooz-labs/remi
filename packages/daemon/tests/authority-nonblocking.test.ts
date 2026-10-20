/** Real file ownership and durable epochs for the nonwaiting outbound check (#1224). */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { createIdentity } from '@remi/shared';
import { IdentityStore } from '../src/auth/identity-store.ts';
import { SecurePushStore } from '../src/notifications/secure-push-store.ts';
import { RelayDeviceStore } from '../src/remote/relay-device-store.ts';
import {
  InterprocessFileLockError,
  withInterprocessFileLock,
  withInterprocessFileLockNonblocking,
} from '../src/storage/interprocess-file-lock.ts';

let directory: string;
let file: string;
const children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(tmpdir(), 'remi-authority-nonblocking-'));
  fs.chmodSync(directory, 0o700);
  file = path.join(directory, 'authorized_keys.json');
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    expect(await child.exited).toBe(0);
    if (!(child.stderr instanceof ReadableStream)) throw new Error('OWNED_CHILD_STDERR_MISSING');
    expect(await new Response(child.stderr).text()).toBe('');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('one nonwaiting acquisition refuses a real live writer without running the decision', async () => {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, 'lock-holder-worker.ts'), directory, '2600'],
    { cwd: directory, env: {}, stdout: 'pipe', stderr: 'pipe' },
  );
  children.push(child);
  const deadline = performance.now() + 3000;
  while (!fs.existsSync(path.join(directory, 'lock-held'))) {
    if (child.exitCode !== null || performance.now() >= deadline)
      throw new Error('OWNED_WRITER_DID_NOT_START');
    await Bun.sleep(5);
  }
  const lock = `${file}.lock`;
  const before = fs.readFileSync(lock);
  expect(JSON.parse(before.toString()).pid).toBe(child.pid);
  let invoked = false;
  let failure: unknown;
  const started = performance.now();
  try {
    withInterprocessFileLockNonblocking(file, () => {
      invoked = true;
    });
  } catch (error) {
    failure = error;
  }
  expect(performance.now() - started).toBeLessThan(500);
  expect(failure).toBeInstanceOf(InterprocessFileLockError);
  expect(failure instanceof InterprocessFileLockError && failure.retryable).toBe(true);
  expect(invoked).toBe(false);
  expect(child.exitCode).toBeNull();
  expect(fs.readFileSync(lock)).toEqual(before);
  expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('nonwaiting ownership publishes complete restricted metadata and releases after callback errors', () => {
  const failure = new Error('owned callback failure');
  expect(() =>
    withInterprocessFileLockNonblocking(file, () => {
      expect(fs.existsSync(`${file}.lock`)).toBe(true);
      const owner = JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8'));
      expect(owner.pid).toBe(process.pid);
      expect(typeof owner.ownerId).toBe('string');
      expect(fs.statSync(`${file}.lock`).mode & 0o777).toBe(0o600);
      throw failure;
    }),
  ).toThrow(failure);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
  expect(withInterprocessFileLockNonblocking(file, () => 'current')).toBe('current');
  expect(fs.readdirSync(directory)).toEqual([]);
});

test('release never removes replacement owner metadata', () => {
  withInterprocessFileLockNonblocking(file, () => {
    const lock = `${file}.lock`;
    const previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, JSON.stringify({ ...previous, ownerId: 'owned-replacement' }));
  });
  expect(fs.existsSync(`${file}.lock`)).toBe(true);
  expect(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).ownerId).toBe('owned-replacement');
});

test.each(['stale', 'malformed', 'symlink'])(
  'nonwaiting acquisition refuses %s metadata without recovering or altering it',
  (kind) => {
    const lock = `${file}.lock`;
    if (kind === 'symlink') {
      fs.writeFileSync(file, 'owned target');
      fs.symlinkSync(file, lock);
    } else if (kind === 'malformed') fs.writeFileSync(lock, '{');
    else {
      const old = Date.now() - 60000;
      fs.writeFileSync(
        lock,
        JSON.stringify({
          version: 1,
          ownerId: 'owned-stale',
          pid: 999999,
          host: hostname(),
          acquiredAt: old,
        }),
      );
      fs.utimesSync(lock, new Date(old), new Date(old));
    }
    const before = fs.readFileSync(lock);
    let invoked = false;
    const started = performance.now();
    expect(() =>
      withInterprocessFileLockNonblocking(file, () => {
        invoked = true;
      }),
    ).toThrow(InterprocessFileLockError);
    expect(performance.now() - started).toBeLessThan(500);
    expect(invoked).toBe(false);
    expect(fs.readFileSync(lock)).toEqual(before);
    expect(fs.lstatSync(lock).isSymbolicLink()).toBe(kind === 'symlink');
    expect(
      fs
        .readdirSync(directory)
        .some((name) => name.endsWith('.tmp') || name.includes('.recovery-')),
    ).toBe(false);
  },
);

test('current-only epoch reads never migrate old grant records', async () => {
  const identity = await createIdentity();
  const store = new IdentityStore(directory);
  await store.addAuthorizedKey(identity.publicKey, 'owned');
  const values = JSON.parse(fs.readFileSync(file, 'utf8'));
  values.keys[0].authorizationEpoch = undefined;
  fs.writeFileSync(file, JSON.stringify(values));
  const before = fs.readFileSync(file);
  expect(store.withAuthorizationEpochNonblocking(identity.publicKey, (epoch) => epoch)).toBeNull();
  expect(fs.readFileSync(file)).toEqual(before);
  expect(store.captureAuthorizationEpoch(identity.publicKey)).toBeTypeOf('string');
});

test.each(['grant', 'enrollment'])(
  'captured authority cannot survive a same-key %s replacement',
  async (kind) => {
    const identity = await createIdentity();
    const store = new IdentityStore(directory);
    const devices = new RelayDeviceStore(directory, store);
    const subscriptions = new SecurePushStore(directory, store);
    await store.addAuthorizedKey(identity.publicKey, 'owned');
    await devices.add(identity.publicKey, 'owned');
    const captured = subscriptions.captureAuthority(identity.publicKey);
    if (!captured) throw new Error('MISSING_OWNED_AUTHORITY');
    expect(subscriptions.isCurrentAuthority(captured)).toBe(true);
    if (kind === 'grant') {
      expect(store.removeAuthorizedKey(identity.fingerprint)).toBe(true);
      await store.addAuthorizedKey(identity.publicKey, 'owned');
    } else {
      devices.remove(identity.fingerprint);
      await devices.add(identity.publicKey, 'owned');
    }
    let faulted = false;
    expect(
      subscriptions.isCurrentAuthority(captured, () => {
        faulted = true;
      }),
    ).toBe(false);
    expect(faulted).toBe(false);
    const fresh = subscriptions.captureAuthority(identity.publicKey);
    if (!fresh) throw new Error('MISSING_FRESH_AUTHORITY');
    expect(fresh.authorizationEpoch === captured.authorizationEpoch).toBe(kind !== 'grant');
    expect(fresh.enrollmentEpoch === captured.enrollmentEpoch).toBe(kind !== 'enrollment');
    expect(subscriptions.isCurrentAuthority(fresh)).toBe(true);
  },
);

test('a real waiting writer cannot interleave inside a nonwaiting epoch decision', async () => {
  const identity = await createIdentity();
  const store = new IdentityStore(directory);
  await store.addAuthorizedKey(identity.publicKey, 'owned');
  const captured = store.captureAuthorizationEpoch(identity.publicKey);
  const attempted = path.join(directory, 'attempted');
  const finished = path.join(directory, 'finished');
  const module = new URL('../src/auth/identity-store.ts', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs'; import {IdentityStore} from ${JSON.stringify(module)};
    writeFileSync(${JSON.stringify(attempted)}, '');
    new IdentityStore(${JSON.stringify(directory)}).removeAuthorizedKey(${JSON.stringify(identity.fingerprint)});
    writeFileSync(${JSON.stringify(finished)}, '');`;
  store.withAuthorizationEpochNonblocking(identity.publicKey, (epoch) => {
    expect(epoch).toBe(captured);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: directory,
      env: {},
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 1000;
    while (!fs.existsSync(attempted)) {
      if (performance.now() >= deadline) throw new Error('OWNED_REVOKER_DID_NOT_START');
      Atomics.wait(sleep, 0, 0, 5);
    }
    Atomics.wait(sleep, 0, 0, 100);
    expect(fs.existsSync(finished)).toBe(false);
  });
  const child = children.at(-1);
  if (!child) throw new Error('MISSING_OWNED_REVOKER');
  expect(await child.exited).toBe(0);
  expect(fs.existsSync(finished)).toBe(true);
  expect(store.withAuthorizationEpochNonblocking(identity.publicKey, (epoch) => epoch)).toBeNull();
  expect(withInterprocessFileLock(file, () => 'writer still works')).toBe('writer still works');
});
