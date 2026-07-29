/**
 * End-to-end encryption for the relay transport (#543).
 *
 * ## Why this exists
 *
 * The signaling worker was built to relay a HANDSHAKE. WebRTC was meant to
 * carry the session itself, and it was never implemented: there is no
 * `RTCPeerConnection` anywhere in this repo. So the worker quietly became the
 * data path, and `RelayAdapter` sends every protocol message through it as
 * plain JSON, including `user_input`, `answer` and device tokens. A product
 * whose first principle is that session data never reaches a server was
 * sending all of it to one.
 *
 * These functions make the worker a courier that cannot read the mail.
 *
 * ## The exchange
 *
 * Piggybacked on the Ed25519 auth handshake that already runs, so it costs no
 * extra round trips:
 *
 *   daemon -> client   auth_challenge   challenge, daemon ephemeral public key
 *   client -> daemon   auth_response    signature over (challenge || client eph), client eph
 *   daemon -> client   auth_result      signature over (challenge || daemon eph || client eph)
 *
 * Each side signs its own ephemeral key with its long-term Ed25519 identity,
 * so the Diffie-Hellman is authenticated: the worker can substitute a key, but
 * it cannot forge the signature over it, and the peer rejects the exchange.
 * Binding the challenge into both signatures ties the exchange to this session,
 * so a recorded handshake cannot be replayed into a new one.
 *
 * Keys are ephemeral and discarded with the connection, so recording today's
 * traffic and stealing an identity key tomorrow does not decrypt it.
 *
 * ## Choices worth knowing
 *
 * **P-256, not X25519.** X25519 is the better curve, but WebCrypto support for
 * it is recent and the clients here include an iOS WKWebView. P-256 ECDH has
 * been universally available for years. The weak link in this design is not the
 * curve.
 *
 * **Separate keys per direction.** Both sides derive two keys from the same
 * shared secret and each encrypts with only one. Sharing a single key would
 * risk both ends picking the same nonce, which loses AES-GCM its guarantees
 * outright.
 *
 * **Random 96-bit nonces.** Per key, collisions become a concern around 2^32
 * messages; a relay session is many orders of magnitude short of that. Counters
 * would be tighter but need reconnect-safe state, and getting that wrong fails
 * silently and catastrophically.
 *
 * ## What it does not do
 *
 * The worker still sees who talks to whom, when, and how much: it routes the
 * traffic. This hides content, not metadata.
 */

import { fromBase64, toBase64 } from './crypto.ts';

/** Domain separator, versioned so a future change cannot be silently accepted. */
const KEX_CONTEXT = 'remi-relay-kex-v1';
const KDF_INFO_DAEMON_TO_CLIENT = 'remi-relay-v1|daemon->client';
const KDF_INFO_CLIENT_TO_DAEMON = 'remi-relay-v1|client->daemon';

/** AES-GCM nonce length in bytes. */
const NONCE_BYTES = 12;

/** An ephemeral ECDH keypair, live for exactly one relay connection. */
export interface EphemeralKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  /** Raw (uncompressed, 65-byte) public key, base64, for the wire. */
  readonly publicKeyBase64: string;
}

/** The two directional keys derived from one exchange. */
export interface RelaySessionKeys {
  /** Encrypts what this side sends. */
  readonly send: CryptoKey;
  /** Decrypts what the peer sends. */
  readonly receive: CryptoKey;
}

/** Generate an ephemeral P-256 keypair for one relay connection. */
export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBase64: toBase64(raw),
  };
}

/**
 * The exact bytes each side signs with its Ed25519 identity key.
 *
 * Built from a context string, the session challenge, and the ephemeral keys
 * in a FIXED order (daemon first) so both sides construct the identical input.
 * The parts are length-prefixed rather than concatenated, so no rearrangement
 * of the pieces can produce the same byte string.
 */
export function kexSigningInput(
  challenge: string,
  daemonEphemeralBase64: string,
  clientEphemeralBase64: string | null,
): ArrayBuffer {
  const parts = [KEX_CONTEXT, challenge, daemonEphemeralBase64, clientEphemeralBase64 ?? ''];
  const encoder = new TextEncoder();
  // `len:value` per part. A value cannot contain its own length prefix, so the
  // encoding is unambiguous.
  return encoder.encode(parts.map((p) => `${p.length}:${p}`).join('')).buffer as ArrayBuffer;
}

/**
 * Derive the two directional keys.
 *
 * @param isDaemon which side is calling, so each assigns `send`/`receive` to
 *   opposite keys. Getting this backwards makes every message fail to decrypt,
 *   loudly, which is the correct direction for that mistake to fail.
 */
export async function deriveRelaySessionKeys(
  myEphemeralPrivate: CryptoKey,
  peerEphemeralPublicBase64: string,
  challenge: string,
  isDaemon: boolean,
): Promise<RelaySessionKeys> {
  const peerPublic = await crypto.subtle.importKey(
    'raw',
    fromBase64(peerEphemeralPublicBase64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublic },
    myEphemeralPrivate,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  // The challenge is the salt: it is fresh per connection and both sides
  // already agree on it, so the same long-term keys never derive the same
  // session keys twice.
  const salt = new TextEncoder().encode(challenge);
  const encoder = new TextEncoder();

  const deriveOne = (info: string): Promise<CryptoKey> =>
    crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

  const daemonToClient = await deriveOne(KDF_INFO_DAEMON_TO_CLIENT);
  const clientToDaemon = await deriveOne(KDF_INFO_CLIENT_TO_DAEMON);

  return isDaemon
    ? { send: daemonToClient, receive: clientToDaemon }
    : { send: clientToDaemon, receive: daemonToClient };
}

/**
 * Encrypt one relay payload.
 *
 * Returns base64 of `nonce || ciphertext`, so the envelope carries everything
 * needed to decrypt except the key.
 */
export async function encryptRelayPayload(key: CryptoKey, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  const packed = new Uint8Array(NONCE_BYTES + ciphertext.byteLength);
  packed.set(nonce, 0);
  packed.set(new Uint8Array(ciphertext), NONCE_BYTES);
  return toBase64(packed.buffer);
}

/**
 * Decrypt one relay payload.
 *
 * Throws on a wrong key, a tampered payload or a truncated envelope; AES-GCM
 * authenticates, so "decrypted to garbage" is not a reachable outcome. Callers
 * must treat a throw as a hostile or broken peer, never as an empty message.
 */
export async function decryptRelayPayload(key: CryptoKey, envelope: string): Promise<string> {
  const packed = new Uint8Array(fromBase64(envelope));
  if (packed.byteLength <= NONCE_BYTES) {
    throw new Error('Relay payload is too short to contain a nonce and ciphertext');
  }
  const nonce = packed.subarray(0, NONCE_BYTES);
  const ciphertext = packed.subarray(NONCE_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
