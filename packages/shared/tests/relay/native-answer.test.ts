/** R6 codec coverage uses actual Ed25519 and independently framed synthetic tuples. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as n from '../../src/relay/index.ts';
import * as r from '../../src/relay/internal.ts';
import { codeOf, codeOfSync, hex, seed, unhex } from './helpers.ts';
import {
  buildNativeAnswerVectors,
  independentBody,
  independentSigningInput,
} from './native-answer-vectors-builder.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/relay-v2/native-answer-vectors.json', import.meta.url), 'utf8'),
) as Awaited<ReturnType<typeof buildNativeAnswerVectors>>;
const first = fixture.cases[0];
if (!first) throw new Error('native answer fixture setup missing');
const baseline = first.message;
const authority = (message: n.NativeAnswer): n.NativeAnswerAuthority => ({
  rid: message.rid,
  machinePublicKey: message.machinePublicKey,
  devicePublicKey: message.devicePublicKey,
});
const altered = (changes: Record<string, unknown>): n.NativeAnswer =>
  ({ ...baseline, ...changes }) as n.NativeAnswer;
const verify = (message: n.NativeAnswer, now = baseline.issuedAt + 1) =>
  n.verifyNativeAnswer(message, authority(message), now);

async function sign(value: n.UnsignedNativeAnswer, signer?: r.Signer): Promise<n.NativeAnswer> {
  const device = signer ?? (await r.signerFromSeed(unhex(fixture.deviceSeedHex)));
  return { ...value, signature: r.b64u(await device.sign(independentSigningInput(value))) };
}

test('native-answer independent vectors regenerate with real Ed25519', async () => {
  expect(await buildNativeAnswerVectors()).toEqual(fixture);
});

test('native-answer fixed-order body and domain input match independent nested framing', async () => {
  for (const item of fixture.cases) {
    expect(hex(n.buildNativeAnswerBody(item.message)), item.name).toBe(item.bodyHex);
    expect(hex(await n.buildNativeAnswerSigningInput(item.message)), item.name).toBe(
      item.signingInputHex,
    );
    expect(await n.nativeAnswerDigest(item.message), item.name).toBe(item.requestDigest);
    expect(n.decodeNativeAnswer(n.encodeNativeAnswer(item.message))).toEqual(item.message);
    const result = await verify(item.message);
    expect(result.message).toEqual(item.message);
    expect(result.requestDigest).toBe(item.requestDigest);
    const { signature: _signature, ...unsigned } = item.message;
    expect(hex(n.buildNativeAnswerBody(unsigned))).toBe(item.bodyHex);
    expect(await n.nativeAnswerDigest(unsigned)).toBe(item.requestDigest);
  }
});

test('native-answer binds every authority, runtime, question, choice and time field', async () => {
  const other = await r.signerFromSeed(seed('native answer second machine'));
  const changes: Record<string, unknown>[] = [
    { rid: hex(await r.ridOf(other.publicKey)), machinePublicKey: r.b64u(other.publicKey) },
    { devicePublicKey: r.b64u(other.publicKey) },
    { id: 'different-request' },
    { sessionId: 'different-session' },
    { runtimeInstance: r.b64u(seed('different-runtime')) },
    { questionId: 'different-question' },
    { collapseId: r.b64u(seed('different-collapse').slice(0, 16)) },
    { revision: 8 },
    { contentDigest: r.b64u(seed('different-content')) },
    { nonce: r.b64u(seed('different-nonce')) },
    {
      issuedAt: baseline.issuedAt + 1,
      timestamp: new Date((baseline.issuedAt + 1) * 1000).toISOString(),
    },
    { expiresAt: baseline.expiresAt - 1 },
    { answer: '2' },
    { claudeSessionId: 'extra-binding' },
    { cancel: false },
    { message: '' },
  ];
  for (const change of changes) {
    const candidate = altered(change);
    expect(hex(n.buildNativeAnswerBody(candidate)), JSON.stringify(change)).not.toBe(first.bodyHex);
    expect(await codeOf(verify(candidate)), JSON.stringify(change)).toBe('BAD_SIGNATURE');
  }
});

test('native-answer refuses push-domain signatures and signatures by the machine', async () => {
  const device = await r.signerFromSeed(unhex(fixture.deviceSeedHex));
  const machine = await r.signerFromSeed(unhex(fixture.machineSeedHex));
  for (const label of ['remi-relay-v2 push content', 'remi-relay-v2 push submit']) {
    const signature = await device.sign(r.lps(label, unhex(first.requestDigest)));
    expect(await codeOf(verify(altered({ signature: r.b64u(signature) })))).toBe('BAD_SIGNATURE');
  }
  expect(await codeOf(verify(await sign(baseline, machine)))).toBe('BAD_SIGNATURE');
  expect(await n.nativeAnswerDigest(altered({ signature: r.b64u(new Uint8Array(64)) }))).toBe(
    first.requestDigest,
  );
});

test('native-answer verifies against caller authority and derived room identity', async () => {
  const other = await r.signerFromSeed(seed('native answer unrelated authority'));
  for (const change of [
    { rid: '00'.repeat(16) },
    { machinePublicKey: r.b64u(other.publicKey) },
    { devicePublicKey: r.b64u(other.publicKey) },
  ]) {
    await expect(
      n.verifyNativeAnswer(baseline, { ...authority(baseline), ...change }, baseline.issuedAt + 1),
    ).rejects.toBeInstanceOf(r.RelayError);
  }
  await expect(verify(await sign(altered({ rid: '00'.repeat(16) })))).rejects.toBeInstanceOf(
    r.RelayError,
  );
});

test('native-answer enforces TTL, future allowance, exact expiry and valid clock', async () => {
  expect((await verify(baseline, baseline.issuedAt - 5)).message).toEqual(baseline);
  expect((await verify(baseline, baseline.expiresAt - 1)).message).toEqual(baseline);
  for (const now of [
    baseline.issuedAt - 6,
    baseline.expiresAt,
    baseline.expiresAt + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
  ]) {
    await expect(verify(baseline, now)).rejects.toBeInstanceOf(r.RelayError);
  }
  for (const change of [
    { expiresAt: baseline.issuedAt + 31 },
    { expiresAt: baseline.issuedAt },
    { issuedAt: 1.5 },
    { issuedAt: -1 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { timestamp: '2023-11-14T22:13:20Z' },
    { revision: 0 },
    { revision: 1.5 },
  ])
    expect(() => n.buildNativeAnswerBody(altered(change))).toThrow(r.RelayError);
});

test('native-answer preserves optional presence and refuses undefined/null/unknown fields', async () => {
  expect(
    new Set(await Promise.all(fixture.cases.map((item) => n.nativeAnswerDigest(item.message))))
      .size,
  ).toBe(fixture.cases.length);
  for (const key of ['claudeSessionId', 'selections', 'cancel', 'message', 'signature']) {
    for (const value of [undefined, null]) {
      expect(codeOfSync(() => n.buildNativeAnswerBody(altered({ [key]: value })))).toBe(
        'MALFORMED',
      );
    }
  }
  for (const change of [{ proof: {} }, { requestId: baseline.id }, { v: 1 }, { type: 'answer' }]) {
    expect(codeOfSync(() => n.buildNativeAnswerBody(altered(change)))).toBe('MALFORMED');
  }
});

test('native-answer rejects malformed optional selections without sorting or dropping meaning', () => {
  const invalid = [
    [],
    [{ questionIndex: 0 }],
    [{ questionIndex: 0, optionIndices: [] }],
    [{ questionIndex: 0, optionIndices: [1, 0] }],
    [{ questionIndex: 0, optionIndices: [1, 1] }],
    [{ questionIndex: 0, optionIndices: [0, 1, 2, 3, 4] }],
    [{ questionIndex: 65536, optionIndices: [0] }],
    [{ questionIndex: 0, optionIndices: [65536] }],
    [{ questionIndex: -1, optionIndices: [0] }],
    [{ questionIndex: 0, optionIndices: [0.5] }],
    [
      { questionIndex: 1, optionIndices: [0] },
      { questionIndex: 0, optionIndices: [0] },
    ],
    [
      { questionIndex: 0, optionIndices: [0] },
      { questionIndex: 0, optionIndices: [1] },
    ],
    [{ questionIndex: 0, optionIndices: [], text: '' }],
    [{ questionIndex: 0, optionIndices: [0], text: 'extra' }],
    [{ questionIndex: 0, optionIndices: [], text: null }],
    [{ questionIndex: 0, optionIndices: [0], injected: true }],
    Array.from({ length: 5 }, (_, questionIndex) => ({ questionIndex, optionIndices: [0] })),
  ];
  for (const selections of invalid) {
    expect(codeOfSync(() => n.buildNativeAnswerBody(altered({ answer: '', selections })))).toBe(
      'MALFORMED',
    );
  }
  for (const change of [
    { answer: '' },
    { cancel: true },
    { answer: '', cancel: true, selections: [{ questionIndex: 0, optionIndices: [0] }] },
    { selections: [{ questionIndex: 0, optionIndices: [0] }] },
    { cancel: 0 },
  ])
    expect(codeOfSync(() => n.buildNativeAnswerBody(altered(change)))).toBe('MALFORMED');
});

test('native-answer strings bind exact Unicode and byte caps without surrogate replacement', () => {
  for (const key of ['id', 'sessionId', 'questionId', 'claudeSessionId', 'answer', 'message']) {
    for (const value of ['\ud800', '\udfff', 'ok\ud800end']) {
      expect(codeOfSync(() => n.buildNativeAnswerBody(altered({ [key]: value })))).toBe(
        'MALFORMED',
      );
    }
  }
  expect(hex(n.buildNativeAnswerBody(altered({ answer: 'é' })))).not.toBe(
    hex(n.buildNativeAnswerBody(altered({ answer: 'e\u0301' }))),
  );
  for (const key of ['id', 'sessionId', 'questionId', 'claudeSessionId', 'answer']) {
    expect(n.buildNativeAnswerBody(altered({ [key]: 'é'.repeat(64) })).length).toBeGreaterThan(0);
    expect(() => n.buildNativeAnswerBody(altered({ [key]: 'é'.repeat(65) }))).toThrow(r.RelayError);
  }
  expect(n.buildNativeAnswerBody(altered({ message: 'x'.repeat(2048) })).length).toBeGreaterThan(0);
  expect(() => n.buildNativeAnswerBody(altered({ message: 'x'.repeat(2049) }))).toThrow(
    r.RelayError,
  );
  const selections = Array.from({ length: 4 }, (_, questionIndex) => ({
    questionIndex,
    optionIndices: [],
    text: 'x'.repeat(2048),
  }));
  expect(codeOfSync(() => n.buildNativeAnswerBody(altered({ answer: '', selections })))).toBe(
    'OVERSIZE',
  );
});

test('native-answer JSON decoder rejects escaped duplicate keys, nested duplicates and trailing data', () => {
  const raw = JSON.stringify(baseline);
  for (const invalid of [
    raw.replace('"type":', '"type":"answer","type":'),
    raw.replace('"answer":', '"ans\\u0077er":"2","answer":'),
    raw.replace('"revision":', '"revision":7,"revision":'),
    `${raw} {}`,
    `${raw.slice(0, -1)},"unknown":false}`,
    JSON.stringify(
      altered({ answer: '', selections: [{ questionIndex: 0, optionIndices: [0] }] }),
    ).replace('"questionIndex":', '"questionIndex":1,"questionIndex":'),
  ])
    expect(codeOfSync(() => n.decodeNativeAnswer(invalid))).toBe('MALFORMED');
  expect(n.decodeNativeAnswer(` \n${raw}\t `)).toEqual(baseline);
  expect(codeOfSync(() => n.decodeNativeAnswer(`${' '.repeat(16384)}${raw}`))).toBe('OVERSIZE');
});

test('native-answer rejects noncanonical binary encodings and weak public keys', () => {
  for (const key of [
    'machinePublicKey',
    'devicePublicKey',
    'runtimeInstance',
    'contentDigest',
    'nonce',
    'signature',
    'collapseId',
  ]) {
    expect(
      codeOfSync(() =>
        n.buildNativeAnswerBody(altered({ [key]: `${baseline[key as keyof n.NativeAnswer]}=` })),
      ),
    ).toBe('MALFORMED');
    expect(codeOfSync(() => n.buildNativeAnswerBody(altered({ [key]: '' })))).toBe('MALFORMED');
  }
  for (const key of ['machinePublicKey', 'devicePublicKey']) {
    for (const bytes of [new Uint8Array(32), Uint8Array.from([1, ...new Uint8Array(31)])]) {
      expect(() => n.buildNativeAnswerBody(altered({ [key]: r.b64u(bytes) }))).toThrow(
        r.RelayError,
      );
    }
  }
  expect(() => n.buildNativeAnswerBody(altered({ rid: baseline.rid.toUpperCase() }))).toThrow(
    r.RelayError,
  );
});

test('native-answer decoder deep freezes owned selections and verifier snapshots before await', async () => {
  const source = fixture.cases.find((item) => item.name === 'structured-indices');
  if (!source) throw new Error('structured fixture setup missing');
  const decoded = n.decodeNativeAnswer(JSON.stringify(source.message));
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.selections)).toBe(true);
  expect(Object.isFrozen(decoded.selections?.[0])).toBe(true);
  expect(Object.isFrozen(decoded.selections?.[0]?.optionIndices)).toBe(true);
  const mutable = JSON.parse(JSON.stringify(source.message)) as n.NativeAnswer & {
    answer: string;
    selections: { questionIndex: number; optionIndices: number[] }[];
  };
  const capturedAuthority = authority(mutable);
  const pending = n.verifyNativeAnswer(mutable, capturedAuthority, baseline.issuedAt + 1);
  mutable.answer = 'changed after invocation';
  mutable.selections[0]?.optionIndices.push(7);
  Object.assign(capturedAuthority, { devicePublicKey: r.b64u(seed('mutated authority')) });
  const result = await pending;
  expect(result.message).toEqual(source.message);
  expect(result.requestDigest).toBe(source.requestDigest);
  expect(Object.isFrozen(result.message)).toBe(true);
  expect(hex(independentBody(result.message))).toBe(source.bodyHex);
});
