/** Byte, length-prefix and base64url helpers (ADR 0034 section 2). */

import { RelayError } from './errors.ts';

/** A byte array WebCrypto accepts: backed by an ArrayBuffer, never a SharedArrayBuffer. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** View `u` as `Bytes`, copying only when its backing store is not an ArrayBuffer. */
export const own = (u: Uint8Array): Bytes =>
  u.buffer instanceof ArrayBuffer ? (u as Bytes) : Uint8Array.from(u);

const encoder = new TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF as the character it is, so decode(encode(x)) is x.
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const utf8 = (s: string): Bytes => encoder.encode(s);

/** Strict UTF-8 decode; invalid input is `MALFORMED`. */
export function fromUtf8(b: Uint8Array): string {
  try {
    return strictDecoder.decode(b);
  } catch {
    throw new RelayError('MALFORMED');
  }
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Unsigned big-endian 64-bit integer; `n` must be a safe integer. */
export function be64(n: number): Bytes {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(n / 2 ** 32));
  view.setUint32(4, n >>> 0);
  return out;
}

/** Read a be64 at `offset`; null when it does not fit a safe integer (always above any limit). */
export function readBe64(b: Uint8Array, offset: number): number | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hi = view.getUint32(offset);
  return hi >= 2 ** 21 ? null : hi * 2 ** 32 + view.getUint32(offset + 4);
}

/** `lps(a, b, ...)`: each part as `be16(len) || bytes`. Strings are ASCII/UTF-8. */
export function lps(...parts: (Uint8Array | string)[]): Bytes {
  const bytes = parts.map((p) => (typeof p === 'string' ? utf8(p) : p));
  const out: Uint8Array[] = [];
  for (const p of bytes) {
    if (p.length > 0xffff) throw new RelayError('MALFORMED');
    out.push(Uint8Array.of(p.length >> 8, p.length & 0xff), p);
  }
  return concat(...out);
}

export function b64u(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Strict base64url: alphabet only, canonical (no stray trailing bits), else `MALFORMED`. */
export function fromB64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new RelayError('MALFORMED');
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const out = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  if (b64u(out) !== s) throw new RelayError('MALFORMED');
  return out;
}

/** XOR-accumulate comparison. Best effort in JavaScript; nothing relies on it alone. */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Overwrite secret bytes in place. */
export function zero(...parts: (Uint8Array | null | undefined)[]): void {
  for (const p of parts) p?.fill(0);
}
