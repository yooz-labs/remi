/**
 * The committed admission vectors (`vectors.json`, ADR 0034 section 13) run through
 * the WORKER's own admission functions, not the library's: every `admission_verify`
 * case must get the verdict the file records, and the ticket vector must match through
 * `matchTicket`. The same file is checked by the library tests, by the Python verifier
 * and by the CryptoKit verifier, so the Worker, the clients and the host agree byte for byte.
 */

import { describe, expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import vectors from '../../shared/tests/fixtures/relay-v2/vectors.json';
import { clientProofHolds, hostProofHolds, matchTicket } from '../src/admission.ts';

const { b64u } = relayV2;
const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

interface AdmissionCase {
  kind: string;
  name: string;
  expect: 'accept' | 'reject';
  role: 'host' | 'client';
  publicKey: string;
  rid: string;
  nonce: string;
  signature: string;
}

const cases = (vectors.negative as { kind: string }[]).filter(
  (c) => c.kind === 'admission_verify',
) as AdmissionCase[];

describe('admission_verify vectors through the Worker', () => {
  test('the file has the cases this test relies on', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.expect === 'accept')).toHaveLength(2);
    expect(new Set(cases.map((c) => c.role))).toEqual(new Set(['host', 'client']));
  });

  test.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const admit = { key: unhex(c.publicKey), signature: unhex(c.signature) };
    const check = c.role === 'host' ? hostProofHolds : clientProofHolds;
    expect(await check(unhex(c.rid), unhex(c.nonce), admit)).toBe(c.expect === 'accept');
  });
});

describe('the ticket vector through matchTicket', () => {
  const ticket = unhex(vectors.admission.ticket);
  const window = { id: 'window-a', h: b64u(unhex(vectors.admission.ticketHash)), exp: 10_000 };
  const other = { id: 'window-b', h: b64u(new Uint8Array(32).fill(9)), exp: 10_000 };

  test('the recorded ticket matches the window that registered its hash', async () => {
    expect(await matchTicket(ticket, [window], 1)).toBe('window-a');
  });

  test('wherever that window sits among the others', async () => {
    expect(await matchTicket(ticket, [window, other], 1)).toBe('window-a');
    expect(await matchTicket(ticket, [other, window], 1)).toBe('window-a');
  });

  test('another ticket matches nothing', async () => {
    expect(await matchTicket(new Uint8Array(32).fill(1), [window, other], 1)).toBeNull();
  });

  test('a window past its expiry matches nothing, and one at its expiry too', async () => {
    expect(await matchTicket(ticket, [window], 10_001)).toBeNull();
    expect(await matchTicket(ticket, [window], 10_000)).toBeNull();
    expect(await matchTicket(ticket, [window], 9_999)).toBe('window-a');
  });

  test('no windows, no match', async () => {
    expect(await matchTicket(ticket, [], 1)).toBeNull();
  });
});
