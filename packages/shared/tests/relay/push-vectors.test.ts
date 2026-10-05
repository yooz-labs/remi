import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as r from '../../src/relay/internal.ts';
import { codeOf, hex, text, unhex } from './helpers.ts';
import { buildPushVectors } from './push-vectors-builder.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/relay-v2/push-vectors.json', import.meta.url), 'utf8'),
) as Awaited<ReturnType<typeof buildPushVectors>>;

test('push synthetic fixture regenerates every exact tuple, signature and sealed byte', async () => {
  expect(await buildPushVectors()).toEqual(fixture);
});
test('all push kinds and noncanonical signed JSON open with actual pinned authority', async () => {
  const recipient = await r.ecPairFromScalar(unhex(fixture.recipientScalarHex));
  for (const c of fixture.cases) {
    const carrier: r.PushCarrier = {
      v: 2,
      rid: c.content.rid,
      collapseId: c.content.collapseId,
      keyVersion: c.content.keyVersion,
      kind: c.content.kind,
      sealed: r.b64u(unhex(c.sealedHex)),
    };
    const authority = {
      machinePublicKey: c.content.machinePublicKey,
      devicePublicKey: c.content.devicePublicKey,
      pushPublicKey: c.content.pushPublicKey,
      keyVersion: c.content.keyVersion,
    };
    const opened = await r.openPushContent(recipient, carrier, authority, 1700000001);
    expect(opened.payload).toEqual(JSON.parse(c.payloadUtf8));
    expect(hex(r.decodeSignedPushContent(unhex(c.innerHex)).payloadBytes)).toBe(c.payloadHex);
    expect(opened.contentDigest).toBe(c.contentInputHex.slice(-64));
    expect(
      (
        await r.verifyPushSubmit(
          r.decodePushSubmit(c.submitJson),
          { rid: c.content.rid, audience: c.submit.audience },
          1700000001,
        )
      ).requestDigest,
    ).toBe(c.requestDigest);
  }
});
test('push signature is checked before interpreting altered plaintext semantics', async () => {
  const c = fixture.cases[0];
  if (!c) throw new Error('fixture missing');
  const recipient = await r.ecPairFromScalar(unhex(fixture.recipientScalarHex));
  // Deliberately construct an attacker-controlled ECIES body with authentic old signature,
  // changing only payload to invalid JSON. ECIES alone supplies no sender authenticity.
  const original = r.decodeSignedPushContent(unhex(c.innerHex));
  const body = r.lps(
    r.fromB64u(c.content.machinePublicKey),
    Buffer.from(c.content.rid, 'hex'),
    r.fromB64u(c.content.devicePublicKey),
    r.fromB64u(c.content.pushPublicKey),
    r.be64(c.content.keyVersion),
    c.content.collapseId,
    r.be64(c.content.revision),
    Uint8Array.of(1),
    r.fromB64u(c.content.nonce),
    r.be64(c.content.issuedAt),
    r.be64(c.content.expiresAt),
    text('{invalid owned JSON'),
  );
  const sealed = await r.seal(
    recipient.publicKey,
    r.pushAad(Buffer.from(c.content.rid, 'hex'), c.content.collapseId),
    r.lps(body, original.signature),
    r.systemRandom,
  );
  expect(
    await codeOf(
      r.openPushContent(
        recipient,
        {
          v: 2,
          rid: c.content.rid,
          collapseId: c.content.collapseId,
          keyVersion: c.content.keyVersion,
          kind: c.content.kind,
          sealed: r.b64u(sealed),
        },
        {
          machinePublicKey: c.content.machinePublicKey,
          devicePublicKey: c.content.devicePublicKey,
          pushPublicKey: c.content.pushPublicKey,
          keyVersion: c.content.keyVersion,
        },
        1700000001,
      ),
    ),
  ).toBe('BAD_SIGNATURE');
});
