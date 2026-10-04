/**
 * Sealing a body to a recipient's P-256 key (ADR 0034 section 10): the ECIES
 * shape of `sealed-answer.ts`, used for pushes (daemon to device) and later for
 * lock-screen answers. Base-mode ECIES does not authenticate the sender.
 *
 *   sealed = E (65) || nonce (12) || AES-256-GCM(key, nonce, aad, plaintext)
 *   key    = HKDF-SHA256(ECDH(e, R), salt = E, info = lps(label, R), 32)
 */

import { type Bytes, concat, lps, own, utf8 } from './bytes.ts';
import { LABEL, MAX_PUSH_PLAINTEXT, MAX_QUESTION_ID, RID_LEN } from './constants.ts';
import { RelayError } from './errors.ts';
import { type EcPair, type Rng, ecGenerate, ecdh, hkdf } from './primitives.ts';

const EPHEMERAL = 65;
const NONCE = 12;
const TAG = 16;

/** `aad = rid || question_id`. The question id is also the APNS collapse id. */
export function pushAad(rid: Uint8Array, questionId: string): Bytes {
  const id = utf8(questionId);
  if (rid.length !== RID_LEN || id.length < 1 || id.length > MAX_QUESTION_ID) {
    throw new RelayError('MALFORMED');
  }
  return concat(rid, id);
}

async function sealKey(
  shared: Uint8Array,
  ephemeral: Uint8Array,
  recipient: Uint8Array,
): Promise<CryptoKey> {
  const raw = await hkdf(shared, ephemeral, lps(LABEL.seal, recipient), 32);
  try {
    return await crypto.subtle.importKey('raw', own(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

export async function seal(
  recipientPublicKey: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  random: Rng,
): Promise<Bytes> {
  if (plaintext.length < 1) throw new RelayError('MALFORMED');
  if (plaintext.length > MAX_PUSH_PLAINTEXT) throw new RelayError('OVERSIZE');
  const ephemeral = await ecGenerate(random);
  const nonce = random(NONCE);
  const shared = await ecdh(ephemeral.privateKey, recipientPublicKey);
  try {
    const key = await sealKey(shared, ephemeral.publicKey, recipientPublicKey);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: own(nonce), additionalData: own(aad), tagLength: 128 },
      key,
      own(plaintext),
    );
    return concat(ephemeral.publicKey, nonce, new Uint8Array(ciphertext));
  } finally {
    shared.fill(0);
  }
}

/** Any failure, of length, point, tag or AAD, is `DECRYPT`. */
export async function openSeal(
  recipient: EcPair,
  aad: Uint8Array,
  sealed: Uint8Array,
): Promise<Bytes> {
  if (
    sealed.length < EPHEMERAL + NONCE + TAG + 1 ||
    sealed.length > EPHEMERAL + NONCE + TAG + MAX_PUSH_PLAINTEXT
  ) {
    throw new RelayError('DECRYPT');
  }
  const ephemeral = sealed.subarray(0, EPHEMERAL);
  let shared: Uint8Array | null = null;
  try {
    shared = await ecdh(recipient.privateKey, ephemeral);
    const key = await sealKey(shared, ephemeral, recipient.publicKey);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: own(sealed.slice(EPHEMERAL, EPHEMERAL + NONCE)),
          additionalData: own(aad),
          tagLength: 128,
        },
        key,
        own(sealed.slice(EPHEMERAL + NONCE)),
      ),
    );
  } catch {
    throw new RelayError('DECRYPT');
  } finally {
    shared?.fill(0);
  }
}
