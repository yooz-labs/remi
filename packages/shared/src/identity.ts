/**
 * Identity management for Remi authentication.
 *
 * Handles creation, serialization, and unlocking of Ed25519 identities
 * with passphrase-encrypted private keys.
 */

import type { Base64, Fingerprint } from './crypto.ts';
import {
  PBKDF2_ITERATIONS,
  decryptPrivateKey,
  encryptPrivateKey,
  exportKeyPair,
  fingerprint,
  generateKeyPair,
  importPrivateKey,
  importPublicKey,
  toBase64,
} from './crypto.ts';

/** Persisted identity with passphrase-encrypted private key */
export interface RemiIdentity {
  readonly version: 1;
  readonly publicKey: Base64;
  readonly encryptedPrivateKey: Base64;
  readonly salt: Base64;
  readonly iv: Base64;
  readonly iterations: number;
  readonly fingerprint: Fingerprint;
  readonly createdAt: string;
}

/** An authorized client public key */
export interface AuthorizedKey {
  readonly publicKey: Base64;
  readonly fingerprint: Fingerprint;
  readonly label: string;
  readonly addedAt: string;
  readonly lastUsedAt: string | null;
}

/** Authorized keys file structure */
export interface AuthorizedKeysFile {
  readonly version: 1;
  readonly keys: AuthorizedKey[];
}

/** Unlocked identity with usable CryptoKey objects */
export interface UnlockedIdentity {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly publicKeyRaw: Base64;
  readonly fingerprint: Fingerprint;
}

/** Known host entry (TOFU model) */
export interface KnownHost {
  readonly fingerprint: Fingerprint;
  readonly publicKey: Base64;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

/**
 * Generate a new identity with a passphrase-encrypted private key.
 */
export async function createIdentity(passphrase: string): Promise<RemiIdentity> {
  const keyPair = await generateKeyPair();
  const exported = await exportKeyPair(keyPair);
  const fp = await fingerprint(exported.publicKeyRaw);

  const encrypted = await encryptPrivateKey(exported.privateKeyRaw, passphrase);

  return {
    version: 1,
    publicKey: toBase64(exported.publicKeyRaw),
    encryptedPrivateKey: encrypted.ciphertext,
    salt: encrypted.salt,
    iv: encrypted.iv,
    iterations: PBKDF2_ITERATIONS,
    fingerprint: fp,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Unlock an identity by decrypting the private key with a passphrase.
 * @throws if passphrase is incorrect
 */
export async function unlockIdentity(
  identity: RemiIdentity,
  passphrase: string,
): Promise<UnlockedIdentity> {
  const privateKeyPkcs8 = await decryptPrivateKey(
    {
      ciphertext: identity.encryptedPrivateKey,
      iv: identity.iv,
      salt: identity.salt,
    },
    passphrase,
    identity.iterations,
  );

  const privateKey = await importPrivateKey(privateKeyPkcs8);
  const publicKey = await importPublicKey(
    // Convert base64 public key back to ArrayBuffer
    Uint8Array.from(atob(identity.publicKey), (c) => c.charCodeAt(0)).buffer,
  );

  return {
    publicKey,
    privateKey,
    publicKeyRaw: identity.publicKey,
    fingerprint: identity.fingerprint,
  };
}

/**
 * Serialize an identity to JSON string for export/storage.
 */
export function serializeIdentity(identity: RemiIdentity): string {
  return JSON.stringify(identity, null, 2);
}

/**
 * Deserialize an identity from JSON string.
 * @throws if JSON is invalid or missing required fields
 */
export function deserializeIdentity(json: string): RemiIdentity {
  const parsed: unknown = JSON.parse(json);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid identity: not an object');
  }

  const obj = parsed as Record<string, unknown>;

  if (obj['version'] !== 1) {
    throw new Error(`Unsupported identity version: ${String(obj['version'])}`);
  }

  const required = ['publicKey', 'encryptedPrivateKey', 'salt', 'iv', 'fingerprint', 'createdAt'];
  for (const field of required) {
    if (typeof obj[field] !== 'string') {
      throw new Error(`Invalid identity: missing or invalid field '${field}'`);
    }
  }

  if (typeof obj['iterations'] !== 'number' || obj['iterations'] < 1) {
    throw new Error('Invalid identity: invalid iterations count');
  }

  return parsed as RemiIdentity;
}

/**
 * Create an AuthorizedKey entry from a public key.
 */
export async function createAuthorizedKey(
  publicKeyBase64: Base64,
  label: string,
): Promise<AuthorizedKey> {
  const publicKeyRaw = Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0)).buffer;
  const fp = await fingerprint(publicKeyRaw);

  return {
    publicKey: publicKeyBase64,
    fingerprint: fp,
    label,
    addedAt: new Date().toISOString(),
    lastUsedAt: null,
  };
}

/**
 * Create an empty authorized keys file.
 */
export function createAuthorizedKeysFile(): AuthorizedKeysFile {
  return { version: 1, keys: [] };
}
