/**
 * The wire encoding of relay v2 frames and a decoder that accepts nothing else
 * (ADR 0034 sections 6.1 and 7).
 *
 * Control frames are canonical compact JSON. The decoder parses, validates the
 * shape, rebuilds the canonical text from the decoded values and requires it to
 * equal the received text, so duplicate keys, reordered keys, whitespace and
 * alternative number or escape forms are all rejected by one comparison.
 */

import { type Bytes, b64u, be64, concat, fromB64u, own, readBe64, utf8 } from './bytes.ts';
import {
  BYE_FRAME,
  MAX_CONTROL_TEXT,
  MAX_COUNTER,
  MAX_FRAME,
  MIN_FRAME,
  type Mode,
  TYPE_BYE,
  TYPE_DATA,
  V,
} from './constants.ts';
import { RelayError } from './errors.ts';

type ControlType = 'hello' | 'hello_ack' | 'auth' | 'ready';
type Size = number | readonly [min: number, max: number];

/** Keys in wire order after `v` and `t`, with the exact decoded length of each value. */
const FIELDS: Readonly<Record<ControlType, readonly (readonly [key: string, size: Size])[]>> = {
  hello: [
    ['m', 0],
    ['e', 65],
    ['n', 32],
  ],
  hello_ack: [
    ['e', 65],
    ['n', 32],
    ['s', 64],
  ],
  auth: [['c', [112, 176]]],
  ready: [['c', 17]],
};

function encodeControl(t: ControlType, values: readonly (string | Uint8Array)[]): string {
  const o: Record<string, string | number> = { v: V, t };
  FIELDS[t].forEach(([key], i) => {
    const value = values[i] as string | Uint8Array;
    o[key] = typeof value === 'string' ? value : b64u(value);
  });
  return JSON.stringify(o);
}

function decodeControl(frame: unknown, t: ControlType): (string | Bytes)[] {
  if (typeof frame !== 'string') throw new RelayError('TYPE');
  if (utf8(frame).length > MAX_CONTROL_TEXT) throw new RelayError('OVERSIZE');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(frame);
  } catch {
    // Not JSON: falls to the shape check below, which refuses it.
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RelayError('MALFORMED');
  }
  const o = parsed as Record<string, unknown>;
  if (!Number.isInteger(o['v'])) throw new RelayError('MALFORMED');
  if (o['v'] !== V) throw new RelayError('VERSION');
  if (o['t'] !== t) throw new RelayError('TYPE');
  if (t === 'hello' && o['m'] !== 'pair' && o['m'] !== 'resume') throw new RelayError('MODE');

  const spec = FIELDS[t];
  const values = spec.map(([key, size]): string | Bytes => {
    const raw = o[key];
    if (typeof raw !== 'string') throw new RelayError('MALFORMED');
    if (size === 0) return raw;
    const bytes = fromB64u(raw);
    const [min, max] = typeof size === 'number' ? [size, size] : size;
    if (bytes.length < min || bytes.length > max) throw new RelayError('MALFORMED');
    return bytes;
  });
  if (encodeControl(t, values) !== frame) throw new RelayError('MALFORMED');
  return values;
}

export const encodeHello = (mode: Mode, ephemeral: Uint8Array, nonce: Uint8Array): string =>
  encodeControl('hello', [mode, ephemeral, nonce]);

export function decodeHello(frame: unknown): { mode: Mode; ephemeral: Bytes; nonce: Bytes } {
  const [mode, ephemeral, nonce] = decodeControl(frame, 'hello') as [Mode, Bytes, Bytes];
  if (ephemeral[0] !== 4) throw new RelayError('MALFORMED');
  return { mode, ephemeral, nonce };
}

export const encodeHelloAck = (
  ephemeral: Uint8Array,
  nonce: Uint8Array,
  signature: Uint8Array,
): string => encodeControl('hello_ack', [ephemeral, nonce, signature]);

export function decodeHelloAck(frame: unknown): {
  ephemeral: Bytes;
  nonce: Bytes;
  signature: Bytes;
} {
  const [ephemeral, nonce, signature] = decodeControl(frame, 'hello_ack') as [Bytes, Bytes, Bytes];
  if (ephemeral[0] !== 4) throw new RelayError('MALFORMED');
  return { ephemeral, nonce, signature };
}

/** `auth` and `ready` carry one AEAD ciphertext, counter 0 implied. */
export const encodeSealedControl = (t: 'auth' | 'ready', ciphertext: Uint8Array): string =>
  encodeControl(t, [ciphertext]);

export const decodeSealedControl = (frame: unknown, t: 'auth' | 'ready'): Bytes =>
  decodeControl(frame, t)[0] as Bytes;

export const encodeDataFrame = (
  counter: number,
  ciphertext: Uint8Array,
  type: number = TYPE_DATA,
): Bytes => concat(Uint8Array.of(type), be64(counter), ciphertext);

/** Steps 1 to 6 of the receiver (ADR 0034 section 7); the caller checks order and the tag. */
export function decodeDataFrame(frame: unknown): {
  type: number;
  counter: number;
  ciphertext: Bytes;
} {
  if (!(frame instanceof Uint8Array)) throw new RelayError('TYPE');
  if (frame.length < BYE_FRAME) throw new RelayError('MALFORMED');
  if (frame.length > MAX_FRAME) throw new RelayError('OVERSIZE');
  const type = frame[0] as number;
  if (type !== TYPE_DATA && type !== TYPE_BYE) throw new RelayError('TYPE');
  if (type === TYPE_BYE ? frame.length !== BYE_FRAME : frame.length < MIN_FRAME) {
    throw new RelayError('MALFORMED');
  }
  const counter = readBe64(frame, 1);
  if (counter === null || counter > MAX_COUNTER) throw new RelayError('COUNTER_LIMIT');
  return { type, counter, ciphertext: own(frame.subarray(9)) };
}
