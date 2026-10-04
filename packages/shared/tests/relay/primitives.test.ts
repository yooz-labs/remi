import { describe, expect, test } from 'bun:test';
import { relayV2 as r } from '../../src/index.ts';
import {
  aeadKey,
  aeadOpen,
  aeadSeal,
  ecGenerate,
  ecdh,
  frameAad,
  frameNonce,
  hkdf,
  hmacSha256,
  importEcPublic,
  sha256,
} from '../../src/relay/primitives.ts';
import { codeOf, hex, seed, seededRandom, text, unhex } from './helpers.ts';

const ORDER = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';
const GENERATOR_X = '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const GENERATOR_Y = '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';

describe('Ed25519 identities', () => {
  test('a seed gives the RFC 8032 public key and a deterministic signature', async () => {
    // RFC 8032 section 7.1, test 1: empty message.
    const signer = await r.signerFromSeed(
      unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
    );
    expect(hex(signer.publicKey)).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
    const sig = await signer.sign(new Uint8Array(0));
    expect(hex(sig)).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(hex(await signer.sign(new Uint8Array(0)))).toBe(hex(sig));
  });

  test('verifySignature accepts the signature and fails closed on every malformation', async () => {
    const signer = await r.signerFromSeed(seed('ed'));
    const msg = text('message');
    const sig = await signer.sign(msg);
    expect(await r.verifySignature(signer.publicKey, msg, sig)).toBe(true);
    expect(await r.verifySignature(signer.publicKey, text('other'), sig)).toBe(false);
    const flipped = sig.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(await r.verifySignature(signer.publicKey, msg, flipped)).toBe(false);
    expect(await r.verifySignature(signer.publicKey, msg, sig.slice(0, 63))).toBe(false);
    expect(await r.verifySignature(signer.publicKey.slice(0, 31), msg, sig)).toBe(false);
    expect(await r.verifySignature(new Uint8Array(32), msg, sig)).toBe(false);
    const other = await r.signerFromSeed(seed('ed other'));
    expect(await r.verifySignature(other.publicKey, msg, sig)).toBe(false);
  });
});

describe('P-256 keys', () => {
  test('scalar 1 is the generator, and the key is built from the scalar alone', async () => {
    const one = new Uint8Array(32);
    one[31] = 1;
    const pair = await r.ecPairFromScalar(one);
    expect(hex(pair.publicKey)).toBe(`04${GENERATOR_X}${GENERATOR_Y}`);
    expect(pair.privateKey.extractable).toBe(false);
  });

  test('a scalar of zero, the group order, above it, or the wrong length is refused', async () => {
    const zeroScalar = new Uint8Array(32);
    const bad = [
      zeroScalar,
      unhex(ORDER),
      unhex('ff'.repeat(32)),
      new Uint8Array(31),
      new Uint8Array(33),
    ];
    for (const d of bad) expect(await codeOf(r.ecPairFromScalar(d))).toBe('MALFORMED');
    const nMinus1 = unhex(ORDER);
    nMinus1[31] = (nMinus1[31] ?? 0) - 1;
    expect((await r.ecPairFromScalar(nMinus1)).publicKey.length).toBe(65);
  });

  test('ecGenerate redraws an out-of-range scalar and zeroes what it drew', async () => {
    const draws = [unhex(ORDER), new Uint8Array(32), seed('ec ok')];
    let i = 0;
    const rng: r.Rng = (n) => (draws[i++] as Uint8Array).slice(0, n);
    const pair = await ecGenerate(rng);
    expect(i).toBe(3);
    expect(pair.publicKey.length).toBe(65);
  });

  test('both sides of ECDH agree, and the secret is the 32-byte X coordinate', async () => {
    const a = await ecGenerate(seededRandom('ecdh a'));
    const b = await ecGenerate(seededRandom('ecdh b'));
    const ab = await ecdh(a.privateKey, b.publicKey);
    const ba = await ecdh(b.privateKey, a.publicKey);
    expect(ab.length).toBe(32);
    expect(hex(ab)).toBe(hex(ba));
  });

  test('a public key off the curve, with the wrong prefix or the wrong length is MALFORMED', async () => {
    const good = (await ecGenerate(seededRandom('pub'))).publicKey;
    const offCurve = good.slice();
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    const compressedPrefix = good.slice();
    compressedPrefix[0] = 2;
    const priv = (await ecGenerate(seededRandom('priv'))).privateKey;
    for (const bad of [offCurve, compressedPrefix, good.slice(0, 64), new Uint8Array(65)]) {
      expect(await codeOf(importEcPublic(bad))).toBe('MALFORMED');
      expect(await codeOf(ecdh(priv, bad))).toBe('MALFORMED');
    }
  });
});

describe('HKDF, HMAC and SHA-256', () => {
  test('HKDF-SHA256 matches RFC 5869 test case 1', async () => {
    const okm = await hkdf(
      unhex('0b'.repeat(22)),
      unhex('000102030405060708090a0b0c'),
      unhex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  test('HMAC-SHA256 matches RFC 4231 test case 2 and SHA-256 matches the empty-input digest', async () => {
    expect(hex(await hmacSha256(text('Jefe'), text('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    expect(hex(await sha256())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('AES-256-GCM frame primitives', () => {
  test('the nonce is a zero 32-bit prefix then the 64-bit counter', () => {
    expect(hex(frameNonce(0))).toBe('000000000000000000000000');
    expect(hex(frameNonce(1))).toBe('000000000000000000000001');
    expect(hex(frameNonce(2 ** 40))).toBe('000000000000010000000000');
  });

  test('the AAD is the label, version, type, direction and counter', () => {
    expect(hex(frameAad(3, r.DIR_C2H, 7))).toBe(
      `${hex(text('remi-relay-v2'))}020301${'00'.repeat(7)}07`,
    );
    expect(frameAad(3, r.DIR_C2H, 7).length).toBe(24);
  });

  test('a frame opens only under the same key, type, direction and counter', async () => {
    // One key on purpose: the header terms are what must tell these apart.
    const key = await aeadKey(seed('aead key'));
    const sealed = await aeadSeal(key, r.TYPE_DATA, r.DIR_C2H, 5, text('payload'));
    expect(hex(await aeadOpen(key, r.TYPE_DATA, r.DIR_C2H, 5, sealed))).toBe(hex(text('payload')));
    expect(await codeOf(aeadOpen(key, r.TYPE_DATA, r.DIR_H2C, 5, sealed))).toBe('DECRYPT');
    expect(await codeOf(aeadOpen(key, r.TYPE_READY, r.DIR_C2H, 5, sealed))).toBe('DECRYPT');
    expect(await codeOf(aeadOpen(key, r.TYPE_DATA, r.DIR_C2H, 6, sealed))).toBe('DECRYPT');
    const otherKey = await aeadKey(seed('aead other'));
    expect(await codeOf(aeadOpen(otherKey, r.TYPE_DATA, r.DIR_C2H, 5, sealed))).toBe('DECRYPT');
  });

  test('the authenticated header is bound by the AAD alone, with the nonce held fixed', async () => {
    // Counter 5 appears in both the nonce and the AAD, so sealing with the real
    // function cannot separate them. Build the tag with a hand-made AAD under the
    // same nonce: if frameAad did not cover type and direction this would open.
    const raw = seed('aad only');
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const forged = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: frameNonce(5), additionalData: frameAad(r.TYPE_DATA, r.DIR_H2C, 5) },
        key,
        text('x'),
      ),
    );
    const open = await aeadKey(raw);
    expect(await codeOf(aeadOpen(open, r.TYPE_DATA, r.DIR_C2H, 5, forged))).toBe('DECRYPT');
    expect(hex(await aeadOpen(open, r.TYPE_DATA, r.DIR_H2C, 5, forged))).toBe('78');
  });

  test('a truncated or extended ciphertext never opens', async () => {
    const key = await aeadKey(seed('aead trunc'));
    const sealed = await aeadSeal(key, r.TYPE_DATA, r.DIR_C2H, 1, text('payload'));
    expect(await codeOf(aeadOpen(key, r.TYPE_DATA, r.DIR_C2H, 1, sealed.slice(0, -1)))).toBe(
      'DECRYPT',
    );
    expect(await codeOf(aeadOpen(key, r.TYPE_DATA, r.DIR_C2H, 1, new Uint8Array(0)))).toBe(
      'DECRYPT',
    );
    expect(
      await codeOf(aeadOpen(key, r.TYPE_DATA, r.DIR_C2H, 1, new Uint8Array([...sealed, 0]))),
    ).toBe('DECRYPT');
  });
});
