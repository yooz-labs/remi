/**
 * The v2 handshake as chains of single-use steps (ADR 0034 section 6).
 *
 * Nothing here reads a clock or a random source of its own: the caller passes
 * `now` (milliseconds) into each step and a `Rng` into the first, so a run is
 * a pure function of its inputs and the test vectors are reproducible. Each
 * step hands back the next one, so a step cannot be taken out of order and a
 * channel cannot exist before key confirmation; calling a step twice is `STATE`.
 *
 * What the library cannot enforce is the daemon's side of enrollment: it must
 * burn the pairing offer and store the device key before it asks for `ready`.
 */

import { type Bytes, concat, fromUtf8, lps, utf8, zero } from './bytes.ts';
import { Channel, type ChannelIO } from './channel.ts';
import {
  DIR_C2H,
  DIR_H2C,
  HANDSHAKE_TIMEOUT_MS,
  LABEL,
  MAX_DEVICE_NAME,
  MODE_BYTE,
  type Mode,
  PAIR_CONFIRM_TIMEOUT_MS,
  TYPE_AUTH,
  TYPE_READY,
  V,
} from './constants.ts';
import {
  decodeHello,
  decodeHelloAck,
  decodeSealedControl,
  encodeHello,
  encodeHelloAck,
  encodeSealedControl,
} from './envelope.ts';
import { RelayError } from './errors.ts';
import { type PairingOffer, fingerprintOf, liveOffers } from './pairing.ts';
import {
  type EcPair,
  type Rng,
  type Signer,
  aeadKey,
  aeadOpen,
  aeadSeal,
  ecdh,
  generateEcPair,
  hkdf,
  ridOf,
  sha256,
  verifySignature,
} from './primitives.ts';

// -- Transcript and key schedule (exported: the vector generator and the tests use them) --

export interface Transcript {
  readonly rid: Uint8Array;
  readonly mode: Mode;
  readonly clientEphemeral: Uint8Array;
  readonly clientNonce: Uint8Array;
  readonly hostEphemeral: Uint8Array;
  readonly hostNonce: Uint8Array;
}

export const transcriptH1 = (t: Transcript): Promise<Uint8Array> =>
  sha256(
    lps(
      LABEL.h1,
      t.rid,
      Uint8Array.of(V),
      Uint8Array.of(MODE_BYTE[t.mode]),
      t.clientEphemeral,
      t.clientNonce,
      t.hostEphemeral,
      t.hostNonce,
    ),
  );

export const hostSigningInput = (h1: Uint8Array): Bytes => lps(LABEL.host, h1);

export const transcriptH2 = (
  h1: Uint8Array,
  hostSignature: Uint8Array,
  devicePublicKey: Uint8Array,
  name: Uint8Array,
): Promise<Uint8Array> => sha256(lps(LABEL.h2, h1, hostSignature, devicePublicKey, name));

export const clientSigningInput = (h2: Uint8Array): Bytes => lps(LABEL.client, h2);

/** `psk` is the 32-byte pairing secret in pair mode and null in resume mode. */
export async function deriveSessionKeys(
  z: Uint8Array,
  h1: Uint8Array,
  psk: Uint8Array | null,
): Promise<{ c2h: Uint8Array; h2c: Uint8Array }> {
  const ikm = concat(z, psk ?? new Uint8Array(0));
  try {
    return {
      c2h: await hkdf(ikm, h1, utf8(LABEL.c2h), 32),
      h2c: await hkdf(ikm, h1, utf8(LABEL.h2c), 32),
    };
  } finally {
    zero(ikm);
  }
}

// -- Single-use steps --

/** A step runs once (a second call is `STATE`); a throw or `abort` overwrites its secrets. */
function step<A extends unknown[], R>(secrets: Uint8Array[], fn: (...args: A) => Promise<R>) {
  let used = false;
  return {
    run: async (...args: A): Promise<R> => {
      if (used) throw new RelayError('STATE');
      used = true;
      try {
        return await fn(...args);
      } catch (e) {
        zero(...secrets);
        throw e;
      }
    },
    abort: (): void => {
      used = true;
      zero(...secrets);
    },
  };
}

const readyDeadline = (mode: Mode): number =>
  mode === 'pair' ? PAIR_CONFIRM_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS;

function checkDeadline(startedAt: number, now: number, limit: number): void {
  if (now - startedAt > limit) throw new RelayError('EXPIRED');
}

// A device name is shown to an operator: bounded, valid UTF-8, no control characters.
function checkName(name: Uint8Array): void {
  try {
    if (name.length <= MAX_DEVICE_NAME && !/[\u0000-\u001f\u007f]/.test(fromUtf8(name))) return;
  } catch {}
  throw new RelayError('NAME');
}

type Keys = { c2h: Uint8Array; h2c: Uint8Array };

// -- Client --

export interface ClientConfig {
  /** The machine key the client trusts: from the token (pair) or its pin (resume). */
  readonly machinePublicKey: Uint8Array;
  readonly device: Signer;
  readonly deviceName?: string;
  readonly mode: Mode;
  /** 32 bytes; required in pair mode, forbidden in resume mode. */
  readonly pairingSecret?: Uint8Array;
  /** Nonces come from here; production passes `systemRandom`. */
  readonly random: Rng;
  /** The ephemeral key pair. Production leaves this out: the engine's `generateKey` is used. */
  readonly ephemeral?: () => Promise<EcPair>;
}

export interface ClientStep1 {
  readonly hello: string;
  onHelloAck(frame: string, now: number): Promise<ClientStep2>;
  abort(): void;
}

export interface ClientStep2 {
  readonly auth: string;
  /** Show this to the user while waiting for `ready` (pair mode). */
  readonly fingerprint: string;
  onReady(frame: string, now: number, io: ChannelIO): Promise<Channel>;
  abort(): void;
}

export async function clientStart(cfg: ClientConfig, startedAt: number): Promise<ClientStep1> {
  const name = utf8(cfg.deviceName ?? '');
  checkName(name);
  const psk = cfg.pairingSecret;
  if (cfg.machinePublicKey.length !== 32 || (psk !== undefined && psk.length !== 32)) {
    throw new RelayError('MALFORMED');
  }
  if ((cfg.mode === 'pair') !== (psk !== undefined)) throw new RelayError('MODE');
  const rid = await ridOf(cfg.machinePublicKey);
  const ephemeral = await (cfg.ephemeral ?? generateEcPair)();
  const nonce = cfg.random(32);

  // Verify the host BEFORE anything of the device's is used: the device key signs
  // only after `sig_h` verified under the machine key this client trusts.
  const ack = step([], async (frame: string, now: number): Promise<ClientStep2> => {
    checkDeadline(startedAt, now, HANDSHAKE_TIMEOUT_MS);
    const a = decodeHelloAck(frame);
    const h1 = await transcriptH1({
      rid,
      mode: cfg.mode,
      clientEphemeral: ephemeral.publicKey,
      clientNonce: nonce,
      hostEphemeral: a.ephemeral,
      hostNonce: a.nonce,
    });
    if (!(await verifySignature(cfg.machinePublicKey, hostSigningInput(h1), a.signature))) {
      throw new RelayError('BAD_SIGNATURE');
    }
    const z = await ecdh(ephemeral.privateKey, a.ephemeral);
    const keys: Keys = await deriveSessionKeys(z, h1, psk ?? null).finally(() => zero(z));
    try {
      const h2 = await transcriptH2(h1, a.signature, cfg.device.publicKey, name);
      const sigC = await cfg.device.sign(clientSigningInput(h2));
      const plaintext = concat(cfg.device.publicKey, sigC, name);
      const sealed = await aeadSeal(await aeadKey(keys.c2h), TYPE_AUTH, DIR_C2H, 0, plaintext);
      // Key confirmation: `ready` must open under `k_h2c` and echo the mode asked for.
      const ready = step(
        [keys.c2h, keys.h2c],
        async (readyFrame: string, readyNow: number, io: ChannelIO) => {
          checkDeadline(startedAt, readyNow, readyDeadline(cfg.mode));
          const ct = decodeSealedControl(readyFrame, 'ready');
          const echo = await aeadOpen(await aeadKey(keys.h2c), TYPE_READY, DIR_H2C, 0, ct);
          if (echo[0] !== MODE_BYTE[cfg.mode]) throw new RelayError('MODE_MISMATCH');
          return Channel.create({ sendKey: keys.c2h, recvKey: keys.h2c, direction: DIR_C2H, io });
        },
      );
      return {
        auth: encodeSealedControl('auth', sealed),
        fingerprint: await fingerprintOf(cfg.device.publicKey, cfg.machinePublicKey),
        onReady: ready.run,
        abort: ready.abort,
      };
    } catch (e) {
      zero(keys.c2h, keys.h2c);
      throw e;
    }
  });
  return {
    hello: encodeHello(cfg.mode, ephemeral.publicKey, nonce),
    onHelloAck: ack.run,
    abort: ack.abort,
  };
}

// -- Host --

export interface HostConfig {
  readonly machine: Signer;
  /** Nonces come from here; production passes `systemRandom`. */
  readonly random: Rng;
  /** The ephemeral key pair. Production leaves this out: the engine's `generateKey` is used. */
  readonly ephemeral?: () => Promise<EcPair>;
}

export interface HostPolicy {
  isEnrolled(devicePublicKey: Uint8Array): boolean;
  readonly offers: readonly PairingOffer[];
}

export interface HostStep1 {
  readonly helloAck: string;
  /**
   * Open and check `auth`. Pair mode tries each live offer in order; the one whose
   * secret opens the frame is the match, reported as `offerIndex` into `policy.offers`.
   */
  onAuth(frame: string, policy: HostPolicy, now: number): Promise<HostStep2>;
  abort(): void;
}

/**
 * The caller confirms the fingerprint, burns the offer, stores the device key and
 * only then calls `ready`.
 */
export interface HostStep2 {
  readonly devicePublicKey: Uint8Array;
  readonly deviceName: string;
  readonly offerIndex: number | null;
  readonly fingerprint: string;
  ready(now: number, io: ChannelIO): Promise<{ ready: string; channel: Channel }>;
  abort(): void;
}

export async function hostOnHello(
  cfg: HostConfig,
  frame: string,
  policy: HostPolicy,
  startedAt: number,
): Promise<HostStep1> {
  const hello = decodeHello(frame);
  if (hello.mode === 'pair' && liveOffers(policy.offers, startedAt).length === 0) {
    throw new RelayError('PAIRING');
  }
  const machinePublicKey = cfg.machine.publicKey;
  const ephemeral = await (cfg.ephemeral ?? generateEcPair)();
  const nonce = cfg.random(32);
  const h1 = await transcriptH1({
    rid: await ridOf(machinePublicKey),
    mode: hello.mode,
    clientEphemeral: hello.ephemeral,
    clientNonce: hello.nonce,
    hostEphemeral: ephemeral.publicKey,
    hostNonce: nonce,
  });
  const hostSignature = await cfg.machine.sign(hostSigningInput(h1));
  const z = await ecdh(ephemeral.privateKey, hello.ephemeral);

  const auth = step(
    [z],
    async (authFrame: string, pol: HostPolicy, now: number): Promise<HostStep2> => {
      try {
        checkDeadline(startedAt, now, HANDSHAKE_TIMEOUT_MS);
        const ciphertext = decodeSealedControl(authFrame, 'auth');
        const candidates =
          hello.mode === 'resume'
            ? [{ offer: null, secret: null }]
            : liveOffers(pol.offers, now).map((offer) => ({ offer, secret: offer.secret }));
        let opened: { keys: Keys; plaintext: Uint8Array; offerIndex: number | null } | null = null;
        for (const { offer, secret } of candidates) {
          const keys = await deriveSessionKeys(z, h1, secret);
          try {
            const plaintext = await aeadOpen(
              await aeadKey(keys.c2h),
              TYPE_AUTH,
              DIR_C2H,
              0,
              ciphertext,
            );
            opened = { keys, plaintext, offerIndex: offer ? pol.offers.indexOf(offer) : null };
            break;
          } catch {
            zero(keys.c2h, keys.h2c);
          }
        }
        if (opened === null) throw new RelayError(hello.mode === 'pair' ? 'PAIRING' : 'DECRYPT');
        const { keys, plaintext, offerIndex } = opened;
        try {
          // The envelope bounds the ciphertext to 112..176 bytes, so this plaintext is
          // 96..160 bytes: key, signature, then at most 64 bytes of name.
          const devicePublicKey = plaintext.slice(0, 32);
          const nameBytes = plaintext.slice(96);
          checkName(nameBytes);
          const h2 = await transcriptH2(h1, hostSignature, devicePublicKey, nameBytes);
          if (
            !(await verifySignature(
              devicePublicKey,
              clientSigningInput(h2),
              plaintext.slice(32, 96),
            ))
          ) {
            throw new RelayError('BAD_SIGNATURE');
          }
          if (hello.mode === 'resume' && !pol.isEnrolled(devicePublicKey)) {
            throw new RelayError('UNKNOWN_DEVICE');
          }
          const ready = step([keys.c2h, keys.h2c], async (readyNow: number, io: ChannelIO) => {
            checkDeadline(startedAt, readyNow, readyDeadline(hello.mode));
            const echo = Uint8Array.of(MODE_BYTE[hello.mode]);
            const sealed = await aeadSeal(await aeadKey(keys.h2c), TYPE_READY, DIR_H2C, 0, echo);
            const channel = await Channel.create({
              sendKey: keys.h2c,
              recvKey: keys.c2h,
              direction: DIR_H2C,
              io,
            });
            return { ready: encodeSealedControl('ready', sealed), channel };
          });
          return {
            devicePublicKey,
            deviceName: fromUtf8(nameBytes),
            offerIndex,
            fingerprint: await fingerprintOf(devicePublicKey, machinePublicKey),
            ready: ready.run,
            abort: ready.abort,
          };
        } catch (e) {
          zero(keys.c2h, keys.h2c);
          throw e;
        }
      } finally {
        zero(z);
      }
    },
  );
  return {
    helloAck: encodeHelloAck(ephemeral.publicKey, nonce, hostSignature),
    onAuth: auth.run,
    abort: auth.abort,
  };
}
