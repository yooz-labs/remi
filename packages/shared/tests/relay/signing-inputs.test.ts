/**
 * The disjointness invariant of the v2 signed messages (ADR 0034 section 18).
 *
 * The v2 machine key is the Ed25519 identity the v1 Authenticator already keeps,
 * and the v2 device key migrates from the v1 phone identity, so a v2 signature
 * must never be usable as a v1 signature or the reverse. v1 direct auth signs a
 * BARE 32-byte challenge, the v1 relay key exchange signs `len:value` text, and
 * the iOS answer path signs `sid|qid|ans`. Every v2 signed message is
 * `lps(label, ...)`: at least 54 bytes, starting with a zero byte (the high byte
 * of a short label's length) and then its own distinct label, so it can equal
 * neither a 32-byte challenge nor a message of another label. The invariant is
 * implicit in the construction; these tests make a change that breaks it fail.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fromBase64, generateChallenge } from '../../src/crypto.ts';
import { kexSigningInput } from '../../src/relay-crypto.ts';
import * as r from '../../src/relay/internal.ts';
import { hex, seed } from './helpers.ts';

const lpLabel = (name: string): Uint8Array => r.lps(name);

const H = seed('signing input hash');
const RID = seed('signing input rid').slice(0, 16);
const NONCE = seed('signing input nonce');

const BUILDERS: [string, string, Uint8Array][] = [
  ['host transcript', r.LABEL.host, r.hostSigningInput(H)],
  ['client transcript', r.LABEL.client, r.clientSigningInput(H)],
  ['host admission', r.LABEL.admitHost, r.admissionInput('host', RID, NONCE)],
  ['client admission', r.LABEL.admitClient, r.admissionInput('client', RID, NONCE)],
  ['signer self-check', r.LABEL.signerCheck, r.SIGNER_CHECK],
];

const startsWith = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);

describe('v2 signing inputs are disjoint from every other signed message', () => {
  test('each is at least 54 bytes and begins with its own length-prefixed label', () => {
    for (const [name, text, input] of BUILDERS) {
      expect([name, input.length >= 54]).toEqual([name, true]);
      expect([name, startsWith(input, lpLabel(text))]).toEqual([name, true]);
      expect([name, input[0]]).toEqual([name, 0]);
    }
  });

  test("the labels are distinct, and no input starts with another input's label", () => {
    const labels = BUILDERS.map(([, text]) => text);
    expect(new Set(labels).size).toBe(labels.length);
    for (const [name, , input] of BUILDERS) {
      for (const [otherName, otherText] of BUILDERS) {
        if (otherName === name) continue;
        expect([name, otherName, startsWith(input, lpLabel(otherText))]).toEqual([
          name,
          otherName,
          false,
        ]);
      }
    }
    expect(BUILDERS.every(([, text]) => text.startsWith('remi-relay-v2 '))).toBe(true);
  });

  test('none can be a v1 direct-auth challenge, a v1 key exchange input or an answer message', () => {
    const challenge = fromBase64(generateChallenge());
    expect(challenge.byteLength).toBe(32);
    const kex = new Uint8Array(kexSigningInput('challenge', 'daemon-ephemeral', null));
    const answer = new TextEncoder().encode('session-id|question-id|answer text');
    for (const [name, , input] of BUILDERS) {
      expect([name, input.length > challenge.byteLength]).toEqual([name, true]);
      expect([name, hex(input) === hex(new Uint8Array(challenge))]).toEqual([name, false]);
      expect([name, input[0] === kex[0]]).toEqual([name, false]);
      expect([name, input[0] === answer[0]]).toEqual([name, false]);
    }
    // v1 texts start with printable ASCII; a v2 input starts with a zero byte.
    expect(kex[0]).toBeGreaterThan(0x1f);
    expect(answer[0]).toBeGreaterThan(0x1f);
  });

  test('a signature over one v2 input does not verify as another', async () => {
    const signer = await r.signerFromSeed(seed('signing input key'));
    const host = await signer.sign(r.hostSigningInput(H));
    for (const [name, , input] of BUILDERS) {
      const expected = name === 'host transcript';
      expect([name, await r.verifySignature(signer.publicKey, input, host)]).toEqual([
        name,
        expected,
      ]);
    }
  });

  test('every Ed25519 signing call in the library passes one of the builders', () => {
    const dir = join(import.meta.dir, '..', '..', 'src', 'relay');
    const calls: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      if (file === 'deterministic.ts') continue;
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        // The raw WebCrypto primitive is counted separately below.
        if (t.includes('subtle.sign(')) continue;
        for (const m of t.matchAll(/\.sign\(([^)]*\)?)/g)) calls.push(`${file}: ${m[1]}`);
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      const allowed = /(hostSigningInput|clientSigningInput|admissionInput)\(|SIGNER_CHECK/;
      expect([call, allowed.test(call)]).toEqual([call, true]);
    }
    // And the raw primitive is only reached through `signerFromKey`'s `sign`.
    const prim = readFileSync(join(dir, 'primitives.ts'), 'utf8');
    expect(prim.match(/subtle\.sign\('Ed25519'/g)?.length).toBe(1);
  });
});
