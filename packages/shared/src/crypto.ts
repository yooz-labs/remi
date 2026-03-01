/**
 * Cross-platform cryptographic utilities for Remi authentication.
 *
 * Uses the Web Crypto API exclusively (available in both Bun and browsers).
 * No external dependencies required.
 *
 * Primitives:
 * - Ed25519: Digital signatures for identity and authentication
 * - PBKDF2-SHA-256: Key derivation from passphrase (600K iterations)
 * - AES-256-GCM: Authenticated encryption for private key at rest
 */

/** Base64-encoded string */
export type Base64 = string;

/** Hex-encoded fingerprint string */
export type Fingerprint = string;

/** Default PBKDF2 iteration count (OWASP 2023 recommendation for SHA-256) */
export const PBKDF2_ITERATIONS = 600_000;

/** Salt size in bytes */
export const SALT_SIZE = 32;

/** AES-GCM IV size in bytes */
export const IV_SIZE = 12;

/** Challenge nonce size in bytes */
export const CHALLENGE_SIZE = 32;

/** Fingerprint display length (hex characters) */
export const FINGERPRINT_LENGTH = 16;

// -- Encoding helpers --

export function toBase64(buffer: ArrayBuffer): Base64 {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

export function fromBase64(base64: Base64): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

// -- Key generation --

export interface RawKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface ExportedKeyPair {
  publicKeyRaw: ArrayBuffer;
  privateKeyRaw: ArrayBuffer;
}

/**
 * Generate an Ed25519 keypair for signing.
 */
export async function generateKeyPair(): Promise<RawKeyPair> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  return {
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  };
}

/**
 * Export a keypair to raw bytes.
 */
export async function exportKeyPair(keyPair: RawKeyPair): Promise<ExportedKeyPair> {
  const [publicKeyRaw, privateKeyRaw] = await Promise.all([
    crypto.subtle.exportKey('raw', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);
  return { publicKeyRaw, privateKeyRaw };
}

/**
 * Import a raw Ed25519 public key.
 */
export async function importPublicKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'Ed25519', true, ['verify']);
}

/**
 * Import a PKCS8-encoded Ed25519 private key.
 */
export async function importPrivateKey(pkcs8: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
}

// -- Signing --

/**
 * Sign data with an Ed25519 private key.
 * @returns Base64-encoded signature
 */
export async function sign(privateKey: CryptoKey, data: ArrayBuffer): Promise<Base64> {
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return toBase64(signature);
}

/**
 * Verify an Ed25519 signature.
 */
export async function verify(
  publicKey: CryptoKey,
  data: ArrayBuffer,
  signatureBase64: Base64,
): Promise<boolean> {
  const signature = fromBase64(signatureBase64);
  return crypto.subtle.verify('Ed25519', publicKey, signature, data);
}

// -- Passphrase KDF --

/**
 * Derive an AES-256 key from a passphrase using PBKDF2-SHA-256.
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: ArrayBuffer,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passphraseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    passphraseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// -- Private key encryption at rest --

export interface EncryptedData {
  ciphertext: Base64;
  iv: Base64;
  salt: Base64;
}

/**
 * Encrypt a private key with a passphrase-derived key.
 * Generates fresh salt and IV.
 */
export async function encryptPrivateKey(
  privateKeyPkcs8: ArrayBuffer,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<EncryptedData> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE));
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));
  const derivedKey = await deriveKeyFromPassphrase(passphrase, salt.buffer, iterations);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    derivedKey,
    privateKeyPkcs8,
  );

  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv.buffer),
    salt: toBase64(salt.buffer),
  };
}

/**
 * Decrypt a private key with a passphrase.
 * @throws if passphrase is wrong (AES-GCM auth tag verification fails)
 */
export async function decryptPrivateKey(
  encrypted: EncryptedData,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<ArrayBuffer> {
  const salt = fromBase64(encrypted.salt);
  const iv = fromBase64(encrypted.iv);
  const ciphertext = fromBase64(encrypted.ciphertext);
  const derivedKey = await deriveKeyFromPassphrase(passphrase, salt, iterations);

  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derivedKey, ciphertext);
}

// -- Fingerprint --

/**
 * Compute a fingerprint from a raw public key.
 * Returns first 16 hex characters of SHA-256 hash.
 */
export async function fingerprint(publicKeyRaw: ArrayBuffer): Promise<Fingerprint> {
  const hash = await crypto.subtle.digest('SHA-256', publicKeyRaw);
  return toHex(hash).slice(0, FINGERPRINT_LENGTH);
}

// -- Challenge --

/**
 * Generate a random 32-byte challenge nonce.
 * @returns Base64-encoded challenge
 */
export function generateChallenge(): Base64 {
  const bytes = crypto.getRandomValues(new Uint8Array(CHALLENGE_SIZE));
  return toBase64(bytes.buffer);
}
