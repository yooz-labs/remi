#!/usr/bin/env bun
/**
 * The pairing link test vectors (#1275, ADR 0037), built deterministically: a fixed machine key, a
 * fixed nonce and a fixed clock. Every client (TypeScript here, Swift in RemiKit) must decode the
 * valid ones to the same code and refuse each invalid one with the same error.
 *
 * Usage: bun packages/shared/tests/fixtures/pairing/generate.ts
 *        bunx biome check --write packages/shared/tests/fixtures/pairing/
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PairingCode, encodePairingLink } from '../../../src/pairing.ts';

/** The clock every vector is read at. */
export const VECTOR_NOW = 1_760_000_000;

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const NONCE = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i)).toString('base64url');

const BASE: PairingCode = {
  v: 1,
  name: 'fixture-mac',
  host: '192.168.1.23',
  port: 18765,
  key: KEY,
  nonce: NONCE,
  exp: VECTOR_NOW + 300,
  proto: 1,
};

/** A link whose body is exactly `json`, encoded as base64url without padding. */
const raw = (json: string): string =>
  `remi://pair#${Buffer.from(json, 'utf8').toString('base64url')}`;
/** `BASE` with `changes`, keys in the order given, as compact JSON. */
const withFields = (changes: Record<string, unknown>): string =>
  JSON.stringify({ ...BASE, ...changes });

export function buildVectors() {
  const valid = [
    { name: 'IPv4 address', code: BASE },
    { name: 'IPv6 address', code: { ...BASE, host: 'fd7a:115c:a1e0::1' } },
    { name: 'DNS name', code: { ...BASE, host: 'studio.tailnet.ts.net' } },
    { name: 'name with a typographic apostrophe', code: { ...BASE, name: 'Sam’s Mac' } },
    {
      name: 'expired, but within the two-minute clock allowance',
      code: { ...BASE, exp: VECTOR_NOW - 60 },
    },
  ].map((v) => ({ ...v, link: encodePairingLink(v.code) }));

  const { nonce: _n, ...noNonce } = BASE;
  const reordered = JSON.stringify({ name: BASE.name, v: 1, ...BASE });
  const invalid = [
    { name: 'a web link', link: 'https://example.com/pair', error: 'NOT_A_PAIRING_LINK' },
    { name: 'a query instead of a fragment', link: 'remi://pair?x=1', error: 'NOT_A_PAIRING_LINK' },
    {
      name: 'scheme in capitals',
      link: `REMI://pair#${encodePairingLink(BASE).slice(12)}`,
      error: 'NOT_A_PAIRING_LINK',
    },
    { name: 'body is not base64url', link: 'remi://pair#!!!!', error: 'MALFORMED' },
    { name: 'body is not JSON', link: raw('hello'), error: 'MALFORMED' },
    { name: 'body is an array', link: raw('[1]'), error: 'MALFORMED' },
    {
      name: 'no version',
      link: raw(JSON.stringify({ ...BASE, v: undefined })),
      error: 'MALFORMED',
    },
    {
      name: 'a newer version',
      link: raw(JSON.stringify({ v: 2, anything: true })),
      error: 'UNSUPPORTED_VERSION',
    },
    { name: 'a missing field', link: raw(JSON.stringify(noNonce)), error: 'MALFORMED' },
    { name: 'an unknown field', link: raw(withFields({ relay: 'wss://x' })), error: 'MALFORMED' },
    { name: 'fields out of order', link: raw(reordered), error: 'NOT_CANONICAL' },
    {
      name: 'whitespace in the JSON',
      link: raw(JSON.stringify(BASE, null, 1)),
      error: 'NOT_CANONICAL',
    },
    {
      name: 'name with a control character',
      link: raw(withFields({ name: 'mac\u001b[2K' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a bidi override',
      link: raw(withFields({ name: 'mac‮evil' })),
      error: 'MALFORMED',
    },
    { name: 'name too long', link: raw(withFields({ name: 'm'.repeat(65) })), error: 'MALFORMED' },
    {
      name: 'host not an address',
      link: raw(withFields({ host: '192.168.1.300' })),
      error: 'MALFORMED',
    },
    { name: 'host with brackets', link: raw(withFields({ host: '[::1]' })), error: 'MALFORMED' },
    { name: 'host with a space', link: raw(withFields({ host: 'my mac' })), error: 'MALFORMED' },
    { name: 'port zero', link: raw(withFields({ port: 0 })), error: 'MALFORMED' },
    { name: 'port too large', link: raw(withFields({ port: 70000 })), error: 'MALFORMED' },
    { name: 'port not an integer', link: raw(withFields({ port: 1.5 })), error: 'MALFORMED' },
    {
      name: 'key of 31 bytes',
      link: raw(withFields({ key: Buffer.alloc(31, 1).toString('base64') })),
      error: 'MALFORMED',
    },
    {
      name: 'nonce of 15 bytes',
      link: raw(withFields({ nonce: Buffer.alloc(15, 7).toString('base64url') })),
      error: 'MALFORMED',
    },
    {
      name: 'nonce with padding',
      link: raw(withFields({ nonce: `${NONCE}==` })),
      error: 'MALFORMED',
    },
    { name: 'expired', link: raw(withFields({ exp: VECTOR_NOW - 200 })), error: 'EXPIRED' },
    {
      name: 'expiry too far ahead',
      link: raw(withFields({ exp: VECTOR_NOW + 3600 })),
      error: 'MALFORMED',
    },
    {
      name: 'another protocol version',
      link: raw(withFields({ proto: 2 })),
      error: 'PROTOCOL_MISMATCH',
    },
    { name: 'protocol version zero', link: raw(withFields({ proto: 0 })), error: 'MALFORMED' },
    { name: 'too long', link: `remi://pair#${'A'.repeat(1100)}`, error: 'MALFORMED' },
  ];
  return { now: VECTOR_NOW, protocolVersion: 1, valid, invalid };
}

if (import.meta.main) {
  const dir = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(dir, 'vectors.json'), `${JSON.stringify(buildVectors(), null, 2)}\n`);
}
