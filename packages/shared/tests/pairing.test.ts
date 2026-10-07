/**
 * The pairing link (#1275, ADR 0037): the checked-in vectors every client decodes, and the encoder
 * that made them. A Swift client reads the same `fixtures/pairing/vectors.json`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint, fromBase64 } from '../src/crypto.ts';
import {
  PAIRING_LINK_PREFIX,
  type PairingCode,
  decodePairingLink,
  encodePairingLink,
  generatePairingNonce,
  isPairingNonce,
} from '../src/pairing.ts';
import { buildVectors } from './fixtures/pairing/generate.ts';

const VECTORS_FILE = join(import.meta.dir, 'fixtures', 'pairing', 'vectors.json');
const vectors = JSON.parse(readFileSync(VECTORS_FILE, 'utf-8')) as Awaited<
  ReturnType<typeof buildVectors>
>;
const built = await buildVectors();
const at = { nowSeconds: vectors.now, protocolVersion: vectors.protocolVersion };

describe('pairing link vectors (#1275)', () => {
  test('the checked-in vectors are what the generator makes (regenerate after a deliberate change)', () => {
    expect(vectors).toEqual(JSON.parse(JSON.stringify(built)));
  });

  test('there are vectors to read', () => {
    expect(vectors.valid.length).toBeGreaterThanOrEqual(5);
    expect(vectors.invalid.length).toBeGreaterThanOrEqual(25);
  });

  for (const vector of built.valid) {
    test(`decodes: ${vector.name}`, () => {
      expect(decodePairingLink(vector.link, at)).toEqual({ ok: true, code: vector.code });
    });
  }

  for (const vector of built.invalid) {
    test(`refuses with ${vector.error}: ${vector.name}`, () => {
      const result = decodePairingLink(vector.link, at);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(vector.error as never);
    });
  }

  test("each valid vector's fingerprint is the SHA-256 prefix of its key, as the app shows it", async () => {
    for (const vector of vectors.valid) {
      const raw = fromBase64(vector.code.key);
      expect(raw.byteLength).toBe(32);
      expect(vector.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(await fingerprint(raw)).toBe(vector.fingerprint);
    }
  });
});

describe('encodePairingLink and nonces (#1275)', () => {
  const base = vectors.valid[0]?.code as PairingCode;

  test('encode then decode gives the same code, with a fresh nonce', () => {
    const code = { ...base, nonce: generatePairingNonce() };
    const link = encodePairingLink(code);
    expect(link.startsWith(PAIRING_LINK_PREFIX)).toBe(true);
    expect(decodePairingLink(link, at)).toEqual({ ok: true, code });
  });

  test('a code that would not decode cannot be encoded', () => {
    for (const bad of [
      { ...base, v: 2 },
      { ...base, port: 0 },
      { ...base, nonce: 'short' },
      { ...base, name: 'a‮b' },
    ]) {
      expect(() => encodePairingLink(bad)).toThrow();
    }
  });

  test('nonces are canonical, 16 bytes, and do not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const nonce = generatePairingNonce();
      expect(isPairingNonce(nonce)).toBe(true);
      expect(nonce).toHaveLength(22);
      seen.add(nonce);
    }
    expect(seen.size).toBe(200);
  });

  test('isPairingNonce refuses what is not one', () => {
    for (const value of [
      undefined,
      7,
      '',
      'A'.repeat(21),
      'A'.repeat(23),
      `${'A'.repeat(21)}B`,
      'AAAAAAAAAAAAAAAAAAAAA=',
    ]) {
      expect(isPairingNonce(value), String(value)).toBe(false);
    }
  });

  test('a decode with the default clock refuses the old vectors as expired', () => {
    const result = decodePairingLink(vectors.valid[0]?.link as string);
    expect(result).toMatchObject({ ok: false, error: 'EXPIRED' });
  });
});
