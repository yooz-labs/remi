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
  expect((await auth.verifyResponse('unknown', response)).result.success).toBe(false);
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
