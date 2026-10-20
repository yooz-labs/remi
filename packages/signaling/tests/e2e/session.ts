/**
 * A real relay v2 session over the Worker, driven only by the library's public
 * `relayV2` surface from `@remi/shared`: the same handshake steps, the same
 * `Channel` and the same frames the daemon and the clients will use. A `Link` is
 * one end of an open channel with what that end sent and received on the wire.
 */

import { relayV2 } from '@remi/shared';
import {
  type FakeHost,
  type Identity,
  type Machine,
  Mailbox,
  type Socket,
  hex,
} from './endpoints.ts';

const { clientStart, hostOnHello, systemRandom } = relayV2;

/** One end of an open channel. `emitted` and `arrived` are the raw frames on the wire. */
export class Link {
  readonly inbox = new Mailbox<Uint8Array | null>();
  readonly emitted: Uint8Array[] = [];
  readonly arrived: Uint8Array[] = [];
  /** Why each receive failed, in order; a healthy link leaves this empty. */
  readonly failures: string[] = [];
  channel!: relayV2.Channel;

  constructor(readonly socket: Socket) {}

  /** The `ChannelIO` the library writes to: the socket, recording every frame. */
  readonly io: relayV2.ChannelIO = {
    emit: (frame) => {
      this.emitted.push(frame.slice());
      this.socket.sendBinary(frame);
    },
    close: (code, reason) => this.socket.ws.close(code, reason),
  };

  /** Start reading the socket into the channel. */
  attach(channel: relayV2.Channel): void {
    this.channel = channel;
    this.socket.tap((m) => {
      if (typeof m !== 'string') this.arrived.push(m.slice());
      channel.receive(m).then(
        (plaintext) => this.inbox.push(plaintext),
        (e) => this.failures.push((e as { code?: string }).code ?? String(e)),
      );
    });
  }

  send(plaintext: Uint8Array | string): Promise<void> {
    return this.channel.send(
      typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext,
    );
  }

  /** The next decrypted message, as text. */
  async text(timeoutMs?: number): Promise<string> {
    const m = await this.inbox.next(timeoutMs);
    if (m === null) throw new Error('the peer ended its stream');
    return new TextDecoder().decode(m);
  }

  async bytes(timeoutMs?: number): Promise<Uint8Array | null> {
    return this.inbox.next(timeoutMs);
  }
}

/** The host side's record of who is enrolled and which pairing offers are live. */
export class HostState {
  readonly enrolled = new Set<string>();
  offers: relayV2.PairingOffer[] = [];
}

export interface HostSession {
  link: Link;
  deviceKey: Uint8Array;
  deviceName: string;
  mode: 'pair' | 'resume';
  fingerprint: string;
}

/**
 * The host's side of one handshake on an open pipe, in the order ADR 0034 section 14
 * requires: verify `auth`, enroll with the Worker and wait for its acknowledgment
 * (pair mode), and only then produce `ready`.
 */
export async function serve(host: FakeHost, state: HostState, pipe: Socket): Promise<HostSession> {
  const policy: relayV2.HostPolicy = {
    isEnrolled: (k) => state.enrolled.has(hex(k)),
    offers: state.offers,
  };
  const hello = await pipe.text();
  const step1 = await hostOnHello(
    { machine: host.machine.signer, random: systemRandom },
    hello,
    policy,
    Date.now(),
  );
  const mode = JSON.parse(hello).m as 'pair' | 'resume';
  pipe.sendText(step1.helloAck);
  const step2 = await step1.onAuth(await pipe.text(), policy, Date.now());
  if (step2.offerIndex !== null) {
    // The pairing offer is spent, the key is stored here and at the Worker, then `ready`.
    const offer = state.offers[step2.offerIndex] as relayV2.PairingOffer;
    state.offers = state.offers.map((o) => (o === offer ? { ...o, used: true } : o));
    state.enrolled.add(hex(step2.devicePublicKey));
    const ack = await host.enroll(step2.devicePublicKey);
    if (ack['ok'] !== true) throw new Error('the Worker did not enroll the device');
  }
  const link = new Link(pipe);
  const { ready, channel } = await step2.ready(Date.now(), link.io);
  pipe.sendText(ready);
  link.attach(channel);
  return {
    link,
    deviceKey: step2.devicePublicKey,
    deviceName: step2.deviceName,
    mode,
    fingerprint: step2.fingerprint,
  };
}

export interface ClientOptions {
  machine: Machine;
  device: Identity;
  deviceName?: string;
  /** Present exactly in pair mode. */
  pairingSecret?: Uint8Array;
}

/** The client's side of one handshake on an open pipe. */
export async function dial(socket: Socket, options: ClientOptions): Promise<Link> {
  const step1 = await clientStart(
    {
      machinePublicKey: options.machine.publicKey,
      device: options.device.signer,
      ...(options.deviceName ? { deviceName: options.deviceName } : {}),
      mode: options.pairingSecret ? 'pair' : 'resume',
      ...(options.pairingSecret ? { pairingSecret: options.pairingSecret } : {}),
      random: systemRandom,
    },
    Date.now(),
  );
  socket.sendText(step1.hello);
  const step2 = await step1.onHelloAck(await socket.text(), Date.now());
  socket.sendText(step2.auth);
  const link = new Link(socket);
  const channel = await step2.onReady(await socket.text(), Date.now(), link.io);
  link.attach(channel);
  return link;
}
