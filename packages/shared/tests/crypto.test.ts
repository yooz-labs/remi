/**
 * Tests for cross-platform crypto utilities.
 * All tests use real cryptographic operations (no mocks).
 */

import { describe, expect, test } from 'bun:test';
import {
  CHALLENGE_SIZE,
  FINGERPRINT_LENGTH,
  decryptPrivateKey,
  encryptPrivateKey,
  exportKeyPair,
  fingerprint,
  fromBase64,
  generateChallenge,
  generateKeyPair,
  importPrivateKey,
  importPublicKey,
  sign,
  toBase64,
  verify,
} from '../src/crypto.ts';

describe('toBase64 / fromBase64', () => {
  test('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const encoded = toBase64(original.buffer);
    const decoded = new Uint8Array(fromBase64(encoded));
    expect(decoded).toEqual(original);
  });

  test('round-trips empty buffer', () => {
    const empty = new Uint8Array(0);
    const encoded = toBase64(empty.buffer);
    const decoded = new Uint8Array(fromBase64(encoded));
    expect(decoded).toEqual(empty);
  });

  test('fromBase64 throws on invalid input with error context', () => {
    expect(() => fromBase64('not-valid-base64!!!')).toThrow(/Invalid Base64 input/);
    expect(() => fromBase64('not-valid-base64!!!')).toThrow(/length=19/);
  });

  test('fromBase64 throws with original error detail', () => {
    try {
      fromBase64('###invalid###');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // Should include both length and the underlying error message
      expect((err as Error).message).toContain('length=');
    }
  });
});

describe('generateKeyPair', () => {
  test('generates an Ed25519 keypair', async () => {
    const keyPair = await generateKeyPair();
    expect(keyPair.publicKey).toBeDefined();
    expect(keyPair.privateKey).toBeDefined();
    expect(keyPair.publicKey.type).toBe('public');
    expect(keyPair.privateKey.type).toBe('private');
  });

  test('generates unique keypairs', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const exp1 = await exportKeyPair(kp1);
    const exp2 = await exportKeyPair(kp2);
    expect(toBase64(exp1.publicKeyRaw)).not.toBe(toBase64(exp2.publicKeyRaw));
  });
});

describe('exportKeyPair / importPublicKey / importPrivateKey', () => {
  test('exports and re-imports public key', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    expect(exported.publicKeyRaw.byteLength).toBe(32); // Ed25519 public key is 32 bytes

    const reimported = await importPublicKey(exported.publicKeyRaw);
    expect(reimported.type).toBe('public');
  });

  test('exports and re-imports private key', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);

    const reimported = await importPrivateKey(exported.privateKeyRaw);
    expect(reimported.type).toBe('private');
  });

  test('re-imported key can sign and verify', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    const reimportedPrivate = await importPrivateKey(exported.privateKeyRaw);
    const reimportedPublic = await importPublicKey(exported.publicKeyRaw);

    const data = new TextEncoder().encode('test message');
    const sig = await sign(reimportedPrivate, data.buffer);
    const valid = await verify(reimportedPublic, data.buffer, sig);
    expect(valid).toBe(true);
  });
});

describe('sign / verify', () => {
  test('signs and verifies data', async () => {
    const keyPair = await generateKeyPair();
    const data = new TextEncoder().encode('hello world');
    const sig = await sign(keyPair.privateKey, data.buffer);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);

    const valid = await verify(keyPair.publicKey, data.buffer, sig);
    expect(valid).toBe(true);
  });

  test('rejects tampered data', async () => {
    const keyPair = await generateKeyPair();
    const data = new TextEncoder().encode('original');
    const sig = await sign(keyPair.privateKey, data.buffer);

    const tampered = new TextEncoder().encode('tampered');
    const valid = await verify(keyPair.publicKey, tampered.buffer, sig);
    expect(valid).toBe(false);
  });

  test('rejects signature from different key', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const data = new TextEncoder().encode('test');
    const sig = await sign(kp1.privateKey, data.buffer);

    const valid = await verify(kp2.publicKey, data.buffer, sig);
    expect(valid).toBe(false);
  });

  test('signs empty data', async () => {
    const keyPair = await generateKeyPair();
    const empty = new Uint8Array(0);
    const sig = await sign(keyPair.privateKey, empty.buffer);
    const valid = await verify(keyPair.publicKey, empty.buffer, sig);
    expect(valid).toBe(true);
  });
});

describe('encryptPrivateKey / decryptPrivateKey', () => {
  // Use fewer iterations for test speed
  const testIterations = 1000;

  test('encrypts and decrypts with correct passphrase', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);

    const encrypted = await encryptPrivateKey(
      exported.privateKeyRaw,
      'mypassphrase',
      testIterations,
    );
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.salt).toBeDefined();

    const decrypted = await decryptPrivateKey(encrypted, 'mypassphrase', testIterations);
    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(exported.privateKeyRaw));
  });

  test('rejects wrong passphrase', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);

    const encrypted = await encryptPrivateKey(exported.privateKeyRaw, 'correct', testIterations);
    await expect(decryptPrivateKey(encrypted, 'wrong', testIterations)).rejects.toThrow();
  });

  test('produces different ciphertext for same key (random salt/iv)', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);

    const enc1 = await encryptPrivateKey(exported.privateKeyRaw, 'pass', testIterations);
    const enc2 = await encryptPrivateKey(exported.privateKeyRaw, 'pass', testIterations);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.salt).not.toBe(enc2.salt);
    expect(enc1.iv).not.toBe(enc2.iv);
  });

  test('decrypted key can sign and verify', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);

    const encrypted = await encryptPrivateKey(exported.privateKeyRaw, 'test', testIterations);
    const decrypted = await decryptPrivateKey(encrypted, 'test', testIterations);
    const privateKey = await importPrivateKey(decrypted);
    const publicKey = await importPublicKey(exported.publicKeyRaw);

    const data = new TextEncoder().encode('verify round-trip');
    const sig = await sign(privateKey, data.buffer);
    const valid = await verify(publicKey, data.buffer, sig);
    expect(valid).toBe(true);
  });
});

describe('fingerprint', () => {
  test('returns hex string of expected length', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    const fp = await fingerprint(exported.publicKeyRaw);

    expect(typeof fp).toBe('string');
    expect(fp.length).toBe(FINGERPRINT_LENGTH);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  test('same key produces same fingerprint', async () => {
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    const fp1 = await fingerprint(exported.publicKeyRaw);
    const fp2 = await fingerprint(exported.publicKeyRaw);
    expect(fp1).toBe(fp2);
  });

  test('different keys produce different fingerprints', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const exp1 = await exportKeyPair(kp1);
    const exp2 = await exportKeyPair(kp2);
    const fp1 = await fingerprint(exp1.publicKeyRaw);
    const fp2 = await fingerprint(exp2.publicKeyRaw);
    expect(fp1).not.toBe(fp2);
  });
});

describe('generateChallenge', () => {
  test('returns base64-encoded challenge', () => {
    const challenge = generateChallenge();
    expect(typeof challenge).toBe('string');
    const decoded = fromBase64(challenge);
    expect(decoded.byteLength).toBe(CHALLENGE_SIZE);
  });

  test('generates unique challenges', () => {
    const challenges = new Set<string>();
    for (let i = 0; i < 100; i++) {
      challenges.add(generateChallenge());
    }
    expect(challenges.size).toBe(100);
  });
});
