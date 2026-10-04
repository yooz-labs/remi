/** A complete real handshake for the tests, built only from the shipping step functions. */

import * as r from '../../src/relay/internal.ts';
import { hex, seed, seededRandom } from './helpers.ts';
import { type Recorder, recorder } from './recorder.ts';

export const NOW = 1_000_000;

export interface Flow {
  machine: r.Signer;
  device: r.Signer;
  offer: r.PairingOffer;
  policy: r.HostPolicy;
  hello: string;
  helloAck: string;
  auth: string;
  ready: string;
  client: r.Channel;
  host: r.Channel;
  clientIo: Recorder;
  hostIo: Recorder;
  fingerprint: string;
}

export interface FlowOptions {
  mode?: r.Mode;
  label?: string;
  deviceName?: string;
  /** Override the device signer (for example to observe or corrupt it). */
  device?: r.Signer;
}

/** A complete real handshake, pair or resume, from the shipping step functions. */
export async function runFlow(options: FlowOptions = {}): Promise<Flow> {
  const mode = options.mode ?? 'pair';
  const label = options.label ?? 'flow';
  const machine = await r.signerFromSeed(seed('machine'));
  const device = options.device ?? (await r.signerFromSeed(seed('device')));
  const offer = r.createPairingOffer(seededRandom(`${label} offer`), NOW);
  const policy: r.HostPolicy = {
    offers: mode === 'pair' ? [offer] : [],
    isEnrolled: (k) => hex(k) === hex(device.publicKey),
  };
  const c1 = await r.clientStart(
    {
      machinePublicKey: machine.publicKey,
      device,
      deviceName: options.deviceName ?? 'Test phone',
      mode,
      ...(mode === 'pair' ? { pairingSecret: offer.secret } : {}),
      random: seededRandom(`${label} client`),
    },
    NOW,
  );
  const h1 = await r.hostOnHello(
    { machine, random: seededRandom(`${label} host`) },
    c1.hello,
    policy,
    NOW,
  );
  const c2 = await c1.onHelloAck(h1.helloAck, NOW + 10);
  const h2 = await h1.onAuth(c2.auth, policy, NOW + 20);
  const hostIo = recorder();
  const clientIo = recorder();
  const { ready, channel: host } = await h2.ready(NOW + 30, hostIo.io);
  const client = await c2.onReady(ready, NOW + 40, clientIo.io);
  return {
    machine,
    device,
    offer,
    policy,
    hello: c1.hello,
    helloAck: h1.helloAck,
    auth: c2.auth,
    ready,
    client,
    host,
    clientIo,
    hostIo,
    fingerprint: c2.fingerprint,
  };
}

/** Everything a hand-driven handshake needs, from fixed seeds. */
export async function makeParts(label: string, mode: r.Mode = 'pair') {
  const machine = await r.signerFromSeed(seed('machine'));
  const device = await r.signerFromSeed(seed('device'));
  const offer = r.createPairingOffer(seededRandom(`${label} offer`), NOW);
  const policy: r.HostPolicy = {
    offers: mode === 'pair' ? [offer] : [],
    isEnrolled: (k) => hex(k) === hex(device.publicKey),
  };
  return { machine, device, offer, policy, mode };
}

/** A device signer that counts how often the device key is used. */
export function countingSigner(signer: r.Signer): { signer: r.Signer; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    signer: {
      publicKey: signer.publicKey,
      sign: async (message) => {
        calls.push(message.length);
        return signer.sign(message);
      },
    },
  };
}
