import { describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { lps } from '../../src/relay/bytes.ts';
import * as r from '../../src/relay/internal.ts';
import { nodeSeal } from './builders.ts';
import { codeOf, codeOfSync, hex, seed, seededRandom, text } from './helpers.ts';

const RID = seed('seal rid').slice(0, 16);
const AAD = r.pushAad(RID, 'question-1');

async function recipient(label = 'seal recipient') {
  const scalar = seed(label);
  return { scalar, pair: await r.ecPairFromScalar(scalar) };
}

/** Open a sealed value with Node's crypto, written independently of the library. */
function nodeOpen(
  scalar: Uint8Array,
  recipientPublic: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
  bindRecipient = true,
): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(scalar));
  const ephemeral = sealed.slice(0, 65);
  const shared = ecdh.computeSecret(Buffer.from(ephemeral));
  const info = Buffer.from(
    bindRecipient ? lps('remi-relay-v2 seal', recipientPublic) : lps('remi-relay-v2 seal'),
  );
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(ephemeral), info, 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.slice(65, 77)));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.slice(sealed.length - 16)));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.slice(77, sealed.length - 16))),
    decipher.final(),
  ]).toString('utf8');
}

describe('push sealing', () => {
  test('a sealed body opens for the recipient and has the documented layout', async () => {
    const { pair } = await recipient();
    const sealed = await r.seal(
      pair.publicKey,
      AAD,
      text('Claude needs you'),
      seededRandom('seal a'),
    );
    expect(sealed.length).toBe(65 + 12 + 'Claude needs you'.length + 16);
    expect(sealed[0]).toBe(4);
    expect(hex(await r.openSeal(pair, AAD, sealed))).toBe(hex(text('Claude needs you')));
  });

  test('the layout is checkable without the library: Node opens it, with the recipient bound into the KDF', async () => {
    const { scalar, pair } = await recipient();
    const sealed = await r.seal(
      pair.publicKey,
      AAD,
      text('independent check'),
      seededRandom('seal b'),
    );
    expect(nodeOpen(scalar, pair.publicKey, AAD, sealed)).toBe('independent check');
    // Without the recipient key in the HKDF info the same bytes do not open: the term is real.
    expect(() => nodeOpen(scalar, pair.publicKey, AAD, sealed, false)).toThrow();
  });

  test('a value sealed by an independent implementation opens, and its length bounds are enforced', async () => {
    const { pair } = await recipient();
    const ok = nodeSeal(pair.publicKey, AAD, text('sealed elsewhere'), 'seal node ok');
    expect(hex(await r.openSeal(pair, AAD, ok))).toBe(hex(text('sealed elsewhere')));
    // Valid ciphertexts that the format forbids: an empty body and a body over the limit.
    const empty = nodeSeal(pair.publicKey, AAD, new Uint8Array(0), 'seal node empty');
    const big = nodeSeal(
      pair.publicKey,
      AAD,
      new Uint8Array(r.MAX_PUSH_PLAINTEXT + 1).fill(1),
      'seal node big',
    );
    const edge = nodeSeal(
      pair.publicKey,
      AAD,
      new Uint8Array(r.MAX_PUSH_PLAINTEXT).fill(1),
      'seal node edge',
    );
    expect(await codeOf(r.openSeal(pair, AAD, empty))).toBe('DECRYPT');
    expect(await codeOf(r.openSeal(pair, AAD, big))).toBe('DECRYPT');
    expect((await r.openSeal(pair, AAD, edge)).length).toBe(r.MAX_PUSH_PLAINTEXT);
  });

  test('with the test hook the ephemeral key and the nonce come from the injected source, in that order', async () => {
    const { pair } = await recipient();
    const a = seededRandom('seal c');
    const sealed = await r.seal(pair.publicKey, AAD, text('x'), a, () => r.ecGenerate(a));
    expect(a.draws.length).toBe(2);
    expect(a.draws[1]?.length).toBe(12);
    expect(hex(sealed.slice(65, 77))).toBe(hex(a.draws[1] as Uint8Array));
    const again = seededRandom('seal c');
    expect(
      hex(await r.seal(pair.publicKey, AAD, text('x'), again, () => r.ecGenerate(again))),
    ).toBe(hex(sealed));
    const d = seededRandom('seal d');
    const other = await r.seal(pair.publicKey, AAD, text('x'), d, () => r.ecGenerate(d));
    expect(hex(other)).not.toBe(hex(sealed));
  });

  test("by default the ephemeral key is the engine's: only the nonce is drawn, and equal sources still differ", async () => {
    const { pair } = await recipient();
    const a = seededRandom('seal engine');
    const first = await r.seal(pair.publicKey, AAD, text('x'), a);
    expect(a.draws.map((d) => d.length)).toEqual([12]);
    const second = await r.seal(pair.publicKey, AAD, text('x'), seededRandom('seal engine'));
    // Same nonce draw, different engine-generated ephemeral key.
    expect(hex(second.slice(65, 77))).toBe(hex(first.slice(65, 77)));
    expect(hex(second.slice(0, 65))).not.toBe(hex(first.slice(0, 65)));
    expect(hex(await r.openSeal(pair, AAD, second))).toBe(hex(text('x')));
  });

  test('the associated data binds the room and the question', async () => {
    const { pair } = await recipient();
    const sealed = await r.seal(pair.publicKey, AAD, text('body'), seededRandom('seal e'));
    expect(await codeOf(r.openSeal(pair, r.pushAad(RID, 'question-2'), sealed))).toBe('DECRYPT');
    expect(
      await codeOf(
        r.openSeal(pair, r.pushAad(seed('other rid').slice(0, 16), 'question-1'), sealed),
      ),
    ).toBe('DECRYPT');
    expect(await codeOf(r.openSeal(pair, new Uint8Array(0), sealed))).toBe('DECRYPT');
  });

  test('the associated data is rid then question id, with bounds on both', () => {
    expect(hex(r.pushAad(RID, 'q'))).toBe(`${hex(RID)}71`);
    expect(codeOfSync(() => r.pushAad(RID, ''))).toBe('MALFORMED');
    expect(codeOfSync(() => r.pushAad(RID, 'q'.repeat(65)))).toBe('MALFORMED');
    expect(r.pushAad(RID, 'q'.repeat(64)).length).toBe(16 + 64);
    expect(codeOfSync(() => r.pushAad(RID.slice(0, 15), 'q'))).toBe('MALFORMED');
  });

  test('another recipient, a tampered byte, a truncation and an extension never open', async () => {
    const { pair } = await recipient();
    const stranger = (await recipient('seal stranger')).pair;
    const sealed = await r.seal(pair.publicKey, AAD, text('body'), seededRandom('seal f'));
    expect(await codeOf(r.openSeal(stranger, AAD, sealed))).toBe('DECRYPT');
    for (let i = 0; i < sealed.length; i++) {
      const bad = sealed.slice();
      bad[i] = (bad[i] ?? 0) ^ 1;
      expect([i, await codeOf(r.openSeal(pair, AAD, bad))]).toEqual([i, 'DECRYPT']);
    }
    expect(await codeOf(r.openSeal(pair, AAD, sealed.slice(0, -1)))).toBe('DECRYPT');
    expect(await codeOf(r.openSeal(pair, AAD, new Uint8Array([...sealed, 0])))).toBe('DECRYPT');
  });

  test('length bounds on both sides: the body is 1 to 2048 bytes', async () => {
    const { pair } = await recipient();
    expect(
      await codeOf(r.seal(pair.publicKey, AAD, new Uint8Array(0), seededRandom('seal g'))),
    ).toBe('MALFORMED');
    expect(
      await codeOf(
        r.seal(
          pair.publicKey,
          AAD,
          new Uint8Array(r.MAX_PUSH_PLAINTEXT + 1),
          seededRandom('seal g'),
        ),
      ),
    ).toBe('OVERSIZE');
    const max = await r.seal(
      pair.publicKey,
      AAD,
      new Uint8Array(r.MAX_PUSH_PLAINTEXT).fill(1),
      seededRandom('seal g'),
    );
    expect((await r.openSeal(pair, AAD, max)).length).toBe(r.MAX_PUSH_PLAINTEXT);
    expect(await codeOf(r.openSeal(pair, AAD, new Uint8Array(65 + 12 + 16)))).toBe('DECRYPT');
    expect(await codeOf(r.openSeal(pair, AAD, new Uint8Array(max.length + 1)))).toBe('DECRYPT');
  });

  test('a recipient key that is not a point on the curve is refused when sealing', async () => {
    const { pair } = await recipient();
    const bad = pair.publicKey.slice();
    bad[64] = (bad[64] ?? 0) ^ 1;
    expect(await codeOf(r.seal(bad, AAD, text('x'), seededRandom('seal h')))).toBe('MALFORMED');
  });

  test('a sealed value whose ephemeral key is not a point is DECRYPT, never a crash', async () => {
    const { pair } = await recipient();
    const sealed = await r.seal(pair.publicKey, AAD, text('body'), seededRandom('seal i'));
    const bad = sealed.slice();
    bad[64] = (bad[64] ?? 0) ^ 1;
    expect(await codeOf(r.openSeal(pair, AAD, bad))).toBe('DECRYPT');
  });
});
