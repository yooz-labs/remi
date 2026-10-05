/** R5 pins exercise real signing/sealing and independently encoded byte tuples. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as r from '../../src/relay/internal.ts';
import { codeOf, codeOfSync, hex, seed, text } from './helpers.ts';

function required<T>(name: string): T {
  const value = (r as unknown as Record<string, unknown>)[name];
  expect(typeof value, `R5 actual shared codec ${name} must exist`).toBe('function');
  return value as T;
}

const payload: Extract<r.SecurePushPayload, { type: 'question' }> = {
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
    kind: 'question' as const,
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
  const complete = text(
    JSON.stringify({
      ...payload,
      options: payload.options.map((o) => ({ ...o, description: 'x'.repeat(450) })),
    }),
  );
  expect(complete.length).toBeLessThanOrEqual(2048);
  expect(codeOfSync(() => encode(content, complete, new Uint8Array(64)))).toBe('OVERSIZE');
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

test('strict payload parser preserves valid raw JSON but refuses decoded aliases, invalid UTF8 and bounded nesting', () => {
  const parse = required<(v: Uint8Array) => unknown>('parsePushPayload');
  expect(parse(text(' { "actionable" : false, "\\u0074ype" : "dismiss" }\n'))).toEqual({
    type: 'dismiss',
    actionable: false,
  });
  expect(
    codeOfSync(() => parse(text('{"type":"dismiss","actionable":false,"\\u0061ctionable":false}'))),
  ).toBe('MALFORMED');
  expect(codeOfSync(() => parse(Uint8Array.of(0xff)))).toBe('MALFORMED');
  expect(codeOfSync(() => parse(text(`${'['.repeat(10)}0${']'.repeat(10)}`)))).toBe('MALFORMED');
});

test('exact reordered whitespace payload is authenticated unchanged; modified raw bytes fail the signature', async () => {
  const build = required<(c: r.PushContentMetadata, p: Uint8Array) => Promise<Uint8Array>>(
    'buildPushContentSigningInput',
  );
  const encode = required<typeof r.encodeSignedPushContent>('encodeSignedPushContent');
  const open = required<typeof r.openPushContent>('openPushContent');
  const { machine, recipient, content: original } = await context();
  const content = { ...original, kind: 'dismiss' as const };
  const bytes = text(' { "actionable": false, "\\u0074ype": "dismiss" } ');
  const signature = await machine.sign(await build(content, bytes));
  const authority = {
    machinePublicKey: content.machinePublicKey,
    devicePublicKey: content.devicePublicKey,
    pushPublicKey: content.pushPublicKey,
    keyVersion: 1,
  };
  const carrier = {
    v: 2 as const,
    rid: content.rid,
    collapseId: content.collapseId,
    keyVersion: 1,
    kind: content.kind,
    sealed: '',
  };
  const wrap = async (p: Uint8Array) => ({
    ...carrier,
    sealed: r.b64u(
      await r.seal(
        recipient.publicKey,
        r.pushAad(Buffer.from(content.rid, 'hex'), content.collapseId),
        encode(content, p, signature),
        r.systemRandom,
      ),
    ),
  });
  expect((await open(recipient, await wrap(bytes), authority, 1001)).payload).toEqual({
    type: 'dismiss',
    actionable: false,
  });
  expect(
    await codeOf(
      open(recipient, await wrap(text('{"type":"dismiss","actionable":false}')), authority, 1001),
    ),
  ).toBe('BAD_SIGNATURE');
});

test('all reviewed weak Ed25519 encodings are refused for both push identities; off-curve P256 never signs', async () => {
  const seal = required<typeof r.sealPushContent>('sealPushContent');
  const encode = required<typeof r.encodeSignedPushContent>('encodeSignedPushContent');
  const { machine, content: original } = await context();
  const weak = [
    ...readFileSync(new URL('../../src/relay/small-order.ts', import.meta.url), 'utf8').matchAll(
      /'([0-9a-f]{64})'/g,
    ),
  ].map((m) => Buffer.from(m[1] ?? '', 'hex'));
  expect(weak.length).toBe(14);
  for (const key of weak)
    for (const field of ['machinePublicKey', 'devicePublicKey']) {
      expect(
        codeOfSync(() =>
          encode(
            { ...original, [field]: r.b64u(key) },
            text(JSON.stringify(payload)),
            new Uint8Array(64),
          ),
        ),
        `weak ${field} must refuse before persistence/signing`,
      ).toBe('MALFORMED');
    }
  const badPoint = new Uint8Array(65);
  badPoint[0] = 4;
  expect(
    await codeOf(
      seal(
        machine,
        { ...original, pushPublicKey: r.b64u(badPoint) } as r.PushContentMetadata,
        payload as r.SecurePushPayload,
        r.systemRandom,
      ),
    ),
  ).toBe('MALFORMED');
});

async function signedSubmission() {
  const seal = required<typeof r.sealPushContent>('sealPushContent');
  const build = required<typeof r.buildPushSubmitSigningInput>('buildPushSubmitSigningInput');
  const { machine, recipient, content } = await context();
  const sealed = await seal(
    machine,
    content as r.PushContentMetadata,
    payload as r.SecurePushPayload,
    r.systemRandom,
  );
  const unsigned = {
    ...content,
    kind: 'question' as const,
    v: 2 as const,
    audience: 'https://owned.example',
    token: 'ab'.repeat(32),
    environment: 'sandbox' as const,
    nonce: r.b64u(seed('submit nonce')),
    expiresAt: 1050,
    sealed: r.b64u(sealed),
  };
  const signature = r.b64u(await machine.sign(await build(unsigned)));
  return { machine, recipient, content, unsigned, signed: { ...unsigned, signature } };
}

test('actual outer machine proof binds every submission field and distinguishes content signatures', async () => {
  const verify = required<typeof r.verifyPushSubmit>('verifyPushSubmit');
  const encode = required<typeof r.encodePushSubmit>('encodePushSubmit');
  const decode = required<typeof r.decodePushSubmit>('decodePushSubmit');
  const { signed, content, machine } = await signedSubmission();
  const expected = { rid: signed.rid, audience: signed.audience };
  const baseline = await verify(decode(encode(signed)), expected, 1001);
  expect(baseline.requestDigest).toMatch(/^[0-9a-f]{64}$/);
  const { signer: other } = await r.generateIdentity();
  const otherEc = await r.generateEcPair();
  const changes: Record<string, unknown> = {
    audience: 'https://other.example',
    rid: 'ab'.repeat(16),
    machinePublicKey: r.b64u(other.publicKey),
    devicePublicKey: r.b64u(other.publicKey),
    pushPublicKey: r.b64u(otherEc.publicKey),
    keyVersion: 2,
    token: 'cd'.repeat(32),
    environment: 'production',
    collapseId: r.b64u(seed('other collapse').slice(0, 16)),
    revision: 2,
    kind: 'turn_complete',
    nonce: r.b64u(seed('other nonce')),
    issuedAt: 999,
    expiresAt: 1049,
    sealed: r.b64u(new Uint8Array(r.fromB64u(signed.sealed).length)),
    signature: r.b64u(new Uint8Array(64)),
  };
  for (const [field, value] of Object.entries(changes))
    await expect(
      verify({ ...signed, [field]: value }, expected, 1001),
      `signed submission field ${field} must bind`,
    ).rejects.toThrow();
  const contentSignature = await machine.sign(
    await required<typeof r.buildPushContentSigningInput>('buildPushContentSigningInput')(
      {
        ...content,
        nonce: r.b64u(seed('content nonce')),
        expiresAt: 1100,
      } as r.PushContentMetadata,
      text(JSON.stringify(payload)),
    ),
  );
  expect(
    await codeOf(verify({ ...signed, signature: r.b64u(contentSignature) }, expected, 1001)),
  ).toBe('BAD_SIGNATURE');
  expect(await codeOf(verify(signed, expected, 1050))).toBe('EXPIRED');
  const reordered = ` { ${Object.entries(signed)
    .reverse()
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(', ')} } `;
  expect((await verify(decode(reordered), expected, 1001)).requestDigest).toBe(
    baseline.requestDigest,
  );
  expect(codeOfSync(() => decode(encode(signed).replace('"v":2', '"v":2,"\\u0076":2')))).toBe(
    'MALFORMED',
  );
  expect(
    codeOfSync(() =>
      decode(encode(signed).replace('"keyVersion":1', '"keyVersion":9007199254740992')),
    ),
  ).toBe('MALFORMED');
  expect(codeOfSync(() => decode(' '.repeat(8193)))).toBe('OVERSIZE');
});

test('push content and submit TTLs and future clock skew enforce exact finite boundaries', async () => {
  const { machine, recipient, content } = await context();
  const dismiss: r.SecurePushPayload = { type: 'dismiss', actionable: false };
  const info: r.SecurePushPayload = {
    type: 'informational',
    actionable: false,
    sessionId: null,
    title: 'owned',
    body: 'owned',
  };
  for (const [kind, p, max] of [
    ['question', payload, 3600],
    ['dismiss', dismiss, 3600],
    ['turn_complete', info, 300],
  ] as const) {
    const c = { ...content, kind, expiresAt: content.issuedAt + max };
    expect(
      (
        await required<typeof r.buildPushContentSigningInput>('buildPushContentSigningInput')(
          c,
          p === payload ? text(JSON.stringify(p)) : r.buildPushPayload(p),
        )
      ).length,
    ).toBeGreaterThan(32);
    expect(
      await codeOf(
        r.buildPushContentSigningInput(
          { ...c, expiresAt: c.expiresAt + 1 },
          p === payload ? text(JSON.stringify(p)) : r.buildPushPayload(p),
        ),
      ),
    ).toBe('MALFORMED');
  }
  const now = 1000;
  const authority = {
    machinePublicKey: content.machinePublicKey,
    devicePublicKey: content.devicePublicKey,
    pushPublicKey: content.pushPublicKey,
    keyVersion: 1,
  };
  for (const skew of [60, 61]) {
    const c = {
      ...content,
      kind: 'dismiss' as const,
      issuedAt: now + skew,
      expiresAt: now + skew + 100,
    };
    const sealed = await r.sealPushContent(machine, c, dismiss, r.systemRandom);
    const carrier = {
      v: 2 as const,
      rid: c.rid,
      collapseId: c.collapseId,
      keyVersion: 1,
      kind: c.kind,
      sealed: r.b64u(sealed),
    };
    if (skew === 60)
      expect((await r.openPushContent(recipient, carrier, authority, now)).payload).toEqual(
        dismiss,
      );
    else
      expect(await codeOf(r.openPushContent(recipient, carrier, authority, now))).toBe('EXPIRED');
  }
  const { unsigned } = await signedSubmission();
  expect(
    (await r.buildPushSubmitSigningInput({ ...unsigned, expiresAt: unsigned.issuedAt + 60 }))
      .length,
  ).toBeGreaterThan(32);
  expect(
    await codeOf(r.buildPushSubmitSigningInput({ ...unsigned, expiresAt: unsigned.issuedAt + 61 })),
  ).toBe('MALFORMED');
  for (const skew of [60, 61]) {
    const actual = await signedSubmission();
    const matching = { ...actual.unsigned, issuedAt: now + skew, expiresAt: now + skew + 60 };
    const proof = {
      ...matching,
      signature: r.b64u(await actual.machine.sign(await r.buildPushSubmitSigningInput(matching))),
    };
    if (skew === 60)
      expect(
        (await r.verifyPushSubmit(proof, { rid: proof.rid, audience: proof.audience }, now))
          .requestDigest,
      ).toMatch(/^[a-f0-9]{64}$/);
    else
      expect(
        await codeOf(r.verifyPushSubmit(proof, { rid: proof.rid, audience: proof.audience }, now)),
      ).toBe('EXPIRED');
  }
});

test('whole signed inner measures multibyte UTF8 exactly at2048 and refuses2049 without truncation', async () => {
  const { machine, recipient, content } = await context();
  const value = {
    ...payload,
    title: '界',
    options: payload.options.map((o) => ({ ...o, description: null })),
  } as r.SecurePushPayload;
  if (value.type !== 'question') throw new Error('question fixture');
  const base = r.buildPushPayload(value);
  const overhead =
    r.encodeSignedPushContent(content, base, new Uint8Array(64)).length - base.length;
  const slack = 2048 - overhead - base.length;
  const desc = '界'.repeat(Math.floor((slack + 2) / 3)) + 'a'.repeat((slack + 2) % 3);
  // Replacing JSON null (4 bytes) with a quoted string (2) gains two bytes of room.
  const options = value.options.map((o, i) => (i === 0 ? { ...o, description: desc } : o));
  const exact = r.buildPushPayload({ ...value, options });
  const sig = await machine.sign(await r.buildPushContentSigningInput(content, exact));
  const inner = r.encodeSignedPushContent(content, exact, sig);
  expect(inner.length).toBe(2048);
  const sealed = await r.seal(
    recipient.publicKey,
    r.pushAad(Buffer.from(content.rid, 'hex'), content.collapseId),
    inner,
    r.systemRandom,
  );
  expect(
    (
      await r.openPushContent(
        recipient,
        {
          v: 2,
          rid: content.rid,
          collapseId: content.collapseId,
          keyVersion: 1,
          kind: content.kind,
          sealed: r.b64u(sealed),
        },
        {
          machinePublicKey: content.machinePublicKey,
          devicePublicKey: content.devicePublicKey,
          pushPublicKey: content.pushPublicKey,
          keyVersion: 1,
        },
        1001,
      )
    ).payload,
  ).toEqual({ ...value, options });
  const larger = r.buildPushPayload({
    ...value,
    options: options.map((o, i) => (i === 0 ? { ...o, description: `${desc}a` } : o)),
  });
  expect(larger.length).toBe(exact.length + 1);
  expect(codeOfSync(() => r.encodeSignedPushContent(content, larger, sig))).toBe('OVERSIZE');
});
