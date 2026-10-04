/**
 * Checks the TypeScript implementation against the committed vectors
 * (`fixtures/relay-v2/vectors.json`), and pins the file itself: regenerating it
 * must produce no change. The Python and Swift verifiers read the same file.
 *
 * The handshake is replayed through the real step functions with the draws taken
 * from the file, so these tests do not depend on the generator's own seeds.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as r from '../../src/relay/internal.ts';
import {
  aeadKey,
  aeadSeal,
  frameAad,
  frameNonce,
  importEcPublic,
} from '../../src/relay/primitives.ts';
import { NOW } from './flow.ts';
import { VECTORS_PATH, generateVectors, render } from './generate-vectors.ts';
import { data, detFrom, hex, unhex } from './helpers.ts';
import { recorder } from './recorder.ts';

// biome-ignore lint/suspicious/noExplicitAny: the file is plain JSON read by shape
type J = any;
const file = readFileSync(VECTORS_PATH, 'utf8');
const V: J = JSON.parse(file);

/** An Rng that hands back the draws recorded in the file, in order. */
function fileRandom(...draws: string[]): r.Rng {
  let i = 0;
  return (n) => {
    const d = unhex(draws[i++] as string);
    if (d.length !== n) throw new Error(`vector draw ${i} has ${d.length} bytes, asked for ${n}`);
    return d;
  };
}

const machine = await r.signerFromSeed(unhex(V.identities.machine.seed));
const device = await r.signerFromSeed(unhex(V.identities.device.seed));
const pairingSecret = unhex(V.admission.pairingSecret);

/**
 * RFC 8032 signing is deterministic on Bun, workerd and OpenSSL, but WebKit and CryptoKit sign
 * with a random component. A recomputed signature is therefore checked by VERIFICATION, and
 * byte for byte only on an engine observed to sign deterministically; the byte-exact replay
 * and the regeneration pin need that determinism and are skipped (visibly) without it.
 */
const probe = new TextEncoder().encode('relay v2 signing determinism probe');
const firstProbe = hex(await machine.sign(probe));
const deterministicSigning = firstProbe === hex(await machine.sign(probe));

async function sameSignature(
  signer: r.Signer,
  input: Uint8Array,
  recorded: string,
  publicKey: Uint8Array,
): Promise<void> {
  const fresh = await signer.sign(input);
  expect(await r.verifySignature(publicKey, input, fresh)).toBe(true);
  expect(await r.verifySignature(publicKey, input, unhex(recorded))).toBe(true);
  if (deterministicSigning) expect(hex(fresh)).toBe(recorded);
}
const liveOffer: r.PairingOffer = {
  secret: pairingSecret,
  expiresAtMs: NOW + 600_000,
  used: false,
};

async function hostFor(name: 'pair' | 'resume', policy: r.HostPolicy) {
  const s = V.sessions[name];
  return r.hostOnHello(
    { machine, ...detFrom(fileRandom(s.hostEphemeral.scalar, s.hostNonce)) },
    s.hello,
    policy,
    NOW,
  );
}

async function clientFor(name: 'pair' | 'resume', machinePublicKey = machine.publicKey) {
  const s = V.sessions[name];
  return r.clientStart(
    {
      machinePublicKey,
      device,
      deviceName: s.deviceName,
      mode: name,
      ...(name === 'pair' ? { pairingSecret } : {}),
      ...detFrom(fileRandom(s.clientEphemeral.scalar, s.clientNonce)),
    },
    NOW,
  );
}

describe('relay v2 vectors: the committed file', () => {
  test.skipIf(!deterministicSigning)('regenerating the vectors produces no change', async () => {
    expect(render(await generateVectors())).toBe(file);
  });

  test('the identity seeds are the documented hashes of public labels', () => {
    const labelled = (label: string): string =>
      createHash('sha256').update(`remi-relay-v2 test vector ${label}`).digest('hex');
    expect(V.identities.machine.seed).toBe(labelled('machine'));
    expect(V.identities.device.seed).toBe(labelled('device'));
    expect(V.identities.impostorMachine.seed).toBe(labelled('impostor machine'));
    expect(V.note).toContain('No key here is real');
    expect(V.protocol).toBe('remi-relay-v2');
    expect(V.format).toBe(1);
  });

  test('the constants in the file are the constants in the library', () => {
    const c = V.constants;
    expect([c.v, c.maxCounter, c.maxPlaintext, c.maxFrame, c.minFrame, c.maxControlText]).toEqual([
      r.V,
      r.MAX_COUNTER,
      r.MAX_PLAINTEXT,
      r.MAX_FRAME,
      r.MIN_FRAME,
      r.MAX_CONTROL_TEXT,
    ]);
    expect([
      c.maxDeviceName,
      c.handshakeTimeoutMs,
      c.pairConfirmTimeoutMs,
      c.pairingTtlSeconds,
      c.pairingSkewSeconds,
    ]).toEqual([
      r.MAX_DEVICE_NAME,
      r.HANDSHAKE_TIMEOUT_MS,
      r.PAIR_CONFIRM_TIMEOUT_MS,
      r.PAIRING_TTL_SECONDS,
      r.PAIRING_SKEW_SECONDS,
    ]);
    expect([c.maxPushPlaintext, c.closeCode, c.closeReason]).toEqual([
      r.MAX_PUSH_PLAINTEXT,
      r.CLOSE_CODE,
      r.CLOSE_REASON,
    ]);
    expect([
      c.byeFrame,
      c.typeAuth,
      c.typeReady,
      c.typeData,
      c.typeBye,
      c.dirC2h,
      c.dirH2c,
    ]).toEqual([
      r.BYE_FRAME,
      r.TYPE_AUTH,
      r.TYPE_READY,
      r.TYPE_DATA,
      r.TYPE_BYE,
      r.DIR_C2H,
      r.DIR_H2C,
    ]);
  });
});

describe('relay v2 vectors: identities and ids', () => {
  test('the seeds give the public keys, and the room id is the first 16 bytes of SHA-256 of the machine key', async () => {
    expect(hex(machine.publicKey)).toBe(V.identities.machine.publicKey);
    expect(hex(device.publicKey)).toBe(V.identities.device.publicKey);
    expect(hex(await r.ridOf(machine.publicKey))).toBe(V.rid);
    expect(V.ridDerivation).toBe(V.rid);
  });
});

for (const name of ['pair', 'resume'] as const) {
  describe(`relay v2 vectors: the ${name} session`, () => {
    const s: J = V.sessions[name];
    const psk = s.psk === null ? null : unhex(s.psk);

    test('the transcript, signatures and keys match', async () => {
      const t: r.Transcript = {
        rid: unhex(V.rid),
        mode: name,
        clientEphemeral: unhex(s.clientEphemeral.publicKey),
        clientNonce: unhex(s.clientNonce),
        hostEphemeral: unhex(s.hostEphemeral.publicKey),
        hostNonce: unhex(s.hostNonce),
      };
      const h1 = await r.transcriptH1(t);
      expect(hex(h1)).toBe(s.h1);
      expect(hex(r.hostSigningInput(h1))).toBe(s.hostSigningInput);
      await sameSignature(machine, r.hostSigningInput(h1), s.hostSignature, machine.publicKey);
      const keys = await r.deriveSessionKeys(unhex(s.z), h1, psk);
      expect([hex(keys.c2h), hex(keys.h2c)]).toEqual([s.keys.c2h, s.keys.h2c]);
      const name2 = new TextEncoder().encode(s.deviceName);
      const h2 = await r.transcriptH2(h1, unhex(s.hostSignature), device.publicKey, name2);
      expect(hex(h2)).toBe(s.h2);
      expect(hex(r.clientSigningInput(h2))).toBe(s.clientSigningInput);
      await sameSignature(device, r.clientSigningInput(h2), s.clientSignature, device.publicKey);
      expect(await r.fingerprintOf(device.publicKey, machine.publicKey)).toBe(s.fingerprint);
    });

    test('the ephemeral keys follow from the scalars', async () => {
      for (const side of ['clientEphemeral', 'hostEphemeral']) {
        const pair = await r.ecPairFromScalar(unhex(s[side].scalar));
        expect(hex(pair.publicKey)).toBe(s[side].publicKey);
      }
    });

    test.skipIf(!deterministicSigning)(
      'the step functions replayed with the file draws produce the file frames byte for byte',
      async () => {
        const offers = name === 'pair' ? [liveOffer] : [];
        const policy: r.HostPolicy = {
          offers,
          isEnrolled: (k) => hex(k) === hex(device.publicKey),
        };
        const c1 = await clientFor(name);
        const h1 = await hostFor(name, policy);
        const c2 = await c1.onHelloAck(h1.helloAck, NOW + 10);
        const h2 = await h1.onAuth(c2.auth, policy, NOW + 20);
        const { ready, channel: host } = await h2.ready(NOW + 30, recorder().io);
        const clientIo = recorder();
        const client = await c2.onReady(ready, NOW + 40, clientIo.io);
        expect([c1.hello, h1.helloAck, c2.auth, ready]).toEqual([
          s.hello,
          s.helloAck,
          s.auth,
          s.ready,
        ]);
        expect([c2.fingerprint, h2.fingerprint]).toEqual([s.fingerprint, s.fingerprint]);
        for (const f of s.data.c2h) {
          await client.send(unhex(f.plaintext));
          expect(hex(clientIo.frames[f.counter - 1] as Uint8Array)).toBe(f.frame);
          expect(hex(data(await host.receive(unhex(f.frame))))).toBe(f.plaintext);
        }
        await client.bye();
        expect(hex(clientIo.frames[10] as Uint8Array)).toBe(s.bye.c2h.frame);
        expect(await host.receive(unhex(s.bye.c2h.frame))).toBeNull();
        expect(await host.transportClosed()).toBe('clean');
      },
    );

    test('the handshake frames are sealed exactly as documented', async () => {
      const keys = { c2h: unhex(s.keys.c2h), h2c: unhex(s.keys.h2c) };
      expect(s.authNonce).toBe(hex(frameNonce(0)));
      expect(s.authAad).toBe(hex(frameAad(r.TYPE_AUTH, r.DIR_C2H, 0)));
      expect(s.readyAad).toBe(hex(frameAad(r.TYPE_READY, r.DIR_H2C, 0)));
      const authCt = await aeadSeal(
        await aeadKey(keys.c2h),
        r.TYPE_AUTH,
        r.DIR_C2H,
        0,
        unhex(s.authPlaintext),
      );
      expect(hex(authCt)).toBe(s.authCiphertext);
      expect(s.auth).toBe(r.encodeSealedControl('auth', authCt));
      const readyCt = await aeadSeal(
        await aeadKey(keys.h2c),
        r.TYPE_READY,
        r.DIR_H2C,
        0,
        unhex(s.readyPlaintext),
      );
      expect(hex(readyCt)).toBe(s.readyCiphertext);
      expect(s.ready).toBe(r.encodeSealedControl('ready', readyCt));
    });

    test('the data frames in both directions have the documented nonce, AAD and bytes, and open in order', async () => {
      for (const [dir, key, frames] of [
        [r.DIR_C2H, s.keys.c2h, s.data.c2h],
        [r.DIR_H2C, s.keys.h2c, s.data.h2c],
      ] as const) {
        expect(frames.length).toBe(10);
        const receiver = await r.Channel.create({
          sendKey: new Uint8Array(32),
          recvKey: unhex(key),
          direction: dir === r.DIR_C2H ? r.DIR_H2C : r.DIR_C2H,
          io: recorder().io,
        });
        for (const f of frames) {
          expect(f.nonce).toBe(hex(frameNonce(f.counter)));
          expect(f.aad).toBe(hex(frameAad(r.TYPE_DATA, dir, f.counter)));
          expect(hex(data(await receiver.receive(unhex(f.frame))))).toBe(f.plaintext);
        }
        const bye = dir === r.DIR_C2H ? s.bye.c2h : s.bye.h2c;
        expect(bye.counter).toBe(11);
        expect(bye.nonce).toBe(hex(frameNonce(11)));
        expect(bye.aad).toBe(hex(frameAad(r.TYPE_BYE, dir, 11)));
        expect(unhex(bye.frame).length).toBe(r.BYE_FRAME);
        expect(await receiver.receive(unhex(bye.frame))).toBeNull();
        expect(receiver.peerEnded).toBe(true);
      }
    });
  });
}

describe('relay v2 vectors: admission, token and sealing', () => {
  test('admission inputs, signatures and the pairing ticket', async () => {
    const a = V.admission;
    const rid = unhex(V.rid);
    const nonce = unhex(a.nonce);
    expect(hex(r.admissionInput('host', rid, nonce))).toBe(a.hostInput);
    expect(hex(r.admissionInput('client', rid, nonce))).toBe(a.clientInput);
    await sameSignature(
      machine,
      r.admissionInput('host', rid, nonce),
      a.hostSignature,
      machine.publicKey,
    );
    await sameSignature(
      device,
      r.admissionInput('client', rid, nonce),
      a.clientSignature,
      device.publicKey,
    );
    const ticket = await r.admitTag(unhex(a.pairingSecret));
    expect(hex(ticket)).toBe(a.ticket);
    expect(hex(await r.admitTagHash(ticket))).toBe(a.ticketHash);
  });

  test('the pairing tokens encode to the file text and decode to the file fields', async () => {
    for (const key of ['noSealKey', 'withSealKey'] as const) {
      const t: J = V.pairingToken[key];
      const token: r.PairingToken = {
        relayUrl: t.relayUrl,
        machinePublicKey: unhex(t.machinePublicKey),
        secret: unhex(t.secret),
        expiresAtSec: t.expiresAtSec,
        ...(t.sealPublicKey ? { sealPublicKey: unhex(t.sealPublicKey) } : {}),
      };
      expect(r.encodePairingToken(token)).toBe(t.text);
      const decoded = await r.decodePairingToken(t.text, V.pairingToken.nowSec);
      expect(decoded.relayUrl).toBe(t.relayUrl);
      expect(hex(decoded.secret)).toBe(t.secret);
      expect(decoded.sealPublicKey ? hex(decoded.sealPublicKey) : null).toBe(t.sealPublicKey);
    }
  });

  test('the sealed push is reproduced from the file draws and opens', async () => {
    const s = V.seal;
    const recipient = await r.ecPairFromScalar(unhex(s.recipientScalar));
    expect(hex(recipient.publicKey)).toBe(s.recipientPublicKey);
    expect(hex(r.pushAad(unhex(s.rid), s.questionId))).toBe(s.aad);
    const draws = fileRandom(s.ephemeralScalar, s.nonce);
    const sealed = await r.seal(recipient.publicKey, unhex(s.aad), unhex(s.plaintext), draws, () =>
      r.ecGenerate(draws),
    );
    expect(hex(sealed)).toBe(s.sealed);
    expect(hex(await r.openSeal(recipient, unhex(s.aad), unhex(s.sealed)))).toBe(s.plaintext);
  });
});

interface Outcome {
  ok: boolean;
  code?: string;
  accepted?: number;
}

async function run(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    const value = await fn();
    return value === false ? { ok: false } : { ok: true };
  } catch (e) {
    if (e instanceof r.RelayError) return { ok: false, code: e.code };
    throw e;
  }
}

async function runNegative(n: J): Promise<Outcome> {
  switch (n.kind) {
    case 'control_decode':
      return run(async () => {
        if (n.frame === 'hello') return r.decodeHello(n.text);
        if (n.frame === 'hello_ack') return r.decodeHelloAck(n.text);
        return r.decodeSealedControl(n.text, n.frame);
      });
    case 'ec_point':
      return run(() => importEcPublic(unhex(n.publicKey)));
    case 'hello_ack_verify':
      return run(async () => {
        const c1 = await clientFor(n.session, unhex(n.machinePublicKey));
        if (c1.hello !== n.clientHello)
          throw new Error('vector client hello does not match the replayed client');
        return c1.onHelloAck(n.helloAck, NOW + 10);
      });
    case 'auth_open':
    case 'auth_check': {
      const offers = n.session === 'pair' ? [{ ...liveOffer, secret: unhex(n.psk) }] : [];
      const enrolled: string[] =
        n.kind === 'auth_check' ? n.enrolled : [V.identities.device.publicKey];
      const policy: r.HostPolicy = { offers, isEnrolled: (k) => enrolled.includes(hex(k)) };
      return run(async () => (await hostFor(n.session, policy)).onAuth(n.auth, policy, NOW + 20));
    }
    case 'ready_open':
      return run(async () => {
        const c1 = await clientFor(n.session);
        const c2 = await c1.onHelloAck(V.sessions[n.session].helloAck, NOW + 10);
        return c2.onReady(n.ready, NOW + 40, recorder().io);
      });
    case 'data_sequence': {
      const receiver = await r.Channel.create({
        sendKey: new Uint8Array(32),
        recvKey: unhex(n.key),
        direction: n.direction === r.DIR_C2H ? r.DIR_H2C : r.DIR_C2H,
        io: recorder().io,
        nextRecv: n.startRecv,
      });
      let accepted = 0;
      let first: Outcome | null = null;
      for (const f of n.frames) {
        const o = await run(() => receiver.receive(unhex(f)));
        if (first !== null) {
          // The first failure closes the channel for good: every later frame is refused.
          if (o.ok || o.code !== 'CLOSED')
            return { ok: false, code: 'NOT CLOSED FOR GOOD', accepted };
          continue;
        }
        if (!o.ok) {
          first = { ...o, accepted };
          continue;
        }
        accepted++;
      }
      if (first !== null) return first;
      return { ok: true, accepted };
    }
    case 'frame_length':
      return run(async () => {
        const frame = new Uint8Array(n.length);
        frame[0] = n.type;
        frame[8] = 1;
        return r.decodeDataFrame(frame);
      });
    case 'token_decode':
      return run(() => r.decodePairingToken(n.text, n.nowSec));
    case 'seal_open':
      return run(async () =>
        r.openSeal(
          await r.ecPairFromScalar(unhex(n.recipientScalar)),
          unhex(n.aad),
          unhex(n.sealed),
        ),
      );
    case 'admission_verify':
      return run(() =>
        r.verifyAdmission(
          n.role,
          unhex(n.publicKey),
          unhex(n.rid),
          unhex(n.nonce),
          unhex(n.signature),
        ),
      );
    default:
      throw new Error(`unknown vector kind ${n.kind}`);
  }
}

describe('relay v2 vectors: every positive control and every negative case behaves as recorded', () => {
  test('the file has the expected breadth', () => {
    const kinds = new Set(V.negative.map((n: J) => n.kind));
    expect([...kinds].sort()).toEqual([
      'admission_verify',
      'auth_check',
      'auth_open',
      'control_decode',
      'data_sequence',
      'ec_point',
      'frame_length',
      'hello_ack_verify',
      'ready_open',
      'seal_open',
      'token_decode',
    ]);
    expect(V.negative.length).toBeGreaterThanOrEqual(140);
    expect(V.negative.filter((n: J) => n.expect === 'reject').length).toBeGreaterThanOrEqual(110);
  });

  for (const n of V.negative as J[]) {
    test(`${n.kind}: ${n.name}`, async () => {
      const o = await runNegative(n);
      if (n.expect === 'accept') {
        expect(o.ok).toBe(true);
        if (n.accepted !== undefined) expect(o.accepted).toBe(n.accepted);
        return;
      }
      expect(o.ok).toBe(false);
      if (n.kind !== 'admission_verify') expect(o.code).toBe(n.code);
      if (n.accepted !== undefined) expect(o.accepted).toBe(n.accepted);
    });
  }
});
