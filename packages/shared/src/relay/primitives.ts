/**
 * Thin WebCrypto wrappers for relay v2 (ADR 0034 section 1).
 *
 * Written fresh rather than reusing `relay-crypto.ts`: that module fixes random
 * nonces, takes base64 strings, derives its keys without the transcript or the
 * pairing secret, and is deleted by R3, so sharing code with it would couple
 * v2 to what it replaces. Only `crypto.subtle` primitives the ADR names appear
 * here, and `systemRandom` is the only place the library touches the platform
 * random source: every state machine takes a `Rng` instead.
 *
 * Production keys come from the engine's own `generateKey`, and a persisted key
 * is the engine's own export (PKCS8 plus the raw public key), so nothing here
 * relies on an engine deriving a public key from a bare scalar or seed. That
 * path exists only in `deterministic.ts`, for tests and vectors (ADR section 17).
 */

import { type Bytes, be64, concat, lps, own, utf8 } from './bytes.ts';
import { type Direction, LABEL, RID_LEN, V } from './constants.ts';
import { RelayError } from './errors.ts';

/**
 * A source of random bytes. Injected everywhere so vectors are reproducible.
 * It must return a fresh array on every call: the library overwrites secret draws.
 */
export type Rng = (length: number) => Uint8Array;
export const systemRandom: Rng = (n) => crypto.getRandomValues(new Uint8Array(n));

/** An Ed25519 identity: the public key and a signer that never exposes the private half. */
export interface Signer {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** A P-256 key pair: the raw public point and the private `CryptoKey`. */
export interface EcPair {
  /** 65 bytes, uncompressed SEC1. */
  readonly publicKey: Uint8Array;
  readonly privateKey: CryptoKey;
}

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)));
}

/** The room id: the first 16 bytes of SHA-256 of the machine public key. */
export async function ridOf(machinePublicKey: Uint8Array): Promise<Uint8Array> {
  return (await sha256(machinePublicKey)).slice(0, RID_LEN);
}

/**
 * What `signerFromKey` signs once to prove the pair matches. It is `lps(label, 32 zero
 * bytes)`: 62 bytes with its own label, so it is disjoint from every other signed message
 * (ADR 0034 section 18), and the signature never leaves this function.
 */
export const SIGNER_CHECK = lps(LABEL.signerCheck, new Uint8Array(32));

/**
 * A signer over a private key the caller already holds (for example one imported from
 * storage). A private key that does not match `publicKey`, or cannot sign, would produce
 * signatures nobody can verify and fail silently at the peer, so the pair is checked
 * once here: a mismatch is `BAD_SIGNATURE`, at construction.
 */
export async function signerFromKey(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Signer> {
  const signer: Signer = {
    publicKey,
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, own(message))),
  };
  let matches = false;
  try {
    matches = await verifySignature(publicKey, SIGNER_CHECK, await signer.sign(SIGNER_CHECK));
  } catch {
    // A key that cannot sign is the same failure as one that does not match.
  }
  if (!matches) throw new RelayError('BAD_SIGNATURE');
  return signer;
}

/**
 * A fresh Ed25519 identity from the engine's `generateKey`. Persist `pkcs8` (the
 * engine's own export, the same form the v1 identity stores) together with
 * `signer.publicKey`, and rebuild the signer with `importKey('pkcs8', ..., false, ...)`
 * and `signerFromKey`. The signer's key is imported again from that export as
 * NON-extractable, so the extractable key `generateKey` made is not kept.
 */
export async function generateIdentity(): Promise<{ signer: Signer; pkcs8: Bytes }> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const [publicKey, pkcs8] = await Promise.all([
    crypto.subtle.exportKey('raw', pair.publicKey),
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
  ]);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  return {
    signer: await signerFromKey(privateKey, new Uint8Array(publicKey)),
    pkcs8: new Uint8Array(pkcs8),
  };
}

/** Fails closed: any malformed key, signature or engine error is `false`. */
export async function verifySignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', own(publicKey), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, own(signature), own(message));
  } catch {
    return false;
  }
}

/**
 * A fresh P-256 pair from the engine's `generateKey`, the public point exported
 * raw. The private key is non-extractable unless the caller (a device persisting
 * a push key) asks otherwise.
 */
export async function generateEcPair(extractable = false): Promise<EcPair> {
  const pair = await crypto.subtle.generateKey(P256, extractable, ['deriveBits']);
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateKey: pair.privateKey,
  };
}

/** A valid P-256 public key, or `MALFORMED`: the platform rejects an off-curve point at import. */
export async function importEcPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new RelayError('MALFORMED');
  try {
    return await crypto.subtle.importKey('raw', own(raw), P256, false, []);
  } catch {
    throw new RelayError('MALFORMED');
  }
}

/** ECDH, X coordinate only. */
export async function ecdh(privateKey: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array> {
  const peer = await importEcPublic(peerPublic);
  try {
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256),
    );
  } catch {
    throw new RelayError('MALFORMED');
  }
}

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', own(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: own(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    own(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, own(data)));
}

// -- AES-256-GCM with the counter nonce and the authenticated header --

export const aeadKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', own(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

/** `0x00000000 || be64(counter)`. */
export const frameNonce = (counter: number): Bytes => concat(new Uint8Array(4), be64(counter));

/** `"remi-relay-v2" || V || type || direction || be64(counter)`. */
export const frameAad = (type: number, direction: Direction, counter: number): Bytes =>
  concat(utf8(LABEL.aad), Uint8Array.of(V, type, direction), be64(counter));

export type SealFn = (
  key: CryptoKey,
  type: number,
  direction: Direction,
  counter: number,
  plaintext: Uint8Array,
) => Promise<Uint8Array>;

export const aeadSeal: SealFn = async (key, type, direction, counter, plaintext) =>
  new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: frameNonce(counter),
        additionalData: frameAad(type, direction, counter),
        tagLength: 128,
      },
      key,
      own(plaintext),
    ),
  );

/** Any failure, tag or otherwise, is `DECRYPT`. */
export async function aeadOpen(
  key: CryptoKey,
  type: number,
  direction: Direction,
  counter: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: frameNonce(counter),
          additionalData: frameAad(type, direction, counter),
          tagLength: 128,
        },
        key,
        own(ciphertext),
      ),
    );
  } catch {
    throw new RelayError('DECRYPT');
  }
}
