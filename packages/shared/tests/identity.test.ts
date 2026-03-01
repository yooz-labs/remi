/**
 * Tests for identity management.
 * All tests use real crypto (no mocks).
 */

import { describe, expect, test } from 'bun:test';
import { FINGERPRINT_LENGTH, fromBase64, sign, verify } from '../src/crypto.ts';
import {
  createAuthorizedKey,
  createAuthorizedKeysFile,
  createIdentity,
  deserializeIdentity,
  serializeIdentity,
  unlockIdentity,
} from '../src/identity.ts';
import type { RemiIdentity } from '../src/identity.ts';

// Use fewer PBKDF2 iterations for test speed by creating identity with low iterations
// We test the identity module functions which internally use PBKDF2_ITERATIONS
// For speed, we create identity objects directly with low iterations

async function createTestIdentity(passphrase: string): Promise<RemiIdentity> {
  // Use the real createIdentity (uses 600K iterations)
  // For testing speed, we just accept the latency or test with smaller scope
  return createIdentity(passphrase);
}

describe('createIdentity', () => {
  test('creates a valid identity with all fields', async () => {
    const identity = await createTestIdentity('testpass');

    expect(identity.version).toBe(1);
    expect(typeof identity.publicKey).toBe('string');
    expect(typeof identity.encryptedPrivateKey).toBe('string');
    expect(typeof identity.salt).toBe('string');
    expect(typeof identity.iv).toBe('string');
    expect(identity.iterations).toBe(600_000);
    expect(identity.fingerprint.length).toBe(FINGERPRINT_LENGTH);
    expect(identity.fingerprint).toMatch(/^[0-9a-f]+$/);
    expect(typeof identity.createdAt).toBe('string');
  });

  test('public key is valid base64 of 32 bytes', async () => {
    const identity = await createTestIdentity('pass');
    const raw = fromBase64(identity.publicKey);
    expect(raw.byteLength).toBe(32);
  });
});

describe('unlockIdentity', () => {
  test('unlocks with correct passphrase', async () => {
    const identity = await createTestIdentity('correct');
    const unlocked = await unlockIdentity(identity, 'correct');

    expect(unlocked.publicKey.type).toBe('public');
    expect(unlocked.privateKey.type).toBe('private');
    expect(unlocked.publicKeyRaw).toBe(identity.publicKey);
    expect(unlocked.fingerprint).toBe(identity.fingerprint);
  });

  test('rejects wrong passphrase', async () => {
    const identity = await createTestIdentity('correct');
    await expect(unlockIdentity(identity, 'wrong')).rejects.toThrow();
  });

  test('unlocked key can sign and verify', async () => {
    const identity = await createTestIdentity('mypass');
    const unlocked = await unlockIdentity(identity, 'mypass');

    const data = new TextEncoder().encode('test data');
    const sig = await sign(unlocked.privateKey, data.buffer);
    const valid = await verify(unlocked.publicKey, data.buffer, sig);
    expect(valid).toBe(true);
  });
});

describe('serializeIdentity / deserializeIdentity', () => {
  test('round-trips identity through JSON', async () => {
    const original = await createTestIdentity('pass');
    const json = serializeIdentity(original);
    const deserialized = deserializeIdentity(json);

    expect(deserialized.version).toBe(original.version);
    expect(deserialized.publicKey).toBe(original.publicKey);
    expect(deserialized.encryptedPrivateKey).toBe(original.encryptedPrivateKey);
    expect(deserialized.salt).toBe(original.salt);
    expect(deserialized.iv).toBe(original.iv);
    expect(deserialized.iterations).toBe(original.iterations);
    expect(deserialized.fingerprint).toBe(original.fingerprint);
  });

  test('rejects invalid JSON', () => {
    expect(() => deserializeIdentity('not json')).toThrow();
  });

  test('rejects missing fields', () => {
    expect(() => deserializeIdentity(JSON.stringify({ version: 1 }))).toThrow();
  });

  test('rejects wrong version', () => {
    expect(() =>
      deserializeIdentity(
        JSON.stringify({
          version: 2,
          publicKey: 'x',
          encryptedPrivateKey: 'x',
          salt: 'x',
          iv: 'x',
          iterations: 1000,
          fingerprint: 'x',
          createdAt: 'x',
        }),
      ),
    ).toThrow();
  });

  test('rejects non-object', () => {
    expect(() => deserializeIdentity('"string"')).toThrow();
    expect(() => deserializeIdentity('null')).toThrow();
    expect(() => deserializeIdentity('42')).toThrow();
  });
});

describe('createAuthorizedKey', () => {
  test('creates authorized key from public key', async () => {
    const identity = await createTestIdentity('pass');
    const authKey = await createAuthorizedKey(identity.publicKey, 'Test Device');

    expect(authKey.publicKey).toBe(identity.publicKey);
    expect(authKey.fingerprint).toBe(identity.fingerprint);
    expect(authKey.label).toBe('Test Device');
    expect(authKey.lastUsedAt).toBeNull();
    expect(typeof authKey.addedAt).toBe('string');
  });
});

describe('createAuthorizedKeysFile', () => {
  test('creates empty authorized keys file', () => {
    const file = createAuthorizedKeysFile();
    expect(file.version).toBe(1);
    expect(file.keys).toEqual([]);
  });
});
