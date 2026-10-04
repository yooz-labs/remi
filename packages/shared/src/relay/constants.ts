/**
 * Relay protocol v2 constants (ADR 0034 section 2).
 *
 * Every value here is part of the wire contract: the test vectors pin the bytes
 * that depend on them, so changing one is a protocol change, not a tweak.
 */

export const V = 2;
export const RID_LEN = 16;

export type Mode = 'pair' | 'resume';
export const MODE_BYTE: Readonly<Record<Mode, number>> = { pair: 1, resume: 2 };

export const DIR_C2H = 1;
export const DIR_H2C = 2;
export type Direction = typeof DIR_C2H | typeof DIR_H2C;

export const TYPE_AUTH = 1;
export const TYPE_READY = 2;
export const TYPE_DATA = 3;

export const MAX_COUNTER = 2 ** 40;
export const MAX_PLAINTEXT = 524288;
/** Type byte, counter, tag. */
export const FRAME_OVERHEAD = 1 + 8 + 16;
export const MIN_FRAME = FRAME_OVERHEAD + 1;
export const MAX_FRAME = FRAME_OVERHEAD + MAX_PLAINTEXT;
export const MAX_CONTROL_TEXT = 512;
export const MAX_DEVICE_NAME = 64;
export const MAX_PENDING_SENDS = 64;
export const MAX_PAIRING_OFFERS = 8;

export const HANDSHAKE_TIMEOUT_MS = 30_000;
export const PAIR_CONFIRM_TIMEOUT_MS = 120_000;
export const PAIRING_TTL_SECONDS = 600;
export const PAIRING_SKEW_SECONDS = 60;

export const MAX_PUSH_PLAINTEXT = 2048;
export const MAX_QUESTION_ID = 64;

/** What every failure sends on the wire: the same code and reason, always. */
export const CLOSE_CODE = 4400;
export const CLOSE_REASON = 'closed';
/** A deliberate local close is not a failure and says so. */
export const CLOSE_NORMAL = 1000;

/** Domain-separation labels (ADR 0034 sections 4, 6, 7, 9, 10). */
export const LABEL = {
  aad: 'remi-relay-v2',
  h1: 'remi-relay-v2 H1',
  h2: 'remi-relay-v2 H2',
  host: 'remi-relay-v2 host',
  client: 'remi-relay-v2 client',
  c2h: 'remi-relay-v2 c2h',
  h2c: 'remi-relay-v2 h2c',
  admitHost: 'remi-relay-v2 admit host',
  admitClient: 'remi-relay-v2 admit client',
  admitTag: 'remi-relay-v2 admit',
  fingerprint: 'remi-relay-v2 fingerprint',
  seal: 'remi-relay-v2 seal',
} as const;
