/**
 * Pure identity transform for the native lock-screen answer relay (#591 P2).
 *
 * The iOS native handler (`RemiAnswerRelay.swift`) signs a lock-screen answer
 * WITHOUT opening the app, using CryptoKit's
 * `Curve25519.Signing.PrivateKey(rawRepresentation:)` — which takes the raw
 * 32-byte Ed25519 seed. It cannot reach the WebView's localStorage, so the web
 * layer mirrors the minimum it needs (seed + raw public key + fingerprint) into
 * native-readable storage.
 *
 * This module owns the pure derivation so it can be unit-tested (NO MOCKS)
 * against the daemon's own `verify()` — see `tests/native-bridge.test.ts`. The
 * Capacitor Preferences I/O that ships it to UserDefaults lives in the web
 * package (`lib/native-bridge.ts`), which is thin glue around this function.
 */

import { fromBase64, toBase64 } from './crypto.ts';
import { type RemiIdentity, isEncrypted } from './identity.ts';

/**
 * The minimum identity the native handler needs to sign an answer. All fields
 * are base64. `seed` is the raw 32-byte Ed25519 private seed; `publicKey` is the
 * raw 32-byte public key (the daemon's authenticator verifies with it); the
 * fingerprint identifies the key in the daemon's authorized-keys store.
 */
export interface NativeIdentityRecord {
  readonly seed: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/**
 * PKCS8 (RFC 8410) wrapping of an Ed25519 private key: a 16-byte prefix followed
 * by the 32-byte seed. An unencrypted `RemiIdentity` stores this PKCS8 blob
 * (base64) directly in `encryptedPrivateKey`; CryptoKit needs only the seed.
 */
const PKCS8_PREFIX_LEN = 16;
const ED25519_SEED_LEN = 32;

/**
 * Derive the native identity record from a stored identity.
 *
 * Returns null when the identity is encrypted (the seed can't be bridged without
 * a passphrase prompt the lock screen cannot show — the same limitation the JS
 * relay's `buildAuth` has) or when the stored PKCS8 is malformed. A null result
 * means the lock-screen relay is simply unavailable for that identity, never an
 * error to swallow.
 */
export function deriveNativeIdentity(identity: RemiIdentity): NativeIdentityRecord | null {
  if (isEncrypted(identity)) return null;
  // Unencrypted: `encryptedPrivateKey` is the raw PKCS8 base64. `fromBase64`
  // throws on a malformed (non-base64) value; treat that as not-bridgeable too,
  // so the function honors its documented "null on malformed PKCS8" contract
  // instead of leaking a throw to a fire-and-forget caller.
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = fromBase64(identity.encryptedPrivateKey);
  } catch {
    return null;
  }
  // Slice past the 16-byte prefix; `fromBase64` returns an ArrayBuffer, so check byteLength.
  const seed = pkcs8.slice(PKCS8_PREFIX_LEN);
  if (seed.byteLength !== ED25519_SEED_LEN) return null;
  return {
    seed: toBase64(seed),
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
  };
}
