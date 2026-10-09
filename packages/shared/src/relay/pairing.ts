/**
 * Pairing token, pairing offers, the human fingerprint and the Worker admission
 * formats (ADR 0034 sections 4, 5 and 9).
 *
 * Expiry and single use of an offer are the daemon's to enforce (R3); what can
 * be checked without state is here. Admission functions are what the Worker (R2)
 * and the clients import so both ends sign and verify the same bytes.
 */

import { type Bytes, b64u, be64, concat, ctEqual, fromB64u, lps, readBe64, utf8 } from './bytes.ts';
import {
  LABEL,
  MAX_PAIRING_OFFERS,
  PAIRING_SKEW_SECONDS,
  PAIRING_TTL_SECONDS,
  RID_LEN,
} from './constants.ts';
import { RelayError } from './errors.ts';
import {
  type Rng,
  type Signer,
  hmacSha256,
  importEcPublic,
  ridOf,
  sha256,
  verifySignature,
} from './primitives.ts';

/** One live pairing token on the host. The daemon flips `used` when it burns the offer. */
export interface PairingOffer {
  readonly secret: Uint8Array;
  readonly expiresAtMs: number;
  readonly used: boolean;
}

export function createPairingOffer(random: Rng, nowMs: number): PairingOffer {
  return { secret: random(32), expiresAtMs: nowMs + PAIRING_TTL_SECONDS * 1000, used: false };
}

/** The pure liveness check; a host machine ignores offers that fail it. */
export const isLiveOffer = (offer: PairingOffer, nowMs: number): boolean =>
  !offer.used && offer.secret.length === 32 && nowMs < offer.expiresAtMs;

/** The offers a host will try, in order, capped. */
export const liveOffers = (offers: readonly PairingOffer[], nowMs: number): PairingOffer[] =>
  offers.filter((o) => isLiveOffer(o, nowMs)).slice(0, MAX_PAIRING_OFFERS);

// -- Token --

export interface PairingToken {
  readonly relayUrl: string;
  readonly machinePublicKey: Uint8Array;
  readonly secret: Uint8Array;
  readonly expiresAtSec: number;
  /** The daemon's P-256 key for answers sealed to the daemon (R6); optional. */
  readonly sealPublicKey?: Uint8Array;
}

const PREFIX = 'remi-pair2:';
const TOKEN_VERSION = 2;
const URL_PATTERN =
  /^(wss:\/\/[a-z0-9.-]+|ws:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;

export function encodePairingToken(t: PairingToken): string {
  const url = utf8(t.relayUrl);
  if (t.machinePublicKey.length !== 32 || t.secret.length !== 32) throw new RelayError('TOKEN');
  if (t.sealPublicKey && t.sealPublicKey.length !== 65) throw new RelayError('TOKEN');
  if (!Number.isSafeInteger(t.expiresAtSec) || t.expiresAtSec < 0) throw new RelayError('TOKEN');
  if (url.length < 1 || url.length > 512 || !URL_PATTERN.test(t.relayUrl)) {
    throw new RelayError('TOKEN');
  }
  return (
    PREFIX +
    b64u(
      concat(
        Uint8Array.of(TOKEN_VERSION, t.sealPublicKey ? 1 : 0),
        be64(t.expiresAtSec),
        t.machinePublicKey,
        t.secret,
        t.sealPublicKey ?? new Uint8Array(0),
        url,
      ),
    )
  );
}

/** Strict decode with the clock injected as `nowSec`; any failure is `TOKEN` or `EXPIRED`. */
export async function decodePairingToken(text: string, nowSec: number): Promise<PairingToken> {
  if (!text.startsWith(PREFIX)) throw new RelayError('TOKEN');
  let b: Bytes;
  try {
    b = fromB64u(text.slice(PREFIX.length));
  } catch {
    throw new RelayError('TOKEN');
  }
  if (b.length < 75 || b[0] !== TOKEN_VERSION || ((b[1] ?? 0) & 0xfe) !== 0) {
    throw new RelayError('TOKEN');
  }
  const hasSeal = (b[1] ?? 0) === 1;
  const urlStart = 74 + (hasSeal ? 65 : 0);
  const expiresAtSec = readBe64(b, 2);
  if (expiresAtSec === null || b.length - urlStart > 512) {
    throw new RelayError('TOKEN');
  }
  // Invalid UTF-8 decodes to U+FFFD, which the pattern below refuses.
  const relayUrl = new TextDecoder().decode(b.subarray(urlStart));
  if (!URL_PATTERN.test(relayUrl)) throw new RelayError('TOKEN');
  if (expiresAtSec <= nowSec) throw new RelayError('EXPIRED');
  if (expiresAtSec > nowSec + PAIRING_TTL_SECONDS + PAIRING_SKEW_SECONDS) {
    throw new RelayError('TOKEN');
  }
  const sealPublicKey = hasSeal ? b.slice(74, 139) : undefined;
  if (sealPublicKey) {
    try {
      await importEcPublic(sealPublicKey);
    } catch {
      throw new RelayError('TOKEN');
    }
  }
  return {
    relayUrl,
    machinePublicKey: b.slice(10, 42),
    secret: b.slice(42, 74),
    expiresAtSec,
    ...(sealPublicKey ? { sealPublicKey } : {}),
  };
}

// -- Fingerprint --

/** `xxxx-xxxx-xxxx-xxxx`: 8 bytes of SHA-256 over both public keys. */
export async function fingerprintOf(
  devicePublicKey: Uint8Array,
  machinePublicKey: Uint8Array,
): Promise<string> {
  const digest = await sha256(lps(LABEL.fingerprint, devicePublicKey, machinePublicKey));
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

// -- Worker admission (formats only) --

export type AdmissionRole = 'host' | 'client';

export const admissionInput = (role: AdmissionRole, rid: Uint8Array, nonce: Uint8Array): Bytes =>
  lps(role === 'host' ? LABEL.admitHost : LABEL.admitClient, rid, nonce);

export async function signAdmission(
  signer: Signer,
  role: AdmissionRole,
  rid: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  return signer.sign(admissionInput(role, rid, nonce));
}

/** For a host proof the public key must also hash to `rid`. Fails closed. */
export async function verifyAdmission(
  role: AdmissionRole,
  publicKey: Uint8Array,
  rid: Uint8Array,
  nonce: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (rid.length !== RID_LEN || nonce.length !== 32) return false;
  if (role === 'host' && !ctEqual(await ridOf(publicKey), rid)) return false;
  return verifySignature(publicKey, admissionInput(role, rid, nonce), signature);
}

/** `A = HMAC-SHA256(psk, "remi-relay-v2 admit")`, the pairing-window ticket. */
export const admitTag = (pairingSecret: Uint8Array): Promise<Uint8Array> =>
  hmacSha256(pairingSecret, utf8(LABEL.admitTag));

/** What the host registers with the Worker: the hash of the ticket, never the ticket. */
export const admitTagHash = (tag: Uint8Array): Promise<Uint8Array> => sha256(tag);

export async function admitTagMatches(
  presentedTag: Uint8Array,
  registeredHash: Uint8Array,
): Promise<boolean> {
  return ctEqual(await sha256(presentedTag), registeredHash);
}
