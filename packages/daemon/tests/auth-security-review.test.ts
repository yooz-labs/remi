/** Real adversarial Ed25519 signatures and owned storage; no private-key possession is needed for the identity point. */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAuthResponse,
  createAuthorizedKey,
  createIdentity,
  fingerprint,
  fromBase64,
  sign,
  toBase64,
  unlockIdentity,
} from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore, validatePublicKey } from '../src/auth/identity-store.ts';
import { DEFAULT_CONFIG, applyEnvOverrides } from '../src/config/config.ts';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-auth-review-'));
  dirs.push(dir);
  const store = new IdentityStore(dir);
  const auth = new Authenticator({
    identity: await unlockIdentity(await store.generate()),
    identityStore: store,
  });
  const point = new Uint8Array(32);
  point[0] = 1;
  const signature = new Uint8Array(64);
  signature[0] = 1;
  const publicKey = toBase64(point.buffer);
  const fp = await fingerprint(point.buffer);
  return { dir, store, auth, publicKey, fp, signature: toBase64(signature.buffer) };
}

test('identity-point forgery never reaches pending, explicit grants, or detached/legacy admission', async () => {
  const { dir, store, auth, publicKey, fp, signature } = await setup();
  auth.createChallenge('unknown');
  const response = createAuthResponse(publicKey, signature, fp);
  expect((await auth.verifyResponse('unknown', response)).result).toMatchObject({
    success: false,
    error: 'INVALID_KEY_DATA',
  });
  expect(store.listPendingKeys()).toHaveLength(0);
  await expect(validatePublicKey(publicKey)).rejects.toThrow('small-order');
  await expect(store.addAuthorizedKey(publicKey, 'forged')).rejects.toThrow('small-order');
  await expect(store.registerPendingKey(publicKey)).rejects.toThrow('small-order');
  const old = await createAuthorizedKey(publicKey, 'legacy');
  fs.writeFileSync(
    path.join(dir, 'authorized_keys.json'),
    JSON.stringify({ version: 1, keys: [old] }),
  );
  const unchanged = fs.readFileSync(path.join(dir, 'authorized_keys.json'), 'utf8');
  auth.createChallenge('legacy');
  expect((await auth.verifyResponse('legacy', response)).result.success).toBe(false);
  expect(await auth.verifyDetachedRequest('private answer', signature, publicKey, fp)).toBe(false);
  expect(fs.readFileSync(path.join(dir, 'authorized_keys.json'), 'utf8')).toBe(unchanged);
  const normal = await createIdentity();
  await store.addAuthorizedKey(normal.publicKey, 'normal');
  expect(store.isAuthorized(normal.publicKey, normal.fingerprint)).toBe(true);
});

test('null and other malformed runtime auth enum values fail at the production config boundary', () => {
  for (const enabled of [null, undefined, 0, 1, '', 'false', [], {}, ['auto']]) {
    expect(() =>
      applyEnvOverrides({ ...DEFAULT_CONFIG, auth: { enabled: enabled as never } }),
    ).toThrow('auth.enabled');
  }
});

test('all fourteen independently checked shared encodings are refused before any new pending/import grant', async () => {
  const { dir, store, auth } = await setup();
  // The independent arithmetic test proves this reviewed list is exactly the torsion encodings.
  // Enumerate the single shared source here instead of maintaining a competing blacklist.
  const source = fs.readFileSync(
    path.resolve(import.meta.dir, '../../shared/src/relay/small-order.ts'),
    'utf8',
  );
  const encodings = [...source.matchAll(/'([0-9a-f]{64})'/g)].map((match) => match[1] as string);
  expect(encodings).toHaveLength(14);
  for (const hex of encodings) {
    const publicKey = Buffer.from(hex, 'hex').toString('base64');
    await expect(validatePublicKey(publicKey)).rejects.toThrow('small-order');
    await expect(store.registerPendingKey(publicKey)).rejects.toThrow('small-order');
    await expect(store.addAuthorizedKey(publicKey, 'low-order')).rejects.toThrow('small-order');
  }
  expect(store.listPendingKeys()).toHaveLength(0);
  expect(store.listAuthorizedKeys()).toHaveLength(0);
  const keys = await Promise.all(
    encodings.map((hex) =>
      createAuthorizedKey(Buffer.from(hex, 'hex').toString('base64'), 'legacy'),
    ),
  );
  fs.writeFileSync(path.join(dir, 'authorized_keys.json'), JSON.stringify({ version: 1, keys }));
  const normal = await unlockIdentity(await createIdentity());
  await store.registerPendingKey(normal.publicKeyRaw);
  await store.authorizePendingKey(normal.fingerprint, 'normal');
  const challenge = auth.createChallenge('normal');
  const signature = await sign(normal.privateKey, fromBase64(challenge.challenge));
  expect(
    (
      await auth.verifyResponse(
        'normal',
        createAuthResponse(normal.publicKeyRaw, signature, normal.fingerprint),
      )
    ).result.success,
  ).toBe(true);
  expect(store.listAuthorizedKeys()).toHaveLength(15);
});

test('a legacy low-order pending candidate cannot be locally approved or silently removed', async () => {
  const { dir, store, publicKey, fp } = await setup();
  const now = Date.now();
  const pendingPath = path.join(dir, 'pending_keys.json');
  const source = JSON.stringify({
    version: 1,
    keys: [
      {
        publicKey,
        fingerprint: fp,
        firstSeenAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600000).toISOString(),
      },
    ],
  });
  fs.writeFileSync(pendingPath, source);
  await expect(store.authorizePendingKey(fp, 'forged')).rejects.toThrow('small-order');
  expect(fs.readFileSync(pendingPath, 'utf8')).toBe(source);
  expect(store.listAuthorizedKeys()).toHaveLength(0);
});
