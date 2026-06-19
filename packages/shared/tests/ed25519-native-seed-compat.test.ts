/**
 * #591 P2 de-risk: prove the native (iOS CryptoKit) signing path is byte-compatible
 * with the daemon's web-crypto Ed25519 verifier — OFF-DEVICE, so we don't burn a
 * costly on-device cycle discovering a crypto mismatch.
 *
 * The native handler will hold only the raw 32-byte Ed25519 seed (CryptoKit's
 * `Curve25519.Signing.PrivateKey(rawRepresentation:)`), bridged from the JS
 * identity's PKCS8 private key. This test extracts that seed exactly as the JS
 * bridge will (`pkcs8.slice(16)`), reconstructs a signer from ONLY the seed
 * (equivalent to what CryptoKit does), signs the canonical answer message, and
 * verifies it with the SAME `verify()` the daemon's authenticator uses. If this
 * passes, a CryptoKit signature from the same seed will verify on the daemon.
 */

import { describe, expect, test } from 'bun:test';
import {
  createIdentity,
  fromBase64,
  importPublicKey,
  sign,
  toBase64,
  unlockIdentity,
  verify,
} from '@remi/shared';

// PKCS8 prefix for an Ed25519 private key (RFC 8410): 16 bytes, then the 32-byte
// seed. CryptoKit's rawRepresentation is exactly those trailing 32 bytes.
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function seedToPkcs8(seed: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(seed, ED25519_PKCS8_PREFIX.length);
  return out.buffer;
}

describe('#591 P2 — native seed Ed25519 compatibility', () => {
  test('a signature from the bridged 32-byte seed verifies with the daemon verifier', async () => {
    const idFile = await createIdentity(); // unencrypted -> signable without a passphrase
    const unlocked = await unlockIdentity(idFile);

    // Export the PKCS8 the JS bridge has, and slice the 32-byte seed it ships to
    // native (the only thing CryptoKit needs).
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', unlocked.privateKey);
    const seed = new Uint8Array(pkcs8).slice(ED25519_PKCS8_PREFIX.length);
    expect(seed.length).toBe(32);

    // Reconstruct a signer from ONLY the seed (what CryptoKit does natively).
    const seedKey = await crypto.subtle.importKey('pkcs8', seedToPkcs8(seed), 'Ed25519', false, [
      'sign',
    ]);

    const message = 'aaaaaaaa-0000-0000-0000-000000000000|bbbbbbbb-0000-0000-0000-000000000000|yes';
    const data = new TextEncoder().encode(message).buffer as ArrayBuffer;
    const sigFromSeed = await sign(seedKey, data);

    // Verify with the public key, exactly as the daemon authenticator does
    // (verify signature is (publicKey, data, signatureBase64)).
    const pub = await importPublicKey(fromBase64(unlocked.publicKeyRaw));
    expect(await verify(pub, data, sigFromSeed)).toBe(true);

    // Ed25519 is deterministic, so the seed-only signer must produce the SAME
    // signature as the original full key — extra proof the seed is the whole key.
    const sigFromFull = await sign(unlocked.privateKey, data);
    expect(sigFromSeed).toBe(sigFromFull);

    // And the public key the native bridge ships (raw, base64) matches.
    expect(toBase64(await crypto.subtle.exportKey('raw', unlocked.publicKey))).toBe(
      unlocked.publicKeyRaw,
    );
  });
});
