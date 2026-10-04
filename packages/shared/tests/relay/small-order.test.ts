/**
 * `isSmallOrderPublicKey` against an independent oracle (ADR 0034 section 17.2).
 *
 * The oracle does not read the list under test. It decompresses Ed25519 points
 * with BigInt arithmetic, finds the eight points of the torsion subgroup as the
 * images of arbitrary curve points under multiplication by the prime group
 * order L, and builds every encoding a decoder might accept for them. The
 * function must say yes to exactly those encodings, over a candidate space
 * that includes every y near the ends of the field and every sign bit.
 */

import { describe, expect, test } from 'bun:test';
import { isSmallOrderPublicKey } from '../../src/relay/small-order.ts';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;

function pow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

type Point = readonly [bigint, bigint];

/** The point with this y and the x of the stated parity, or null when none exists. */
function decompress(y: bigint, sign: bigint): Point | null {
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * inv(v));
  x = pow(x, (P + 3n) / 8n);
  if (mod(x * x * v) !== u) x = mod(x * SQRT_M1);
  if (mod(x * x * v) !== u) return null;
  if ((x & 1n) !== sign) x = mod(-x);
  return [x, y];
}

function add(a: Point, b: Point): Point {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const t = mod(D * x1 * x2 * y1 * y2);
  return [mod((x1 * y2 + x2 * y1) * inv(1n + t)), mod((y1 * y2 + x1 * x2) * inv(1n - t))];
}

function multiply(k: bigint, point: Point): Point {
  let result: Point = [0n, 1n];
  let addend = point;
  let n = k;
  while (n > 0n) {
    if (n & 1n) result = add(result, addend);
    addend = add(addend, addend);
    n >>= 1n;
  }
  return result;
}

function encode(y: bigint, sign: bigint): string {
  const bytes = new Uint8Array(32);
  let v = y;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  bytes[31] = (bytes[31] ?? 0) | (sign ? 0x80 : 0);
  return Buffer.from(bytes).toString('hex');
}

/** The eight torsion points: [L] of arbitrary curve points, until all eight have appeared. */
function torsion(): Point[] {
  const found = new Map<string, Point>();
  for (let y = 2n; found.size < 8 && y < 500n; y++) {
    for (const sign of [0n, 1n]) {
      const point = decompress(y, sign);
      if (!point) continue;
      const t = multiply(L, point);
      found.set(`${t[0]},${t[1]}`, t);
    }
  }
  return [...found.values()];
}

/** Every encoding a decoder might accept for a torsion point. */
function oracleEncodings(): Set<string> {
  const out = new Set<string>();
  for (const [x, y] of torsion()) {
    const signs = x === 0n ? [0n, 1n] : [x & 1n];
    const ys = y < 19n ? [y, y + P] : [y];
    for (const yy of ys) for (const s of signs) out.add(encode(yy, s));
  }
  return out;
}

describe('isSmallOrderPublicKey', () => {
  const oracle = oracleEncodings();

  test('the oracle finds the eight torsion points and fourteen encodings', () => {
    expect(torsion()).toHaveLength(8);
    expect(oracle.size).toBe(14);
    // Every torsion point really has order dividing 8.
    for (const point of torsion()) expect(multiply(8n, point)).toEqual([0n, 1n]);
  });

  test('every encoding of a torsion point is refused, and nothing else in the candidate space is', () => {
    const ys = new Set<bigint>();
    for (let i = 0n; i < 40n; i++) {
      ys.add(i);
      ys.add(P - 1n - i);
      ys.add(P + (i % 19n));
    }
    for (const encoding of oracle) {
      const y =
        BigInt(`0x${Buffer.from(encoding, 'hex').reverse().toString('hex')}`) & (2n ** 255n - 1n);
      ys.add(y);
    }
    let positives = 0;
    for (const y of ys) {
      for (const sign of [0n, 1n]) {
        const encoding = encode(y, sign);
        const verdict = isSmallOrderPublicKey(Uint8Array.from(Buffer.from(encoding, 'hex')));
        expect([encoding, verdict]).toEqual([encoding, oracle.has(encoding)]);
        if (verdict) positives++;
      }
    }
    expect(positives).toBe(14);
  });

  test('the identity point, the order-2 point and the order-4 point are refused by name', () => {
    expect(isSmallOrderPublicKey(Uint8Array.from(Buffer.from(encode(1n, 0n), 'hex')))).toBe(true);
    expect(isSmallOrderPublicKey(Uint8Array.from(Buffer.from(encode(P - 1n, 0n), 'hex')))).toBe(
      true,
    );
    expect(isSmallOrderPublicKey(Uint8Array.from(Buffer.from(encode(0n, 0n), 'hex')))).toBe(true);
  });

  test('ordinary keys and wrong lengths are not small-order', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    expect(isSmallOrderPublicKey(raw)).toBe(false);
    expect(isSmallOrderPublicKey(new Uint8Array(31))).toBe(false);
    expect(isSmallOrderPublicKey(new Uint8Array(33))).toBe(false);
    expect(isSmallOrderPublicKey(new Uint8Array(0))).toBe(false);
  });
});
