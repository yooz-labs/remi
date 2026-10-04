/**
 * The client side of admission, the enrolled set and the pairing windows against
 * the REAL Worker and Durable Object (ADR 0034 sections 4, 14 and 19): a stranger
 * is refused, an enrolled device is admitted, revocation holds at the edge, a
 * ticket is single use even when two sockets present it at once, and only the
 * authenticated host changes any of it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import {
  FakeHost,
  type Machine,
  REFUSED,
  Socket,
  admit,
  admitText,
  advanceClock,
  bunKeepsCloseReason,
  clientUrl,
  connectClient,
  hex,
  holdBurns,
  newIdentity,
  newMachine,
  readNonce,
  roomState,
  runAlarm,
} from './endpoints.ts';
import { type TestWorker, startWorker } from './harness.ts';

const { admitTag, b64u, signAdmission, systemRandom } = relayV2;

let worker: TestWorker;
beforeEach(async () => {
  worker = await startWorker();
});
afterEach(() => worker.stop());

const refused = async (socket: Socket): Promise<void> => {
  expect(await socket.closed).toEqual(REFUSED);
};

/** A machine, its host and one enrolled device. */
async function enrolled() {
  const machine = await newMachine();
  const host = await FakeHost.start(worker, machine);
  const device = await newIdentity();
  await host.enroll(device.publicKey);
  return { machine, host, device };
}

describe('who may enter', () => {
  test('a device the host never enrolled is refused, and the host is not told', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const stranger = await newIdentity();
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(socket, stranger, 'client', machine.rid);
    await refused(socket);
    expect(await host.quiet()).toBe(true);
  });

  test('an enrolled device is admitted, learns the host is up, and the host is told', async () => {
    const { machine, host, device } = await enrolled();
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(socket, device, 'client', machine.rid);
    expect(await socket.text()).toBe('{"t":"admitted","up":true}');
    expect(await host.nextConnection()).toMatch(/^[0-9a-f]{32}$/);
  });

  test('an enrolled key with a signature by another key is refused', async () => {
    const { machine, device } = await enrolled();
    const impostor = await newIdentity();
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    const nonce = await readNonce(socket);
    socket.sendText(
      admitText(
        device.publicKey,
        await signAdmission(impostor.signer, 'client', machine.rid, nonce),
      ),
    );
    await refused(socket);
  });

  test('a signature for the host role is not a client proof', async () => {
    const { machine, device } = await enrolled();
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    const nonce = await readNonce(socket);
    socket.sendText(
      admitText(device.publicKey, await signAdmission(device.signer, 'host', machine.rid, nonce)),
    );
    await refused(socket);
  });

  test('the machine key proving the host role is not a client proof, even when that key is enrolled', async () => {
    // Enrolled, the machine key passes every check but the role: only the role binding of the
    // signature separates a host proof from a client proof.
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    await host.enroll(machine.publicKey);
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    const nonce = await readNonce(socket);
    socket.sendText(
      admitText(machine.publicKey, await signAdmission(machine.signer, 'host', machine.rid, nonce)),
    );
    await refused(socket);
    // the same key with a client-role proof is admitted, so the refusal above was the role
    const { socket: ok } = await connectClient(worker, machine, machine);
    expect(ok.isClosed).toBe(false);
  });

  test('a client proof made for another room is refused', async () => {
    const { machine, host, device } = await enrolled();
    const other = await newMachine();
    await host.enroll(device.publicKey);
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    const nonce = await readNonce(socket);
    socket.sendText(
      admitText(device.publicKey, await signAdmission(device.signer, 'client', other.rid, nonce)),
    );
    await refused(socket);
  });

  test('an admission replayed on another socket is refused', async () => {
    const { machine, device } = await enrolled();
    const first = await Socket.open(clientUrl(worker, machine.ridHex));
    const nonce = await readNonce(first);
    const proof = admitText(
      device.publicKey,
      await signAdmission(device.signer, 'client', machine.rid, nonce),
    );
    first.sendText(proof);
    expect((await first.json())['t']).toBe('admitted');
    const replay = await Socket.open(clientUrl(worker, machine.ridHex));
    await readNonce(replay);
    replay.sendText(proof);
    await refused(replay);
  });

  test('a client must wait for open: anything it says first closes it', async () => {
    const { machine, device } = await enrolled();
    const { socket } = await connectClient(worker, machine, device);
    socket.sendText('hello');
    await refused(socket);
  });

  test('one live connection per device key: a newer admission closes the older', async () => {
    const { machine, device } = await enrolled();
    const older = await connectClient(worker, machine, device);
    const newer = await connectClient(worker, machine, device);
    await refused(older.socket);
    expect(newer.socket.isClosed).toBe(false);
  });
});

describe('only the authenticated host changes the enrolled set', () => {
  test('a client that sends enroll before its pipe opens is closed and enrolls nobody', async () => {
    const { machine, device } = await enrolled();
    const stranger = await newIdentity();
    const { socket } = await connectClient(worker, machine, device);
    socket.sendText(JSON.stringify({ t: 'enroll', k: b64u(stranger.publicKey) }));
    await refused(socket);
    const state = await roomState(worker, machine.ridHex);
    expect(Object.keys(state.storage)).toEqual([`dev:${hex(device.publicKey)}`]);
  });

  test('inside an open pipe the same text is only forwarded, never obeyed', async () => {
    const { machine, host, device } = await enrolled();
    const stranger = await newIdentity();
    const { socket } = await connectClient(worker, machine, device);
    const pipe = await host.openPipe(await host.nextConnection());
    expect(await socket.json()).toEqual({ t: 'open' });
    const command = JSON.stringify({ t: 'enroll', k: b64u(stranger.publicKey) });
    socket.sendText(command);
    expect(await pipe.text()).toBe(command);
    // the Worker did not enroll it: the stranger is still refused
    const attempt = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(attempt, stranger, 'client', machine.rid);
    await refused(attempt);
    expect(Object.keys((await roomState(worker, machine.ridHex)).storage)).toEqual([
      `dev:${hex(device.publicKey)}`,
    ]);
  });

  test('a pipe socket cannot enroll either: its text goes to the client', async () => {
    const { machine, host, device } = await enrolled();
    const stranger = await newIdentity();
    const { socket } = await connectClient(worker, machine, device);
    const pipe = await host.openPipe(await host.nextConnection());
    await socket.json();
    const command = JSON.stringify({ t: 'enroll', k: b64u(stranger.publicKey) });
    pipe.sendText(command);
    expect(await socket.text()).toBe(command);
    expect(Object.keys((await roomState(worker, machine.ridHex)).storage)).toHaveLength(1);
  });

  test('the identity point cannot be enrolled', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    expect(await host.enroll(identityPoint)).toEqual({ t: 'ack', r: 'enroll', ok: false });
    expect(Object.keys((await roomState(worker, machine.ridHex)).storage)).toEqual([]);
  });

  test('enrolling the same key twice is one row, and the cap holds', async () => {
    await worker.stop();
    worker = await startWorker({ MAX_ENROLLED: '2' });
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const [a, b, c] = [await newIdentity(), await newIdentity(), await newIdentity()];
    expect((await host.enroll(a.publicKey))['ok']).toBe(true);
    expect((await host.enroll(a.publicKey))['ok']).toBe(true);
    expect((await host.enroll(b.publicKey))['ok']).toBe(true);
    expect((await host.enroll(c.publicKey))['ok']).toBe(false);
    expect(Object.keys((await roomState(worker, machine.ridHex)).storage)).toHaveLength(2);
  });
});

describe('revocation is enforced at the edge', () => {
  test('revoking an enrolled device closes its live session and refuses its next admission', async () => {
    const { machine, host, device } = await enrolled();
    const { socket } = await connectClient(worker, machine, device);
    const pipe = await host.openPipe(await host.nextConnection());
    await socket.json();
    expect(await host.revoke(device.publicKey)).toEqual({ t: 'ack', r: 'revoke', ok: true });
    await refused(socket);
    // the pipe ends with it
    expect((await pipe.closed).code).toBe(4400);
    const again = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(again, device, 'client', machine.rid);
    await refused(again);
    expect(Object.keys((await roomState(worker, machine.ridHex)).storage)).toEqual([]);
  });

  test('revoking closes a client that is still waiting for its pipe, and the host hears it go', async () => {
    const { machine, host, device } = await enrolled();
    const { socket } = await connectClient(worker, machine, device);
    const cid = await host.nextConnection();
    host.control.sendText(JSON.stringify({ t: 'revoke', k: b64u(device.publicKey) }));
    // the departure is announced as it happens, and the revocation is acknowledged
    expect(await host.notice()).toEqual({ t: 'gone', c: cid });
    expect(await host.nextAck()).toEqual({ t: 'ack', r: 'revoke', ok: true });
    await refused(socket);
  });

  test('revoking one device leaves another enrolled device connected', async () => {
    const { machine, host, device } = await enrolled();
    const other = await newIdentity();
    await host.enroll(other.publicKey);
    const kept = await connectClient(worker, machine, other);
    await host.nextConnection();
    await host.revoke(device.publicKey);
    expect(await kept.socket.quiet(200)).toBe(true);
    expect(kept.socket.isClosed).toBe(false);
  });
});

describe('pairing windows and the admission ticket', () => {
  async function pairing(ttl = 600) {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const secret = systemRandom(32);
    expect(await host.openWindow(secret, ttl)).toEqual({ t: 'ack', r: 'pairing', ok: true });
    return { machine, host, secret, ticket: await admitTag(secret) };
  }

  test('a device that is not enrolled enters with the ticket of an open window', async () => {
    const { machine, ticket } = await pairing();
    const device = await newIdentity();
    const { socket, hostUp } = await connectClient(worker, machine, device, ticket);
    expect(hostUp).toBe(true);
    expect(socket.isClosed).toBe(false);
  });

  test('a ticket is single use: a second device presenting it is refused', async () => {
    const { machine, ticket } = await pairing();
    await connectClient(worker, machine, await newIdentity(), ticket);
    const replay = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(replay, await newIdentity(), 'client', machine.rid, ticket);
    await refused(replay);
  });

  test('the same device replaying the ticket on a new socket is refused too', async () => {
    const { machine, ticket } = await pairing();
    const device = await newIdentity();
    await connectClient(worker, machine, device, ticket);
    const replay = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(replay, device, 'client', machine.rid, ticket);
    await refused(replay);
  });

  /** Open `count` sockets and send every admission, each by its own device, in the same tick. */
  async function presentTogether(machine: Machine, ticket: Uint8Array, count: number) {
    const sockets = await Promise.all(
      Array.from({ length: count }, () => Socket.open(clientUrl(worker, machine.ridHex))),
    );
    const proofs = await Promise.all(
      sockets.map(async (socket) => {
        const nonce = await readNonce(socket);
        const device = await newIdentity();
        return admitText(
          device.publicKey,
          await signAdmission(device.signer, 'client', machine.rid, nonce),
          ticket,
        );
      }),
    );
    sockets.forEach((socket, i) => socket.sendText(proofs[i] as string));
    return Promise.all(
      sockets.map((socket) =>
        Promise.race([
          socket.text().then((t) => (JSON.parse(t) as { t: string }).t),
          socket.closed.then(() => 'closed'),
        ]),
      ),
    );
  }

  test('sockets presenting one ticket at the same moment admit exactly one', async () => {
    const { machine, ticket } = await pairing();
    const outcomes = await presentTogether(machine, ticket, 4);
    expect(outcomes.filter((o) => o === 'admitted')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'closed')).toHaveLength(3);
  });

  test('admissions held until every one has matched the window still burn it once', async () => {
    // Locally the checks of different sockets may simply run one after another. Here the room
    // holds three admissions after they matched and passed every check, then lets them burn
    // together, so the single transaction is what decides.
    const { machine, ticket } = await pairing();
    await holdBurns(worker, machine.ridHex, 3);
    const outcomes = await presentTogether(machine, ticket, 3);
    expect(outcomes.filter((o) => o === 'admitted')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'closed')).toHaveLength(2);
  });

  test('a ticket from another secret is refused', async () => {
    const { machine } = await pairing();
    const wrong = await admitTag(systemRandom(32));
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(socket, await newIdentity(), 'client', machine.rid, wrong);
    await refused(socket);
  });

  test('a refused admission does not burn the window: a bad signature leaves it open', async () => {
    const { machine, ticket } = await pairing();
    const device = await newIdentity();
    const impostor = await newIdentity();
    const bad = await Socket.open(clientUrl(worker, machine.ridHex));
    const nonce = await readNonce(bad);
    bad.sendText(
      admitText(
        device.publicKey,
        await signAdmission(impostor.signer, 'client', machine.rid, nonce),
        ticket,
      ),
    );
    await refused(bad);
    const { socket } = await connectClient(worker, machine, device, ticket);
    expect(socket.isClosed).toBe(false);
  });

  test('the identity point holding the ticket is refused and the window is not burned', async () => {
    const { machine, ticket } = await pairing();
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const universal = new Uint8Array(64);
    universal[0] = 1;
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    await readNonce(socket);
    socket.sendText(admitText(identityPoint, universal, ticket));
    await refused(socket);
    const { socket: real } = await connectClient(worker, machine, await newIdentity(), ticket);
    expect(real.isClosed).toBe(false);
  });

  test('an expired window admits nobody', async () => {
    const { machine, ticket } = await pairing(1);
    await advanceClock(worker, machine.ridHex, 2_000);
    const socket = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(socket, await newIdentity(), 'client', machine.rid, ticket);
    await refused(socket);
  });

  test('a window outlives nothing it was not given: its lifetime is the ttl the host chose', async () => {
    const { machine, ticket } = await pairing(30);
    await advanceClock(worker, machine.ridHex, 20_000);
    const { socket } = await connectClient(worker, machine, await newIdentity(), ticket);
    expect(socket.isClosed).toBe(false);
  });

  test('at most eight windows are live at once, and an expired one frees its place', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    for (let i = 0; i < 8; i++) {
      expect((await host.openWindow(systemRandom(32), 60))['ok']).toBe(true);
    }
    expect(await host.openWindow(systemRandom(32), 60)).toEqual({
      t: 'ack',
      r: 'pairing',
      ok: false,
    });
    await advanceClock(worker, machine.ridHex, 61_000);
    expect((await host.openWindow(systemRandom(32), 60))['ok']).toBe(true);
  });

  test('a device that paired can come back without the ticket once the host enrolled it', async () => {
    const { machine, host, ticket } = await pairing();
    const device = await newIdentity();
    await connectClient(worker, machine, device, ticket);
    await host.nextConnection();
    // before the host enrolls it, the key alone is not enough
    const early = await Socket.open(clientUrl(worker, machine.ridHex));
    await admit(early, device, 'client', machine.rid);
    await refused(early);
    await host.enroll(device.publicKey);
    const again = await connectClient(worker, machine, device);
    expect(again.socket.isClosed).toBe(false);
  });
});

describe('a client with no host, and a host that comes and goes', () => {
  async function waiting(machine: Machine) {
    const device = await newIdentity();
    const first = await FakeHost.start(worker, machine);
    await first.enroll(device.publicKey);
    first.control.close();
    await first.control.closed;
    return device;
  }

  test('a client admitted while the host is away waits, and is told when the host registers again', async () => {
    const machine = await newMachine();
    const device = await waiting(machine);
    const { socket, hostUp } = await connectClient(worker, machine, device);
    expect(hostUp).toBe(false);
    const host = await FakeHost.start(worker, machine);
    expect(await socket.text()).toBe('{"t":"host","up":true}');
    const cid = await host.nextConnection();
    await host.openPipe(cid);
    expect(await socket.json()).toEqual({ t: 'open' });
  });

  test('a waiting client is closed when it has waited too long', async () => {
    const machine = await newMachine();
    const device = await waiting(machine);
    const { socket } = await connectClient(worker, machine, device);
    await advanceClock(worker, machine.ridHex, 599_000);
    await runAlarm(worker, machine.ridHex);
    expect(socket.isClosed).toBe(false);
    await advanceClock(worker, machine.ridHex, 2_000);
    await runAlarm(worker, machine.ridHex);
    await refused(socket);
  });

  test('when the host leaves, a client waiting for its pipe goes back to waiting and is told', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const device = await newIdentity();
    await host.enroll(device.publicKey);
    const { socket } = await connectClient(worker, machine, device);
    await host.nextConnection();
    host.control.close();
    await host.control.closed;
    expect(await socket.text()).toBe('{"t":"host","up":false}');
    const again = await FakeHost.start(worker, machine);
    expect(await socket.text()).toBe('{"t":"host","up":true}');
    expect(await again.nextConnection()).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a client whose pipe never opens is closed after the pipe timeout, and the host hears it go', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const device = await newIdentity();
    await host.enroll(device.publicKey);
    const { socket } = await connectClient(worker, machine, device);
    const cid = await host.nextConnection();
    await advanceClock(worker, machine.ridHex, 16_000);
    await runAlarm(worker, machine.ridHex);
    await refused(socket);
    expect(await host.notice()).toEqual({ t: 'gone', c: cid });
  });

  test('a new control socket is told about clients that were already pending', async () => {
    const machine = await newMachine();
    const first = await FakeHost.start(worker, machine);
    const device = await newIdentity();
    await first.enroll(device.publicKey);
    const { socket } = await connectClient(worker, machine, device);
    const cid = await first.nextConnection();
    const second = await FakeHost.start(worker, machine);
    expect(await second.nextConnection()).toBe(cid);
    expect(socket.isClosed).toBe(false);
  });
});

describe('when one end of a pipe closes', () => {
  async function openPipe() {
    const { machine, host, device } = await enrolled();
    const { socket } = await connectClient(worker, machine, device);
    const pipe = await host.openPipe(await host.nextConnection());
    await socket.json();
    return { socket, pipe };
  }

  test('the close code and reason the peer chose are passed on to the other end', async () => {
    const { socket, pipe } = await openPipe();
    socket.ws.close(4001, 'ended by the phone');
    const closed = await pipe.closed;
    expect(closed.code).toBe(4001);
    // Bun 1.3.11 sends no close reason, so there is none to pass on there (see the helper)
    if (await bunKeepsCloseReason()) expect(closed.reason).toBe('ended by the phone');
  });

  test('a socket that dies without a close frame ends the other with the generic close', async () => {
    const { socket, pipe } = await openPipe();
    (socket.ws as unknown as { terminate(): void }).terminate();
    expect(await pipe.closed).toEqual(REFUSED);
  });
});
