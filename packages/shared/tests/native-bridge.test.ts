/**
 * #591 P2: prove the PRODUCTION `deriveNativeIdentity` transform produces a seed
 * that signs answers the daemon will accept — OFF-DEVICE, NO MOCKS, against the
 * same `verify()` the daemon's authenticator uses.
 *
 * `ed25519-native-seed-compat.test.ts` proves the raw seed-extraction technique
 * in isolation; this test pins the actual function the web bridge ships through
 * Capacitor Preferences, so a regression in `deriveNativeIdentity` (wrong slice,
 * wrong public key, encrypted-identity leak) fails here rather than on a device.
 */

import { describe, expect, test } from 'bun:test';
import {
  createIdentity,
  deriveNativeIdentity,
  fromBase64,
  importPublicKey,
  sign,
  toBase64,
  verify,
} from '@remi/shared';

// PKCS8 (RFC 8410) Ed25519 prefix: 16 bytes, then the 32-byte seed. CryptoKit's
// rawRepresentation IS those trailing 32 bytes; we rebuild a signer from them.
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function seedToPkcs8(seedB64: string): ArrayBuffer {
  const seed = new Uint8Array(fromBase64(seedB64));
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(seed, ED25519_PKCS8_PREFIX.length);
  return out.buffer;
}

describe('#591 P2 — deriveNativeIdentity', () => {
  test('the derived seed signs an answer the daemon verifier accepts', async () => {
    const identity = await createIdentity(); // unencrypted -> bridgeable
    const record = deriveNativeIdentity(identity);
    expect(record).not.toBeNull();
    if (!record) return;

    // The native handler holds exactly these three base64 fields.
    expect(new Uint8Array(fromBase64(record.seed)).length).toBe(32);
    expect(record.publicKey).toBe(identity.publicKey);
    expect(record.fingerprint).toBe(identity.fingerprint);

    // Reconstruct CryptoKit's seed-only signer and sign the canonical message.
    const seedKey = await crypto.subtle.importKey(
      'pkcs8',
      seedToPkcs8(record.seed),
      'Ed25519',
      false,
      ['sign'],
    );
    const message = 'aaaaaaaa-0000-0000-0000-000000000000|bbbbbbbb-0000-0000-0000-000000000000|yes';
    const data = new TextEncoder().encode(message).buffer as ArrayBuffer;
    const signature = await sign(seedKey, data);

    // Verify with the bridged public key, exactly as the daemon authenticator does.
    const pub = await importPublicKey(fromBase64(record.publicKey));
    expect(await verify(pub, data, signature)).toBe(true);
  });

  test('an encrypted identity is NOT bridgeable (returns null, no leak)', async () => {
    const encrypted = await createIdentity('a-real-passphrase');
    expect(deriveNativeIdentity(encrypted)).toBeNull();
  });

  test('a malformed (non-base64) unencrypted key returns null, never throws', async () => {
    const identity = await createIdentity();
    // iterations === 0 keeps it "unencrypted", but the PKCS8 blob is garbage.
    const malformed = { ...identity, encryptedPrivateKey: '%%% not base64 %%%' };
    expect(deriveNativeIdentity(malformed)).toBeNull();
  });

  test('the public key round-trips to the same raw bytes the daemon expects', async () => {
    const identity = await createIdentity();
    const record = deriveNativeIdentity(identity);
    if (!record) throw new Error('expected a bridgeable identity');
    // Re-exporting the imported public key yields the identical base64 the
    // record carries — confirms publicKey is raw (not SPKI) as the daemon needs.
    const pub = await importPublicKey(fromBase64(record.publicKey));
    expect(toBase64(await crypto.subtle.exportKey('raw', pub))).toBe(record.publicKey);
  });
});
