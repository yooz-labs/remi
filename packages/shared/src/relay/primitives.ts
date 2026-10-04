/**
 * Thin WebCrypto wrappers for relay v2 (ADR 0034 section 1).
 *
 * Written fresh rather than reusing `relay-crypto.ts`: that module fixes random
 * nonces, takes base64 strings, derives its keys without the transcript or the
 * pairing secret, and is deleted by R3, so sharing code with it would couple
 * v2 to what it replaces. Only `crypto.subtle` primitives the ADR names appear
 * here, and `systemRandom` is the only place the library touches the platform
 * random source: every state machine takes a `Rng` instead.
 */

import { type Bytes, be64, concat, fromB64u, own, utf8, zero } from './bytes.ts';
import { type Direction, LABEL, RID_LEN, V } from './constants.ts';
import { RelayError } from './errors.ts';

/** A source of random bytes. Injected everywhere so vectors are reproducible. */
export type Rng = (length: number) => Uint8Array;
export const systemRandom: Rng = (n) => crypto.getRandomValues(new Uint8Array(n));

/** An Ed25519 identity: the public key and a signer that never exposes the private half. */
export interface Signer {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** A P-256 key pair whose private half is a non-extractable `CryptoKey`. */
export interface EcPair {
  /** 65 bytes, uncompressed SEC1. */
  readonly publicKey: Uint8Array;
  readonly privateKey: CryptoKey;
}

const hexBytes = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
const ED25519_PKCS8 = hexBytes('302e020100300506032b657004220420');
const P256_PKCS8 = hexBytes(
  '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
);
/** The P-256 group order. */
const P256_ORDER = hexBytes('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)));
}

/** The room id: the first 16 bytes of SHA-256 of the machine public key. */
export async function ridOf(machinePublicKey: Uint8Array): Promise<Uint8Array> {
  return (await sha256(machinePublicKey)).slice(0, RID_LEN);
}

export async function signerFromSeed(seed: Uint8Array): Promise<Signer> {
  const pkcs8 = concat(ED25519_PKCS8, seed);
  try {
    const exportable = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', exportable);
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
    return {
      publicKey: fromB64u(jwk.x ?? ''),
      sign: async (message) =>
        new Uint8Array(await crypto.subtle.sign('Ed25519', key, own(message))),
    };
  } finally {
    zero(pkcs8);
  }
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

function validScalar(d: Uint8Array): boolean {
  if (d.length !== 32 || d.every((b) => b === 0)) return false;
  for (let i = 0; i < 32; i++) {
    if ((d[i] ?? 0) !== (P256_ORDER[i] ?? 0)) return (d[i] ?? 0) < (P256_ORDER[i] ?? 0);
  }
  return false;
}

/** Build a P-256 pair from a 32-byte scalar `1 <= d < n`. The scalar is not retained. */
export async function ecPairFromScalar(d: Uint8Array): Promise<EcPair> {
  if (!validScalar(d)) throw new RelayError('MALFORMED');
  const pkcs8 = concat(P256_PKCS8, d);
  try {
    const exportable = await crypto.subtle.importKey('pkcs8', pkcs8, P256, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', exportable);
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, P256, false, ['deriveBits']);
    return {
      publicKey: concat(Uint8Array.of(4), fromB64u(jwk.x ?? ''), fromB64u(jwk.y ?? '')),
      privateKey,
    };
  } finally {
    zero(pkcs8);
  }
}

/** Fresh P-256 pair from the injected source, redrawing a scalar outside `[1, n-1]`. */
export async function ecGenerate(random: Rng): Promise<EcPair> {
  for (;;) {
    const d = random(32);
    try {
      if (validScalar(d)) return await ecPairFromScalar(d);
    } finally {
      zero(d);
    }
  }
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
