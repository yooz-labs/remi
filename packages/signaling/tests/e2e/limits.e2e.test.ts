/**
 * Hello-flood limits and size limits against the REAL Worker and Durable Object
 * (ADR 0034 section 19): a per-address limit and a per-room limit through the
 * global limiter object, a cap on unadmitted sockets, a per-device admission
 * budget, a cap on admitted clients, and the frame ceiling. Each limit is run
 * with a SMALL value (a Worker variable), never with a flood: the code under test
 * is the real limiter, only its number is changed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import {
  FakeHost,
  type Identity,
  type Machine,
  REFUSED,
  Socket,
  admit,
  admitText,
  advanceClock,
  clientUrl,
  connectClient,
  holdBurns,
  hostUrl,
  newIdentity,
  newMachine,
  pipeUrl,
  readNonce,
  roomState,
  runAlarm,
  upgradeStatus,
} from './endpoints.ts';
import { type TestWorker, startWorker } from './harness.ts';

const { MAX_CONTROL_TEXT, MAX_FRAME, signAdmission } = relayV2;

let worker: TestWorker | undefined;
const start = async (vars: Record<string, string> = {}): Promise<TestWorker> => {
  worker = await startWorker(vars);
  return worker;
};
afterEach(() => worker?.stop());

describe('per-address and per-room limits (the global limiter object)', () => {
  test('a supported high limit reaches the room and a small second budget still counts', async () => {
    const w = await start({ LIMIT_IP_CLIENT: '100001', LIMIT_RID: '1' });
    const machine = await newMachine();
    const first = await Socket.open(clientUrl(w, machine.ridHex));
    await readNonce(first);
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
  });

  test('a supported subsecond window counts and renews at the front door', async () => {
    const w = await start({ LIMIT_IP_CLIENT: '1', LIMIT_WINDOW_MS: '400' });
    const machine = await newMachine();
    const first = await Socket.open(clientUrl(w, machine.ridHex));
    await readNonce(first);
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
    await Bun.sleep(500);
    const retry = await Socket.open(clientUrl(w, machine.ridHex));
    await readNonce(retry);
  });

  test('past the per-address budget an upgrade is refused with 429, and each route class has its own', async () => {
    const w = await start({ LIMIT_IP_CLIENT: '2' });
    const machine = await newMachine();
    await Socket.open(clientUrl(w, machine.ridHex));
    await Socket.open(clientUrl(w, machine.ridHex));
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
    // the host route is a different bucket: a stranger flooding clients cannot lock the host out
    const host = await FakeHost.start(w, machine);
    expect(host.control.isClosed).toBe(false);
  });

  test('the per-room budget counts every address and every route together, and spares other rooms', async () => {
    const w = await start({ LIMIT_RID: '3' });
    const machine = await newMachine();
    await Socket.open(clientUrl(w, machine.ridHex));
    await Socket.open(hostUrl(w, machine.ridHex));
    await Socket.open(clientUrl(w, machine.ridHex));
    expect(await upgradeStatus(hostUrl(w, machine.ridHex))).toBe(429);
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
    expect(await upgradeStatus(pipeUrl(w, machine.ridHex, 'ab'.repeat(16)))).toBe(429);
    const other = await newMachine();
    await Socket.open(hostUrl(w, other.ridHex));
  });

  test('a budget renews when its window ends', async () => {
    const w = await start({ LIMIT_IP_CLIENT: '1', LIMIT_WINDOW_MS: '1000' });
    const machine = await newMachine();
    await Socket.open(clientUrl(w, machine.ridHex));
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
    await Bun.sleep(1100);
    await Socket.open(clientUrl(w, machine.ridHex));
  });

  test('a refusal at the front never reaches the room: the stranger holds no slot', async () => {
    const w = await start({ LIMIT_IP_CLIENT: '1' });
    const machine = await newMachine();
    await Socket.open(clientUrl(w, machine.ridHex));
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
    const state = await (
      await fetch(`${w.url}/__room/${machine.ridHex}/__state`, { keepalive: false } as RequestInit)
    ).json();
    expect((state as { sockets: unknown[] }).sockets).toHaveLength(1);
  });
});

describe('the cap on unadmitted sockets', () => {
  test('a room holds only so many unadmitted client sockets, and the deadline frees the slots', async () => {
    const w = await start({ MAX_PENDING_CLIENT: '2' });
    const machine = await newMachine();
    const first = await Socket.open(clientUrl(w, machine.ridHex));
    const second = await Socket.open(clientUrl(w, machine.ridHex));
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
    await advanceClock(w, machine.ridHex, 11_000);
    await runAlarm(w, machine.ridHex);
    expect(await first.closed).toEqual(REFUSED);
    expect(await second.closed).toEqual(REFUSED);
    const third = await Socket.open(clientUrl(w, machine.ridHex));
    expect(third.isClosed).toBe(false);
  });

  test('the host side has its own cap, so unadmitted clients cannot starve the host', async () => {
    const w = await start({ MAX_PENDING_CLIENT: '1', MAX_PENDING_HOST: '1' });
    const machine = await newMachine();
    await Socket.open(clientUrl(w, machine.ridHex));
    expect(await upgradeStatus(clientUrl(w, machine.ridHex))).toBe(429);
    const host = await FakeHost.start(w, machine);
    expect(host.control.isClosed).toBe(false);
  });

  test('an admitted socket no longer counts against the cap', async () => {
    const w = await start({ MAX_PENDING_HOST: '1' });
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    // the host is admitted, so the one pending slot is free for another host-side socket
    const again = await Socket.open(hostUrl(w, machine.ridHex));
    await readNonce(again);
    expect(again.isClosed).toBe(false);
    expect(host.control.isClosed).toBe(false);
  });
});

describe('the per-device admission budget', () => {
  async function enrolledDevices(w: TestWorker, count: number) {
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    const devices: Identity[] = [];
    for (let i = 0; i < count; i++) {
      const device = await newIdentity();
      await host.enroll(device.publicKey);
      devices.push(device);
    }
    return { machine, host, devices };
  }

  test('a device is admitted only so often, and another device is not affected', async () => {
    const w = await start({ LIMIT_DEVICE_ADMITS: '2' });
    const { machine, devices } = await enrolledDevices(w, 2);
    const [a, b] = devices as [Identity, Identity];
    await connectClient(w, machine, a);
    await connectClient(w, machine, a);
    const third = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(third, a, 'client', machine.rid);
    expect(await third.closed).toEqual(REFUSED);
    const other = await connectClient(w, machine, b);
    expect(other.socket.isClosed).toBe(false);
  });

  test('bad signatures under a device key do not spend that device budget', async () => {
    const w = await start({ LIMIT_DEVICE_ADMITS: '2' });
    const { machine, devices } = await enrolledDevices(w, 1);
    const [device] = devices as [Identity];
    const impostor = await newIdentity();
    for (let i = 0; i < 4; i++) {
      const bad = await Socket.open(clientUrl(w, machine.ridHex));
      const nonce = await readNonce(bad);
      bad.sendText(
        admitText(
          device.publicKey,
          await signAdmission(impostor.signer, 'client', machine.rid, nonce),
        ),
      );
      expect(await bad.closed).toEqual(REFUSED);
    }
    await connectClient(w, machine, device);
    await connectClient(w, machine, device);
    const third = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(third, device, 'client', machine.rid);
    expect(await third.closed).toEqual(REFUSED);
  });
});

describe('the cap on admitted clients', () => {
  test('an in-flight pairing reserves capacity against distinct tickets and resume', async () => {
    const w = await start({ MAX_CLIENTS: '1' });
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    const resumedDevice = await newIdentity();
    await host.enroll(resumedDevice.publicKey);
    const secrets = [relayV2.systemRandom(32), relayV2.systemRandom(32)];
    const tickets = await Promise.all(secrets.map((secret) => relayV2.admitTag(secret)));
    for (const secret of secrets) await host.openWindow(secret);
    const firstDevice = await newIdentity();
    const secondDevice = await newIdentity();
    await holdBurns(w, machine.ridHex, 2);
    const first = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(first, firstDevice, 'client', machine.rid, tickets[0]);
    // No notice arrives while the real admission handler waits at the burn barrier.
    expect(await first.quiet(50)).toBe(true);
    const second = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(second, secondDevice, 'client', machine.rid, tickets[1]);
    const secondOutcome = await Promise.race([
      second.json().then((m) => m['t']),
      second.closed.then(() => 'closed'),
    ]);
    expect(secondOutcome).toBe('closed');
    const resume = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(resume, resumedDevice, 'client', machine.rid);
    expect(await resume.closed).toEqual(REFUSED);
    await holdBurns(w, machine.ridHex, 0);
    expect((await first.json())['t']).toBe('admitted');
    expect((await roomState(w, machine.ridHex)).sockets.filter((a) => a?.k)).toHaveLength(1);
    first.close();
    await first.closed;
    // The refused second ticket is still valid, and completed reservations do not hold a slot.
    const retry = await connectClient(w, machine, secondDevice, tickets[1]);
    expect(retry.socket.isClosed).toBe(false);
  });

  test('closing during a held burn frees capacity and preserves the ticket', async () => {
    const w = await start({ MAX_CLIENTS: '1' });
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    const secret = relayV2.systemRandom(32);
    await host.openWindow(secret);
    const ticket = await relayV2.admitTag(secret);
    const device = await newIdentity();
    await holdBurns(w, machine.ridHex, 2);
    const abandoned = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(abandoned, device, 'client', machine.rid, ticket);
    expect(await abandoned.quiet(50)).toBe(true);
    abandoned.close();
    await abandoned.closed;
    await holdBurns(w, machine.ridHex, 0);
    const state = await roomState(w, machine.ridHex);
    expect(state.storage['pw']).toHaveLength(1);
    expect(state.sockets.filter((a) => a?.k)).toHaveLength(0);
    const retry = await connectClient(w, machine, device, ticket);
    expect(retry.socket.isClosed).toBe(false);
  });

  test('losing a concurrent ticket burn releases its reservation', async () => {
    const w = await start({ MAX_CLIENTS: '2' });
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    const secret = relayV2.systemRandom(32);
    await host.openWindow(secret);
    const ticket = await relayV2.admitTag(secret);
    await holdBurns(w, machine.ridHex, 2);
    const devices = [await newIdentity(), await newIdentity()];
    const sockets = await Promise.all(devices.map(() => Socket.open(clientUrl(w, machine.ridHex))));
    await Promise.all(
      sockets.map((socket, i) =>
        admit(socket, devices[i] as Identity, 'client', machine.rid, ticket),
      ),
    );
    const outcomes = await Promise.all(
      sockets.map((socket) =>
        Promise.race([socket.json().then((m) => m['t']), socket.closed.then(() => 'closed')]),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === 'admitted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'closed')).toHaveLength(1);
    const newcomer = await newIdentity();
    await host.enroll(newcomer.publicKey);
    const resumed = await connectClient(w, machine, newcomer);
    expect(resumed.socket.isClosed).toBe(false);
  });

  test('the same device reconnects at capacity and replaces its incumbent', async () => {
    const w = await start({ MAX_CLIENTS: '1' });
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    const device = await newIdentity();
    await host.enroll(device.publicKey);
    const incumbent = await connectClient(w, machine, device);
    const replacement = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(replacement, device, 'client', machine.rid);
    const outcome = await Promise.race([
      replacement.json().then((m) => m['t']),
      replacement.closed.then(() => 'closed'),
    ]);
    expect(outcome).toBe('admitted');
    expect(replacement.isClosed).toBe(false);
    expect(await incumbent.socket.closed).toEqual(REFUSED);
  });

  test('a capacity refusal leaves a pairing ticket available to retry', async () => {
    const w = await start({ MAX_CLIENTS: '1' });
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    const incumbentDevice = await newIdentity();
    await host.enroll(incumbentDevice.publicKey);
    const incumbent = await connectClient(w, machine, incumbentDevice);
    const secret = relayV2.systemRandom(32);
    await host.openWindow(secret);
    const ticket = await relayV2.admitTag(secret);
    const newcomer = await newIdentity();
    const refused = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(refused, newcomer, 'client', machine.rid, ticket);
    expect(await refused.closed).toEqual(REFUSED);
    expect((await roomState(w, machine.ridHex)).storage['pw']).toHaveLength(1);
    incumbent.socket.close();
    await incumbent.socket.closed;
    const retry = await connectClient(w, machine, newcomer, ticket);
    expect(retry.socket.isClosed).toBe(false);
  });

  test('a room admits only so many clients at once, and a departure makes room', async () => {
    const w = await start({ MAX_CLIENTS: '2' });
    const machine = await newMachine();
    const host = await FakeHost.start(w, machine);
    const devices = [await newIdentity(), await newIdentity(), await newIdentity()];
    for (const d of devices) await host.enroll(d.publicKey);
    const [a, b, c] = devices as [Identity, Identity, Identity];
    const first = await connectClient(w, machine, a);
    await connectClient(w, machine, b);
    const over = await Socket.open(clientUrl(w, machine.ridHex));
    await admit(over, c, 'client', machine.rid);
    expect(await over.closed).toEqual(REFUSED);
    first.socket.close();
    await first.socket.closed;
    const retry = await connectClient(w, machine, c);
    expect(retry.socket.isClosed).toBe(false);
  });
});

describe('the frame ceiling', () => {
  async function openPipe(w: TestWorker, machine: Machine) {
    const host = await FakeHost.start(w, machine);
    const device = await newIdentity();
    await host.enroll(device.publicKey);
    const { socket: client } = await connectClient(w, machine, device);
    const pipe = await host.openPipe(await host.nextConnection());
    await client.json();
    return { client, pipe };
  }

  const frame = (length: number): Uint8Array => new Uint8Array(length).fill(0xab);

  for (const sender of ['client', 'host'] as const) {
    test(`multibyte text is bounded by UTF-8 bytes from the ${sender}`, async () => {
      const w = await start();
      const { client, pipe } = await openPipe(w, await newMachine());
      const [source, peer] = sender === 'client' ? [client, pipe] : [pipe, client];
      const fits = `${'€'.repeat(170)}xx`;
      expect(new TextEncoder().encode(fits)).toHaveLength(MAX_CONTROL_TEXT);
      source.sendText(fits);
      expect(await peer.text()).toBe(fits);
      source.sendText(`${fits}x`);
      const outcome = await Promise.race([source.closed, peer.text().then(() => 'forwarded')]);
      expect(outcome).toEqual(REFUSED);
      expect(await peer.closed).toEqual(REFUSED);
      expect(await peer.quiet(50)).toBe(true);
    });
  }

  test('a binary message of MAX_FRAME bytes crosses in both directions, byte for byte', async () => {
    const w = await start();
    const { client, pipe } = await openPipe(w, await newMachine());
    const out = frame(MAX_FRAME);
    client.sendBinary(out);
    expect(await pipe.binary(8000)).toEqual(out);
    pipe.sendBinary(out);
    expect(await client.binary(8000)).toEqual(out);
  });

  test('one byte more is refused: the sender is closed and nothing reaches the peer', async () => {
    const w = await start();
    const { client, pipe } = await openPipe(w, await newMachine());
    client.sendBinary(frame(MAX_FRAME + 1));
    expect(await client.closed).toEqual(REFUSED);
    // the peer sees the end of the pipe, not the oversized frame
    expect((await pipe.closed).code).toBe(4400);
  });

  test('the same ceiling holds from the host side', async () => {
    const w = await start();
    const { client, pipe } = await openPipe(w, await newMachine());
    pipe.sendBinary(frame(MAX_FRAME + 1));
    expect(await pipe.closed).toEqual(REFUSED);
    expect((await client.closed).code).toBe(4400);
  });

  test('a text message of MAX_CONTROL_TEXT bytes crosses and one byte more is refused', async () => {
    const w = await start();
    const { client, pipe } = await openPipe(w, await newMachine());
    const fits = 'x'.repeat(MAX_CONTROL_TEXT);
    client.sendText(fits);
    expect(await pipe.text()).toBe(fits);
    client.sendText('x'.repeat(MAX_CONTROL_TEXT + 1));
    expect(await client.closed).toEqual(REFUSED);
  });
});
