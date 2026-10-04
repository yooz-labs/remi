/**
 * Shared helpers for the relay v2 tests.
 *
 * Everything is derived from public labels, never from `crypto.getRandomValues`,
 * so a failing run reproduces byte for byte and the committed vectors can be
 * regenerated exactly. No key produced here is real.
 */

import { createHash } from 'node:crypto';
import { relayV2 as r } from '../../src/index.ts';

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const unhex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(h, 'hex'));
export const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

/** 32 bytes derived from a public label: `SHA-256("remi-relay-v2 test vector " || label)`. */
export const seed = (label: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(`remi-relay-v2 test vector ${label}`).digest());

/** A deterministic byte stream: block `i` is `SHA-256(label || ":" || i)`. */
export function seededRandom(label: string): r.Rng & { draws: Uint8Array[] } {
  let block = 0;
  const draws: Uint8Array[] = [];
  const rng = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let o = 0; o < n; o += 32) {
      const digest = createHash('sha256').update(`${label}:${block++}`).digest();
      out.set(digest.subarray(0, Math.min(32, n - o)), o);
    }
    draws.push(out.slice());
    return out;
  };
  return Object.assign(rng, { draws });
}

/** Run a promise that must reject with a `RelayError` and return its code. */
export async function codeOf(p: Promise<unknown>): Promise<r.RelayErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof r.RelayError) return e.code;
    throw e;
  }
  throw new Error('expected a RelayError, got a resolved promise');
}

export function codeOfSync(fn: () => unknown): r.RelayErrorCode {
  try {
    fn();
  } catch (e) {
    if (e instanceof r.RelayError) return e.code;
    throw e;
  }
  throw new Error('expected a RelayError, got a return value');
}
