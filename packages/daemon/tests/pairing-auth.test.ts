/**
 * A phone's first connection with a pairing code (#1275, ADR 0037): the authenticator claims the
 * code only after the signature verifies, holds a waiting claim for the person's decision, and
 * answers each dead code with its own error. Real Ed25519 identities and a real, isolated store.
 */
import { afterEach, describe, expect, test } from 'bun:test';
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

async function setup(pairingWaitMs = 400) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pairing-auth-'));
  dirs.push(dir);
  const store = new IdentityStore(dir);
  const server = await store.generate();
  const auth = new Authenticator({
    identity: await unlockIdentity(server),
    identityStore: store,
    pairingWaitMs,
  });
  const client = await createIdentity();
  const unlocked = await unlockIdentity(client);
  async function respondWith(
    id: string,
    pairing: { nonce: string; label?: string } | undefined,
    isOpen: () => boolean,
  ) {
    const challenge = auth.createChallenge(id);
    const signature = await sign(unlocked.privateKey, fromBase64(challenge.challenge));
    return auth.verifyResponse(
      id,
      createAuthResponse(client.publicKey, signature, client.fingerprint, undefined, pairing),
      { isOpen },
    );
  }
  async function respond(id: string, pairing?: { nonce: string; label?: string }, wrong = false) {
    const challenge = auth.createChallenge(id);
    const signature = await sign(
      unlocked.privateKey,
      wrong ? new Uint8Array(32).buffer : fromBase64(challenge.challenge),
    );
    const response = createAuthResponse(
      client.publicKey,
      signature,
      client.fingerprint,
      undefined,
      pairing === undefined ? undefined : { nonce: pairing.nonce, label: pairing.label },
    );
    return auth.verifyResponse(id, response);
  }
  return { store, client, respond, respondWith, dir };
}

describe('pairing on the first connection (#1275)', () => {
  test('a claim approved while it waits is answered with the ordinary success', async () => {
    const { store, client, respond } = await setup(5000);
    const { nonce } = store.createPairing();
    const pending = respond('c1', { nonce, label: 'Sam phone' });
    while (store.readPairing(nonce)?.state !== 'claimed') await Bun.sleep(10);
    await store.approvePairing(nonce, client.fingerprint);
    const outcome = await pending;
    expect(outcome.result.success).toBe(true);
    expect(outcome.result.serverSignature).toBeTruthy();
    expect(outcome.verifiedFingerprint).toBe(client.fingerprint);
    expect(store.listAuthorizedKeys()[0]?.label).toBe('Sam phone');
  });

  test('an undecided claim is PAIRING_PENDING after the wait; a retry after approval succeeds', async () => {
    const { store, client, respond } = await setup(300);
    const { nonce } = store.createPairing();
    const started = Date.now();
    expect((await respond('c1', { nonce })).result.error).toBe('PAIRING_PENDING');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await store.approvePairing(nonce, client.fingerprint);
    expect((await respond('c2', { nonce })).result.success).toBe(true);
  });

  test('a rejection while it waits is PAIRING_REJECTED; a cancellation is PAIRING_CANCELLED', async () => {
    const first = await setup(5000);
    const a = first.store.createPairing();
    const rejected = first.respond('c1', { nonce: a.nonce });
    while (first.store.readPairing(a.nonce)?.state !== 'claimed') await Bun.sleep(10);
    first.store.rejectPairing(a.nonce);
    expect((await rejected).result.error).toBe('PAIRING_REJECTED');

    const second = await setup(5000);
    const b = second.store.createPairing();
    const cancelled = second.respond('c1', { nonce: b.nonce });
    while (second.store.readPairing(b.nonce)?.state !== 'claimed') await Bun.sleep(10);
    second.store.cancelPairing(b.nonce);
    expect((await cancelled).result.error).toBe('PAIRING_CANCELLED');
  });

  test('a code that is not a nonce, one never made, and a bad label are refused before anything is registered', async () => {
    const { store, respond } = await setup();
    const { nonce } = store.createPairing();
    expect((await respond('c1', { nonce: 'short' })).result.error).toBe('PAIRING_MALFORMED');
    expect((await respond('c2', { nonce: 'AAAAAAAAAAAAAAAAAAAAAA' })).result.error).toBe(
      'PAIRING_UNKNOWN',
    );
    for (const label of ['', 'x'.repeat(65), 'a‮b', 'a\nb']) {
      expect((await respond(`l${label.length}`, { nonce, label })).result.error, label).toBe(
        'PAIRING_MALFORMED',
      );
    }
    expect(store.listPendingKeys()).toHaveLength(0);
    expect(store.readPairing(nonce)?.state).toBe('open');
  });

  test('a bad signature never claims the code', async () => {
    const { store, respond } = await setup();
    const { nonce } = store.createPairing();
    expect((await respond('c1', { nonce }, true)).result.error).toBe('INVALID_SIGNATURE');
    expect(store.readPairing(nonce)?.state).toBe('open');
    expect(store.listPendingKeys()).toHaveLength(0);
  });

  test('an authorized key authenticates as always, code or not', async () => {
    const { store, client, respond } = await setup();
    await store.addAuthorizedKey(client.publicKey, 'already');
    const { nonce } = store.createPairing();
    expect((await respond('c1', { nonce })).result.success).toBe(true);
    expect((await respond('c2')).result.success).toBe(true);
  });

  test('a claim waiting while another process holds the lock is still decided (#1281 review)', async () => {
    const { store, client, respond, dir } = await setup(8000);
    const { nonce } = store.createPairing();
    const pending = respond('c1', { nonce });
    while (store.readPairing(nonce)?.state !== 'claimed') await Bun.sleep(10);
    const worker = path.join(import.meta.dir, 'lock-holder-worker.ts');
    const holder = Bun.spawn([process.execPath, worker, dir, '2600'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await holder.exited;
    await store.approvePairing(nonce, client.fingerprint);
    expect((await pending).result.success).toBe(true);
  }, 20000);

  test('a claim whose connection closed stops waiting at once', async () => {
    const { store, respondWith } = await setup(8000);
    const { nonce } = store.createPairing();
    let open = true;
    setTimeout(() => {
      open = false;
    }, 200);
    const started = Date.now();
    const outcome = await respondWith('c1', { nonce }, () => open);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.result.error).toBe('PAIRING_PENDING');
  });

  test('without a code, an unknown key is pending as before (#873)', async () => {
    const { store, respond } = await setup();
    expect((await respond('c1')).result.error).toBe('UNKNOWN_KEY');
    expect(store.listPendingKeys()).toHaveLength(1);
  });

  test('a claim without a label is labeled for what it is', async () => {
    const { store, client, respond } = await setup(5000);
    const { nonce } = store.createPairing();
    const pending = respond('c1', { nonce });
    while (store.readPairing(nonce)?.state !== 'claimed') await Bun.sleep(10);
    expect(store.readPairing(nonce)?.claim?.label).toBe('paired device');
    await store.approvePairing(nonce, client.fingerprint);
    expect((await pending).result.success).toBe(true);
  });
});
