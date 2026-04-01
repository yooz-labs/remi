/**
 * Identity management for Remi authentication.
 *
 * Handles creation, serialization, and unlocking of Ed25519 identities.
 * Private keys can be passphrase-encrypted (AES-256-GCM) or stored
 * unencrypted for zero-friction startup.
 */

import type { Base64, Fingerprint } from './crypto.ts';
import {
  PBKDF2_ITERATIONS,
  decryptPrivateKey,
  encryptPrivateKey,
  exportKeyPair,
  fingerprint,
  fromBase64,
  generateKeyPair,
  importPrivateKey,
  importPublicKey,
  toBase64,
} from './crypto.ts';

/**
 * Persisted identity. The private key is either passphrase-encrypted
 * (iterations > 0, non-empty salt/iv) or stored as raw PKCS8 base64
 * (iterations === 0, empty salt/iv). Use `isEncrypted()` to check.
 */
export interface RemiIdentity {
  readonly version: 1;
  readonly publicKey: Base64;
  /** Encrypted ciphertext (when encrypted) or raw PKCS8 base64 (when unencrypted) */
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

/** Check whether an identity has an encrypted private key. */
export function isEncrypted(identity: RemiIdentity): boolean {
  return identity.iterations > 0;
}

/**
 * Generate a new identity. When a passphrase is provided the private key
 * is encrypted with PBKDF2 + AES-256-GCM. Without a passphrase the raw
 * PKCS8 key is stored directly (zero-friction mode).
 */
export async function createIdentity(passphrase?: string): Promise<RemiIdentity> {
  const keyPair = await generateKeyPair();
  const exported = await exportKeyPair(keyPair);
  const fp = await fingerprint(exported.publicKeyRaw);

  if (passphrase !== undefined && passphrase.length === 0) {
    throw new Error('Passphrase must not be empty. Omit it to create an unencrypted identity.');
  }

  if (passphrase) {
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

  return {
    version: 1,
    publicKey: toBase64(exported.publicKeyRaw),
    encryptedPrivateKey: toBase64(exported.privateKeyRaw),
    salt: '',
    iv: '',
    iterations: 0,
    fingerprint: fp,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Unlock an identity. Encrypted identities require a passphrase;
 * unencrypted identities can be unlocked without one.
 * @throws if passphrase is required but missing, or if it is incorrect
 */
export async function unlockIdentity(
  identity: RemiIdentity,
  passphrase?: string,
): Promise<UnlockedIdentity> {
  let privateKeyPkcs8: ArrayBuffer;

  if (isEncrypted(identity)) {
    if (!passphrase) {
      throw new Error('Passphrase required for encrypted identity');
    }
    privateKeyPkcs8 = await decryptPrivateKey(
      {
        ciphertext: identity.encryptedPrivateKey,
        iv: identity.iv,
        salt: identity.salt,
      },
      passphrase,
      identity.iterations,
    );
  } else {
    privateKeyPkcs8 = fromBase64(identity.encryptedPrivateKey);
  }

  const privateKey = await importPrivateKey(privateKeyPkcs8);
  const publicKey = await importPublicKey(fromBase64(identity.publicKey));

  return {
    publicKey,
    privateKey,
    publicKeyRaw: identity.publicKey,
    fingerprint: identity.fingerprint,
  };
}

/**
 * Re-key an identity: change, add, or remove the passphrase without
 * regenerating the keypair. The fingerprint and public key stay the same,
 * so authorized clients do not need to re-authorize.
 *
 * @param identity  The existing identity (encrypted or unencrypted)
 * @param oldPassphrase  Passphrase to unlock (undefined if unencrypted)
 * @param newPassphrase  New passphrase (undefined to store unencrypted)
 */
export async function rekeyIdentity(
  identity: RemiIdentity,
  oldPassphrase?: string,
  newPassphrase?: string,
): Promise<RemiIdentity> {
  // Unlock to get the raw private key
  const unlocked = await unlockIdentity(identity, oldPassphrase);
  const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', unlocked.privateKey);

  if (newPassphrase) {
    const encrypted = await encryptPrivateKey(privateKeyRaw, newPassphrase);
    return {
      version: 1,
      publicKey: identity.publicKey,
      encryptedPrivateKey: encrypted.ciphertext,
      salt: encrypted.salt,
      iv: encrypted.iv,
      iterations: PBKDF2_ITERATIONS,
      fingerprint: identity.fingerprint,
      createdAt: identity.createdAt,
    };
  }

  return {
    version: 1,
    publicKey: identity.publicKey,
    encryptedPrivateKey: toBase64(privateKeyRaw),
    salt: '',
    iv: '',
    iterations: 0,
    fingerprint: identity.fingerprint,
    createdAt: identity.createdAt,
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

  const required = ['publicKey', 'encryptedPrivateKey', 'fingerprint', 'createdAt'];
  for (const field of required) {
    if (typeof obj[field] !== 'string') {
      throw new Error(`Invalid identity: missing or invalid field '${field}'`);
    }
  }

  // salt and iv must be strings (empty string for unencrypted)
  for (const field of ['salt', 'iv']) {
    if (typeof obj[field] !== 'string') {
      throw new Error(`Invalid identity: missing or invalid field '${field}'`);
    }
  }

  if (typeof obj['iterations'] !== 'number' || obj['iterations'] < 0) {
    throw new Error('Invalid identity: invalid iterations count');
  }

  // Cross-field consistency: encrypted vs unencrypted
  if (obj['iterations'] === 0 && (obj['salt'] !== '' || obj['iv'] !== '')) {
    throw new Error('Invalid identity: unencrypted identity must have empty salt and iv');
  }
  if ((obj['iterations'] as number) > 0 && (obj['salt'] === '' || obj['iv'] === '')) {
    throw new Error('Invalid identity: encrypted identity requires non-empty salt and iv');
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
  const publicKeyRaw = fromBase64(publicKeyBase64);
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
