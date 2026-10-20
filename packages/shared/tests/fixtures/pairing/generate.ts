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
import { fingerprint, fromBase64 } from '../../../src/crypto.ts';
import { type PairingCodeV1, type PairingCodeV2, encodePairingLink } from '../../../src/pairing.ts';

/** The clock every vector is read at. */
export const VECTOR_NOW = 1_760_000_000;

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const NONCE = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i)).toString('base64url');

const BASE: PairingCodeV1 = {
  v: 1,
  name: 'fixture-mac',
  host: '192.168.1.23',
  port: 18765,
  key: KEY,
  nonce: NONCE,
  exp: VECTOR_NOW + 300,
  proto: 1,
};

const BASE_V2: PairingCodeV2 = {
  v: 2,
  name: 'fixture-mac',
  hosts: ['192.168.1.23', '100.101.102.103'],
  port: 18765,
  key: KEY,
  nonce: NONCE,
  exp: VECTOR_NOW + 300,
  proto: 1,
};

const SCHEDULE_V2: PairingCodeV2 = {
  ...BASE_V2,
  hosts: ['100.101.102.103', '203.0.113.9', '192.168.1.23', 'studio.tailnet.ts.net'],
};

/** A link whose body is exactly `json`, encoded as base64url without padding. */
const raw = (json: string): string =>
  `remi://pair#${Buffer.from(json, 'utf8').toString('base64url')}`;
/** `BASE` with `changes`, keys in the order given, as compact JSON. */
const withFields = (changes: Record<string, unknown>): string =>
  JSON.stringify({ ...BASE, ...changes });
/** `BASE_V2` with `changes`, in canonical field order. */
const withV2Fields = (changes: Record<string, unknown>): string =>
  JSON.stringify({ ...BASE_V2, ...changes });
/** Add one unknown ASCII field so the JSON reaches an exact encoded-size boundary. */
const paddedJson = (json: string, bytes: number): string => {
  const padding = bytes - new TextEncoder().encode(json).byteLength - 7;
  if (padding < 0) throw new Error(`Cannot pad ${json.length} bytes to ${bytes}`);
  return `${json.slice(0, -1)},"x":"${'a'.repeat(padding)}"}`;
};

export async function buildVectors() {
  const valid = [
    { name: 'IPv4 address', code: BASE },
    { name: 'IPv6 address', code: { ...BASE, host: 'fd7a:115c:a1e0::1' } },
    { name: 'DNS name', code: { ...BASE, host: 'studio.tailnet.ts.net' } },
    { name: 'name with a typographic apostrophe', code: { ...BASE, name: 'Sam’s Mac' } },
    {
      name: 'expired, but within the two-minute clock allowance',
      code: { ...BASE, exp: VECTOR_NOW - 60 },
    },
    { name: 'name of exactly 64 code points', code: { ...BASE, name: 'm'.repeat(64) } },
    {
      name: 'name of 64 astral characters (128 UTF-16 units)',
      code: { ...BASE, name: '\u{1F600}'.repeat(64) },
    },
    { name: 'expiry at the furthest a code may be', code: { ...BASE, exp: VECTOR_NOW + 1020 } },
    { name: 'IPv6 with an embedded zero run at the end', code: { ...BASE, host: '2001:db8::' } },
    { name: 'IPv6 fully written out', code: { ...BASE, host: '2001:db8:0:0:0:0:0:1' } },
    { name: 'v2 local and Tailscale candidates', code: BASE_V2 },
    { name: 'v2 single explicit candidate', code: { ...BASE_V2, hosts: ['203.0.113.9'] } },
    { name: 'v2 candidates preserve canonical source order', code: SCHEDULE_V2 },
  ].map((v) => ({ ...v, link: encodePairingLink(v.code) }));
  // The machine's fingerprint for each valid link: what the app shows next to it.
  const validWithFingerprints = await Promise.all(
    valid.map(async (v) => ({ ...v, fingerprint: await fingerprint(fromBase64(v.code.key)) })),
  );

  const { nonce: _n, ...noNonce } = BASE;
  const { name: baseName, v: baseVersion, ...rest } = BASE;
  const reordered = JSON.stringify({ name: baseName, v: baseVersion, ...rest });
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
      link: raw(JSON.stringify({ v: 3, anything: true })),
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
    {
      name: 'v1 link at its 1024-character boundary',
      link: raw(paddedJson(JSON.stringify(BASE), 759)),
      error: 'MALFORMED',
    },
    {
      name: 'v1 link over its 1024-character limit',
      link: raw(paddedJson(JSON.stringify(BASE), 760)),
      error: 'MALFORMED',
    },
    // Added after the #1281 review.
    {
      name: 'base64url with non-zero trailing bits',
      link: `${encodePairingLink(BASE).slice(0, -1)}${String.fromCharCode(encodePairingLink(BASE).charCodeAt(encodePairingLink(BASE).length - 1) + 1)}`,
      error: 'NOT_CANONICAL',
    },
    {
      name: 'key in non-canonical base64 (non-zero trailing bits)',
      link: raw(withFields({ key: `${KEY.slice(0, 42)}B=` })),
      error: 'MALFORMED',
    },
    {
      name: 'a field written with a \\u escape',
      link: raw(withFields({}).replace('fixture-mac', 'fixture\\u002dmac')),
      error: 'NOT_CANONICAL',
    },
    {
      name: 'a field given twice',
      link: raw(withFields({}).replace('"v":1,', '"v":1,"v":1,')),
      error: 'NOT_CANONICAL',
    },
    {
      name: 'a number written as 1.0',
      link: raw(withFields({}).replace('"v":1,', '"v":1.0,')),
      error: 'NOT_CANONICAL',
    },
    {
      name: 'a number written with an exponent',
      link: raw(withFields({}).replace('"port":18765', '"port":1.8765e4')),
      error: 'NOT_CANONICAL',
    },
    {
      name: 'name of 65 code points',
      link: raw(withFields({ name: 'm'.repeat(65) })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a zero-width space',
      link: raw(withFields({ name: 'mac\u200Bbook' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a byte order mark',
      link: raw(withFields({ name: '\uFEFFmac' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a line separator',
      link: raw(withFields({ name: 'mac\u2028book' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a soft hyphen',
      link: raw(withFields({ name: 'mac\u00ADbook' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a tag character',
      link: raw(withFields({ name: 'mac\u{E0041}' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a quotation mark',
      link: raw(withFields({ name: 'the "mac"' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a backslash',
      link: raw(withFields({ name: 'mac\\book' })),
      error: 'MALFORMED',
    },
    {
      name: 'name with a lone surrogate',
      link: raw(withFields({ name: 'mac\ud800' })),
      error: 'MALFORMED',
    },
    {
      name: 'expired at exactly the clock allowance',
      link: raw(withFields({ exp: VECTOR_NOW - 120 })),
      error: 'EXPIRED',
    },
    {
      name: 'expiry one second past the furthest',
      link: raw(withFields({ exp: VECTOR_NOW + 1021 })),
      error: 'MALFORMED',
    },
    { name: 'IPv6 of three colons', link: raw(withFields({ host: ':::' })), error: 'MALFORMED' },
    { name: 'IPv6 of two groups', link: raw(withFields({ host: 'a:b' })), error: 'MALFORMED' },
    {
      name: 'IPv6 ending in a single colon',
      link: raw(withFields({ host: 'abcd:' })),
      error: 'MALFORMED',
    },
    {
      name: 'IPv6 of eleven groups',
      link: raw(withFields({ host: '1:2:3:4:5:6:7:8:9:a:b' })),
      error: 'MALFORMED',
    },
    {
      name: 'IPv6 with a group of five digits',
      link: raw(withFields({ host: '2001:db8::12345' })),
      error: 'MALFORMED',
    },
    {
      name: 'a name whose last label is a number',
      link: raw(withFields({ host: '0x7f.1' })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 has no candidates',
      link: raw(withV2Fields({ hosts: [] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 has more than four candidates',
      link: raw(
        withV2Fields({
          hosts: ['192.168.1.23', '192.168.1.24', '192.168.1.25', '192.168.1.26', '192.168.1.27'],
        }),
      ),
      error: 'MALFORMED',
    },
    {
      name: 'v2 requires candidates instead of the v1 host field',
      link: raw(JSON.stringify({ ...BASE, v: 2, host: BASE.host })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 candidates are required',
      link: raw(
        JSON.stringify(
          Object.fromEntries(Object.entries(BASE_V2).filter(([key]) => key !== 'hosts')),
        ),
      ),
      error: 'MALFORMED',
    },
    {
      name: 'v2 unknown field',
      link: raw(withV2Fields({ relay: 'wss://x' })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 fields out of order',
      link: raw(
        JSON.stringify({
          v: 2,
          hosts: BASE_V2.hosts,
          name: BASE_V2.name,
          port: BASE_V2.port,
          key: BASE_V2.key,
          nonce: BASE_V2.nonce,
          exp: BASE_V2.exp,
          proto: BASE_V2.proto,
        }),
      ),
      error: 'NOT_CANONICAL',
    },
    {
      name: 'v2 pretty-printed JSON is not canonical',
      link: raw(JSON.stringify(BASE_V2, null, 1)),
      error: 'NOT_CANONICAL',
    },
    {
      name: 'v2 duplicate DNS candidates after case and trailing-dot normalization',
      link: raw(withV2Fields({ hosts: ['Studio.example', 'studio.example.'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 duplicate IPv6 candidates after numeric normalization',
      link: raw(withV2Fields({ hosts: ['2001:db8::1', '2001:0db8:0:0:0:0:0:1'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 duplicate IPv4 and mapped IPv6 candidates',
      link: raw(withV2Fields({ hosts: ['192.0.2.1', '::ffff:c000:201'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 IPv4 loopback candidate',
      link: raw(withV2Fields({ hosts: ['127.0.0.1'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 IPv4 unspecified candidate',
      link: raw(withV2Fields({ hosts: ['0.0.0.0'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 IPv4 link-local candidate',
      link: raw(withV2Fields({ hosts: ['169.254.1.2'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 IPv6 loopback candidate',
      link: raw(withV2Fields({ hosts: ['::1'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 IPv6 unspecified candidate',
      link: raw(withV2Fields({ hosts: ['::'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 IPv6 link-local candidate',
      link: raw(withV2Fields({ hosts: ['febf::1'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 IPv4-mapped loopback candidate',
      link: raw(withV2Fields({ hosts: ['::ffff:7f00:1'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 localhost candidate',
      link: raw(withV2Fields({ hosts: ['localhost.'] })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 expired candidate set',
      link: raw(withV2Fields({ exp: VECTOR_NOW - 200 })),
      error: 'EXPIRED',
    },
    {
      name: 'v2 expiry too far ahead',
      link: raw(withV2Fields({ exp: VECTOR_NOW + 3600 })),
      error: 'MALFORMED',
    },
    {
      name: 'v2 protocol mismatch',
      link: raw(withV2Fields({ proto: 2 })),
      error: 'PROTOCOL_MISMATCH',
    },
    {
      name: 'v2 link at its 2048-character and 1527-byte boundary',
      link: raw(paddedJson(JSON.stringify(BASE_V2), 1527)),
      error: 'MALFORMED',
    },
    {
      name: 'v2 link exceeds its 2048-character limit',
      link: raw(paddedJson(JSON.stringify(BASE_V2), 1530)),
      error: 'MALFORMED',
    },
    {
      name: 'v2 decoded JSON exceeds 1527 bytes',
      link: raw(paddedJson(JSON.stringify(BASE_V2), 1528)),
      error: 'MALFORMED',
    },
  ];
  return { now: VECTOR_NOW, protocolVersion: 1, valid: validWithFingerprints, invalid };
}

if (import.meta.main) {
  const dir = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(dir, 'vectors.json'), `${JSON.stringify(await buildVectors(), null, 2)}\n`);
}
