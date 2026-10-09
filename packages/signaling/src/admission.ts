/**
 * Admission checks of the relay Worker (ADR 0034 section 4 and section 14).
 *
 * Admission is an access-control and abuse-control layer, not a confidentiality
 * layer: nothing in the end-to-end protocol depends on the Worker behaving, and
 * the Worker never holds a pairing secret, a session key or a device private key.
 *
 * THE ADMISSION TICKET `A` IS WORKER-VISIBLE AND AN ABUSE-CONTROL TOKEN ONLY.
 * The Worker sees `A` in clear when a client presents it (and the hash the host
 * registered), so `A` must never be mistaken for a secret and must never be
 * logged. It does not weaken the end-to-end guarantee: `A` is an HMAC output and
 * does not reveal the pairing secret, and the session keys need that secret
 * inside the key derivation. What `A` can do is let whoever sees it first race
 * the legitimate phone for a ten-minute window and burn it: a denial of one
 * pairing, never a compromise. Nothing here relies on it for anything else.
 *
 * The comparisons of ticket hashes go through `admitTagMatches` only. A
 * source-level test bans `===`, `indexOf` and the like on any line that touches
 * a ticket or a hash in this file and in the room.
 */

import {
  type Admit,
  admitTagMatches,
  fromB64u,
  isSmallOrderPublicKey,
  verifyAdmission,
} from '@remi/shared/relay/index.ts';

/** A pairing window the host registered: the hash of the ticket, never the ticket. */
export interface PairingWindow {
  /** An internal handle, so a burn can name a window without comparing hashes. */
  readonly id: string;
  /** `b64u(SHA-256(A))`, as registered. */
  readonly h: string;
  /** Expiry in the room's clock, milliseconds. */
  readonly exp: number;
}

/**
 * A host, or a host's pipe, proves it holds the machine key: the key hashes to
 * the room id, is not a small-order key, and signed the Worker's nonce for the
 * host role in this room. Lengths were fixed by the decoder (key 32, signature
 * 64) and are checked again by `verifyAdmission` (room id 16, nonce 32).
 */
export async function hostProofHolds(
  rid: Uint8Array,
  nonce: Uint8Array,
  admit: Admit,
): Promise<boolean> {
  if (isSmallOrderPublicKey(admit.key)) return false;
  return verifyAdmission('host', admit.key, rid, nonce, admit.signature);
}

/**
 * A client proves it holds the device key it names: not a small-order key, and
 * the signature covers this room, the client role and the Worker's nonce. It
 * says nothing about WHETHER the key may enter; that is the enrolled set or a
 * pairing window.
 */
export async function clientProofHolds(
  rid: Uint8Array,
  nonce: Uint8Array,
  admit: Admit,
): Promise<boolean> {
  if (isSmallOrderPublicKey(admit.key)) return false;
  return verifyAdmission('client', admit.key, rid, nonce, admit.signature);
}

/**
 * The handle of the live window whose registered hash matches the presented
 * ticket, or null. Every live window is compared, with no early exit, each
 * through `admitTagMatches` (a constant-time comparison of SHA-256(ticket) with
 * the registered hash), so the work does not depend on where a match sits.
 * Expired windows are skipped by the caller's clock, not compared.
 */
export async function matchTicket(
  ticket: Uint8Array,
  windows: readonly PairingWindow[],
  nowMs: number,
): Promise<string | null> {
  let matched: string | null = null;
  for (const window of windows) {
    if (window.exp <= nowMs) continue;
    if (await admitTagMatches(ticket, fromB64u(window.h))) matched = window.id;
  }
  return matched;
}
