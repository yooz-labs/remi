/**
 * The first end-to-end tests over the REAL Worker and Durable Object: a fake
 * host and a fake client run the real relay v2 handshake and encrypted frames
 * from `@remi/shared` (no mocked crypto) through the Worker, and the tests then
 * ask what the Worker could see, what it refused and what it left alone.
 *
 * Nothing here talks to Cloudflare: the runtime is workerd under Miniflare.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import {
  FakeHost,
  type Identity,
  type Machine,
  REFUSED,
  Socket,
  admit,
  advanceClock,
  clientUrl,
  connectClient,
  hex,
  hostUrl,
  newIdentity,
  newMachine,
  pipeUrl,
  roomSeen,
  roomState,
  runAlarm,
} from './endpoints.ts';
import { type TestWorker, startWorker } from './harness.ts';
import { HostState, type Link, dial, serve } from './session.ts';

const { MAX_FRAME, MAX_PLAINTEXT, admitTag, b64u, createPairingOffer, systemRandom } = relayV2;

let worker: TestWorker;
beforeEach(async () => {
  worker = await startWorker();
});
afterEach(() => worker.stop());

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A host that has opened a pairing window, and the secret and ticket of that window. */
async function openPairing(w: TestWorker) {
  const machine = await newMachine();
  const host = await FakeHost.start(w, machine);
  const state = new HostState();
  const offer = createPairingOffer(systemRandom, Date.now());
  state.offers = [offer];
  expect(await host.openWindow(offer.secret)).toEqual({ t: 'ack', r: 'pairing', ok: true });
  return { machine, host, state, offer, ticket: await admitTag(offer.secret) };
}

/** Bring one client connection up to an open pipe and run both ends of the handshake. */
async function connect(
  host: FakeHost,
  state: HostState,
  machine: Machine,
  device: Identity,
  options: { ticket?: Uint8Array; secret?: Uint8Array; name?: string } = {},
) {
  const { socket } = await connectClient(worker, machine, device, options.ticket);
  const pipe = await host.openPipe(await host.nextConnection());
  expect(await socket.json()).toEqual({ t: 'open' });
  const [hostSide, client] = await Promise.all([
    serve(host, state, pipe),
    dial(socket, {
      machine,
      device,
      ...(options.name ? { deviceName: options.name } : {}),
      ...(options.secret ? { pairingSecret: options.secret } : {}),
    }),
  ]);
  return { hostSide, client, host: hostSide.link, socket, pipe };
}

async function exchange(a: Link, b: Link, label: string): Promise<void> {
  await a.send(`${label} a-to-b`);
  expect(await b.text()).toBe(`${label} a-to-b`);
  await b.send(`${label} b-to-a`);
  expect(await a.text()).toBe(`${label} b-to-a`);
}

describe('a real session through the Worker', () => {
  test('a device pairs with a ticket, then resumes without one, and frames cross in both directions', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const device = await newIdentity();
    const paired = await connect(host, state, machine, device, {
      ticket,
      secret: offer.secret,
      name: 'Test phone',
    });
    expect(paired.hostSide.mode).toBe('pair');
    expect(paired.hostSide.deviceName).toBe('Test phone');
    expect(hex(paired.hostSide.deviceKey)).toBe(hex(device.publicKey));
    await exchange(paired.client, paired.host, 'paired');

    // end both directions cleanly: a BYE is a counter-checked frame the Worker also relays blind
    await paired.client.channel.bye();
    expect(await paired.host.bytes()).toBeNull();
    await paired.host.channel.bye();
    expect(await paired.client.bytes()).toBeNull();
    paired.socket.close();
    await paired.socket.closed;
    expect(await paired.client.channel.transportClosed()).toBe('clean');

    // the device is now enrolled at the Worker too, so it resumes with its key alone
    const resumed = await connect(host, state, machine, device);
    expect(resumed.hostSide.mode).toBe('resume');
    await exchange(resumed.client, resumed.host, 'resumed');
  });

  test('a frame of the largest size the library allows crosses the Worker and decrypts', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const s = await connect(host, state, machine, await newIdentity(), {
      ticket,
      secret: offer.secret,
    });
    const big = new Uint8Array(MAX_PLAINTEXT).map((_, i) => i % 251);
    await s.client.send(big);
    expect(await s.host.bytes()).toEqual(big);
    await s.host.send(big);
    expect(await s.client.bytes()).toEqual(big);
    // MAX_FRAME is what went over the wire
    expect(s.client.emitted.at(-1)?.length).toBe(MAX_FRAME);
  });

  test('the Worker delivers the sender frames byte for byte', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const s = await connect(host, state, machine, await newIdentity(), {
      ticket,
      secret: offer.secret,
    });
    for (let i = 0; i < 5; i++) await s.client.send(`c${i}`);
    for (let i = 0; i < 5; i++) await s.host.text();
    for (let i = 0; i < 5; i++) await s.host.send(`h${i}`);
    for (let i = 0; i < 5; i++) await s.client.text();
    expect(s.host.arrived).toEqual(s.client.emitted);
    expect(s.client.arrived).toEqual(s.host.emitted);
    expect(s.host.failures).toEqual([]);
    expect(s.client.failures).toEqual([]);
  });
});

describe('what the Worker sees', () => {
  const contains = (haystack: Uint8Array, needle: Uint8Array): boolean =>
    Buffer.from(haystack).includes(Buffer.from(needle));

  test('only ciphertext: no device name, no payload, no pairing secret reaches the object', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const device = await newIdentity();
    const name = 'SENTINEL-PHONE-NAME-7f3a91';
    const s = await connect(host, state, machine, device, { ticket, secret: offer.secret, name });
    const toHost = `SENTINEL-TO-HOST-${hex(systemRandom(8))}`;
    const toClient = `SENTINEL-TO-CLIENT-${hex(systemRandom(8))}`;
    await s.client.send(toHost);
    await s.host.send(toClient);
    // a larger body of repeated plaintext, so a leak would show many times
    const repeated = `SENTINEL-BULK-${'ab'.repeat(2000)}`;
    await s.client.send(repeated);
    // the endpoints really did receive the sentinels, so the scan below is not an empty search
    expect(await s.host.text()).toBe(toHost);
    expect(await s.client.text()).toBe(toClient);
    expect(await s.host.text()).toBe(repeated);
    expect(s.hostSide.deviceName).toBe(name);

    const seen = await roomSeen(worker, machine.ridHex);
    const state0 = await roomState(worker, machine.ridHex);
    const everything = Buffer.concat([
      ...seen.map((m) => Buffer.from(m.bytes, 'base64')),
      Buffer.from(JSON.stringify(state0)),
    ]);

    // what must NOT be there, in every form it could take
    const secrets: [string, Uint8Array][] = [
      ['the device name', utf8(name)],
      ['the host payload', utf8(toHost)],
      ['the client payload', utf8(toClient)],
      ['the bulk payload', utf8('SENTINEL-BULK')],
      ['the pairing secret (raw)', offer.secret],
      ['the pairing secret (hex)', utf8(hex(offer.secret))],
      ['the pairing secret (base64url)', utf8(b64u(offer.secret))],
      ['the pairing secret (base64)', utf8(Buffer.from(offer.secret).toString('base64'))],
    ];
    for (const [what, bytes] of secrets)
      expect([what, contains(everything, bytes)]).toEqual([what, false]);

    // what the Worker DOES see, as ADR 0034 section 11 says: the ticket, both public keys, the hello
    expect(contains(everything, utf8(b64u(ticket)))).toBe(true);
    expect(contains(everything, utf8(b64u(device.publicKey)))).toBe(true);
    expect(contains(everything, utf8(b64u(machine.publicKey)))).toBe(true);
    expect(contains(everything, utf8('"t":"hello"'))).toBe(true);

    // every binary message the object handled is a data frame the library emitted, nothing else
    const binary = seen
      .filter((m) => m.kind === 'binary')
      .map((m) => Buffer.from(m.bytes, 'base64'));
    const emitted = [...s.client.emitted, ...s.host.emitted].map((f) => Buffer.from(f));
    expect(binary.length).toBeGreaterThanOrEqual(3);
    for (const frame of binary) {
      expect(emitted.some((e) => e.equals(frame))).toBe(true);
      expect([3, 4]).toContain(frame[0] as number);
    }
  });

  test('storage holds only enrolled public keys, and a pairing window holds a hash, not the ticket', async () => {
    const { machine, host, offer, ticket } = await openPairing(worker);
    const before = await roomState(worker, machine.ridHex);
    const windows = before.storage['pw'] as { id: string; h: string; exp: number }[];
    expect(windows).toHaveLength(1);
    expect(windows[0]?.h).toBe(b64u(await relayV2.admitTagHash(ticket)));
    expect(JSON.stringify(before)).not.toContain(b64u(ticket));
    expect(JSON.stringify(before)).not.toContain(b64u(offer.secret));
    void host;
  });
});

describe('what the Worker refuses and leaves alone', () => {
  test('a session older than ten minutes, and older than an hour, is still alive', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const s = await connect(host, state, machine, await newIdentity(), {
      ticket,
      secret: offer.secret,
    });
    await exchange(s.client, s.host, 'young');
    for (const minutes of [11, 50, 400]) {
      await advanceClock(worker, machine.ridHex, minutes * 60_000);
      await runAlarm(worker, machine.ridHex);
      await exchange(s.client, s.host, `after ${minutes} more minutes`);
    }
    const room = await roomState(worker, machine.ridHex);
    expect(room.sockets.filter((x) => x?.st === 'open')).toHaveLength(2);
    expect(room.sockets.every((x) => x?.dl === 0)).toBe(true);
  });

  test('a stranger cannot take the host seat or a pipe while a session is live, and the session goes on', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const s = await connect(host, state, machine, await newIdentity(), {
      ticket,
      secret: offer.secret,
    });
    const stranger = await newIdentity();

    const seat = await Socket.open(hostUrl(worker, machine.ridHex));
    await admit(seat, stranger, 'host', machine.rid);
    expect(await seat.closed).toEqual(REFUSED);

    const cid = (await roomState(worker, machine.ridHex)).sockets.find((x) => x?.r === 'pipe')?.c;
    const pipe = await Socket.open(pipeUrl(worker, machine.ridHex, cid as string));
    await admit(pipe, stranger, 'host', machine.rid);
    expect(await pipe.closed).toEqual(REFUSED);

    await exchange(s.client, s.host, 'still the real host');
  });

  test('a stranger cannot join as a client, with a key of its own or with a replayed ticket', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    await connect(host, state, machine, await newIdentity(), { ticket, secret: offer.secret });
    const stranger = await newIdentity();
    const bare = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(bare, stranger, 'client', machine.rid);
    expect(await bare.closed).toEqual(REFUSED);
    const replay = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(replay, stranger, 'client', machine.rid, ticket);
    expect(await replay.closed).toEqual(REFUSED);
  });

  test('revoking a device ends its live session at the edge, and it cannot come back', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const device = await newIdentity();
    const s = await connect(host, state, machine, device, { ticket, secret: offer.secret });
    await exchange(s.client, s.host, 'before');
    expect(await host.revoke(device.publicKey)).toEqual({ t: 'ack', r: 'revoke', ok: true });
    expect(await s.socket.closed).toEqual(REFUSED);
    expect((await s.pipe.closed).code).toBe(4400);
    // no BYE came before the close, so both ends are told the tail may be truncated
    expect(await s.client.channel.transportClosed()).toBe('unclean');
    expect(await s.host.channel.transportClosed()).toBe('unclean');
    const again = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(again, device, 'client', machine.rid);
    expect(await again.closed).toEqual(REFUSED);
  });

  test('a pairing ticket works once: after a device paired, the same ticket admits nobody', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    await connect(host, state, machine, await newIdentity(), { ticket, secret: offer.secret });
    const late = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(late, await newIdentity(), 'client', machine.rid, ticket);
    expect(await late.closed).toEqual(REFUSED);
  });
});

describe('a host that goes away and comes back', () => {
  test('a waiting client is told when the host registers again, and its session completes', async () => {
    const { machine, host, state, offer, ticket } = await openPairing(worker);
    const device = await newIdentity();
    const first = await connect(host, state, machine, device, { ticket, secret: offer.secret });
    first.socket.close();
    await first.socket.closed;

    // the host process dies: its control socket and pipes go with it
    host.control.close();
    await host.control.closed;

    const { socket, hostUp } = await connectClient(worker, machine, device);
    expect(hostUp).toBe(false);
    const restarted = await FakeHost.start(worker, machine);
    expect(await socket.text()).toBe('{"t":"host","up":true}');
    const pipe = await restarted.openPipe(await restarted.nextConnection());
    expect(await socket.json()).toEqual({ t: 'open' });
    const [hostSide, client] = await Promise.all([
      serve(restarted, state, pipe),
      dial(socket, { machine, device }),
    ]);
    expect(hostSide.mode).toBe('resume');
    await exchange(client, hostSide.link, 'after the restart');
  });
});
