/** R5 pins exercise real signing/sealing and independently encoded byte tuples. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as r from '../../src/relay/internal.ts';
import { codeOfSync, hex, seed, text } from './helpers.ts';

function required<T>(name: string): T {
  const value = (r as unknown as Record<string, unknown>)[name];
  expect(typeof value, `R5 actual shared codec ${name} must exist`).toBe('function');
  return value as T;
}

const payload = {
  type: 'question',
  actionable: true,
  sessionId: 'owned-session',
  runtimeInstance: r.b64u(seed('push runtime')),
  questionId: 'owned-question',
  title: 'Owned permission',
  body: 'Owned controlled choice',
  category: 'REMI_YNA',
  options: [
    {
      value: '1',
      label: 'Allow once',
      isYes: true,
      isNo: false,
      description: null,
      standingGrant: null,
    },
    {
      value: '2',
      label: 'Allow for this session',
      isYes: true,
      isNo: false,
      description: 'Complete scope remains visible',
      standingGrant: 'addRules',
    },
    { value: '3', label: 'Deny', isYes: false, isNo: true, description: null, standingGrant: null },
  ],
};

async function context() {
  const { signer: machine } = await r.generateIdentity();
  const { signer: device } = await r.generateIdentity();
  const recipient = await r.generateEcPair(true);
  const content = {
    machinePublicKey: r.b64u(machine.publicKey),
    rid: hex(await r.ridOf(machine.publicKey)),
    devicePublicKey: r.b64u(device.publicKey),
    pushPublicKey: r.b64u(recipient.publicKey),
    keyVersion: 1,
    collapseId: r.b64u(seed('push collapse').slice(0, 16)),
    revision: 1,
    kind: 'question',
    nonce: r.b64u(seed('push content nonce')),
    issuedAt: 1000,
    expiresAt: 1100,
  };
  return { machine, device, recipient, content };
}

test('push payload preserves complete values, labels, flags, descriptions and standing scope', () => {
  const build = required<(v: unknown) => Uint8Array>('buildPushPayload');
  const parse = required<(v: Uint8Array) => unknown>('parsePushPayload');
  expect(parse(build(payload))).toEqual(payload);
  expect(codeOfSync(() => build({ ...payload, outerVerified: true }))).toBe('MALFORMED');
  expect(
    codeOfSync(() =>
      build({ ...payload, options: [{ ...payload.options[0], description: undefined }] }),
    ),
  ).toBe('MALFORMED');
});

test('push payload refuses duplicate JSON members including nested option authority', () => {
  const parse = required<(v: Uint8Array) => unknown>('parsePushPayload');
  expect(
    codeOfSync(() => parse(text('{"type":"dismiss","actionable":true,"actionable":false}'))),
  ).toBe('MALFORMED');
  const duplicate = JSON.stringify(payload).replace('"isYes":true', '"isYes":false,"isYes":true');
  expect(codeOfSync(() => parse(text(duplicate)))).toBe('MALFORMED');
});

test('push content signature input equals independent fixed-order tuple bytes', async () => {
  const build = required<(c: unknown, p: Uint8Array) => Promise<Uint8Array>>(
    'buildPushContentSigningInput',
  );
  const { content } = await context();
  const bytes = text(JSON.stringify(payload));
  const body = r.lps(
    r.fromB64u(content.machinePublicKey),
    Buffer.from(content.rid, 'hex'),
    r.fromB64u(content.devicePublicKey),
    r.fromB64u(content.pushPublicKey),
    r.be64(1),
    content.collapseId,
    r.be64(1),
    Uint8Array.of(1),
    r.fromB64u(content.nonce),
    r.be64(1000),
    r.be64(1100),
    bytes,
  );
  const expected = r.lps(
    'remi-relay-v2 push content',
    new Uint8Array(createHash('sha256').update(body).digest()),
  );
  expect(
    hex(await build(content, bytes)),
    'every signed field must bind the exact approved tuple',
  ).toBe(hex(expected));
});

test('actual signed push seal opens only for current pinned machine/device/push-key context', async () => {
  const seal =
    required<(s: r.Signer, c: unknown, p: unknown, random: r.Rng) => Promise<Uint8Array>>(
      'sealPushContent',
    );
  const open =
    required<
      (
        recipient: r.EcPair,
        carrier: unknown,
        authority: unknown,
        now: number,
      ) => Promise<{ payload: unknown }>
    >('openPushContent');
  const { machine, recipient, content } = await context();
  const sealed = await seal(machine, content, payload, r.systemRandom);
  const carrier = {
    v: 2,
    rid: content.rid,
    collapseId: content.collapseId,
    keyVersion: 1,
    kind: content.kind,
    sealed: r.b64u(sealed),
  };
  const authority = {
    machinePublicKey: content.machinePublicKey,
    devicePublicKey: content.devicePublicKey,
    pushPublicKey: content.pushPublicKey,
    keyVersion: 1,
  };
  expect((await open(recipient, carrier, authority, 1001)).payload).toEqual(payload);
  await expect(
    open(recipient, carrier, { ...authority, devicePublicKey: r.b64u(seed('other device')) }, 1001),
  ).rejects.toThrow();
  await expect(open(recipient, { ...carrier, kind: 'dismiss' }, authority, 1001)).rejects.toThrow();
  await expect(open(recipient, carrier, authority, 1100)).rejects.toThrow();
});

test('whole signed envelope refuses oversized content without truncation', async () => {
  const encode =
    required<(c: unknown, p: Uint8Array, s: Uint8Array) => Uint8Array>('encodeSignedPushContent');
  const { content } = await context();
  expect(codeOfSync(() => encode(content, new Uint8Array(2048), new Uint8Array(64)))).toBe(
    'OVERSIZE',
  );
});

test('submission codec refuses duplicate or unknown JSON and preserves typed uncertain outcome', () => {
  const decode = required<(v: string) => unknown>('decodePushSubmit');
  expect(codeOfSync(() => decode('{"v":2,"v":2}'))).toBe('MALFORMED');
  const decodeResult = required<(v: string) => unknown>('decodePushSubmitResult');
  const uncertain = { v: 2, requestDigest: 'a'.repeat(64), outcome: 'uncertain' };
  expect(decodeResult(JSON.stringify(uncertain))).toEqual(uncertain);
  expect(codeOfSync(() => decodeResult(JSON.stringify({ ...uncertain, success: true })))).toBe(
    'MALFORMED',
  );
  expect(codeOfSync(() => decodeResult('{"v":2,"requestDigest":null,"outcome":"accepted"}'))).toBe(
    'MALFORMED',
  );
});
