import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { b64u, fromB64u } from '../../src/relay/bytes.ts';
import * as r from '../../src/relay/internal.ts';
import { ecGenerate } from '../../src/relay/primitives.ts';
import { codeOf, hex, seed, seededRandom, text, unhex } from './helpers.ts';

const NOW_SEC = 1_800_000_000;
const MACHINE = seed('pairing machine key');
const SECRET = seed('pairing secret');
const URL = 'wss://relay.example.test/v2';

async function sealKey(): Promise<Uint8Array> {
  return (await ecGenerate(seededRandom('pairing seal key'))).publicKey;
}

const token = (patch: Partial<r.PairingToken> = {}): r.PairingToken => ({
  relayUrl: URL,
  machinePublicKey: MACHINE,
  secret: SECRET,
  expiresAtSec: NOW_SEC + 600,
  ...patch,
});

/** Re-wrap raw token bytes in the string form. */
const wrap = (bytes: Uint8Array): string => `remi-pair2:${b64u(bytes)}`;
const unwrap = (s: string): Uint8Array => fromB64u(s.slice('remi-pair2:'.length));

describe('pairing offers', () => {
  test('an offer takes its secret from the injected source and lives for ten minutes', () => {
    const rng = seededRandom('offer');
    const offer = r.createPairingOffer(rng, 5_000);
    expect(offer.secret.length).toBe(32);
    expect(hex(offer.secret)).toBe(hex(rng.draws[0] as Uint8Array));
    expect(offer.used).toBe(false);
    expect(offer.expiresAtMs).toBe(5_000 + r.PAIRING_TTL_SECONDS * 1000);
  });

  test('an offer is live until it is used or its time is up', () => {
    const live: r.PairingOffer = { secret: SECRET, expiresAtMs: 10_000, used: false };
    expect(r.isLiveOffer(live, 9_999)).toBe(true);
    expect(r.isLiveOffer(live, 10_000)).toBe(false);
    expect(r.isLiveOffer({ ...live, used: true }, 0)).toBe(false);
    expect(r.isLiveOffer({ ...live, secret: SECRET.slice(0, 31) }, 0)).toBe(false);
  });

  test('liveOffers keeps order, drops dead offers and caps how many a host will try', () => {
    const offers: r.PairingOffer[] = Array.from({ length: 12 }, (_, i) => ({
      secret: seed(`offer ${i}`),
      expiresAtMs: 10_000,
      used: i === 1,
    }));
    const live = r.liveOffers(offers, 0);
    expect(live.length).toBe(r.MAX_PAIRING_OFFERS);
    expect(live[0]).toBe(offers[0] as r.PairingOffer);
    expect(live[1]).toBe(offers[2] as r.PairingOffer);
    expect(r.liveOffers(offers, 10_000)).toEqual([]);
  });
});

describe('pairing token', () => {
  test('the binary layout is version, flags, expiry, machine key, secret, then the url', () => {
    const bytes = unwrap(r.encodePairingToken(token()));
    expect(bytes[0]).toBe(2);
    expect(bytes[1]).toBe(0);
    expect(hex(bytes.slice(2, 10))).toBe(
      hex(new Uint8Array(new BigUint64Array([BigInt(NOW_SEC + 600)]).buffer).reverse()),
    );
    expect(hex(bytes.slice(10, 42))).toBe(hex(MACHINE));
    expect(hex(bytes.slice(42, 74))).toBe(hex(SECRET));
    expect(new TextDecoder().decode(bytes.slice(74))).toBe(URL);
  });

  test('a token with a seal key places it before the url and sets flag bit 0', async () => {
    const key = await sealKey();
    const bytes = unwrap(r.encodePairingToken(token({ sealPublicKey: key })));
    expect(bytes[1]).toBe(1);
    expect(hex(bytes.slice(74, 139))).toBe(hex(key));
    expect(new TextDecoder().decode(bytes.slice(139))).toBe(URL);
  });

  test('a token round trips, with and without a seal key', async () => {
    const key = await sealKey();
    for (const t of [token(), token({ sealPublicKey: key })]) {
      const d = await r.decodePairingToken(r.encodePairingToken(t), NOW_SEC);
      expect(d.relayUrl).toBe(t.relayUrl);
      expect(hex(d.machinePublicKey)).toBe(hex(t.machinePublicKey));
      expect(hex(d.secret)).toBe(hex(t.secret));
      expect(d.expiresAtSec).toBe(t.expiresAtSec);
      expect(d.sealPublicKey ? hex(d.sealPublicKey) : null).toBe(
        t.sealPublicKey ? hex(t.sealPublicKey) : null,
      );
    }
  });

  test('a loopback ws url is allowed for local development, other plain ws urls are not', async () => {
    for (const url of [
      'ws://localhost:8787',
      'ws://127.0.0.1:8787/v2',
      'wss://a.b-c.example:443/x/y_z~1',
    ]) {
      expect(
        (await r.decodePairingToken(r.encodePairingToken(token({ relayUrl: url })), NOW_SEC))
          .relayUrl,
      ).toBe(url);
    }
    for (const url of [
      'ws://example.com',
      'ws://localhost.evil.com',
      'http://example.com',
      'https://example.com',
      'wss://',
      'wss://UPPER.example',
      'wss://user@example.com',
      'wss://example.com?q=1',
      'wss://example.com/#f',
      'wss://[::1]/',
      'wss://example.com/with space',
      '',
    ]) {
      expect(() => r.encodePairingToken(token({ relayUrl: url }))).toThrow(r.RelayError);
    }
  });

  test('encoding refuses fields of the wrong size', async () => {
    const key = await sealKey();
    for (const t of [
      token({ machinePublicKey: MACHINE.slice(0, 31) }),
      token({ secret: SECRET.slice(0, 31) }),
      token({ sealPublicKey: key.slice(0, 64) }),
      token({ relayUrl: `wss://${'a'.repeat(510)}` }),
    ]) {
      expect(() => r.encodePairingToken(t)).toThrow(r.RelayError);
    }
  });

  test('a string without the prefix, or with a payload that is not canonical base64url, is TOKEN', async () => {
    const good = r.encodePairingToken(token());
    for (const bad of [
      '',
      good.slice(1),
      good.replace('remi-pair2:', 'remi-pair1:'),
      `${good}=`,
      `${good} `,
      `remi-pair2:${'+'.repeat(40)}`,
    ]) {
      expect(await codeOf(r.decodePairingToken(bad, NOW_SEC))).toBe('TOKEN');
    }
  });

  test('a malformed binary token is TOKEN: short, wrong version, reserved flags, empty url', async () => {
    const good = unwrap(r.encodePairingToken(token()));
    const variants: Uint8Array[] = [
      good.slice(0, 74),
      good.slice(0, 40),
      Uint8Array.from(good, (b, i) => (i === 0 ? 1 : b)),
      Uint8Array.from(good, (b, i) => (i === 0 ? 3 : b)),
      Uint8Array.from(good, (b, i) => (i === 1 ? 2 : b)),
      Uint8Array.from(good, (b, i) => (i === 1 ? 0x80 : b)),
      Uint8Array.from(good, (b, i) => (i === 1 ? 1 : b)),
    ];
    for (const v of variants)
      expect(await codeOf(r.decodePairingToken(wrap(v), NOW_SEC))).toBe('TOKEN');
  });

  test('a token too short to hold its fixed part is TOKEN, not a crash', async () => {
    for (const len of [0, 1, 5, 9, 10, 74]) {
      expect(await codeOf(r.decodePairingToken(wrap(new Uint8Array(len).fill(2)), NOW_SEC))).toBe(
        'TOKEN',
      );
    }
  });

  test('an url of 513 bytes, invalid UTF-8, or unlisted characters is TOKEN', async () => {
    const head = unwrap(r.encodePairingToken(token())).slice(0, 74);
    const withUrl = (url: Uint8Array): string => wrap(new Uint8Array([...head, ...url]));
    const long = text(`wss://${'a'.repeat(507)}`);
    expect(long.length).toBe(513);
    expect(await codeOf(r.decodePairingToken(withUrl(long), NOW_SEC))).toBe('TOKEN');
    expect(await codeOf(r.decodePairingToken(withUrl(unhex('7773733a2f2fc328')), NOW_SEC))).toBe(
      'TOKEN',
    );
    expect(await codeOf(r.decodePairingToken(withUrl(text('wss://exaémple.com')), NOW_SEC))).toBe(
      'TOKEN',
    );
  });

  test('an expired token is EXPIRED, one expiring this second included', async () => {
    const t = r.encodePairingToken(token({ expiresAtSec: NOW_SEC }));
    expect(await codeOf(r.decodePairingToken(t, NOW_SEC))).toBe('EXPIRED');
    expect(await codeOf(r.decodePairingToken(t, NOW_SEC + 1))).toBe('EXPIRED');
    expect((await r.decodePairingToken(t, NOW_SEC - 1)).expiresAtSec).toBe(NOW_SEC);
  });

  test('a token that outlives the policy is TOKEN, at exactly the ttl plus the skew is accepted', async () => {
    const limit = NOW_SEC + r.PAIRING_TTL_SECONDS + r.PAIRING_SKEW_SECONDS;
    expect(
      (await r.decodePairingToken(r.encodePairingToken(token({ expiresAtSec: limit })), NOW_SEC))
        .expiresAtSec,
    ).toBe(limit);
    expect(
      await codeOf(
        r.decodePairingToken(r.encodePairingToken(token({ expiresAtSec: limit + 1 })), NOW_SEC),
      ),
    ).toBe('TOKEN');
  });

  test('an expiry that does not fit a safe integer is TOKEN', async () => {
    const good = unwrap(r.encodePairingToken(token()));
    const huge = good.slice();
    huge.fill(0xff, 2, 10);
    expect(await codeOf(r.decodePairingToken(wrap(huge), NOW_SEC))).toBe('TOKEN');
  });

  test('a seal key that is not a point on the curve is TOKEN', async () => {
    const key = (await sealKey()).slice();
    key[64] = (key[64] ?? 0) ^ 1;
    const bad = r.encodePairingToken(token({ sealPublicKey: key }));
    expect(await codeOf(r.decodePairingToken(bad, NOW_SEC))).toBe('TOKEN');
  });
});

describe('fingerprint', () => {
  test('is four groups of four lowercase hex digits over both public keys', async () => {
    const device = seed('fp device');
    const fp = await r.fingerprintOf(device, MACHINE);
    expect(fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    const expected = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from('0019', 'hex'),
          Buffer.from('remi-relay-v2 fingerprint'),
          Buffer.from('0020', 'hex'),
          device,
          Buffer.from('0020', 'hex'),
          MACHINE,
        ]),
      )
      .digest('hex')
      .slice(0, 16);
    expect(fp.replaceAll('-', '')).toBe(expected);
  });

  test('depends on both keys and on their order', async () => {
    const a = seed('fp a');
    const b = seed('fp b');
    const base = await r.fingerprintOf(a, b);
    expect(await r.fingerprintOf(b, a)).not.toBe(base);
    expect(await r.fingerprintOf(a, seed('fp c'))).not.toBe(base);
    expect(await r.fingerprintOf(seed('fp d'), b)).not.toBe(base);
    expect(await r.fingerprintOf(a, b)).toBe(base);
  });
});

describe('Worker admission formats', () => {
  const nonce = seed('admission nonce');
  const other = seed('admission other nonce');

  test('a host proof verifies only for the right room, nonce and key', async () => {
    const machine = await r.signerFromSeed(MACHINE);
    const rid = await r.ridOf(machine.publicKey);
    const sig = await r.signAdmission(machine, 'host', rid, nonce);
    expect(await r.verifyAdmission('host', machine.publicKey, rid, nonce, sig)).toBe(true);
    expect(await r.verifyAdmission('host', machine.publicKey, rid, other, sig)).toBe(false);
    expect(
      await r.verifyAdmission(
        'host',
        machine.publicKey,
        seed('other room').slice(0, 16),
        nonce,
        sig,
      ),
    ).toBe(false);
    expect(await r.verifyAdmission('host', machine.publicKey, rid, nonce.slice(0, 31), sig)).toBe(
      false,
    );
    expect(await r.verifyAdmission('host', machine.publicKey, rid.slice(0, 15), nonce, sig)).toBe(
      false,
    );
  });

  test('a host proof from a key that does not hash to the room id is refused even with a valid signature', async () => {
    const attacker = await r.signerFromSeed(seed('attacker'));
    const victimRid = await r.ridOf((await r.signerFromSeed(MACHINE)).publicKey);
    const sig = await r.signAdmission(attacker, 'host', victimRid, nonce);
    expect(await r.verifyAdmission('host', attacker.publicKey, victimRid, nonce, sig)).toBe(false);
  });

  test('a client proof is refused for another room, and for a nonce or room id of the wrong length', async () => {
    const device = await r.signerFromSeed(seed('admission device two'));
    const rid = seed('room a').slice(0, 16);
    const sig = await r.signAdmission(device, 'client', rid, nonce);
    expect(await r.verifyAdmission('client', device.publicKey, rid, nonce, sig)).toBe(true);
    expect(
      await r.verifyAdmission('client', device.publicKey, seed('room b').slice(0, 16), nonce, sig),
    ).toBe(false);
    const shortNonce = nonce.slice(0, 31);
    const shortSig = await r.signAdmission(device, 'client', rid, shortNonce);
    expect(await r.verifyAdmission('client', device.publicKey, rid, shortNonce, shortSig)).toBe(
      false,
    );
    const shortRid = rid.slice(0, 15);
    const ridSig = await r.signAdmission(device, 'client', shortRid, nonce);
    expect(await r.verifyAdmission('client', device.publicKey, shortRid, nonce, ridSig)).toBe(
      false,
    );
  });

  test('the role is part of what is signed: a client proof is not a host proof and the reverse', async () => {
    const machine = await r.signerFromSeed(MACHINE);
    const rid = await r.ridOf(machine.publicKey);
    const clientSig = await r.signAdmission(machine, 'client', rid, nonce);
    const hostSig = await r.signAdmission(machine, 'host', rid, nonce);
    expect(await r.verifyAdmission('client', machine.publicKey, rid, nonce, clientSig)).toBe(true);
    expect(await r.verifyAdmission('host', machine.publicKey, rid, nonce, clientSig)).toBe(false);
    expect(await r.verifyAdmission('client', machine.publicKey, rid, nonce, hostSig)).toBe(false);
  });

  test('a client proof needs no relation between the device key and the room id', async () => {
    const device = await r.signerFromSeed(seed('admission device'));
    const rid = await r.ridOf((await r.signerFromSeed(MACHINE)).publicKey);
    const sig = await r.signAdmission(device, 'client', rid, nonce);
    expect(await r.verifyAdmission('client', device.publicKey, rid, nonce, sig)).toBe(true);
    expect(await r.verifyAdmission('client', device.publicKey, rid, other, sig)).toBe(false);
  });

  test('the admission ticket is HMAC-SHA256 of the label under the pairing secret, and only its hash is registered', async () => {
    const tag = await r.admitTag(SECRET);
    expect(hex(tag)).toBe(createHmac('sha256', SECRET).update('remi-relay-v2 admit').digest('hex'));
    const registered = await r.admitTagHash(tag);
    expect(hex(registered)).toBe(createHash('sha256').update(tag).digest('hex'));
    expect(await r.admitTagMatches(tag, registered)).toBe(true);
    expect(await r.admitTagMatches(await r.admitTag(seed('another secret')), registered)).toBe(
      false,
    );
    expect(await r.admitTagMatches(tag, registered.slice(0, 31))).toBe(false);
    expect(hex(tag)).not.toBe(hex(SECRET));
  });
});
