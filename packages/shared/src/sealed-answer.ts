/**
 * Sealed lock-screen answers (#875).
 *
 * ## Why this is not the relay's encryption
 *
 * `relay-crypto.ts` hangs a signed ephemeral exchange off the auth handshake,
 * which works because both peers are live and talking. The lock-screen path has
 * no handshake and often no connection at all: that is its entire purpose
 * (#575 P4a). A phone answers from a push notification while the app is
 * suspended, over a single HTTP POST, and the Worker forwards it.
 *
 * Today that POST carries `sessionId`, `questionId` and the answer text as
 * plain JSON, so the Worker reads every answer given from a lock screen. This
 * seals it.
 *
 * ## The shape
 *
 * Ephemeral-static ECDH. The daemon holds a long-lived P-256 "answer key" and
 * publishes the public half; the phone pins it alongside the daemon's
 * fingerprint. To answer, the phone generates an ephemeral keypair, derives a
 * key against the pinned static one, and seals the body. Only the daemon can
 * open it.
 *
 * One request, no round trip, nothing to negotiate while the app is asleep.
 *
 * ## Why a separate key rather than the Ed25519 identity the phone already pins
 *
 * An Ed25519 key can be converted to X25519 for ECDH, and that would need no
 * new state at all. WebCrypto cannot do that conversion, and the clients here
 * include an iOS WKWebView, so it would mean adding a crypto library to a
 * security-critical path. A separate P-256 key costs one published field and
 * uses primitives every target has had for years.
 *
 * ## What it does not do
 *
 * No forward secrecy for the daemon's side: the static key opens every answer
 * sealed to it, so stealing that file retroactively opens recorded answers. The
 * relay's exchange has forward secrecy because both peers are live; this one
 * cannot without a round trip the sleeping phone does not have. Rotating the
 * key invalidates every phone's pin until each reconnects, which is the real
 * cost and the reason it is not rotated per boot.
 *
 * The Worker still sees the room code it routes by, and that an answer happened.
 */

import { fromBase64, toBase64 } from './crypto.ts';

const SEAL_INFO = 'remi-sealed-answer-v1';
const NONCE_BYTES = 12;

/** The envelope that replaces the plaintext answer body on the wire. */
export interface SealedAnswer {
  /** Raw P-256 public key of the one-shot sender key, base64. */
  readonly ephemeralPublicKey: string;
  /** Base64 `nonce || ciphertext` over the JSON answer body. */
  readonly sealed: string;
}

/** A long-lived keypair a daemon publishes so phones can seal answers to it. */
export interface AnswerKeyPair {
  readonly publicKeyBase64: string;
  readonly privateKeyPkcs8Base64: string;
}

/** Generate a daemon answer key. Long-lived: phones pin the public half. */
export async function generateAnswerKeyPair(): Promise<AnswerKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const [raw, pkcs8] = await Promise.all([
    crypto.subtle.exportKey('raw', pair.publicKey),
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
  ]);
  return { publicKeyBase64: toBase64(raw), privateKeyPkcs8Base64: toBase64(pkcs8) };
}

/** Derive the one AES-GCM key both sides reach, from either side's material. */
async function deriveSealKey(
  privateKey: CryptoKey,
  peerPublicKeyBase64: string,
  ephemeralPublicKeyBase64: string,
): Promise<CryptoKey> {
  const peerPublic = await crypto.subtle.importKey(
    'raw',
    fromBase64(peerPublicKeyBase64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublic },
    privateKey,
    256,
  );
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // The sender's ephemeral key is the salt, so two answers sealed to the
      // same daemon key never derive the same AES key.
      salt: new Uint8Array(fromBase64(ephemeralPublicKeyBase64)),
      info: new TextEncoder().encode(SEAL_INFO),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Seal an answer body to a daemon's published answer key.
 *
 * @param daemonAnswerKeyBase64 the pinned public key, learned when the phone
 *   last connected. A caller with no pinned key must refuse to send rather than
 *   fall back to plaintext.
 */
export async function sealAnswer(
  daemonAnswerKeyBase64: string,
  body: unknown,
): Promise<SealedAnswer> {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const ephemeralRaw = await crypto.subtle.exportKey('raw', ephemeral.publicKey);
  const ephemeralPublicKey = toBase64(ephemeralRaw);

  const key = await deriveSealKey(ephemeral.privateKey, daemonAnswerKeyBase64, ephemeralPublicKey);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(JSON.stringify(body)),
  );

  const packed = new Uint8Array(NONCE_BYTES + ciphertext.byteLength);
  packed.set(nonce, 0);
  packed.set(new Uint8Array(ciphertext), NONCE_BYTES);
  return { ephemeralPublicKey, sealed: toBase64(packed.buffer) };
}

/**
 * Open a sealed answer with the daemon's answer private key.
 *
 * Throws on a wrong key, a tampered envelope or malformed JSON. AES-GCM
 * authenticates, so callers must treat a throw as a hostile or corrupt request
 * and refuse the answer, never as an empty one.
 */
export async function openSealedAnswer(
  privateKeyPkcs8Base64: string,
  envelope: SealedAnswer,
): Promise<unknown> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64(privateKeyPkcs8Base64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const key = await deriveSealKey(
    privateKey,
    envelope.ephemeralPublicKey,
    envelope.ephemeralPublicKey,
  );

  const packed = new Uint8Array(fromBase64(envelope.sealed));
  if (packed.byteLength <= NONCE_BYTES) {
    throw new Error('Sealed answer is too short to contain a nonce and ciphertext');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.subarray(0, NONCE_BYTES) },
    key,
    packed.subarray(NONCE_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** True when a body looks like a sealed envelope rather than a plaintext answer. */
export function isSealedAnswer(body: unknown): body is SealedAnswer {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b['ephemeralPublicKey'] === 'string' && typeof b['sealed'] === 'string';
}
