/**
 * The relay v2 engine check (ADR 0034 section 17).
 *
 * One engine-independent check of the library's WebCrypto use: no `node:` imports, no
 * Bun API, only `crypto.subtle` and the library. It is bundled for the target engine
 * (see README.md) and run there; `run()` returns a report and the runners print it.
 *
 * Groups:
 * - `base`: known-answer tests of the primitives, the PRODUCTION key path (engine
 *   `generateKey`, export and import round trips) and complete production handshakes.
 *   Must pass on every engine the relay supports.
 * - `jwk`: the committed vectors replayed through the shipping step functions with each
 *   ephemeral key imported as a JWK whose public coordinates are supplied, so no engine
 *   derives a public key from a scalar. Must pass everywhere.
 * - `scalar`: the same replay, and a few known answers, with keys built from a bare
 *   scalar or seed (the test-only `deterministic.ts` path). Informational: WebKit
 *   refuses a P-256 scalar-only PKCS8 import, which is why production does not use it.
 *
 * Signatures are compared by verification, and byte for byte only on an engine whose
 * signing is observed to be deterministic (WebKit and CryptoKit randomize).
 */

import * as r from '../../packages/shared/src/relay/internal.ts';

// biome-ignore lint/suspicious/noExplicitAny: the vector file is plain JSON read by shape
export type Vectors = any;
// biome-ignore lint/suspicious/noExplicitAny: a vector case is plain JSON read by shape
type J = any;

export type Group = 'base' | 'scalar' | 'jwk';
export interface Result {
  readonly group: Group;
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}
export interface Report {
  readonly engine: string;
  readonly results: Result[];
  /** Observations (Ed25519 behavior) that are recorded, not pass or fail. */
  readonly measurements: Record<string, string>;
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
const NOW = 1_000_000;

const nullIo: r.ChannelIO = { emit: () => undefined, close: () => undefined };
function recordingIo(): { frames: Uint8Array[]; io: r.ChannelIO } {
  const frames: Uint8Array[] = [];
  return {
    frames,
    io: {
      emit: (f) => {
        frames.push(f);
      },
      close: () => undefined,
    },
  };
}

/** An Rng that hands back the draws recorded in the file, in order. */
function fileRandom(...draws: string[]): r.Rng {
  let i = 0;
  return (n) => {
    const d = unhex(draws[i++] ?? '');
    if (d.length !== n) throw new Error(`draw ${i} has ${d.length} bytes, asked for ${n}`);
    return d;
  };
}
const scalarPeer = (random: r.Rng) => ({ random, ephemeral: () => r.ecGenerate(random) });

async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ ok: boolean; code?: string; value?: T }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof r.RelayError) return { ok: false, code: e.code };
    return { ok: false, code: `ENGINE:${(e as Error).name}` };
  }
}

// -- Pure BigInt P-256 (this check only): a public point from a scalar without asking the engine --
const P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;
function modpow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
  }
  return result;
}
type Point = readonly [bigint, bigint] | null;
function add(p: Point, q: Point): Point {
  if (!p) return q;
  if (!q) return p;
  const [x1, y1] = p;
  const [x2, y2] = q;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const slope =
    x1 === x2
      ? mod(3n * x1 * x1 - 3n) * modpow(2n * y1, P - 2n)
      : mod(y2 - y1) * modpow(x2 - x1, P - 2n);
  const lam = mod(slope);
  const x3 = mod(lam * lam - x1 - x2);
  return [x3, mod(lam * (x1 - x3) - y1)];
}
function multiply(k: bigint, point: Point): Point {
  let acc: Point = null;
  let addend = point;
  for (let n = k; n > 0n; n >>= 1n) {
    if (n & 1n) acc = add(acc, addend);
    addend = add(addend, addend);
  }
  return acc;
}
const pad32 = (n: bigint): string => n.toString(16).padStart(64, '0');
const b64url = (h: string): string =>
  btoa(String.fromCharCode(...unhex(h)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** An ECDH pair from a scalar by JWK import with the public coordinates supplied. */
async function jwkPair(scalar: Uint8Array): Promise<r.EcPair> {
  const point = multiply(BigInt(`0x${hex(scalar)}`), [GX, GY]);
  if (!point) throw new Error('scalar is a multiple of the group order');
  const [x, y] = point;
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pad32(x)),
    y: b64url(pad32(y)),
    d: b64url(hex(scalar)),
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  return { publicKey: unhex(`04${pad32(x)}${pad32(y)}`), privateKey };
}

/**
 * A signer that returns a recorded signature for a known signing input. It does not verify it:
 * the peer's own verification does, and the check also verifies the file's host signature and
 * the admission signatures directly.
 */
function recordedSigner(publicKey: Uint8Array, table: Map<string, string>): r.Signer {
  return {
    publicKey,
    sign: async (message) => {
      const recorded = table.get(hex(message));
      if (!recorded) throw new Error('a signing input that is not in the vector file');
      return unhex(recorded);
    },
  };
}

export async function run(V: Vectors): Promise<Report> {
  const results: Result[] = [];
  const measurements: Record<string, string> = {};
  const note = (group: Group) => ({
    check: (name: string, ok: boolean, detail?: string): void => {
      results.push({ group, name, ok, ...(detail ? { detail } : {}) });
    },
    guard: async (name: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        results.push({
          group,
          name,
          ok: false,
          detail: `threw ${(e as Error).name}: ${(e as Error).message}`,
        });
      }
    },
  });
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  const engine = nav?.userAgent ?? 'unknown';

  // ---- base: primitives against known answers
  {
    const { check, guard } = note('base');
    await guard('known answers', async () => {
      const okm = await r.hkdf(
        unhex('0b'.repeat(22)),
        unhex('000102030405060708090a0b0c'),
        unhex('f0f1f2f3f4f5f6f7f8f9'),
        42,
      );
      check(
        'HKDF-SHA256 matches RFC 5869 test 1',
        hex(okm) ===
          '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
      );
      check(
        'HMAC-SHA256 matches RFC 4231 test 2',
        hex(await r.hmacSha256(text('Jefe'), text('what do ya want for nothing?'))) ===
          '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
      );
      check(
        'SHA-256 of the empty input',
        hex(await r.sha256()) ===
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });
    await guard('p-256 point refusals', async () => {
      const good = (await r.generateEcPair()).publicKey;
      const off = good.slice();
      off[64] = (off[64] ?? 0) ^ 1;
      check(
        'an off-curve P-256 point is refused at import',
        !(await attempt(() => r.importEcPublic(off))).ok,
      );
      const hybrid = good.slice();
      hybrid[0] = (good[64] ?? 0) & 1 ? 7 : 6;
      check(
        'a hybrid-prefixed P-256 point is refused',
        !(await attempt(() => r.importEcPublic(hybrid))).ok,
      );
    });
    await guard('production keys', async () => {
      const a = await r.generateEcPair();
      const b = await r.generateEcPair();
      check(
        'generateEcPair: the private key is non-extractable',
        a.privateKey.extractable === false,
      );
      check(
        'generateEcPair: the raw public key is 65 bytes starting 04',
        a.publicKey.length === 65 && a.publicKey[0] === 4,
      );
      check(
        'ECDH agrees from both sides',
        hex(await r.ecdh(a.privateKey, b.publicKey)) ===
          hex(await r.ecdh(b.privateKey, a.publicKey)),
      );
      const persistable = await r.generateEcPair(true);
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', persistable.privateKey);
      const restored = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
      );
      check(
        "a P-256 PKCS8 export imports again (the engine's own export, no scalar import)",
        hex(await r.ecdh(restored, b.publicKey)) ===
          hex(await r.ecdh(b.privateKey, persistable.publicKey)),
      );
      const { signer, pkcs8: identity } = await r.generateIdentity();
      const message = text('engine identity');
      const signature = await signer.sign(message);
      check(
        'generateIdentity signs and the signature verifies',
        await r.verifySignature(signer.publicKey, message, signature),
      );
      const key = await crypto.subtle.importKey('pkcs8', identity, 'Ed25519', false, ['sign']);
      const again = await (await r.signerFromKey(key, signer.publicKey)).sign(message);
      const deterministic = hex(again) === hex(signature);
      measurements['Ed25519 signing is deterministic (two signatures of one message are equal)'] =
        String(deterministic);
      check(
        'an Ed25519 PKCS8 export imports again and signs (compared by verification)',
        await r.verifySignature(signer.publicKey, message, again),
      );
    });
    await guard('production handshakes', async () => {
      for (const mode of ['pair', 'resume'] as const) {
        const machine = (await r.generateIdentity()).signer;
        const device = (await r.generateIdentity()).signer;
        const offer = r.createPairingOffer(r.systemRandom, NOW);
        const policy: r.HostPolicy = {
          offers: mode === 'pair' ? [offer] : [],
          isEnrolled: (k) => hex(k) === hex(device.publicKey),
        };
        const client0 = await r.clientStart(
          {
            machinePublicKey: machine.publicKey,
            device,
            deviceName: 'engine check',
            mode,
            ...(mode === 'pair' ? { pairingSecret: offer.secret } : {}),
            random: r.systemRandom,
          },
          NOW,
        );
        const host0 = await r.hostOnHello(
          { machine, random: r.systemRandom },
          client0.hello,
          policy,
          NOW,
        );
        const client1 = await client0.onHelloAck(host0.helloAck, NOW + 1);
        const host1 = await host0.onAuth(client1.auth, policy, NOW + 2);
        const hostIo = recordingIo();
        const clientIo = recordingIo();
        const { ready, channel: host } = await host1.ready(NOW + 3, hostIo.io);
        const client = await client1.onReady(ready, NOW + 4, clientIo.io);
        await client.send(text('ping'));
        await host.send(text('pong'));
        const got = await host.receive(clientIo.frames[0] as Uint8Array);
        const back = await client.receive(hostIo.frames[0] as Uint8Array);
        check(
          `a production ${mode} handshake carries data both ways`,
          got !== null &&
            back !== null &&
            hex(got) === hex(text('ping')) &&
            hex(back) === hex(text('pong')),
        );
        await client.bye();
        const ended = await host.receive(clientIo.frames[1] as Uint8Array);
        check(
          `a production ${mode} stream ends with BYE and a clean close`,
          ended === null && (await host.transportClosed()) === 'clean',
        );
      }
    });
  }

  // ---- the vectors, replayed through the step functions in two key-construction modes
  const vectorPhase = async (mode: 'scalar' | 'jwk'): Promise<void> => {
    const { check, guard } = note(mode);
    const pairingSecret = unhex(V.admission.pairingSecret);
    const liveOffer: r.PairingOffer = {
      secret: pairingSecret,
      expiresAtMs: NOW + 600_000,
      used: false,
    };
    const machinePk = unhex(V.identities.machine.publicKey);
    const devicePk = unhex(V.identities.device.publicKey);
    const sigTable = new Map<string, string>();
    for (const n of ['pair', 'resume'] as const) {
      sigTable.set(V.sessions[n].hostSigningInput, V.sessions[n].hostSignature);
      sigTable.set(V.sessions[n].clientSigningInput, V.sessions[n].clientSignature);
    }
    sigTable.set(V.admission.hostInput, V.admission.hostSignature);
    sigTable.set(V.admission.clientInput, V.admission.clientSignature);
    // jwk mode never builds a key from a seed: public keys come from the file and signatures are recorded.
    const machine =
      mode === 'jwk'
        ? recordedSigner(machinePk, sigTable)
        : await r.signerFromSeed(unhex(V.identities.machine.seed));
    const device =
      mode === 'jwk'
        ? recordedSigner(devicePk, sigTable)
        : await r.signerFromSeed(unhex(V.identities.device.seed));
    const peer = (scalar: string, nonce: string) =>
      mode === 'jwk'
        ? { random: fileRandom(nonce), ephemeral: () => jwkPair(unhex(scalar)) }
        : scalarPeer(fileRandom(scalar, nonce));
    const hostFor = (name: 'pair' | 'resume', policy: r.HostPolicy) => {
      const s = V.sessions[name];
      return r.hostOnHello(
        { machine, ...peer(s.hostEphemeral.scalar, s.hostNonce) },
        s.hello,
        policy,
        NOW,
      );
    };
    const clientFor = (name: 'pair' | 'resume', pinned: Uint8Array = machinePk) => {
      const s = V.sessions[name];
      return r.clientStart(
        {
          machinePublicKey: pinned,
          device,
          deviceName: s.deviceName,
          mode: name,
          ...(name === 'pair' ? { pairingSecret } : {}),
          ...peer(s.clientEphemeral.scalar, s.clientNonce),
        },
        NOW,
      );
    };
    // a signature the engine produces itself must verify too (replayed signatures only prove verification)
    const recorded = V.sessions.pair.hostSignature as string;
    check(
      "the file's host signature verifies on this engine",
      await r.verifySignature(machinePk, unhex(V.sessions.pair.hostSigningInput), unhex(recorded)),
    );
    check('the room id follows from the machine key', hex(await r.ridOf(machinePk)) === V.rid);

    for (const name of ['pair', 'resume'] as const) {
      await guard(`replay ${name}`, async () => {
        const s = V.sessions[name];
        const policy: r.HostPolicy = {
          offers: name === 'pair' ? [liveOffer] : [],
          isEnrolled: (k) => hex(k) === hex(devicePk),
        };
        const client0 = await clientFor(name);
        const host0 = await hostFor(name, policy);
        const client1 = await client0.onHelloAck(host0.helloAck, NOW + 10);
        const host1 = await host0.onAuth(client1.auth, policy, NOW + 20);
        const hostIo = recordingIo();
        const clientIo = recordingIo();
        const { ready, channel: host } = await host1.ready(NOW + 30, hostIo.io);
        const client = await client1.onReady(ready, NOW + 40, clientIo.io);
        check(
          `${name}: hello, hello_ack, auth and ready are the file's bytes`,
          client0.hello === s.hello &&
            host0.helloAck === s.helloAck &&
            client1.auth === s.auth &&
            ready === s.ready,
        );
        check(
          `${name}: both ends show the file's fingerprint`,
          client1.fingerprint === s.fingerprint && host1.fingerprint === s.fingerprint,
        );
        let all = true;
        for (const f of s.data.c2h) {
          await client.send(unhex(f.plaintext));
          const got = await host.receive(unhex(f.frame));
          all =
            all &&
            hex(clientIo.frames[f.counter - 1] as Uint8Array) === f.frame &&
            got !== null &&
            hex(got) === f.plaintext;
        }
        await client.bye();
        check(
          `${name}: ten data frames and the BYE are the file's bytes and open`,
          all &&
            hex(clientIo.frames[10] as Uint8Array) === s.bye.c2h.frame &&
            (await host.receive(unhex(s.bye.c2h.frame))) === null,
        );
      });
    }
    await guard('admission, token and seal', async () => {
      const a = V.admission;
      const rid = unhex(V.rid);
      const nonce = unhex(a.nonce);
      check(
        "the admission inputs are the file's, and its signatures verify",
        hex(r.admissionInput('host', rid, nonce)) === a.hostInput &&
          hex(r.admissionInput('client', rid, nonce)) === a.clientInput &&
          (await r.verifyAdmission('host', machinePk, rid, nonce, unhex(a.hostSignature))) &&
          (await r.verifyAdmission('client', devicePk, rid, nonce, unhex(a.clientSignature))),
      );
      check(
        "the admission ticket is the file's",
        hex(await r.admitTag(pairingSecret)) === a.ticket,
      );
      for (const key of ['noSealKey', 'withSealKey'] as const) {
        const t = V.pairingToken[key];
        const d = await r.decodePairingToken(t.text, V.pairingToken.nowSec);
        check(
          `the ${key} pairing token decodes to the file's fields`,
          d.relayUrl === t.relayUrl && hex(d.secret) === t.secret,
        );
      }
      const s = V.seal;
      const recipient =
        mode === 'jwk'
          ? await jwkPair(unhex(s.recipientScalar))
          : await r.ecPairFromScalar(unhex(s.recipientScalar));
      const draws = mode === 'jwk' ? fileRandom(s.nonce) : fileRandom(s.ephemeralScalar, s.nonce);
      const sealed = await r.seal(
        recipient.publicKey,
        unhex(s.aad),
        unhex(s.plaintext),
        draws,
        mode === 'jwk' ? () => jwkPair(unhex(s.ephemeralScalar)) : () => r.ecGenerate(draws),
      );
      check(
        "the sealed push is the file's and opens",
        hex(sealed) === s.sealed &&
          hex(await r.openSeal(recipient, unhex(s.aad), unhex(s.sealed))) === s.plaintext,
      );
    });

    // every negative and control case
    const tally: Record<string, [number, number]> = {};
    for (const n of V.negative as J[]) {
      const out = await attempt<J>(async () => {
        switch (n.kind) {
          case 'control_decode':
            return n.frame === 'hello'
              ? r.decodeHello(n.text)
              : n.frame === 'hello_ack'
                ? r.decodeHelloAck(n.text)
                : r.decodeSealedControl(n.text, n.frame);
          case 'ec_point':
            return r.importEcPublic(unhex(n.publicKey));
          case 'hello_ack_verify':
            return (await clientFor(n.session, unhex(n.machinePublicKey))).onHelloAck(
              n.helloAck,
              NOW + 10,
            );
          case 'auth_open':
          case 'auth_check': {
            const offers = n.session === 'pair' ? [{ ...liveOffer, secret: unhex(n.psk) }] : [];
            const enrolled: string[] =
              n.kind === 'auth_check' ? n.enrolled : [V.identities.device.publicKey];
            const policy: r.HostPolicy = { offers, isEnrolled: (k) => enrolled.includes(hex(k)) };
            return (await hostFor(n.session, policy)).onAuth(n.auth, policy, NOW + 20);
          }
          case 'ready_open': {
            const client1 = await (await clientFor(n.session)).onHelloAck(
              V.sessions[n.session].helloAck,
              NOW + 10,
            );
            return client1.onReady(n.ready, NOW + 40, nullIo);
          }
          case 'data_sequence': {
            const receiver = await r.Channel.create({
              sendKey: new Uint8Array(32),
              recvKey: unhex(n.key),
              direction: n.direction === r.DIR_C2H ? r.DIR_H2C : r.DIR_C2H,
              io: nullIo,
              nextRecv: n.startRecv,
            });
            let accepted = 0;
            let failed: string | undefined;
            for (const f of n.frames) {
              const o = await attempt(() => receiver.receive(unhex(f)));
              if (failed !== undefined) {
                if (o.ok || o.code !== 'CLOSED')
                  throw new Error('the channel was not closed for good');
              } else if (o.ok) accepted++;
              else failed = o.code;
            }
            return { accepted, failed };
          }
          case 'frame_length': {
            const f = new Uint8Array(n.length);
            f[0] = n.type;
            f[8] = 1;
            return r.decodeDataFrame(f);
          }
          case 'token_decode':
            return r.decodePairingToken(n.text, n.nowSec);
          case 'seal_open':
            return r.openSeal(
              mode === 'jwk'
                ? await jwkPair(unhex(n.recipientScalar))
                : await r.ecPairFromScalar(unhex(n.recipientScalar)),
              unhex(n.aad),
              unhex(n.sealed),
            );
          case 'admission_verify': {
            if (
              !(await r.verifyAdmission(
                n.role,
                unhex(n.publicKey),
                unhex(n.rid),
                unhex(n.nonce),
                unhex(n.signature),
              ))
            )
              throw new r.RelayError('BAD_SIGNATURE');
            return true;
          }
          default:
            throw new Error(`unknown vector kind ${n.kind}`);
        }
      });
      let ok: boolean;
      if (n.kind === 'data_sequence') {
        const v = (out.value ?? {}) as { accepted?: number; failed?: string };
        ok = out.ok && v.accepted === n.accepted && (v.failed ?? null) === (n.code ?? null);
      } else if (n.expect === 'accept') ok = out.ok;
      else ok = !out.ok && (n.kind === 'admission_verify' || out.code === n.code);
      const t = tally[n.kind] ?? [0, 0];
      tally[n.kind] = t;
      t[ok ? 0 : 1]++;
      if (!ok)
        check(
          `${n.kind}: ${n.name}`,
          false,
          `expected ${n.expect}${n.code ? `/${n.code}` : ''}, got ${out.ok ? 'accepted' : out.code}`,
        );
    }
    for (const [kind, [pass, fail]] of Object.entries(tally))
      check(`${kind}: ${pass + fail} cases`, fail === 0, fail ? `${fail} failed` : undefined);
  };
  await vectorPhase('scalar');
  await vectorPhase('jwk');

  // ---- scalar and seed construction known answers (informational: WebKit refuses the P-256 one)
  {
    const { check, guard } = note('scalar');
    await guard('ed25519 from a seed', async () => {
      const s = await r.signerFromSeed(
        unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
      );
      check(
        'an Ed25519 seed gives the RFC 8032 public key',
        hex(s.publicKey) === 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
      );
    });
    await guard('p-256 from a scalar', async () => {
      const one = new Uint8Array(32);
      one[31] = 1;
      check(
        'a P-256 scalar of 1 gives the generator',
        hex((await r.ecPairFromScalar(one)).publicKey) === `04${pad32(GX)}${pad32(GY)}`,
      );
    });
  }

  // ---- Ed25519 verification edge cases, measured (not pass or fail)
  await (async () => {
    const seedKey = await crypto.subtle
      .importKey(
        'pkcs8',
        Uint8Array.from([
          ...unhex('302e020100300506032b657004220420'),
          ...unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
        ]),
        'Ed25519',
        false,
        ['sign'],
      )
      .catch(() => null);
    const pk = unhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const msg = text('edge');
    if (!seedKey) {
      measurements['Ed25519 seed import'] = 'refused by this engine';
      return;
    }
    const sign = async (): Promise<Uint8Array<ArrayBuffer>> =>
      new Uint8Array(await crypto.subtle.sign('Ed25519', seedKey, msg));
    const sig = await sign();
    const verify = async (
      key: Uint8Array<ArrayBuffer>,
      m: Uint8Array<ArrayBuffer>,
      sg: Uint8Array<ArrayBuffer>,
    ): Promise<string> => {
      try {
        return String(
          await crypto.subtle.verify(
            'Ed25519',
            await crypto.subtle.importKey('raw', key, 'Ed25519', false, ['verify']),
            sg,
            m,
          ),
        );
      } catch (e) {
        return `throws ${(e as Error).name}`;
      }
    };
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const sInt = [...sig.slice(32)].reverse().reduce((a, b) => (a << 8n) | BigInt(b), 0n);
    const sBytes = new Uint8Array(32);
    for (let i = 0, v = sInt + L; i < 32; i++, v >>= 8n) sBytes[i] = Number(v & 0xffn);
    const identity = unhex(`01${'00'.repeat(31)}`);
    const order2 = unhex(`ec${'ff'.repeat(30)}7f`);
    const zeroSig = new Uint8Array(64);
    zeroSig.set(identity, 0);
    let order2Accepted = 0;
    for (let i = 0; i < 16; i++)
      if ((await verify(order2, text(`message ${i}`), zeroSig)) === 'true') order2Accepted++;
    measurements['Ed25519: a canonical signature verifies'] = await verify(pk, msg, sig);
    measurements['Ed25519: signing is deterministic (RFC 8032 seed, two signatures)'] = String(
      hex(sig) === hex(await sign()),
    );
    measurements['Ed25519: a non-canonical S (S + L) verifies'] = await verify(
      pk,
      msg,
      new Uint8Array([...sig.slice(0, 32), ...sBytes]),
    );
    measurements[
      'Ed25519: the all-identity signature verifies under the identity public key (any message)'
    ] = await verify(identity, msg, zeroSig);
    measurements[
      'Ed25519: the all-identity signature verifies under the order-2 key for N of 16 messages'
    ] = String(order2Accepted);
    measurements['Ed25519: a 31-byte public key'] = await verify(pk.slice(0, 31), msg, sig);
  })();

  return { engine, results, measurements };
}

export interface Summary {
  readonly groups: Record<Group, { pass: number; total: number }>;
  readonly failures: Result[];
  /** True when every `base` and `jwk` check passed. The `scalar` group is informational. */
  readonly pass: boolean;
}

export function summarize(report: Report): Summary {
  const groups: Summary['groups'] = {
    base: { pass: 0, total: 0 },
    scalar: { pass: 0, total: 0 },
    jwk: { pass: 0, total: 0 },
  };
  for (const result of report.results) {
    groups[result.group].total++;
    if (result.ok) groups[result.group].pass++;
  }
  const failures = report.results.filter((x) => !x.ok);
  return { groups, failures, pass: failures.every((x) => x.group === 'scalar') };
}

export function describe(report: Report): string {
  const s = summarize(report);
  const lines = [`engine: ${report.engine}`];
  for (const g of ['base', 'jwk', 'scalar'] as const) {
    const note = g === 'scalar' ? ' (informational: keys built from a bare scalar or seed)' : '';
    lines.push(`${g}: ${s.groups[g].pass} of ${s.groups[g].total} checks pass${note}`);
  }
  const required = s.failures.filter((x) => x.group !== 'scalar');
  for (const f of required)
    lines.push(`  FAIL [${f.group}] ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  const scalar = s.failures.filter((x) => x.group === 'scalar');
  if (scalar.length > 0) {
    lines.push(`  scalar-built keys: ${scalar.length} lines fail; distinct causes:`);
    for (const cause of new Set(scalar.map((x) => x.detail ?? 'no detail').slice(0, 40))) {
      lines.push(`    ${cause}`);
    }
  }
  for (const [k, v] of Object.entries(report.measurements)) lines.push(`  ${k}: ${v}`);
  lines.push(s.pass ? 'PASS' : 'FAIL');
  return lines.join('\n');
}
