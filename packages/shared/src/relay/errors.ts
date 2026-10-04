/**
 * Typed failures of the relay v2 library (ADR 0034 section 8).
 *
 * The code exists for tests and the local log. It never reaches the wire:
 * every failure, whichever check produced it, closes with the same constants.
 */

import { CLOSE_CODE, CLOSE_REASON } from './constants.ts';

export type RelayErrorCode =
  | 'MALFORMED'
  | 'VERSION'
  | 'TYPE'
  | 'MODE'
  | 'MODE_MISMATCH'
  | 'OVERSIZE'
  | 'BAD_SIGNATURE'
  | 'DECRYPT'
  | 'COUNTER'
  | 'COUNTER_LIMIT'
  | 'UNKNOWN_DEVICE'
  | 'PAIRING'
  | 'EXPIRED'
  | 'STATE'
  | 'NAME'
  | 'TOKEN'
  | 'QUEUE_FULL'
  | 'CLOSED'
  | 'ENDED'
  | 'IO';

/** The one close every failure uses. */
export const FAILURE_CLOSE = Object.freeze({ code: CLOSE_CODE, reason: CLOSE_REASON });

export class RelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode) {
    super(code);
    this.name = 'RelayError';
    this.code = code;
  }

  /** The wire close for this failure: identical for every code. */
  get close(): typeof FAILURE_CLOSE {
    return FAILURE_CLOSE;
  }
}

/** Keep a RelayError, wrap anything else (an engine failure) as `IO`. */
export function asRelayError(e: unknown): RelayError {
  return e instanceof RelayError ? e : new RelayError('IO');
}
