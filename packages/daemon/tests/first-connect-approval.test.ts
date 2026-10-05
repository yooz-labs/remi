/** Real Ed25519 identities and isolated durable stores; no harness/model launches. */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAuthResponse, createIdentity, fromBase64, sign, unlockIdentity } from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-approval-'));
  dirs.push(dir);
  const store = new IdentityStore(dir);
  const server = await store.generate();
  const auth = new Authenticator({ identity: await unlockIdentity(server), identityStore: store });
  const client = await createIdentity();
  const unlocked = await unlockIdentity(client);
  async function response(id: string, claim = client.fingerprint, wrong = false) {
    const challenge = auth.createChallenge(id);
    const signature = await sign(
      unlocked.privateKey,
      wrong ? new Uint8Array(32).buffer : fromBase64(challenge.challenge),
    );
    return createAuthResponse(client.publicKey, signature, claim);
  }
  return { dir, store, auth, client, unlocked, response };
}

test('valid unknown stays rejected, persists pending, exact local approval admits only fresh retry', async () => {
  const { dir, store, auth, client, response } = await setup();
  const reply = await response('first');
  expect((await auth.verifyResponse('first', reply)).result.error).toBe('UNKNOWN_KEY');
  const pending = store.listPendingKeys();
  expect(pending).toHaveLength(1);
  expect(pending[0]?.publicKey).toBe(client.publicKey);
  expect(pending[0]?.fingerprint).toBe(client.fingerprint);
  expect(store.listAuthorizedKeys()).toHaveLength(0);
  await store.authorizePendingKey(client.fingerprint, 'Phone');
  expect((await auth.verifyResponse('first', reply)).result.error).toBe('NO_PENDING_CHALLENGE');
  const restarted = new IdentityStore(dir);
  expect(restarted.isAuthorized(client.publicKey, client.fingerprint)).toBe(true);
  expect(restarted.listPendingKeys()).toHaveLength(0);
  expect((await auth.verifyResponse('retry', await response('retry'))).result.success).toBe(true);
});

test('invalid signature, spoofed fingerprint, missing/consumed challenges and detached answers never queue', async () => {
  const { store, auth, client, unlocked, response } = await setup();
  expect(
    (await auth.verifyResponse('bad', await response('bad', client.fingerprint, true))).result
      .error,
  ).toBe('INVALID_SIGNATURE');
  const spoof = await response('spoof', '0000000000000000');
  expect((await auth.verifyResponse('spoof', spoof)).result.error).toBe('FINGERPRINT_MISMATCH');
  expect((await auth.verifyResponse('spoof', spoof)).result.error).toBe('NO_PENDING_CHALLENGE');
  expect((await auth.verifyResponse('missing', spoof)).result.error).toBe('NO_PENDING_CHALLENGE');
  const sig = await sign(unlocked.privateKey, new TextEncoder().encode('answer').buffer);
  expect(
    await auth.verifyDetachedRequest('answer', sig, client.publicKey, client.fingerprint),
  ).toBe(false);
  expect(store.listPendingKeys()).toHaveLength(0);
});

test('pending queue has fixed TTL, bounded capacity, restrictive modes and exact approval', async () => {
  const { dir, store, client } = await setup();
  const first = await store.registerPendingKey(client.publicKey);
  await store.registerPendingKey(client.publicKey);
  expect(store.listPendingKeys()[0]).toEqual(first);
  expect(Date.parse(first.expiresAt) - Date.parse(first.firstSeenAt)).toBe(600_000);
  for (let i = 1; i < 32; i++) await store.registerPendingKey((await createIdentity()).publicKey);
  expect(store.listPendingKeys()).toHaveLength(32);
  await expect(store.registerPendingKey((await createIdentity()).publicKey)).rejects.toThrow(
    'PENDING_QUEUE_FULL',
  );
  await expect(store.authorizePendingKey(client.fingerprint.slice(0, 8), 'prefix')).rejects.toThrow(
    'No unexpired pending key',
  );
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(dir, 'pending_keys.json')).mode & 0o777).toBe(0o600);
  await store.authorizePendingKey(client.fingerprint, 'Phone');
  expect(fs.statSync(path.join(dir, 'authorized_keys.json')).mode & 0o777).toBe(0o600);
});

test('corrupt stores and malformed explicit keys are refused without overwriting', async () => {
  const { dir, store } = await setup();
  await expect(store.addAuthorizedKey('AAAA', 'bad')).rejects.toThrow();
  await expect(store.registerPendingKey('AAAA')).rejects.toThrow();
  fs.writeFileSync(path.join(dir, 'authorized_keys.json'), '{corrupt');
  await expect(
    store.addAuthorizedKey((await createIdentity()).publicKey, 'safe'),
  ).rejects.toThrow();
  expect(fs.readFileSync(path.join(dir, 'authorized_keys.json'), 'utf8')).toBe('{corrupt');
});

test('authorized or pending JSON null and malformed key records fail visibly', async () => {
  const { dir, store, client } = await setup();
  fs.writeFileSync(path.join(dir, 'pending_keys.json'), 'null');
  expect(() => store.listPendingKeys()).toThrow();
  expect(fs.readFileSync(path.join(dir, 'pending_keys.json'), 'utf8')).toBe('null');
  fs.rmSync(path.join(dir, 'pending_keys.json'));
  fs.writeFileSync(path.join(dir, 'authorized_keys.json'), 'null');
  await expect(store.addAuthorizedKey(client.publicKey, 'valid')).rejects.toThrow();
  expect(fs.readFileSync(path.join(dir, 'authorized_keys.json'), 'utf8')).toBe('null');
});

test('malformed and noncanonical challenge keys never create candidates', async () => {
  const { auth, store, client, response } = await setup();
  const valid = await response('malformed');
  expect(
    (await auth.verifyResponse('malformed', { ...valid, clientPublicKey: 'AAAA' })).result.success,
  ).toBe(false);
  const alternative = await response('noncanonical');
  expect(
    (
      await auth.verifyResponse('noncanonical', {
        ...alternative,
        clientPublicKey: client.publicKey.replace(/=$/, ''),
      })
    ).result.success,
  ).toBe(false);
  expect(store.listPendingKeys()).toHaveLength(0);
});

test('revoked key can request approval again but no stale candidate resurrects trust', async () => {
  const { store, auth, client, response } = await setup();
  await auth.verifyResponse('unknown', await response('unknown'));
  await store.addAuthorizedKey(client.publicKey, 'explicit');
  expect(store.removeAuthorizedKey(client.fingerprint)).toBe(true);
  expect(store.listPendingKeys()).toHaveLength(0);
  expect((await auth.verifyResponse('revoked', await response('revoked'))).result.error).toBe(
    'UNKNOWN_KEY',
  );
  expect(store.listPendingKeys()).toHaveLength(1);
  expect(store.isAuthorized(client.publicKey, client.fingerprint)).toBe(false);
});

test('queue capacity and storage errors are explicit unsuccessful handshake refusals', async () => {
  const { dir, store, auth, response } = await setup();
  for (let i = 0; i < 32; i++) await store.registerPendingKey((await createIdentity()).publicKey);
  const full = await auth.verifyResponse('full', await response('full'));
  expect(full.result.success).toBe(false);
  expect(full.result.error).toBe('PENDING_QUEUE_FULL');
  expect(full.verifiedFingerprint).toBeUndefined();
  expect(store.listPendingKeys()).toHaveLength(32);
  fs.writeFileSync(path.join(dir, 'pending_keys.json'), '{corrupt');
  const corrupt = await auth.verifyResponse('store', await response('store'));
  expect(corrupt.result.success).toBe(false);
  expect(corrupt.result.error).toStartWith('AUTH_STORE_ERROR: ');
  expect(corrupt.verifiedFingerprint).toBeUndefined();
  expect(fs.readFileSync(path.join(dir, 'pending_keys.json'), 'utf8')).toBe('{corrupt');
});
