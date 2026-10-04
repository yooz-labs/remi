/**
 * Deterministic generator for the relay v2 test vectors (ADR 0034 section 13).
 *
 *   bun packages/shared/tests/relay/generate-vectors.ts
 *
 * writes `packages/shared/tests/fixtures/relay-v2/vectors.json`. Every value
 * comes from a fixed public label (`SHA-256("remi-relay-v2 test vector " ||
 * label)`) or from the library fed those seeds: no key in the file is real and
 * none has protected anything. A test regenerates the file in memory and
 * requires it to equal the committed one.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64u, be64, concat } from '../../src/relay/bytes.ts';
import * as r from '../../src/relay/internal.ts';
import {
  aeadKey,
  aeadSeal,
  ecGenerate,
  ecdh,
  frameAad,
  frameNonce,
} from '../../src/relay/primitives.ts';
import { nodeSeal, refHash } from './builders.ts';
import { NOW } from './flow.ts';
import { hex, seed, seededRandom, text } from './helpers.ts';
import { recorder } from './recorder.ts';

export const VECTORS_PATH = join(import.meta.dir, '..', 'fixtures', 'relay-v2', 'vectors.json');

const NOW_SEC = 1_800_000_000;
const DEVICE_NAME = 'Vector phone';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const bytesHex = (b: Uint8Array): string => hex(b);
const flip = (b: Uint8Array, i: number): Uint8Array =>
  Uint8Array.from(b, (x, j) => (j === i ? x ^ 1 : x));

interface Session {
  mode: r.Mode;
  psk: Uint8Array | null;
  z: Uint8Array;
  h1: Uint8Array;
  hostSignature: Uint8Array;
  keys: { c2h: Uint8Array; h2c: Uint8Array };
  hello: string;
  helloAck: string;
  auth: string;
  ready: string;
  transcript: r.Transcript;
  json: Obj;
}

export async function generateVectors(): Promise<Obj> {
  const machine = await r.signerFromSeed(seed('machine'));
  const device = await r.signerFromSeed(seed('device'));
  const impostor = await r.signerFromSeed(seed('impostor machine'));
  const rid = await r.ridOf(machine.publicKey);
  const nameBytes = text(DEVICE_NAME);
  const offer = r.createPairingOffer(seededRandom('vector offer'), NOW);

  async function session(mode: r.Mode): Promise<Session> {
    const label = `vector ${mode}`;
    const psk = mode === 'pair' ? offer.secret : null;
    const clientRng = seededRandom(`${label} client`);
    const hostRng = seededRandom(`${label} host`);
    const policy: r.HostPolicy = {
      offers: mode === 'pair' ? [offer] : [],
      isEnrolled: (k) => hex(k) === hex(device.publicKey),
    };
    const c1 = await r.clientStart(
      {
        machinePublicKey: machine.publicKey,
        device,
        deviceName: DEVICE_NAME,
        mode,
        ...(psk ? { pairingSecret: psk } : {}),
        random: clientRng,
      },
      NOW,
    );
    const h1s = await r.hostOnHello({ machine, random: hostRng }, c1.hello, policy, NOW);
    const c2 = await c1.onHelloAck(h1s.helloAck, NOW + 10);
    const h2s = await h1s.onAuth(c2.auth, policy, NOW + 20);
    const hostIo = recorder();
    const clientIo = recorder();
    const { ready, channel: hostCh } = await h2s.ready(NOW + 30, hostIo.io);
    const clientCh = await c2.onReady(ready, NOW + 40, clientIo.io);
    for (let i = 1; i <= 10; i++) {
      await clientCh.send(text(JSON.stringify({ type: 'ping', n: i })));
      await hostCh.send(text(JSON.stringify({ type: 'pong', n: i })));
    }

    // Independent recomputation of every value from the raw draws, then a check that the
    // real flow produced exactly those bytes.
    if (clientRng.draws.length !== 2 || hostRng.draws.length !== 2)
      throw new Error('unexpected random draws');
    const [cScalar, cNonce] = clientRng.draws as [Uint8Array, Uint8Array];
    const [hScalar, hNonce] = hostRng.draws as [Uint8Array, Uint8Array];
    const cPair = await r.ecPairFromScalar(cScalar);
    const hPair = await r.ecPairFromScalar(hScalar);
    const z = await ecdh(cPair.privateKey, hPair.publicKey);
    const transcript: r.Transcript = {
      rid,
      mode,
      clientEphemeral: cPair.publicKey,
      clientNonce: cNonce,
      hostEphemeral: hPair.publicKey,
      hostNonce: hNonce,
    };
    const h1 = await r.transcriptH1(transcript);
    const hostSignature = await machine.sign(r.hostSigningInput(h1));
    const keys = await r.deriveSessionKeys(z, h1, psk);
    const h2 = await r.transcriptH2(h1, hostSignature, device.publicKey, nameBytes);
    const clientSignature = await device.sign(r.clientSigningInput(h2));
    const authPlaintext = concat(device.publicKey, clientSignature, nameBytes);
    const authCt = await aeadSeal(
      await aeadKey(keys.c2h),
      r.TYPE_AUTH,
      r.DIR_C2H,
      0,
      authPlaintext,
    );
    const readyPlaintext = Uint8Array.of(mode === 'pair' ? 1 : 2);
    const readyCt = await aeadSeal(
      await aeadKey(keys.h2c),
      r.TYPE_READY,
      r.DIR_H2C,
      0,
      readyPlaintext,
    );
    const expect = (name: string, got: string, want: string): void => {
      if (got !== want) throw new Error(`generator self-check failed: ${name}`);
    };
    expect('hello', c1.hello, r.encodeHello(mode, cPair.publicKey, cNonce));
    expect('helloAck', h1s.helloAck, r.encodeHelloAck(hPair.publicKey, hNonce, hostSignature));
    expect('auth', c2.auth, r.encodeSealedControl('auth', authCt));
    expect('ready', ready, r.encodeSealedControl('ready', readyCt));
    expect('fingerprint', c2.fingerprint, h2s.fingerprint);

    const data = async (
      frames: Uint8Array[],
      key: Uint8Array,
      dir: r.Direction,
      label2: string,
      ping: boolean,
    ): Promise<Json[]> => {
      const aesKey = await aeadKey(key);
      const out: Json[] = [];
      for (let i = 0; i < frames.length; i++) {
        const counter = i + 1;
        const plaintext = text(JSON.stringify({ type: ping ? 'ping' : 'pong', n: counter }));
        const ct = await aeadSeal(aesKey, r.TYPE_DATA, dir, counter, plaintext);
        const frame = concat(Uint8Array.of(r.TYPE_DATA), be64(counter), ct);
        expect(`${label2} frame ${counter}`, hex(frame), hex(frames[i] as Uint8Array));
        out.push({
          counter,
          plaintext: bytesHex(plaintext),
          nonce: bytesHex(frameNonce(counter)),
          aad: bytesHex(frameAad(r.TYPE_DATA, dir, counter)),
          frame: bytesHex(frame),
        });
      }
      return out;
    };

    const json: Obj = {
      mode,
      psk: psk ? bytesHex(psk) : null,
      deviceName: DEVICE_NAME,
      clientEphemeral: { scalar: bytesHex(cScalar), publicKey: bytesHex(cPair.publicKey) },
      hostEphemeral: { scalar: bytesHex(hScalar), publicKey: bytesHex(hPair.publicKey) },
      clientNonce: bytesHex(cNonce),
      hostNonce: bytesHex(hNonce),
      hello: c1.hello,
      helloAck: h1s.helloAck,
      h1: bytesHex(h1),
      hostSigningInput: bytesHex(r.hostSigningInput(h1)),
      hostSignature: bytesHex(hostSignature),
      z: bytesHex(z),
      keys: { c2h: bytesHex(keys.c2h), h2c: bytesHex(keys.h2c) },
      h2: bytesHex(h2),
      clientSigningInput: bytesHex(r.clientSigningInput(h2)),
      clientSignature: bytesHex(clientSignature),
      authPlaintext: bytesHex(authPlaintext),
      authNonce: bytesHex(frameNonce(0)),
      authAad: bytesHex(frameAad(r.TYPE_AUTH, r.DIR_C2H, 0)),
      authCiphertext: bytesHex(authCt),
      auth: c2.auth,
      readyPlaintext: bytesHex(readyPlaintext),
      readyNonce: bytesHex(frameNonce(0)),
      readyAad: bytesHex(frameAad(r.TYPE_READY, r.DIR_H2C, 0)),
      readyCiphertext: bytesHex(readyCt),
      ready,
      fingerprint: c2.fingerprint,
      data: {
        c2h: await data(clientIo.frames, keys.c2h, r.DIR_C2H, 'c2h', true),
        h2c: await data(hostIo.frames, keys.h2c, r.DIR_H2C, 'h2c', false),
      },
    };
    return {
      mode,
      psk,
      z,
      h1,
      hostSignature,
      keys,
      hello: c1.hello,
      helloAck: h1s.helloAck,
      auth: c2.auth,
      ready,
      transcript,
      json,
    };
  }

  const pair = await session('pair');
  const resume = await session('resume');
  const negative: Obj[] = [];

  // ---- control frame decoding
  {
    const helloObj = JSON.parse(pair.hello) as Record<string, string>;
    const ackObj = JSON.parse(pair.helloAck) as Record<string, string>;
    const h = (patch: Record<string, unknown>): string => JSON.stringify({ ...helloObj, ...patch });
    const ctl = (name: string, frame: string, textFrame: string, code: string): void => {
      negative.push({
        kind: 'control_decode',
        name,
        frame,
        text: textFrame,
        expect: 'reject',
        code,
      });
    };
    ctl('hello version 3', 'hello', pair.hello.replace('"v":2', '"v":3'), 'VERSION');
    ctl('hello version 1 (a v1 peer)', 'hello', pair.hello.replace('"v":2', '"v":1'), 'VERSION');
    ctl('hello version is a string', 'hello', pair.hello.replace('"v":2', '"v":"2"'), 'MALFORMED');
    ctl('hello version 2.0', 'hello', pair.hello.replace('"v":2', '"v":2.0'), 'MALFORMED');
    ctl('hello unknown mode', 'hello', h({ m: 'admin' }), 'MODE');
    ctl('hello wrong type', 'hello', h({ t: 'hello_ack' }), 'TYPE');
    ctl('hello extra field', 'hello', pair.hello.replace('}', ',"x":"y"}'), 'MALFORMED');
    ctl('hello missing nonce', 'hello', pair.hello.replace(/,"n":"[^"]*"/, ''), 'MALFORMED');
    ctl(
      'hello keys reordered',
      'hello',
      JSON.stringify({ v: 2, t: 'hello', m: helloObj['m'], n: helloObj['n'], e: helloObj['e'] }),
      'MALFORMED',
    );
    ctl('hello whitespace', 'hello', pair.hello.replace(',"t"', ', "t"'), 'MALFORMED');
    ctl('hello trailing space', 'hello', `${pair.hello} `, 'MALFORMED');
    ctl('hello padded base64url', 'hello', h({ e: `${helloObj['e']}=` }), 'MALFORMED');
    ctl(
      'hello standard base64 alphabet',
      'hello',
      h({ e: `+${(helloObj['e'] as string).slice(1)}` }),
      'MALFORMED',
    );
    ctl(
      'hello ephemeral key 64 bytes',
      'hello',
      h({ e: b64u(r.decodeHello(pair.hello).ephemeral.slice(0, 64)) }),
      'MALFORMED',
    );
    ctl(
      'hello ephemeral key with compressed prefix',
      'hello',
      h({
        e: b64u(Uint8Array.from(r.decodeHello(pair.hello).ephemeral, (x, i) => (i === 0 ? 2 : x))),
      }),
      'MALFORMED',
    );
    ctl(
      'hello nonce 31 bytes',
      'hello',
      h({ n: b64u(r.decodeHello(pair.hello).nonce.slice(0, 31)) }),
      'MALFORMED',
    );
    ctl(
      'hello duplicate key',
      'hello',
      pair.hello.replace('"m":"pair"', '"m":"pair","m":"pair"'),
      'MALFORMED',
    );
    ctl('hello escaped mode', 'hello', pair.hello.replace('"pair"', '"p\\u0061ir"'), 'MALFORMED');
    ctl('hello field is a number', 'hello', h({ n: 5 }), 'MALFORMED');
    ctl('hello not json', 'hello', 'not json', 'MALFORMED');
    ctl('hello over the size limit', 'hello', 'x'.repeat(513), 'OVERSIZE');
    ctl('hello at the size limit is not oversize', 'hello', 'x'.repeat(512), 'MALFORMED');
    ctl('hello of 300 two-byte characters (600 bytes)', 'hello', '\u00e9'.repeat(300), 'OVERSIZE');
    ctl('hello version 3.0', 'hello', pair.hello.replace('"v":2', '"v":3.0'), 'VERSION');
    ctl('hello version true', 'hello', pair.hello.replace('"v":2', '"v":true'), 'MALFORMED');
    ctl('hello version NaN', 'hello', pair.hello.replace('"v":2', '"v":NaN'), 'MALFORMED');
    ctl('hello type is a number', 'hello', h({ t: 5 }), 'TYPE');
    ctl('hello mode is a number', 'hello', h({ m: 1 }), 'MODE');
    ctl('hello without a mode', 'hello', pair.hello.replace(/"m":"pair",/, ''), 'MODE');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const nonce = helloObj['n'] as string;
    const lastIndex = alphabet.indexOf(nonce.slice(-1));
    const trailing =
      alphabet[(lastIndex & ~3) | 1] === nonce.slice(-1)
        ? alphabet[(lastIndex & ~3) | 2]
        : alphabet[(lastIndex & ~3) | 1];
    ctl(
      'hello nonce with non-zero trailing bits',
      'hello',
      h({ n: nonce.slice(0, -1) + trailing }),
      'MALFORMED',
    );
    ctl(
      'hello nonce of 41 characters (1 modulo 4)',
      'hello',
      h({ n: nonce.slice(0, 41) }),
      'MALFORMED',
    );
    ctl('hello_ack version 1', 'hello_ack', pair.helloAck.replace('"v":2', '"v":1'), 'VERSION');
    ctl(
      'hello_ack signature 63 bytes',
      'hello_ack',
      JSON.stringify({
        ...ackObj,
        s: b64u(r.decodeHelloAck(pair.helloAck).signature.slice(0, 63)),
      }),
      'MALFORMED',
    );
    ctl('hello_ack where auth is expected', 'auth', pair.helloAck, 'TYPE');
    for (const [len, label2] of [
      [111, 'auth ciphertext 111 bytes'],
      [177, 'auth ciphertext 177 bytes'],
    ] as const) {
      ctl(label2, 'auth', r.encodeSealedControl('auth', new Uint8Array(len)), 'MALFORMED');
    }
    for (const [len, label2] of [
      [16, 'ready ciphertext 16 bytes'],
      [18, 'ready ciphertext 18 bytes'],
    ] as const) {
      ctl(label2, 'ready', r.encodeSealedControl('ready', new Uint8Array(len)), 'MALFORMED');
    }
    ctl('ready where auth is expected', 'auth', pair.ready, 'TYPE');
    negative.push({
      kind: 'control_decode',
      name: 'control: a valid hello',
      frame: 'hello',
      text: pair.hello,
      expect: 'accept',
    });
    negative.push({
      kind: 'control_decode',
      name: 'control: a valid hello_ack',
      frame: 'hello_ack',
      text: pair.helloAck,
      expect: 'accept',
    });
  }

  // ---- ephemeral keys that are not points
  {
    const point = r.decodeHello(pair.hello).ephemeral;
    negative.push({
      kind: 'ec_point',
      name: 'public key off the curve',
      publicKey: bytesHex(flip(point, 64)),
      expect: 'reject',
      code: 'MALFORMED',
    });
    negative.push({
      kind: 'ec_point',
      name: 'all-zero coordinates',
      publicKey: bytesHex(Uint8Array.from(point, (_, i) => (i === 0 ? 4 : 0))),
      expect: 'reject',
      code: 'MALFORMED',
    });
    negative.push({
      kind: 'ec_point',
      name: 'control: a valid point',
      publicKey: bytesHex(point),
      expect: 'accept',
    });
  }

  // ---- host authentication (the client's check of hello_ack)
  {
    const t = pair.transcript;
    const otherPoint = (await ecGenerate(seededRandom('vector other point'))).publicKey;
    const ackFor = async (
      change: Partial<r.Transcript>,
      signer: r.Signer = machine,
    ): Promise<string> => {
      const sig = await signer.sign(r.hostSigningInput(await r.transcriptH1({ ...t, ...change })));
      return r.encodeHelloAck(t.hostEphemeral, t.hostNonce, sig);
    };
    const entry = (
      name: string,
      ack: string,
      expectation: 'accept' | 'reject',
      clientHello = pair.hello,
    ): void => {
      negative.push({
        kind: 'hello_ack_verify',
        name,
        session: clientHello === pair.hello ? 'pair' : 'resume',
        machinePublicKey: bytesHex(machine.publicKey),
        clientHello,
        helloAck: ack,
        expect: expectation,
        ...(expectation === 'reject' ? { code: 'BAD_SIGNATURE' } : {}),
      });
    };
    entry('control: the genuine hello_ack', pair.helloAck, 'accept');
    const sig = r.decodeHelloAck(pair.helloAck).signature;
    entry(
      'one signature bit flipped',
      r.encodeHelloAck(t.hostEphemeral, t.hostNonce, flip(sig, 10)),
      'reject',
    );
    entry(
      'signed by another machine key (a malicious relay)',
      await ackFor({}, impostor),
      'reject',
    );
    entry('a genuine hello_ack of another session', resume.helloAck, 'reject');
    entry(
      'signature over another room id',
      await ackFor({ rid: seed('other rid').slice(0, 16) }),
      'reject',
    );
    entry('signature over another mode', await ackFor({ mode: 'resume' }), 'reject');
    entry(
      'signature over another client ephemeral key',
      await ackFor({ clientEphemeral: otherPoint }),
      'reject',
    );
    entry(
      'signature over another client nonce',
      await ackFor({ clientNonce: seed('other client nonce') }),
      'reject',
    );
    entry(
      'signature over another host ephemeral key',
      await ackFor({ hostEphemeral: otherPoint }),
      'reject',
    );
    entry(
      'signature over another host nonce',
      await ackFor({ hostNonce: seed('other host nonce') }),
      'reject',
    );
    // A relay that flips the client's mode in transit: the host signs the mode it saw.
    const flipped = await r.hostOnHello(
      { machine, random: seededRandom('vector flipped host') },
      resume.hello.replace('"resume"', '"pair"'),
      { offers: [offer], isEnrolled: () => true },
      NOW,
    );
    entry(
      'the relay flipped resume to pair in the hello',
      flipped.helloAck,
      'reject',
      resume.hello,
    );
  }

  // ---- key schedule and the host's check of auth
  {
    const authText = (s: Session, plaintext: Uint8Array, keys = s.keys): Promise<string> =>
      aeadKey(keys.c2h)
        .then((k) => aeadSeal(k, r.TYPE_AUTH, r.DIR_C2H, 0, plaintext))
        .then((ct) => r.encodeSealedControl('auth', ct));
    const open = (
      name: string,
      hostSession: Session,
      hostPsk: Uint8Array | null,
      auth: string,
      expectation: 'accept' | 'reject',
      extra: Obj = {},
    ): void => {
      negative.push({
        kind: 'auth_open',
        name,
        session: hostSession.mode,
        z: bytesHex(hostSession.z),
        h1: bytesHex(hostSession.h1),
        psk: hostPsk ? bytesHex(hostPsk) : null,
        auth,
        expect: expectation,
        ...(expectation === 'reject'
          ? { code: hostSession.mode === 'pair' ? 'PAIRING' : 'DECRYPT' }
          : {}),
        ...extra,
      });
    };
    open('control: the host derives the keys the client used', pair, pair.psk, pair.auth, 'accept');
    const wrongPsk = seed('wrong pairing secret');
    const wrongKeys = await r.deriveSessionKeys(pair.z, pair.h1, wrongPsk);
    open(
      'the client mixed in the wrong pairing secret',
      pair,
      pair.psk,
      await authText(pair, text('x'.repeat(96)), wrongKeys),
      'reject',
      { senderPsk: bytesHex(wrongPsk) },
    );
    const noPskKeys = await r.deriveSessionKeys(pair.z, pair.h1, null);
    open(
      'the client mixed in no pairing secret',
      pair,
      pair.psk,
      await authText(pair, text('x'.repeat(96)), noPskKeys),
      'reject',
      { senderPsk: null },
    );
    const pskKeys = await r.deriveSessionKeys(resume.z, resume.h1, pair.psk);
    open(
      'the client mixed in a pairing secret on a resume',
      resume,
      null,
      await authText(resume, text('x'.repeat(96)), pskKeys),
      'reject',
      { senderPsk: bytesHex(pair.psk as Uint8Array) },
    );
    open('an auth captured from another session', pair, pair.psk, resume.auth, 'reject');
    open(
      'an auth replayed with the pair session transcript on a fresh host',
      resume,
      null,
      pair.auth,
      'reject',
    );

    // What the host checks after it opens auth.
    const check = async (
      name: string,
      s: Session,
      plaintext: Uint8Array,
      expectation: 'accept' | 'reject',
      code?: string,
      // At pair time the device is not enrolled yet; on a resume it must be.
      enrolled: Uint8Array[] = s.mode === 'resume' ? [device.publicKey] : [],
    ): Promise<void> => {
      negative.push({
        kind: 'auth_check',
        name,
        session: s.mode,
        mode: s.mode,
        z: bytesHex(s.z),
        h1: bytesHex(s.h1),
        psk: s.psk ? bytesHex(s.psk) : null,
        hostSignature: bytesHex(s.hostSignature),
        auth: await authText(s, plaintext),
        enrolled: enrolled.map(bytesHex),
        expect: expectation,
        ...(code ? { code } : {}),
      });
    };
    const label = text('remi-relay-v2 H2');
    const signed = async (h2: Uint8Array, name: Uint8Array): Promise<Uint8Array> =>
      concat(device.publicKey, await device.sign(r.clientSigningInput(h2)), name);
    const real = async (s: Session, name: Uint8Array): Promise<Uint8Array> =>
      signed(await r.transcriptH2(s.h1, s.hostSignature, device.publicKey, name), name);
    await check(
      'control: a correct auth in pair mode',
      pair,
      await real(pair, nameBytes),
      'accept',
    );
    await check(
      'control: a correct auth in resume mode',
      resume,
      await real(resume, nameBytes),
      'accept',
    );
    await check(
      'resume with a device key that is not enrolled',
      resume,
      await real(resume, nameBytes),
      'reject',
      'UNKNOWN_DEVICE',
      [],
    );
    const good = await real(pair, nameBytes);
    await check(
      'device signature with one bit flipped',
      pair,
      concat(good.slice(0, 32), flip(good.slice(32, 96), 5), nameBytes),
      'reject',
      'BAD_SIGNATURE',
    );
    const stranger = await r.signerFromSeed(seed('stranger device'));
    const strangerSig = await stranger.sign(
      r.clientSigningInput(
        await r.transcriptH2(pair.h1, pair.hostSignature, device.publicKey, nameBytes),
      ),
    );
    await check(
      'signature by another key than the one presented',
      pair,
      concat(device.publicKey, strangerSig, nameBytes),
      'reject',
      'BAD_SIGNATURE',
    );
    const h1 = pair.h1;
    const sigH = pair.hostSignature;
    const dpk = device.publicKey;
    const variants: [string, Uint8Array][] = [
      ['label', refHash(h1, sigH, dpk, nameBytes)],
      ['transcript hash', refHash(label, sigH, dpk, nameBytes)],
      ['host signature', refHash(label, h1, dpk, nameBytes)],
      ['device key', refHash(label, h1, sigH, nameBytes)],
      ['device name', refHash(label, h1, sigH, dpk)],
    ];
    for (const [term, h2] of variants) {
      await check(
        `signature over H2 without the ${term}`,
        pair,
        await signed(h2, nameBytes),
        'reject',
        'BAD_SIGNATURE',
      );
    }
    const badNames: [string, Uint8Array][] = [
      ['a control character', text('bad\u0007name')],
      ['DEL', text('x\u007f')],
      ['invalid UTF-8', Uint8Array.of(0xc3, 0x28)],
    ];
    for (const [what, bad] of badNames) {
      await check(`device name with ${what}`, pair, await real(pair, bad), 'reject', 'NAME');
    }
    await check('control: a 64-byte name', pair, await real(pair, text('a'.repeat(64))), 'accept');
    await check(
      'control: an empty name (the 112-byte ciphertext)',
      pair,
      await real(pair, new Uint8Array(0)),
      'accept',
    );
    await check(
      'control: a name of one space (U+0020 is not a control character)',
      pair,
      await real(pair, text(' ')),
      'accept',
    );
    await check(
      'control: a name with a C1 control character (U+0085 is allowed)',
      pair,
      await real(pair, text('a\u0085b')),
      'accept',
    );
    await check(
      'control: a name with a byte order mark (U+FEFF is a character)',
      pair,
      await real(pair, text('\ufeffphone')),
      'accept',
    );
    await check(
      'device name with U+001F',
      pair,
      await real(pair, text('a\u001fb')),
      'reject',
      'NAME',
    );
    // Two defects at once pin the order of the checks: name, then signature, then enrollment.
    const badSigBadName = await real(pair, text('bad\u0007name'));
    await check(
      'a bad name and a bad signature report the name',
      pair,
      concat(
        badSigBadName.slice(0, 32),
        flip(badSigBadName.slice(32, 96), 3),
        badSigBadName.slice(96),
      ),
      'reject',
      'NAME',
    );
    const badSigResume = await real(resume, nameBytes);
    await check(
      'a bad signature and an unknown device report the signature',
      resume,
      concat(
        badSigResume.slice(0, 32),
        flip(badSigResume.slice(32, 96), 3),
        badSigResume.slice(96),
      ),
      'reject',
      'BAD_SIGNATURE',
      [],
    );
  }

  // ---- key confirmation (the client's check of ready)
  {
    const sealReady = async (
      s: Session,
      plaintext: Uint8Array,
      type = r.TYPE_READY,
      dir: r.Direction = r.DIR_H2C,
      counter = 0,
      keys = s.keys,
    ): Promise<string> =>
      r.encodeSealedControl(
        'ready',
        await aeadSeal(await aeadKey(keys.h2c), type, dir, counter, plaintext),
      );
    const entry = async (
      name: string,
      s: Session,
      ready: string,
      expectation: 'accept' | 'reject',
      code?: string,
    ): Promise<void> => {
      negative.push({
        kind: 'ready_open',
        name,
        session: s.mode,
        mode: s.mode,
        z: bytesHex(s.z),
        h1: bytesHex(s.h1),
        psk: s.psk ? bytesHex(s.psk) : null,
        ready,
        expect: expectation,
        ...(code ? { code } : {}),
      });
    };
    await entry('control: the genuine ready', pair, pair.ready, 'accept');
    await entry('control: the genuine ready of a resume', resume, resume.ready, 'accept');
    await entry(
      'echo of the other mode',
      pair,
      await sealReady(pair, Uint8Array.of(2)),
      'reject',
      'MODE_MISMATCH',
    );
    await entry(
      'echo of zero',
      pair,
      await sealReady(pair, Uint8Array.of(0)),
      'reject',
      'MODE_MISMATCH',
    );
    await entry(
      'pair echo on a resume session',
      resume,
      await sealReady(resume, Uint8Array.of(1)),
      'reject',
      'MODE_MISMATCH',
    );
    await entry(
      'ready sealed as an auth',
      pair,
      await sealReady(pair, Uint8Array.of(1), r.TYPE_AUTH),
      'reject',
      'DECRYPT',
    );
    await entry(
      'ready sealed for the other direction',
      pair,
      await sealReady(pair, Uint8Array.of(1), r.TYPE_READY, r.DIR_C2H),
      'reject',
      'DECRYPT',
    );
    await entry(
      'ready sealed with counter 1',
      pair,
      await sealReady(pair, Uint8Array.of(1), r.TYPE_READY, r.DIR_H2C, 1),
      'reject',
      'DECRYPT',
    );
    await entry('ready of another session', pair, resume.ready, 'reject', 'DECRYPT');
    await entry(
      'ready from random bytes',
      pair,
      r.encodeSealedControl('ready', seed('random ready').slice(0, 17)),
      'reject',
      'DECRYPT',
    );
  }

  // ---- the data channel
  {
    const frames = (s: Session): Uint8Array[] =>
      (s.json['data'] as { c2h: { frame: string }[] }).c2h.map((f) => Buffer.from(f.frame, 'hex'));
    const f = frames(pair);
    const key = pair.keys.c2h;
    const seq = (
      name: string,
      list: Uint8Array[],
      accepted: number,
      code: string | null,
      opts: { key?: Uint8Array; direction?: number; startRecv?: number } = {},
    ): void => {
      negative.push({
        kind: 'data_sequence',
        name,
        key: bytesHex(opts.key ?? key),
        direction: opts.direction ?? r.DIR_C2H,
        startRecv: opts.startRecv ?? 1,
        frames: list.map(bytesHex),
        expect: code ? 'reject' : 'accept',
        accepted,
        ...(code ? { code } : {}),
      });
    };
    seq('control: ten frames in order', f, 10, null);
    seq(
      'a frame replayed',
      [f[0] as Uint8Array, f[1] as Uint8Array, f[1] as Uint8Array],
      2,
      'COUNTER',
    );
    seq('the first frame replayed', [f[0] as Uint8Array, f[0] as Uint8Array], 1, 'COUNTER');
    seq('a gap (frame 2 dropped)', [f[0] as Uint8Array, f[2] as Uint8Array], 1, 'COUNTER');
    seq('reordered frames', [f[1] as Uint8Array, f[0] as Uint8Array], 0, 'COUNTER');
    seq(
      'the last byte cut off',
      [f[0] as Uint8Array, (f[1] as Uint8Array).slice(0, -1)],
      1,
      'DECRYPT',
    );
    seq(
      'a byte appended',
      [f[0] as Uint8Array, new Uint8Array([...(f[1] as Uint8Array), 0])],
      1,
      'DECRYPT',
    );
    seq('a ciphertext bit flipped', [flip(f[0] as Uint8Array, 12)], 0, 'DECRYPT');
    seq(
      'a tag bit flipped',
      [flip(f[0] as Uint8Array, (f[0] as Uint8Array).length - 1)],
      0,
      'DECRYPT',
    );
    seq('the type byte flipped', [flip(f[0] as Uint8Array, 0)], 0, 'TYPE');
    seq(
      'the type byte set to the handshake auth type',
      [Uint8Array.from(f[0] as Uint8Array, (x, i) => (i === 0 ? 1 : x))],
      0,
      'TYPE',
    );
    seq(
      'counter 0, the handshake counter',
      [Uint8Array.from(f[0] as Uint8Array, (x, i) => (i === 8 ? 0 : x))],
      0,
      'COUNTER',
    );
    seq('the frame shorter than the minimum', [(f[0] as Uint8Array).slice(0, 25)], 0, 'MALFORMED');
    seq('a reflected frame: opened under the other direction', f, 0, 'DECRYPT', {
      direction: r.DIR_H2C,
    });
    seq('the right frames under another key', f, 0, 'DECRYPT', { key: pair.keys.h2c });
    // Counter limit: a receiver already at the limit takes frame 2^40 and then refuses 2^40 + 1 even with a valid tag.
    const limitKey = await aeadKey(key);
    const atLimit = async (counter: number): Promise<Uint8Array> =>
      concat(
        Uint8Array.of(r.TYPE_DATA),
        be64(counter),
        await aeadSeal(limitKey, r.TYPE_DATA, r.DIR_C2H, counter, text('limit')),
      );
    seq(
      'the maximum counter is accepted, the next is not',
      [await atLimit(r.MAX_COUNTER), await atLimit(r.MAX_COUNTER + 1)],
      1,
      'COUNTER_LIMIT',
      { startRecv: r.MAX_COUNTER },
    );
    seq(
      'a counter above the limit as the first frame',
      [await atLimit(r.MAX_COUNTER + 1)],
      0,
      'COUNTER_LIMIT',
    );
    for (const [len, expectation, code] of [
      [25, 'reject', 'MALFORMED'],
      [26, 'accept', null],
      [r.MAX_FRAME, 'accept', null],
      [r.MAX_FRAME + 1, 'reject', 'OVERSIZE'],
    ] as const) {
      negative.push({
        kind: 'frame_length',
        name: `a data frame of ${len} bytes`,
        length: len,
        expect: expectation,
        ...(code ? { code } : {}),
      });
    }
  }

  // ---- pairing token
  const tokenBase = {
    relayUrl: 'wss://relay.example.test/v2',
    machinePublicKey: machine.publicKey,
    secret: offer.secret,
    expiresAtSec: NOW_SEC + 600,
  };
  const sealPair = await r.ecPairFromScalar(seed('token seal key'));
  const tokenJson = (t: r.PairingToken): Obj => ({
    text: r.encodePairingToken(t),
    relayUrl: t.relayUrl,
    machinePublicKey: bytesHex(t.machinePublicKey),
    secret: bytesHex(t.secret),
    expiresAtSec: t.expiresAtSec,
    sealPublicKey: t.sealPublicKey ? bytesHex(t.sealPublicKey) : null,
  });
  {
    const good = r.encodePairingToken(tokenBase);
    const raw = Buffer.from(good.slice('remi-pair2:'.length), 'base64url');
    const wrap = (b: Uint8Array): string => `remi-pair2:${b64u(b)}`;
    const mutateAt = (i: number, v: number): string =>
      wrap(Uint8Array.from(raw, (x, j) => (j === i ? v : x)));
    const tok = (
      name: string,
      t: string,
      expectation: 'accept' | 'reject',
      code?: string,
      nowSec = NOW_SEC,
    ): void => {
      negative.push({
        kind: 'token_decode',
        name,
        text: t,
        nowSec,
        expect: expectation,
        ...(code ? { code } : {}),
      });
    };
    tok('control: the genuine token', good, 'accept');
    tok('wrong prefix', good.replace('remi-pair2:', 'remi-pair1:'), 'reject', 'TOKEN');
    tok('padded payload', `${good}=`, 'reject', 'TOKEN');
    tok('token version 1', mutateAt(0, 1), 'reject', 'TOKEN');
    tok('token version 3', mutateAt(0, 3), 'reject', 'TOKEN');
    tok('reserved flag bit set', mutateAt(1, 2), 'reject', 'TOKEN');
    tok('seal flag set but no key present', mutateAt(1, 1), 'reject', 'TOKEN');
    tok('shorter than the fixed part', wrap(raw.subarray(0, 74)), 'reject', 'TOKEN');
    tok('five bytes only', wrap(raw.subarray(0, 5)), 'reject', 'TOKEN');
    tok('expired by one second', good, 'reject', 'EXPIRED', NOW_SEC + 601);
    tok('expiring exactly now', good, 'reject', 'EXPIRED', NOW_SEC + 600);
    tok('valid one second before expiry', good, 'accept', undefined, NOW_SEC + 599);
    tok(
      'expiry beyond the policy',
      r.encodePairingToken({ ...tokenBase, expiresAtSec: NOW_SEC + 661 }),
      'reject',
      'TOKEN',
    );
    tok(
      'expiry at the policy limit',
      r.encodePairingToken({ ...tokenBase, expiresAtSec: NOW_SEC + 660 }),
      'accept',
    );
    tok(
      'expiry that is not a safe integer',
      wrap(Uint8Array.from(raw, (x, j) => (j >= 2 && j < 10 ? 0xff : x))),
      'reject',
      'TOKEN',
    );
    for (const [name, url] of [
      ['plain ws to a non-loopback host', 'ws://example.com'],
      ['http scheme', 'http://example.com'],
      ['uppercase host', 'wss://UPPER.example'],
      ['userinfo', 'wss://user@example.com'],
      ['query string', 'wss://example.com?q=1'],
      ['fragment', 'wss://example.com/#f'],
      ['space in the path', 'wss://example.com/a b'],
      ['empty host', 'wss://'],
    ] as const) {
      tok(`relay url: ${name}`, wrap(concat(raw.subarray(0, 74), text(url))), 'reject', 'TOKEN');
    }
    tok(
      'relay url of 513 bytes',
      wrap(concat(raw.subarray(0, 74), text(`wss://${'a'.repeat(507)}`))),
      'reject',
      'TOKEN',
    );
    tok(
      'relay url that is not UTF-8',
      wrap(
        concat(raw.subarray(0, 74), Uint8Array.of(0x77, 0x73, 0x73, 0x3a, 0x2f, 0x2f, 0xc3, 0x28)),
      ),
      'reject',
      'TOKEN',
    );
    const withSeal = wrap(
      concat(
        Uint8Array.of(2, 1),
        raw.subarray(2, 74),
        sealPair.publicKey,
        text(tokenBase.relayUrl),
      ),
    );
    tok('control: a token with a seal key', withSeal, 'accept');
    for (const url of [
      'ws://localhost:8787',
      'ws://127.0.0.1:8787/v2',
      'wss://relay.example.test:8443/a/b_c-d.e~f',
    ]) {
      tok(`control: relay url ${url}`, wrap(concat(raw.subarray(0, 74), text(url))), 'accept');
    }
    tok('reserved flag bit 7 set', mutateAt(1, 0x80), 'reject', 'TOKEN');
    tok('reserved flag bit 2 set', mutateAt(1, 4), 'reject', 'TOKEN');
    tok(
      'relay url with a trailing newline',
      wrap(concat(raw.subarray(0, 74), text('wss://relay.example.test/v2\n'))),
      'reject',
      'TOKEN',
    );
    tok(
      'an expired token with an invalid url reports the url (url first)',
      wrap(concat(raw.subarray(0, 74), text('http://example.com'))),
      'reject',
      'TOKEN',
      NOW_SEC + 700,
    );
    tok(
      'seal key not on the curve',
      wrap(
        concat(
          Uint8Array.of(2, 1),
          raw.subarray(2, 74),
          flip(sealPair.publicKey, 64),
          text(tokenBase.relayUrl),
        ),
      ),
      'reject',
      'TOKEN',
    );
  }

  // ---- sealing
  const sealRecipient = await r.ecPairFromScalar(seed('seal recipient'));
  const questionId = 'question-vector-1';
  const sealAad = r.pushAad(rid, questionId);
  const sealRng = seededRandom('vector seal');
  const sealPlain = text(
    JSON.stringify({ kind: 'question', title: 'Claude needs you', options: ['Yes', 'No'] }),
  );
  const sealed = await r.seal(sealRecipient.publicKey, sealAad, sealPlain, sealRng);
  {
    const entry = (
      name: string,
      aad: Uint8Array,
      value: Uint8Array,
      scalar: Uint8Array,
      expectation: 'accept' | 'reject',
    ): void => {
      negative.push({
        kind: 'seal_open',
        name,
        recipientScalar: bytesHex(scalar),
        aad: bytesHex(aad),
        sealed: bytesHex(value),
        expect: expectation,
        ...(expectation === 'reject' ? { code: 'DECRYPT' } : {}),
      });
    };
    const scalar = seed('seal recipient');
    entry('control: the genuine sealed push', sealAad, sealed, scalar, 'accept');
    entry('another question id', r.pushAad(rid, 'question-vector-2'), sealed, scalar, 'reject');
    entry(
      'another room id',
      r.pushAad(seed('other rid').slice(0, 16), questionId),
      sealed,
      scalar,
      'reject',
    );
    entry('another recipient', sealAad, sealed, seed('seal stranger'), 'reject');
    entry('one ciphertext bit flipped', sealAad, flip(sealed, 90), scalar, 'reject');
    entry('the ephemeral key corrupted', sealAad, flip(sealed, 64), scalar, 'reject');
    entry('the nonce corrupted', sealAad, flip(sealed, 70), scalar, 'reject');
    entry('truncated by one byte', sealAad, sealed.slice(0, -1), scalar, 'reject');
    entry(
      'sealed with an empty body by another implementation',
      sealAad,
      nodeSeal(sealRecipient.publicKey, sealAad, new Uint8Array(0), 'vector seal empty'),
      scalar,
      'reject',
    );
    entry(
      'sealed with a 2049-byte body by another implementation',
      sealAad,
      nodeSeal(
        sealRecipient.publicKey,
        sealAad,
        new Uint8Array(r.MAX_PUSH_PLAINTEXT + 1).fill(7),
        'vector seal big',
      ),
      scalar,
      'reject',
    );
    entry(
      'control: sealed by another implementation',
      sealAad,
      nodeSeal(sealRecipient.publicKey, sealAad, text('sealed by node'), 'vector seal node'),
      scalar,
      'accept',
    );
  }

  // ---- Worker admission formats
  const admissionNonce = seed('admission nonce');
  const hostAdmission = await r.signAdmission(machine, 'host', rid, admissionNonce);
  const clientAdmission = await r.signAdmission(device, 'client', rid, admissionNonce);
  const ticket = await r.admitTag(offer.secret);
  {
    const entry = async (
      name: string,
      role: r.AdmissionRole,
      pk: Uint8Array,
      ridv: Uint8Array,
      nonce: Uint8Array,
      sig: Uint8Array,
      expectation: 'accept' | 'reject',
    ): Promise<void> => {
      negative.push({
        kind: 'admission_verify',
        name,
        role,
        publicKey: bytesHex(pk),
        rid: bytesHex(ridv),
        nonce: bytesHex(nonce),
        signature: bytesHex(sig),
        expect: expectation,
      });
    };
    await entry(
      'control: the host proof',
      'host',
      machine.publicKey,
      rid,
      admissionNonce,
      hostAdmission,
      'accept',
    );
    await entry(
      'control: the client proof',
      'client',
      device.publicKey,
      rid,
      admissionNonce,
      clientAdmission,
      'accept',
    );
    await entry(
      'host proof for another nonce',
      'host',
      machine.publicKey,
      rid,
      seed('other admission nonce'),
      hostAdmission,
      'reject',
    );
    await entry(
      'host proof for another room (fails the room-id hash check and the signature)',
      'host',
      machine.publicKey,
      seed('other rid').slice(0, 16),
      admissionNonce,
      hostAdmission,
      'reject',
    );
    await entry(
      'client proof presented as a host proof',
      'host',
      machine.publicKey,
      rid,
      admissionNonce,
      await r.signAdmission(machine, 'client', rid, admissionNonce),
      'reject',
    );
    await entry(
      'host proof presented as a client proof',
      'client',
      machine.publicKey,
      rid,
      admissionNonce,
      hostAdmission,
      'reject',
    );
    await entry(
      'host key that does not hash to the room id',
      'host',
      impostor.publicKey,
      rid,
      admissionNonce,
      await r.signAdmission(impostor, 'host', rid, admissionNonce),
      'reject',
    );
    await entry(
      'client proof for another room',
      'client',
      device.publicKey,
      seed('other rid').slice(0, 16),
      admissionNonce,
      clientAdmission,
      'reject',
    );
    await entry(
      'client proof with a 15-byte room id',
      'client',
      device.publicKey,
      rid.slice(0, 15),
      admissionNonce,
      await r.signAdmission(device, 'client', rid.slice(0, 15), admissionNonce),
      'reject',
    );
    await entry(
      'client proof with a 31-byte nonce',
      'client',
      device.publicKey,
      rid,
      admissionNonce.slice(0, 31),
      await r.signAdmission(device, 'client', rid, admissionNonce.slice(0, 31)),
      'reject',
    );
  }

  const constants: Obj = {
    v: r.V,
    maxCounter: r.MAX_COUNTER,
    maxPlaintext: r.MAX_PLAINTEXT,
    maxFrame: r.MAX_FRAME,
    minFrame: r.MIN_FRAME,
    maxControlText: r.MAX_CONTROL_TEXT,
    maxDeviceName: r.MAX_DEVICE_NAME,
    handshakeTimeoutMs: r.HANDSHAKE_TIMEOUT_MS,
    pairConfirmTimeoutMs: r.PAIR_CONFIRM_TIMEOUT_MS,
    pairingTtlSeconds: r.PAIRING_TTL_SECONDS,
    pairingSkewSeconds: r.PAIRING_SKEW_SECONDS,
    maxPushPlaintext: r.MAX_PUSH_PLAINTEXT,
    closeCode: r.CLOSE_CODE,
    closeReason: r.CLOSE_REASON,
  };

  return {
    format: 1,
    protocol: 'remi-relay-v2',
    note: 'Every value derives from public labels (SHA-256 of "remi-relay-v2 test vector <label>") and the library fed those seeds. No key here is real. Regenerate with packages/shared/tests/relay/generate-vectors.ts.',
    constants,
    identities: {
      machine: { seed: bytesHex(seed('machine')), publicKey: bytesHex(machine.publicKey) },
      device: { seed: bytesHex(seed('device')), publicKey: bytesHex(device.publicKey) },
      impostorMachine: {
        seed: bytesHex(seed('impostor machine')),
        publicKey: bytesHex(impostor.publicKey),
      },
    },
    rid: bytesHex(rid),
    ridDerivation: bytesHex(
      new Uint8Array(createHash('sha256').update(machine.publicKey).digest()).slice(0, 16),
    ),
    sessions: { pair: pair.json, resume: resume.json },
    admission: {
      nonce: bytesHex(admissionNonce),
      hostInput: bytesHex(r.admissionInput('host', rid, admissionNonce)),
      hostSignature: bytesHex(hostAdmission),
      clientInput: bytesHex(r.admissionInput('client', rid, admissionNonce)),
      clientSignature: bytesHex(clientAdmission),
      pairingSecret: bytesHex(offer.secret),
      ticket: bytesHex(ticket),
      ticketHash: bytesHex(await r.admitTagHash(ticket)),
    },
    pairingToken: {
      noSealKey: tokenJson(tokenBase),
      withSealKey: tokenJson({ ...tokenBase, sealPublicKey: sealPair.publicKey }),
      nowSec: NOW_SEC,
    },
    seal: {
      recipientScalar: bytesHex(seed('seal recipient')),
      recipientPublicKey: bytesHex(sealRecipient.publicKey),
      rid: bytesHex(rid),
      questionId,
      aad: bytesHex(sealAad),
      plaintext: bytesHex(sealPlain),
      ephemeralScalar: bytesHex(sealRng.draws[0] as Uint8Array),
      nonce: bytesHex(sealRng.draws[1] as Uint8Array),
      sealed: bytesHex(sealed),
    },
    negative,
  };
}

export const render = (v: Obj): string => `${JSON.stringify(v, null, 2)}\n`;

if (import.meta.main) {
  writeFileSync(VECTORS_PATH, render(await generateVectors()));
  console.log(`wrote ${VECTORS_PATH}`);
}
