import { describe, expect, test } from 'bun:test';
import { b64u, concat } from '../../src/relay/bytes.ts';
import * as r from '../../src/relay/internal.ts';
import { aeadKey, aeadSeal, ecGenerate } from '../../src/relay/primitives.ts';
import { manualClient, manualHost, refHash } from './builders.ts';
import { NOW, countingSigner, makeParts, runFlow } from './flow.ts';
import { codeOf, hex, seed, seededRandom, text } from './helpers.ts';
import { recorder } from './recorder.ts';

/** Drive both sides by hand up to `hello_ack`, returning the pieces tests want to tamper with. */
async function toAck(
  mode: r.Mode = 'pair',
  label = 'hs',
  overrides: { device?: r.Signer; machine?: r.Signer; deviceName?: string } = {},
) {
  const p = await makeParts(label, mode);
  const device = overrides.device ?? p.device;
  const c1 = await r.clientStart(
    {
      machinePublicKey: p.machine.publicKey,
      device,
      deviceName: overrides.deviceName ?? 'Test phone',
      mode,
      ...(mode === 'pair' ? { pairingSecret: p.offer.secret } : {}),
      random: seededRandom(`${label} client`),
    },
    NOW,
  );
  const h1 = await r.hostOnHello(
    { machine: overrides.machine ?? p.machine, random: seededRandom(`${label} host`) },
    c1.hello,
    p.policy,
    NOW,
  );
  return { p, c1, h1 };
}

describe('handshake, happy paths', () => {
  test('a pairing handshake opens a working channel in both directions', async () => {
    const f = await runFlow({ mode: 'pair' });
    for (let i = 1; i <= 10; i++) {
      await f.client.send(text(`from client ${i}`));
      await f.host.send(text(`from host ${i}`));
      expect(hex(await f.host.receive(f.clientIo.frames[i - 1] as Uint8Array))).toBe(
        hex(text(`from client ${i}`)),
      );
      expect(hex(await f.client.receive(f.hostIo.frames[i - 1] as Uint8Array))).toBe(
        hex(text(`from host ${i}`)),
      );
    }
  });

  test('a resume handshake opens a working channel with an enrolled device', async () => {
    const f = await runFlow({ mode: 'resume' });
    await f.client.send(text('resumed'));
    expect(hex(await f.host.receive(f.clientIo.frames[0] as Uint8Array))).toBe(
      hex(text('resumed')),
    );
  });

  test('both ends show the same fingerprint, and the host learns the name and the matching offer', async () => {
    const { p, c1, h1 } = await toAck('pair', 'fp');
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    const h2 = await h1.onAuth(c2.auth, p.policy, NOW + 2);
    expect(c2.fingerprint).toBe(h2.fingerprint);
    expect(c2.fingerprint).toBe(await r.fingerprintOf(p.device.publicKey, p.machine.publicKey));
    expect(h2.deviceName).toBe('Test phone');
    expect(hex(h2.devicePublicKey)).toBe(hex(p.device.publicKey));
    expect(h2.offerIndex).toBe(0);
    expect(
      await toAck('resume', 'fp2').then(
        async ({ p: q, c1: a, h1: b }) =>
          (await b.onAuth((await a.onHelloAck(b.helloAck, NOW + 1)).auth, q.policy, NOW + 2))
            .offerIndex,
      ),
    ).toBeNull();
  });

  test('the same inputs always give byte-identical frames: no clock or random source is read', async () => {
    const a = await runFlow({ label: 'determinism' });
    const b = await runFlow({ label: 'determinism' });
    expect([b.hello, b.helloAck, b.auth, b.ready]).toEqual([a.hello, a.helloAck, a.auth, a.ready]);
    await a.client.send(text('same'));
    await b.client.send(text('same'));
    expect(hex(b.clientIo.frames[0] as Uint8Array)).toBe(hex(a.clientIo.frames[0] as Uint8Array));
    const c = await runFlow({ label: 'determinism, other seed' });
    expect(c.hello).not.toBe(a.hello);
  });

  test('two handshakes with the same long-term keys and secret derive unrelated keys', async () => {
    const a = await runFlow({ label: 'session a' });
    const b = await runFlow({ label: 'session b' });
    await a.client.send(text('session a message'));
    expect(await codeOf(b.host.receive(a.clientIo.frames[0] as Uint8Array))).toBe('DECRYPT');
  });

  test('the device identity and name are not readable on the wire before the channel is up', async () => {
    const f = await runFlow({ deviceName: 'Distinctive Phone Name' });
    for (const frame of [f.hello, f.helloAck, f.auth, f.ready]) {
      expect(frame).not.toContain(b64u(f.device.publicKey));
      expect(frame).not.toContain(hex(f.device.publicKey));
      expect(frame).not.toContain('Distinctive');
      expect(frame).not.toContain(b64u(text('Distinctive Phone Name')));
    }
  });
});

describe('handshake, version, mode and type', () => {
  test('a host refuses a hello of another version', async () => {
    const p = await makeParts('ver');
    const hello = r.encodeHello(
      'pair',
      (await ecGenerate(seededRandom('v e'))).publicKey,
      seed('v n'),
    );
    for (const v of [1, 3]) {
      const bad = hello.replace('"v":2', `"v":${v}`);
      const code = await codeOf(
        r.hostOnHello({ machine: p.machine, random: seededRandom('v h') }, bad, p.policy, NOW),
      );
      expect(code).toBe('VERSION');
    }
  });

  test('a client refuses a hello_ack of another version, a downgrade included', async () => {
    for (const v of [1, 3]) {
      const { c1, h1 } = await toAck();
      expect(await codeOf(c1.onHelloAck(h1.helloAck.replace('"v":2', `"v":${v}`), NOW + 1))).toBe(
        'VERSION',
      );
    }
  });

  test('a host refuses an unknown mode', async () => {
    const p = await makeParts('mode');
    const hello = r
      .encodeHello('pair', (await ecGenerate(seededRandom('m e'))).publicKey, seed('m n'))
      .replace('"pair"', '"admin"');
    expect(
      await codeOf(
        r.hostOnHello({ machine: p.machine, random: seededRandom('m h') }, hello, p.policy, NOW),
      ),
    ).toBe('MODE');
  });

  test('a frame of the wrong type for the step is refused by every step', async () => {
    const { p, c1, h1 } = await toAck();
    expect(
      await codeOf(
        r.hostOnHello(
          { machine: p.machine, random: seededRandom('t') },
          h1.helloAck,
          p.policy,
          NOW,
        ),
      ),
    ).toBe('TYPE');
    expect(await codeOf(c1.onHelloAck(c1.hello, NOW + 1))).toBe('TYPE');
    const c2 = await (await toAck()).c1
      .onHelloAck((await toAck()).h1.helloAck, NOW + 1)
      .catch(() => null);
    void c2;
    expect(await codeOf(h1.onAuth(c1.hello, p.policy, NOW + 1))).toBe('TYPE');
  });

  test('a binary frame where a text frame is expected is TYPE', async () => {
    const { p, c1, h1 } = await toAck();
    const binary = new Uint8Array(40) as unknown as string;
    expect(await codeOf(c1.onHelloAck(binary, NOW + 1))).toBe('TYPE');
    expect(await codeOf(h1.onAuth(binary, p.policy, NOW + 1))).toBe('TYPE');
  });

  test('malformed JSON or base64, and extra or missing fields, are refused at every step', async () => {
    const f = await runFlow({ label: 'malformed' });
    const p = await makeParts('malformed');
    const helloOf = async (): Promise<string> =>
      (
        await r.clientStart(
          {
            machinePublicKey: p.machine.publicKey,
            device: p.device,
            mode: 'pair',
            pairingSecret: p.offer.secret,
            random: seededRandom('mf c'),
          },
          NOW,
        )
      ).hello;
    const hello = await helloOf();
    const cases: [string, (s: string) => string][] = [
      ['not json', () => 'not json'],
      ['truncated', (s) => s.slice(0, -2)],
      ['extra field', (s) => s.replace('}', ',"x":"y"}')],
      ['missing field', (s) => s.replace(/,"n":"[^"]*"/, '')],
      ['bad base64', (s) => s.replace(/"e":"./, '"e":"!')],
    ];
    for (const [, mutate] of cases) {
      const code = await codeOf(
        r.hostOnHello(
          { machine: p.machine, random: seededRandom('mf h') },
          mutate(hello),
          p.policy,
          NOW,
        ),
      );
      expect(code).toBe('MALFORMED');
      const { c1 } = await toAck();
      expect(await codeOf(c1.onHelloAck(mutate(f.helloAck), NOW + 1))).toBe('MALFORMED');
    }
  });
});

describe('handshake, the host is authenticated first', () => {
  test('a hello_ack signed by another machine key (a malicious relay) is refused and no identity is revealed', async () => {
    const spy = countingSigner((await makeParts('imp')).device);
    const impostor = await r.signerFromSeed(seed('impostor machine'));
    const { c1, h1 } = await toAck('pair', 'imp', { device: spy.signer, machine: impostor });
    expect(await codeOf(c1.onHelloAck(h1.helloAck, NOW + 1))).toBe('BAD_SIGNATURE');
    expect(spy.calls).toEqual([]);
  });

  test('a hello_ack with one flipped signature bit is refused and the device key is never used', async () => {
    const spy = countingSigner((await makeParts('bad')).device);
    const { c1, h1 } = await toAck('pair', 'bad', { device: spy.signer });
    const ack = r.decodeHelloAck(h1.helloAck);
    const sig = ack.signature.slice();
    sig[10] = (sig[10] ?? 0) ^ 1;
    const forged = r.encodeHelloAck(ack.ephemeral, ack.nonce, sig);
    expect(await codeOf(c1.onHelloAck(forged, NOW + 1))).toBe('BAD_SIGNATURE');
    expect(spy.calls).toEqual([]);
  });

  test('a genuine hello_ack from another session is refused: the signature covers this session', async () => {
    const other = await toAck('pair', 'other session');
    const { c1 } = await toAck('pair', 'this session');
    expect(await codeOf(c1.onHelloAck(other.h1.helloAck, NOW + 1))).toBe('BAD_SIGNATURE');
  });

  test('the device key signs exactly once, and only after the host verified', async () => {
    const spy = countingSigner((await makeParts('once')).device);
    const { p, c1, h1 } = await toAck('pair', 'once', { device: spy.signer });
    expect(spy.calls).toEqual([]);
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    expect(spy.calls.length).toBe(1);
    await h1.onAuth(c2.auth, p.policy, NOW + 2);
    expect(spy.calls.length).toBe(1);
  });

  test('a host signature over a transcript that differs in any single term is refused', async () => {
    const { p, c1, h1 } = await toAck('pair', 'terms');
    const ack = r.decodeHelloAck(h1.helloAck);
    const hello = r.decodeHello(c1.hello);
    const base: r.Transcript = {
      rid: await r.ridOf(p.machine.publicKey),
      mode: 'pair',
      clientEphemeral: hello.ephemeral,
      clientNonce: hello.nonce,
      hostEphemeral: ack.ephemeral,
      hostNonce: ack.nonce,
    };
    const otherPoint = (await ecGenerate(seededRandom('terms other point'))).publicKey;
    const variants: [string, Partial<r.Transcript>][] = [
      ['rid', { rid: seed('terms other rid').slice(0, 16) }],
      ['mode', { mode: 'resume' }],
      ['client ephemeral key', { clientEphemeral: otherPoint }],
      ['client nonce', { clientNonce: seed('terms other client nonce') }],
      ['host ephemeral key', { hostEphemeral: otherPoint }],
      ['host nonce', { hostNonce: seed('terms other host nonce') }],
    ];
    // The control: a correctly signed ack with the real transcript is accepted, so a
    // refusal below is caused by the single changed term and nothing else.
    const control = await toAck('pair', 'terms');
    const controlSig = await p.machine.sign(r.hostSigningInput(await r.transcriptH1(base)));
    expect(
      (await control.c1.onHelloAck(r.encodeHelloAck(ack.ephemeral, ack.nonce, controlSig), NOW + 1))
        .auth.length,
    ).toBeGreaterThan(0);
    for (const [name, change] of variants) {
      const fresh = await toAck('pair', 'terms');
      const h1Changed = await r.transcriptH1({ ...base, ...change });
      const sig = await p.machine.sign(r.hostSigningInput(h1Changed));
      const forged = r.encodeHelloAck(ack.ephemeral, ack.nonce, sig);
      expect([name, await codeOf(fresh.c1.onHelloAck(forged, NOW + 1))]).toEqual([
        name,
        'BAD_SIGNATURE',
      ]);
    }
  });

  test('a relay that changes the hello in transit is caught by the client: every term the host signs', async () => {
    const { p, c1 } = await toAck('pair', 'transit');
    const hello = r.decodeHello(c1.hello);
    const otherPoint = (await ecGenerate(seededRandom('transit point'))).publicKey;
    const tampered: [string, string][] = [
      ['client ephemeral key', r.encodeHello('pair', otherPoint, hello.nonce)],
      ['client nonce', r.encodeHello('pair', hello.ephemeral, seed('transit nonce'))],
      ['mode', r.encodeHello('resume', hello.ephemeral, hello.nonce)],
    ];
    for (const [name, frame] of tampered) {
      const policy: r.HostPolicy = { offers: [p.offer], isEnrolled: () => true };
      const host = await r.hostOnHello(
        { machine: p.machine, random: seededRandom('transit host') },
        frame,
        policy,
        NOW,
      );
      const fresh = await toAck('pair', 'transit');
      expect([name, await codeOf(fresh.c1.onHelloAck(host.helloAck, NOW + 1))]).toEqual([
        name,
        'BAD_SIGNATURE',
      ]);
    }
  });

  test('a relay that changes the hello_ack keys or nonce in transit is caught', async () => {
    const { c1, h1 } = await toAck('pair', 'ack tamper');
    const ack = r.decodeHelloAck(h1.helloAck);
    const otherPoint = (await ecGenerate(seededRandom('ack point'))).publicKey;
    for (const forged of [
      r.encodeHelloAck(otherPoint, ack.nonce, ack.signature),
      r.encodeHelloAck(ack.ephemeral, seed('ack nonce'), ack.signature),
    ]) {
      const fresh = await toAck('pair', 'ack tamper');
      expect(await codeOf(fresh.c1.onHelloAck(forged, NOW + 1))).toBe('BAD_SIGNATURE');
    }
    void c1;
  });
});

describe('handshake, key schedule', () => {
  const z = seed('kdf z');
  const h1 = seed('kdf h1');
  const psk = seed('kdf psk');

  test('the two directions get different keys, and the derivation is deterministic', async () => {
    const a = await r.deriveSessionKeys(z, h1, psk);
    expect(hex(a.c2h)).not.toBe(hex(a.h2c));
    const b = await r.deriveSessionKeys(z, h1, psk);
    expect(hex(b.c2h)).toBe(hex(a.c2h));
    expect(a.c2h.length).toBe(32);
  });

  test('every input matters: the shared secret, the transcript hash and the pairing secret', async () => {
    const base = await r.deriveSessionKeys(z, h1, psk);
    const flip = (b: Uint8Array): Uint8Array => Uint8Array.from(b, (x, i) => (i === 0 ? x ^ 1 : x));
    const variants = {
      z: await r.deriveSessionKeys(flip(z), h1, psk),
      transcript: await r.deriveSessionKeys(z, flip(h1), psk),
      psk: await r.deriveSessionKeys(z, h1, flip(psk)),
      'no psk': await r.deriveSessionKeys(z, h1, null),
    };
    for (const [name, keys] of Object.entries(variants)) {
      expect([name, hex(keys.c2h) === hex(base.c2h), hex(keys.h2c) === hex(base.h2c)]).toEqual([
        name,
        false,
        false,
      ]);
    }
  });

  test('a client with the wrong pairing secret fails at the host with the pairing error', async () => {
    const p = await makeParts('wrong psk');
    const wrong = seed('not the pairing secret');
    const c1 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode: 'pair',
        pairingSecret: wrong,
        random: seededRandom('wp c'),
      },
      NOW,
    );
    const h1 = await r.hostOnHello(
      { machine: p.machine, random: seededRandom('wp h') },
      c1.hello,
      p.policy,
      NOW,
    );
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    expect(await codeOf(h1.onAuth(c2.auth, p.policy, NOW + 2))).toBe('PAIRING');
  });

  test('a flipped mode is caught: the transcript differs on the two sides', async () => {
    // Client resumes, the relay turns its hello into a pair hello, and a pairing offer is open.
    const p = await makeParts('flip', 'pair');
    const c1 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode: 'resume',
        random: seededRandom('fl c'),
      },
      NOW,
    );
    const flipped = c1.hello.replace('"resume"', '"pair"');
    const h1 = await r.hostOnHello(
      { machine: p.machine, random: seededRandom('fl h') },
      flipped,
      p.policy,
      NOW,
    );
    expect(await codeOf(c1.onHelloAck(h1.helloAck, NOW + 1))).toBe('BAD_SIGNATURE');
  });

  test('a client in pair mode needs the secret and a resume client must not carry one', async () => {
    const p = await makeParts('cfg');
    const base = {
      machinePublicKey: p.machine.publicKey,
      device: p.device,
      random: seededRandom('cfg'),
    };
    expect(await codeOf(r.clientStart({ ...base, mode: 'pair' }, NOW))).toBe('MODE');
    expect(
      await codeOf(r.clientStart({ ...base, mode: 'resume', pairingSecret: p.offer.secret }, NOW)),
    ).toBe('MODE');
    expect(
      await codeOf(
        r.clientStart({ ...base, mode: 'pair', pairingSecret: seed('x').slice(0, 31) }, NOW),
      ),
    ).toBe('MALFORMED');
    expect(
      await codeOf(
        r.clientStart({ ...base, machinePublicKey: new Uint8Array(31), mode: 'resume' }, NOW),
      ),
    ).toBe('MALFORMED');
  });
});

describe('handshake, the host checks the client', () => {
  interface Ctx {
    h1: Uint8Array;
    sigH: Uint8Array;
    device: r.Signer;
  }
  type Builder = (ctx: Ctx) => Promise<Uint8Array>;

  /** Run a hand-built client through a real host; `build` makes the auth plaintext. */
  async function viaHost(mode: r.Mode, label: string, build: Builder) {
    const p = await makeParts(label, mode);
    const psk = mode === 'pair' ? p.offer.secret : null;
    const mc = await manualClient(mode, psk, p.machine.publicKey, label);
    const h1 = await r.hostOnHello(
      { machine: p.machine, random: seededRandom(`${label} host`) },
      mc.hello,
      p.policy,
      NOW,
    );
    const acked = await mc.onAck(h1.helloAck);
    const body = await build({ h1: acked.h1, sigH: acked.ack.signature, device: p.device });
    return { p, h1, auth: await acked.sealAuth(body) };
  }

  type H2Of = (h1: Uint8Array, sigH: Uint8Array, d: Uint8Array, n: Uint8Array) => Uint8Array;

  /** An auth plaintext whose signature covers `h2Of` (the real H2 by default). */
  const authWith =
    (name: Uint8Array, h2Of?: H2Of): Builder =>
    async (ctx) => {
      const h2 = h2Of
        ? h2Of(ctx.h1, ctx.sigH, ctx.device.publicKey, name)
        : await r.transcriptH2(ctx.h1, ctx.sigH, ctx.device.publicKey, name);
      const sig = await ctx.device.sign(r.clientSigningInput(h2));
      return concat(ctx.device.publicKey, sig, name);
    };

  const LABEL_H2 = text('remi-relay-v2 H2');

  test('a hand-built auth that is correct in every respect is accepted (the control for the next tests)', async () => {
    const { p, h1, auth } = await viaHost('pair', 'ctl', authWith(text('ok')));
    expect((await h1.onAuth(auth, p.policy, NOW + 1)).deviceName).toBe('ok');
  });

  test('a signature by another key is refused even though the frame decrypts', async () => {
    const stranger = await r.signerFromSeed(seed('stranger'));
    const build: Builder = async (ctx) => {
      const h2 = await r.transcriptH2(ctx.h1, ctx.sigH, ctx.device.publicKey, text(''));
      return concat(ctx.device.publicKey, await stranger.sign(r.clientSigningInput(h2)));
    };
    const { p, h1, auth } = await viaHost('pair', 'sig', build);
    expect(await codeOf(h1.onAuth(auth, p.policy, NOW + 1))).toBe('BAD_SIGNATURE');
  });

  test('the client signature covers every term of H2: dropping any one is refused', async () => {
    const name = text('phone');
    const terms: [string, H2Of][] = [
      ['the label', (h1, sigH, d, n) => refHash(h1, sigH, d, n)],
      ['the transcript hash', (_h1, sigH, d, n) => refHash(LABEL_H2, sigH, d, n)],
      ['the host signature', (h1, _s, d, n) => refHash(LABEL_H2, h1, d, n)],
      ['the device key', (h1, sigH, _d, n) => refHash(LABEL_H2, h1, sigH, n)],
      ['the device name', (h1, sigH, d) => refHash(LABEL_H2, h1, sigH, d)],
    ];
    // The control: the reference construction itself, with every term, is accepted.
    const full: H2Of = (h1, sigH, d, n) => refHash(LABEL_H2, h1, sigH, d, n);
    const ctl = await viaHost('pair', 'h2 ctl', authWith(name, full));
    expect((await ctl.h1.onAuth(ctl.auth, ctl.p.policy, NOW + 1)).deviceName).toBe('phone');
    for (const [term, h2Of] of terms) {
      const { p, h1, auth } = await viaHost('pair', 'h2 terms', authWith(name, h2Of));
      expect([term, await codeOf(h1.onAuth(auth, p.policy, NOW + 1))]).toEqual([
        term,
        'BAD_SIGNATURE',
      ]);
    }
  });

  test('a device key that is not enrolled is refused on resume, an enrolled one is accepted', async () => {
    const f = await toAck('resume', 'enrol');
    const c2 = await f.c1.onHelloAck(f.h1.helloAck, NOW + 1);
    const closed: r.HostPolicy = { offers: [], isEnrolled: () => false };
    expect(await codeOf(f.h1.onAuth(c2.auth, closed, NOW + 2))).toBe('UNKNOWN_DEVICE');
    const g = await toAck('resume', 'enrol');
    const d2 = await g.c1.onHelloAck(g.h1.helloAck, NOW + 1);
    expect((await g.h1.onAuth(d2.auth, g.p.policy, NOW + 2)).offerIndex).toBeNull();
  });

  test('a corrupted device signature from the real client is refused', async () => {
    const real = (await makeParts('corrupt')).device;
    const corrupt: r.Signer = {
      publicKey: real.publicKey,
      sign: async (m) => Uint8Array.from(await real.sign(m), (b, i) => (i === 3 ? b ^ 1 : b)),
    };
    const { p, c1, h1 } = await toAck('pair', 'corrupt', { device: corrupt });
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    expect(await codeOf(h1.onAuth(c2.auth, p.policy, NOW + 2))).toBe('BAD_SIGNATURE');
  });

  test('the plaintext layout and the device name are checked', async () => {
    const good = authWith(text('n'));
    const named = (n: Uint8Array): Builder => authWith(n);
    const variants: [string, Builder, string][] = [
      ['95 bytes', async (c) => (await good(c)).slice(0, 95), 'MALFORMED'],
      ['161 bytes', async (c) => concat(await good(c), new Uint8Array(160)), 'MALFORMED'],
      ['control character in the name', named(text('bad\u0007name')), 'NAME'],
      [
        'name of 65 bytes (the layout bound catches it first)',
        named(text('a'.repeat(65))),
        'MALFORMED',
      ],
      ['invalid UTF-8 in the name', named(Uint8Array.of(0xc3, 0x28)), 'NAME'],
      ['DEL in the name', named(text('x\u007f')), 'NAME'],
    ];
    for (const [name, build, code] of variants) {
      const { p, h1, auth } = await viaHost('pair', `layout ${name}`, build);
      expect([name, await codeOf(h1.onAuth(auth, p.policy, NOW + 1))]).toEqual([name, code]);
    }
    for (const accepted of [text(''), text('a'.repeat(64)), text('Zoë’s phone')]) {
      const { p, h1, auth } = await viaHost('pair', 'name ok', named(accepted));
      expect((await h1.onAuth(auth, p.policy, NOW + 1)).deviceName).toBe(
        new TextDecoder().decode(accepted),
      );
    }
  });

  test('a leading byte order mark is part of the name, not stripped', async () => {
    const bom = text('\ufeffphone');
    const { p, h1, auth } = await viaHost('pair', 'name bom', authWith(bom));
    expect((await h1.onAuth(auth, p.policy, NOW + 1)).deviceName).toBe('\ufeffphone');
  });

  test('the client refuses to start with an invalid device name', async () => {
    const p = await makeParts('client name');
    for (const deviceName of ['a'.repeat(65), 'tab\there', 'nul\u0000']) {
      const code = await codeOf(
        r.clientStart(
          {
            machinePublicKey: p.machine.publicKey,
            device: p.device,
            deviceName,
            mode: 'resume',
            random: seededRandom('cn'),
          },
          NOW,
        ),
      );
      expect(code).toBe('NAME');
    }
  });

  test('an auth replayed on a second connection is refused: its keys belong to the first', async () => {
    for (const mode of ['pair', 'resume'] as const) {
      const first = await toAck(mode, 'replay');
      const c2 = await first.c1.onHelloAck(first.h1.helloAck, NOW + 1);
      // The attacker replays the captured hello AND the captured auth to a fresh host.
      const fresh = await r.hostOnHello(
        { machine: first.p.machine, random: seededRandom('replay fresh host') },
        first.c1.hello,
        first.p.policy,
        NOW + 5,
      );
      const code = await codeOf(fresh.onAuth(c2.auth, first.p.policy, NOW + 6));
      expect([mode, code]).toEqual([mode, mode === 'pair' ? 'PAIRING' : 'DECRYPT']);
    }
  });
});

describe('handshake, pairing offers', () => {
  test('a pair hello with no offer, a used offer or an expired offer is refused before any key work', async () => {
    const p = await makeParts('offers');
    const c1 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode: 'pair',
        pairingSecret: p.offer.secret,
        random: seededRandom('of c'),
      },
      NOW,
    );
    const host = (offers: r.PairingOffer[], now = NOW): Promise<unknown> =>
      r.hostOnHello(
        { machine: p.machine, random: seededRandom('of h') },
        c1.hello,
        { offers, isEnrolled: () => false },
        now,
      );
    expect(await codeOf(host([]))).toBe('PAIRING');
    expect(await codeOf(host([{ ...p.offer, used: true }]))).toBe('PAIRING');
    expect(await codeOf(host([p.offer], p.offer.expiresAtMs))).toBe('PAIRING');
    expect(await host([p.offer])).toBeDefined();
  });

  test('a secret used once cannot pair again', async () => {
    const { p, c1, h1 } = await toAck('pair', 'reuse');
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    const h2 = await h1.onAuth(c2.auth, p.policy, NOW + 2);
    expect(h2.offerIndex).toBe(0);
    // The daemon burns the offer; a second client with the same secret is refused at hello.
    const burned: r.HostPolicy = { offers: [{ ...p.offer, used: true }], isEnrolled: () => false };
    expect(
      await codeOf(
        r.hostOnHello(
          { machine: p.machine, random: seededRandom('reuse h2') },
          c1.hello,
          burned,
          NOW + 3,
        ),
      ),
    ).toBe('PAIRING');
  });

  test('an offer that expires between hello and auth no longer matches', async () => {
    const p = await makeParts('late');
    const shortLived: r.PairingOffer = {
      secret: p.offer.secret,
      expiresAtMs: NOW + 1000,
      used: false,
    };
    const policy: r.HostPolicy = { offers: [shortLived], isEnrolled: () => false };
    const c1 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode: 'pair',
        pairingSecret: shortLived.secret,
        random: seededRandom('late c'),
      },
      NOW,
    );
    const h1 = await r.hostOnHello(
      { machine: p.machine, random: seededRandom('late h') },
      c1.hello,
      policy,
      NOW,
    );
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    expect(await codeOf(h1.onAuth(c2.auth, policy, shortLived.expiresAtMs))).toBe('PAIRING');
    const c3 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode: 'pair',
        pairingSecret: shortLived.secret,
        random: seededRandom('late c'),
      },
      NOW,
    );
    const h3 = await r.hostOnHello(
      { machine: p.machine, random: seededRandom('late h') },
      c3.hello,
      policy,
      NOW,
    );
    const c4 = await c3.onHelloAck(h3.helloAck, NOW + 1);
    expect((await h3.onAuth(c4.auth, policy, shortLived.expiresAtMs - 1)).offerIndex).toBe(0);
  });

  test('with several live offers the matching one is reported by its position in the policy', async () => {
    const p = await makeParts('many');
    const offers: r.PairingOffer[] = [
      { secret: seed('many 0'), expiresAtMs: NOW + 5000, used: true },
      { secret: seed('many 1'), expiresAtMs: NOW + 5000, used: false },
      { secret: seed('many 2'), expiresAtMs: NOW + 5000, used: false },
    ];
    const policy: r.HostPolicy = { offers, isEnrolled: () => false };
    const c1 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode: 'pair',
        pairingSecret: seed('many 2'),
        random: seededRandom('many c'),
      },
      NOW,
    );
    const h1 = await r.hostOnHello(
      { machine: p.machine, random: seededRandom('many h') },
      c1.hello,
      policy,
      NOW,
    );
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    expect((await h1.onAuth(c2.auth, policy, NOW + 2)).offerIndex).toBe(2);
    // The burned offer's secret does not match even though it is listed.
    const c3 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode: 'pair',
        pairingSecret: seed('many 0'),
        random: seededRandom('many c3'),
      },
      NOW,
    );
    const h3 = await r.hostOnHello(
      { machine: p.machine, random: seededRandom('many h3') },
      c3.hello,
      policy,
      NOW,
    );
    const c4 = await c3.onHelloAck(h3.helloAck, NOW + 1);
    expect(await codeOf(h3.onAuth(c4.auth, policy, NOW + 2))).toBe('PAIRING');
  });
});

describe('handshake, key confirmation', () => {
  /** A real client up to `auth`, facing a hand-rolled host that can seal any `ready`. */
  async function clientFacingManualHost(mode: r.Mode, label: string) {
    const p = await makeParts(label, mode);
    const psk = mode === 'pair' ? p.offer.secret : null;
    const c1 = await r.clientStart(
      {
        machinePublicKey: p.machine.publicKey,
        device: p.device,
        mode,
        ...(psk ? { pairingSecret: psk } : {}),
        random: seededRandom(`${label} c`),
      },
      NOW,
    );
    const host = await manualHost(p.machine, mode, psk, c1.hello, label);
    const c2 = await c1.onHelloAck(host.helloAck, NOW + 1);
    return { c2, host };
  }

  test('a ready sealed under the right key with the right mode opens the channel (the control)', async () => {
    const { c2, host } = await clientFacingManualHost('pair', 'kc ctl');
    const io = recorder();
    const channel = await c2.onReady(await host.sealReady(Uint8Array.of(1)), NOW + 2, io.io);
    expect(channel.closed).toBe(false);
  });

  test('a ready that does not decrypt is refused, whether random or from another session', async () => {
    const { c2 } = await clientFacingManualHost('pair', 'kc a');
    const random = r.encodeSealedControl('ready', seed('kc random').slice(0, 17));
    expect(await codeOf(c2.onReady(random, NOW + 2, recorder().io))).toBe('DECRYPT');
    const { c2: c3 } = await clientFacingManualHost('pair', 'kc b');
    const other = await clientFacingManualHost('pair', 'kc c');
    expect(
      await codeOf(
        c3.onReady(await other.host.sealReady(Uint8Array.of(1)), NOW + 2, recorder().io),
      ),
    ).toBe('DECRYPT');
  });

  test('a ready that decrypts but echoes the wrong mode, or has the wrong shape, is refused', async () => {
    const cases: [Uint8Array, r.RelayErrorCode][] = [
      [Uint8Array.of(2), 'MODE_MISMATCH'],
      [Uint8Array.of(0), 'MODE_MISMATCH'],
      [Uint8Array.of(1, 1), 'MALFORMED'],
      [new Uint8Array(0), 'MALFORMED'],
    ];
    for (const [body, code] of cases) {
      const { c2, host } = await clientFacingManualHost('pair', 'kc mode');
      expect(await codeOf(c2.onReady(await host.sealReady(body), NOW + 2, recorder().io))).toBe(
        code,
      );
    }
    const { c2, host } = await clientFacingManualHost('resume', 'kc mode r');
    expect(
      await codeOf(c2.onReady(await host.sealReady(Uint8Array.of(1)), NOW + 2, recorder().io)),
    ).toBe('MODE_MISMATCH');
  });

  test('no channel exists when confirmation fails, and nothing was sent', async () => {
    const { c2, host } = await clientFacingManualHost('pair', 'kc none');
    const io = recorder();
    await expect(
      c2.onReady(await host.sealReady(Uint8Array.of(2)), NOW + 2, io.io),
    ).rejects.toBeInstanceOf(r.RelayError);
    expect(io.frames).toEqual([]);
    expect(io.closes).toEqual([]);
  });

  test('a ready sealed as an auth, or with another counter, does not open', async () => {
    const { c2, host } = await clientFacingManualHost('pair', 'kc hdr');
    const asAuth = r.encodeSealedControl(
      'ready',
      await aeadSeal(await aeadKey(host.keys.h2c), r.TYPE_AUTH, r.DIR_H2C, 0, Uint8Array.of(1)),
    );
    expect(await codeOf(c2.onReady(asAuth, NOW + 2, recorder().io))).toBe('DECRYPT');
    const { c2: c3, host: h3 } = await clientFacingManualHost('pair', 'kc hdr2');
    const counter1 = r.encodeSealedControl(
      'ready',
      await aeadSeal(await aeadKey(h3.keys.h2c), r.TYPE_READY, r.DIR_H2C, 1, Uint8Array.of(1)),
    );
    expect(await codeOf(c3.onReady(counter1, NOW + 2, recorder().io))).toBe('DECRYPT');
    const { c2: c4, host: h4 } = await clientFacingManualHost('pair', 'kc hdr3');
    const wrongDir = r.encodeSealedControl(
      'ready',
      await aeadSeal(await aeadKey(h4.keys.h2c), r.TYPE_READY, r.DIR_C2H, 0, Uint8Array.of(1)),
    );
    expect(await codeOf(c4.onReady(wrongDir, NOW + 2, recorder().io))).toBe('DECRYPT');
  });
});

describe('handshake, steps are single use', () => {
  test('a step called twice is STATE, and an aborted step cannot be used', async () => {
    const { p, c1, h1 } = await toAck('pair', 'twice');
    const c2 = await c1.onHelloAck(h1.helloAck, NOW + 1);
    expect(await codeOf(c1.onHelloAck(h1.helloAck, NOW + 1))).toBe('STATE');
    const h2 = await h1.onAuth(c2.auth, p.policy, NOW + 2);
    expect(await codeOf(h1.onAuth(c2.auth, p.policy, NOW + 2))).toBe('STATE');
    const { ready } = await h2.ready(NOW + 3, recorder().io);
    expect(await codeOf(h2.ready(NOW + 3, recorder().io))).toBe('STATE');
    await c2.onReady(ready, NOW + 4, recorder().io);
    expect(await codeOf(c2.onReady(ready, NOW + 4, recorder().io))).toBe('STATE');
    const again = await toAck('pair', 'abort');
    again.c1.abort();
    again.h1.abort();
    expect(await codeOf(again.c1.onHelloAck(again.h1.helloAck, NOW + 1))).toBe('STATE');
    expect(await codeOf(again.h1.onAuth(again.c1.hello, again.p.policy, NOW + 1))).toBe('STATE');
  });
});

describe('handshake, deadlines', () => {
  test('the client refuses a hello_ack after the handshake timeout, and accepts one exactly at it', async () => {
    const a = await toAck();
    expect((await a.c1.onHelloAck(a.h1.helloAck, NOW + r.HANDSHAKE_TIMEOUT_MS)).auth).toBeDefined();
    const b = await toAck();
    expect(await codeOf(b.c1.onHelloAck(b.h1.helloAck, NOW + r.HANDSHAKE_TIMEOUT_MS + 1))).toBe(
      'EXPIRED',
    );
  });

  test('the host refuses an auth after the handshake timeout, and accepts one exactly at it', async () => {
    const a = await toAck();
    const c2 = await a.c1.onHelloAck(a.h1.helloAck, NOW + 1);
    expect((await a.h1.onAuth(c2.auth, a.p.policy, NOW + r.HANDSHAKE_TIMEOUT_MS)).deviceName).toBe(
      'Test phone',
    );
    const b = await toAck();
    const d2 = await b.c1.onHelloAck(b.h1.helloAck, NOW + 1);
    expect(await codeOf(b.h1.onAuth(d2.auth, b.p.policy, NOW + r.HANDSHAKE_TIMEOUT_MS + 1))).toBe(
      'EXPIRED',
    );
  });

  test('ready is bound by the short timeout when resuming and the human timeout when pairing, on both sides', async () => {
    for (const [mode, limit] of [
      ['resume', r.HANDSHAKE_TIMEOUT_MS],
      ['pair', r.PAIR_CONFIRM_TIMEOUT_MS],
    ] as const) {
      for (const [late, outcome] of [
        [0, 'ok'],
        [1, 'EXPIRED'],
      ] as const) {
        const hostSide = await toAck(mode, `dl host ${mode}`);
        const c2 = await hostSide.c1.onHelloAck(hostSide.h1.helloAck, NOW + 1);
        const h2 = await hostSide.h1.onAuth(c2.auth, hostSide.p.policy, NOW + 2);
        const hostResult = h2.ready(NOW + limit + late, recorder().io).then(
          () => 'ok',
          (e) => (e as r.RelayError).code,
        );
        expect([mode, 'host', late, await hostResult]).toEqual([mode, 'host', late, outcome]);

        const clientSide = await toAck(mode, `dl client ${mode}`);
        const d2 = await clientSide.c1.onHelloAck(clientSide.h1.helloAck, NOW + 1);
        const e2 = await clientSide.h1.onAuth(d2.auth, clientSide.p.policy, NOW + 2);
        const { ready } = await e2.ready(NOW + 3, recorder().io);
        const clientResult = d2.onReady(ready, NOW + limit + late, recorder().io).then(
          () => 'ok',
          (e) => (e as r.RelayError).code,
        );
        expect([mode, 'client', late, await clientResult]).toEqual([mode, 'client', late, outcome]);
      }
    }
  });
});

describe('handshake, secrets', () => {
  test('the ephemeral scalar is overwritten once the key is built', async () => {
    const p = await makeParts('wipe');
    const drawn: Uint8Array[] = [];
    const inner = seededRandom('wipe');
    const random: r.Rng = (n) => {
      const out = inner(n);
      drawn.push(out);
      return out;
    };
    await r.clientStart(
      { machinePublicKey: p.machine.publicKey, device: p.device, mode: 'resume', random },
      NOW,
    );
    expect(drawn.length).toBe(2);
    expect(hex(drawn[0] as Uint8Array)).toBe('00'.repeat(32));
    expect(hex(drawn[1] as Uint8Array)).not.toBe('00'.repeat(32));
  });
});

describe('handshake, random mutation of any frame in transit never yields a channel', () => {
  test('120 single-character mutations of hello, hello_ack, auth and ready all end in a refusal', async () => {
    const rng = seededRandom('handshake mutations');
    const pick = (n: number): number => (rng(4).reduce((acc, b) => acc * 256 + b, 0) >>> 0) % n;
    const mutate = (frame: string): string => {
      for (;;) {
        const i = pick(frame.length);
        const c = frame[i] as string;
        const replacement = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_{}":,'[
          pick(70)
        ] as string;
        if (replacement !== c) return frame.slice(0, i) + replacement + frame.slice(i + 1);
      }
    };
    for (let n = 0; n < 120; n++) {
      const which = n % 4;
      const p = await makeParts(`mut ${n}`, 'pair');
      const attempt = async (): Promise<string> => {
        const c1 = await r.clientStart(
          {
            machinePublicKey: p.machine.publicKey,
            device: p.device,
            mode: 'pair',
            pairingSecret: p.offer.secret,
            random: seededRandom(`mut ${n} c`),
          },
          NOW,
        );
        const hello = which === 0 ? mutate(c1.hello) : c1.hello;
        const h1 = await r.hostOnHello(
          { machine: p.machine, random: seededRandom(`mut ${n} h`) },
          hello,
          p.policy,
          NOW,
        );
        const c2 = await c1.onHelloAck(which === 1 ? mutate(h1.helloAck) : h1.helloAck, NOW + 1);
        const h2 = await h1.onAuth(which === 2 ? mutate(c2.auth) : c2.auth, p.policy, NOW + 2);
        const { ready } = await h2.ready(NOW + 3, recorder().io);
        await c2.onReady(which === 3 ? mutate(ready) : ready, NOW + 4, recorder().io);
        return 'channel';
      };
      const outcome = await attempt().catch((e) =>
        e instanceof r.RelayError ? e.code : `unexpected ${String(e)}`,
      );
      expect([n, outcome === 'channel' || outcome.startsWith('unexpected')]).toEqual([n, false]);
    }
  });
});
