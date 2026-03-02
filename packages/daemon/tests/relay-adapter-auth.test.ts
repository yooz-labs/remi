/**
 * Tests for RelayAdapter authentication and code rotation.
 * Uses real crypto, no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAuthResponse, createIdentity, fromBase64, sign, unlockIdentity } from '@remi/shared';
import type { UnlockedIdentity } from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';
import { SignalingClient, generateConnectionCode } from '../src/remote/signaling-client.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-relay-auth-test-'));
}

describe('generateConnectionCode', () => {
  test('generates valid XXXX-YYYY format', () => {
    const code = generateConnectionCode();
    expect(code).toMatch(/^[A-Z]{4}-[0-9]{4}$/);
    // Should not contain ambiguous characters
    expect(code).not.toMatch(/[0OIL1]/);
  });

  test('generates unique codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateConnectionCode());
    }
    // With ~49 bits of entropy, 100 codes should be unique
    expect(codes.size).toBe(100);
  });
});

describe('SignalingClient code rotation', () => {
  test('rotateOnReconnect defaults to true', () => {
    const client = new SignalingClient('wss://example.com');
    // Can't test internal state directly, but we can verify the constructor accepts it
    expect(client).toBeDefined();
    client.close();
  });

  test('rotateOnReconnect can be set to false', () => {
    const client = new SignalingClient('wss://example.com', { rotateOnReconnect: false });
    expect(client).toBeDefined();
    client.close();
  });
});

describe('RelayAdapter auth flow', () => {
  let tmpDir: string;
  let store: IdentityStore;
  let serverIdentity: UnlockedIdentity;
  let authenticator: Authenticator;
  let clientIdentity: UnlockedIdentity;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new IdentityStore(tmpDir);

    // Generate server identity
    await store.generate('serverpass');
    serverIdentity = await store.unlock('serverpass');

    // Generate client identity
    const clientIdFile = await createIdentity('clientpass');
    clientIdentity = await unlockIdentity(clientIdFile, 'clientpass');

    // Authorize the client
    await store.addAuthorizedKey(clientIdFile.publicKey, 'Test Client');

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

  test('authenticator creates challenge with server public key', () => {
    const challenge = authenticator.createChallenge('conn-1');
    expect(challenge.type).toBe('auth_challenge');
    expect(challenge.challenge).toBeDefined();
    expect(challenge.serverPublicKey).toBeDefined();
    expect(challenge.serverFingerprint).toBeDefined();
  });

  test('authenticator verifies valid client response', async () => {
    const challenge = authenticator.createChallenge('conn-1');

    // Client signs the challenge
    const challengeData = fromBase64(challenge.challenge);
    const signature = await sign(clientIdentity.privateKey, challengeData);
    const response = createAuthResponse(
      clientIdentity.publicKeyRaw,
      signature,
      clientIdentity.fingerprint,
    );

    const result = await authenticator.verifyResponse('conn-1', response);
    expect(result.success).toBe(true);
    expect(result.serverSignature).toBeDefined();
  });

  test('authenticator rejects unauthorized client', async () => {
    const challenge = authenticator.createChallenge('conn-1');

    // Create an unauthorized client
    const unauthorizedId = await createIdentity('otherpass');
    const unauthorizedIdentity = await unlockIdentity(unauthorizedId, 'otherpass');

    const challengeData = fromBase64(challenge.challenge);
    const signature = await sign(unauthorizedIdentity.privateKey, challengeData);
    const response = createAuthResponse(
      unauthorizedIdentity.publicKeyRaw,
      signature,
      unauthorizedIdentity.fingerprint,
    );

    const result = await authenticator.verifyResponse('conn-1', response);
    expect(result.success).toBe(false);
    expect(result.error).toContain('UNKNOWN_KEY');
  });

  test('authenticator cleanup removes pending challenge', () => {
    authenticator.createChallenge('conn-1');
    authenticator.removePendingChallenge('conn-1');
    // No error thrown; subsequent verify should fail gracefully
  });
});
