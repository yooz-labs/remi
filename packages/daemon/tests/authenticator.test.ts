/**
 * Tests for Authenticator - server-side challenge-response authentication.
 * All tests use real cryptographic operations.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAuthResponse, createIdentity, fromBase64, sign, unlockIdentity } from '@remi/shared';
import type { UnlockedIdentity } from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-auth-test-'));
}

describe('Authenticator', () => {
  let tmpDir: string;
  let store: IdentityStore;
  let serverIdentity: UnlockedIdentity;
  let authenticator: Authenticator;

  // Client identity for testing
  let clientIdentity: UnlockedIdentity;
  let clientPublicKeyBase64: string;
  let clientFingerprint: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new IdentityStore(tmpDir);

    // Generate server identity (unencrypted for test speed)
    await store.generate();
    serverIdentity = await store.unlock();

    // Generate client identity (unencrypted for test speed)
    const clientIdFile = await createIdentity();
    clientIdentity = await unlockIdentity(clientIdFile);
    clientPublicKeyBase64 = clientIdFile.publicKey;
    clientFingerprint = clientIdFile.fingerprint;

    // Authorize the client
    await store.addAuthorizedKey(clientPublicKeyBase64, 'Test Client');

    authenticator = new Authenticator({
      identity: serverIdentity,
      identityStore: store,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe('createChallenge', () => {
    test('creates a valid auth challenge message', () => {
      const challenge = authenticator.createChallenge('conn-1');
      expect(challenge.type).toBe('auth_challenge');
      expect(typeof challenge.challenge).toBe('string');
      expect(challenge.serverFingerprint).toBe(serverIdentity.fingerprint);
      expect(challenge.serverPublicKey).toBe(serverIdentity.publicKeyRaw);
    });

    test('creates unique challenges per connection', () => {
      const c1 = authenticator.createChallenge('conn-1');
      const c2 = authenticator.createChallenge('conn-2');
      expect(c1.challenge).not.toBe(c2.challenge);
    });
  });

  describe('verifyResponse', () => {
    test('accepts valid response from authorized client', async () => {
      const challenge = authenticator.createChallenge('conn-1');

      // Client signs the challenge
      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(clientIdentity.privateKey, challengeData);

      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);

      const { result } = await authenticator.verifyResponse('conn-1', response);
      expect(result.success).toBe(true);
      expect(result.serverSignature).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    test('rejects unknown client key', async () => {
      const challenge = authenticator.createChallenge('conn-1');

      // Create a different client (not authorized)
      const unknownId = await createIdentity('unknown');
      const unknownUnlocked = await unlockIdentity(unknownId, 'unknown');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownUnlocked.privateKey, challengeData);

      const response = createAuthResponse(unknownId.publicKey, signature, unknownId.fingerprint);

      const { result } = await authenticator.verifyResponse('conn-1', response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNKNOWN_KEY');
    });

    test('rejects invalid signature', async () => {
      const _challenge = authenticator.createChallenge('conn-1');

      // Sign wrong data
      const wrongData = new TextEncoder().encode('wrong data');
      const signature = await sign(clientIdentity.privateKey, wrongData.buffer);

      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);

      const { result } = await authenticator.verifyResponse('conn-1', response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_SIGNATURE');
    });

    test('rejects reused challenge (one-time use)', async () => {
      const challenge = authenticator.createChallenge('conn-1');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(clientIdentity.privateKey, challengeData);

      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);

      // First use succeeds
      const { result: result1 } = await authenticator.verifyResponse('conn-1', response);
      expect(result1.success).toBe(true);

      // Second use fails (challenge consumed)
      const { result: result2 } = await authenticator.verifyResponse('conn-1', response);
      expect(result2.success).toBe(false);
      expect(result2.error).toBe('NO_PENDING_CHALLENGE');
    });

    test('rejects response for wrong connection', async () => {
      authenticator.createChallenge('conn-1');

      const challengeData = fromBase64(authenticator.createChallenge('conn-2').challenge);
      const signature = await sign(clientIdentity.privateKey, challengeData);

      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);

      // Try to use conn-2's response for conn-1 (conn-1's challenge was already consumed by conn-2's creation)
      const { result } = await authenticator.verifyResponse('conn-999', response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('NO_PENDING_CHALLENGE');
    });

    test('updates lastUsedAt on successful auth', async () => {
      const challenge = authenticator.createChallenge('conn-1');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(clientIdentity.privateKey, challengeData);

      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);

      await authenticator.verifyResponse('conn-1', response);

      const keys = store.listAuthorizedKeys();
      expect(keys[0]?.lastUsedAt).not.toBeNull();
    });
  });

  describe('removePendingChallenge', () => {
    test('cleans up pending challenge', async () => {
      authenticator.createChallenge('conn-1');
      authenticator.removePendingChallenge('conn-1');

      const challengeData = new TextEncoder().encode('anything');
      const signature = await sign(clientIdentity.privateKey, challengeData.buffer);

      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);

      const { result } = await authenticator.verifyResponse('conn-1', response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('NO_PENDING_CHALLENGE');
    });
  });

  describe('properties', () => {
    test('serverFingerprint returns identity fingerprint', () => {
      expect(authenticator.serverFingerprint).toBe(serverIdentity.fingerprint);
    });

    test('serverPublicKey returns identity public key', () => {
      expect(authenticator.serverPublicKey).toBe(serverIdentity.publicKeyRaw);
    });
  });

  describe('TOFU (Trust On First Use)', () => {
    let tofuAuthenticator: Authenticator;
    let unknownIdentity: UnlockedIdentity;
    let unknownPublicKeyBase64: string;
    let unknownFingerprint: string;

    beforeEach(async () => {
      // Create authenticator with TOFU enabled
      tofuAuthenticator = new Authenticator({
        identity: serverIdentity,
        identityStore: store,
        tofuMode: 'auto-accept',
      });

      // Create an unknown client (not pre-authorized)
      const unknownId = await createIdentity();
      unknownIdentity = await unlockIdentity(unknownId);
      unknownPublicKeyBase64 = unknownId.publicKey;
      unknownFingerprint = unknownId.fingerprint;
    });

    test('auto-accept mode: unknown client with valid signature is accepted', async () => {
      const challenge = tofuAuthenticator.createChallenge('conn-tofu');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownIdentity.privateKey, challengeData);
      const response = createAuthResponse(unknownPublicKeyBase64, signature, unknownFingerprint);

      const { result } = await tofuAuthenticator.verifyResponse('conn-tofu', response);
      expect(result.success).toBe(true);
      expect(result.serverSignature).toBeDefined();
    });

    test('auto-accept mode: client key is added to authorized keys', async () => {
      const challenge = tofuAuthenticator.createChallenge('conn-tofu');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownIdentity.privateKey, challengeData);
      const response = createAuthResponse(unknownPublicKeyBase64, signature, unknownFingerprint);

      await tofuAuthenticator.verifyResponse('conn-tofu', response);

      // Key should now be in the store
      expect(store.isAuthorized(unknownPublicKeyBase64, unknownFingerprint)).toBe(true);
    });

    test('auto-accept mode: bad signature never triggers TOFU', async () => {
      const _challenge = tofuAuthenticator.createChallenge('conn-tofu');

      // Sign wrong data
      const wrongData = new TextEncoder().encode('wrong data');
      const signature = await sign(unknownIdentity.privateKey, wrongData.buffer);
      const response = createAuthResponse(unknownPublicKeyBase64, signature, unknownFingerprint);

      const { result } = await tofuAuthenticator.verifyResponse('conn-tofu', response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_SIGNATURE');

      // Key should NOT be added
      expect(store.isAuthorized(unknownPublicKeyBase64, unknownFingerprint)).toBe(false);
    });

    test('reject mode: unknown client is rejected even with valid signature', async () => {
      const rejectAuthenticator = new Authenticator({
        identity: serverIdentity,
        identityStore: store,
        tofuMode: 'reject',
      });

      const challenge = rejectAuthenticator.createChallenge('conn-reject');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownIdentity.privateKey, challengeData);
      const response = createAuthResponse(unknownPublicKeyBase64, signature, unknownFingerprint);

      const { result } = await rejectAuthenticator.verifyResponse('conn-reject', response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNKNOWN_KEY');
    });

    test('already-authorized key does not trigger TOFU', async () => {
      // Pre-authorize the client
      await store.addAuthorizedKey(unknownPublicKeyBase64, 'Pre-Authorized');

      const challenge = tofuAuthenticator.createChallenge('conn-existing');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownIdentity.privateKey, challengeData);
      const response = createAuthResponse(unknownPublicKeyBase64, signature, unknownFingerprint);

      const { result } = await tofuAuthenticator.verifyResponse('conn-existing', response);
      expect(result.success).toBe(true);

      // Should still have just one key entry (not duplicated)
      const keys = store.listAuthorizedKeys();
      const matching = keys.filter((k) => k.fingerprint === unknownFingerprint);
      expect(matching.length).toBe(1);
      expect(matching[0]?.label).toBe('Pre-Authorized');
    });

    test('default TOFU mode is reject', async () => {
      const defaultAuth = new Authenticator({
        identity: serverIdentity,
        identityStore: store,
      });

      const challenge = defaultAuth.createChallenge('conn-default');
      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownIdentity.privateKey, challengeData);
      const response = createAuthResponse(unknownPublicKeyBase64, signature, unknownFingerprint);

      const { result } = await defaultAuth.verifyResponse('conn-default', response);
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNKNOWN_KEY');
    });

    test('auto-accept mode: handles race condition when key is added concurrently', async () => {
      const challenge = tofuAuthenticator.createChallenge('conn-race');

      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownIdentity.privateKey, challengeData);
      const response = createAuthResponse(unknownPublicKeyBase64, signature, unknownFingerprint);

      // Simulate concurrent authorization (another connection added the key first)
      await store.addAuthorizedKey(unknownPublicKeyBase64, 'concurrent-add');

      // TOFU should still succeed (catches DuplicateKeyError)
      const { result } = await tofuAuthenticator.verifyResponse('conn-race', response);
      expect(result.success).toBe(true);
    });
  });
});
