/**
 * The host and pipe side of admission against the REAL Worker and Durable Object
 * (ADR 0034 section 4 and section 14): the nonce, the host proof, every refusal,
 * the deadline, the edge ping and the routes. A refusal is always the same close
 * (4400, `closed`), so no test below can tell which check refused, only that one did.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import {
  FakeHost,
  REFUSED,
  Socket,
  admit,
  admitText,
  advanceClock,
  connectClient,
  hex,
  hostUrl,
  newIdentity,
  newMachine,
  readNonce,
  roomSeen,
  roomState,
  runAlarm,
  upgradeStatus,
} from './endpoints.ts';
import { type TestWorker, startWorker } from './harness.ts';

const { signAdmission } = relayV2;

let worker: TestWorker;
beforeEach(async () => {
  worker = await startWorker();
});
afterEach(() => worker.stop());

/** An admission that must be refused: the socket closes with the one generic close. */
async function refused(socket: Socket): Promise<void> {
  expect(await socket.closed).toEqual(REFUSED);
}

describe('the nonce', () => {
  test('every socket gets its own fresh 32-byte nonce as its first message', async () => {
    const machine = await newMachine();
    const nonces = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const socket = await Socket.open(hostUrl(worker, machine.ridHex));
      const nonce = await readNonce(socket);
      expect(nonce).toHaveLength(32);
      nonces.add(hex(nonce));
    }
    expect(nonces.size).toBe(4);
  });

  test('the first message is exactly the nonce notice and nothing else', async () => {
    const machine = await newMachine();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    const first = await socket.text();
    expect(first).toMatch(/^\{"t":"nonce","n":"[A-Za-z0-9_-]{43}"\}$/);
    expect(await socket.quiet()).toBe(true);
  });

  test('an admission replayed on another socket is refused, because the nonce differs', async () => {
    const machine = await newMachine();
    const first = await Socket.open(hostUrl(worker, machine.ridHex));
    const nonce = await readNonce(first);
    const proof = admitText(
      machine.publicKey,
      await signAdmission(machine.signer, 'host', machine.rid, nonce),
    );
    first.sendText(proof);
    expect((await first.json())['t']).toBe('admitted');

    const replay = await Socket.open(hostUrl(worker, machine.ridHex));
    await readNonce(replay);
    replay.sendText(proof);
    await refused(replay);
    // the replayed proof did not displace the real host
    expect(first.isClosed).toBe(false);
  });
});

describe('who may take the host seat', () => {
  test('a stranger with a key of its own is refused: its key does not hash to the room id', async () => {
    const machine = await newMachine();
    const stranger = await newIdentity();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    await admit(socket, stranger, 'host', machine.rid);
    await refused(socket);
  });

  test('a stranger presenting the machine public key with its own signature is refused', async () => {
    const machine = await newMachine();
    const stranger = await newIdentity();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    const nonce = await readNonce(socket);
    socket.sendText(
      admitText(
        machine.publicKey,
        await signAdmission(stranger.signer, 'host', machine.rid, nonce),
      ),
    );
    await refused(socket);
  });

  test('a displaced host stays seated: a stranger cannot replace the real control socket', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const stranger = await newIdentity();
    const attempt = await Socket.open(hostUrl(worker, machine.ridHex));
    await admit(attempt, stranger, 'host', machine.rid);
    await refused(attempt);

    // the real host is still the one the Worker talks to
    const device = await newIdentity();
    await host.enroll(device.publicKey);
    await connectClient(worker, machine, device);
    expect(await host.nextConnection()).toMatch(/^[0-9a-f]{32}$/);
  });

  test('the machine key holder replaces its own old control socket (a reconnect)', async () => {
    const machine = await newMachine();
    const old = await FakeHost.start(worker, machine);
    const fresh = await FakeHost.start(worker, machine);
    expect(await old.control.closed).toEqual(REFUSED);
    expect(fresh.control.isClosed).toBe(false);
    const device = await newIdentity();
    expect(await fresh.enroll(device.publicKey)).toEqual({ t: 'ack', r: 'enroll', ok: true });
  });

  test('a signature for the client role is not a host proof', async () => {
    const machine = await newMachine();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    const nonce = await readNonce(socket);
    socket.sendText(
      admitText(
        machine.publicKey,
        await signAdmission(machine.signer, 'client', machine.rid, nonce),
      ),
    );
    await refused(socket);
  });

  test('a host proof made for another room is refused here', async () => {
    const machine = await newMachine();
    const other = await newMachine();
    // `machine` signs honestly, but for the other room's id: the room id is part of what is signed
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    const nonce = await readNonce(socket);
    socket.sendText(
      admitText(machine.publicKey, await signAdmission(machine.signer, 'host', other.rid, nonce)),
    );
    await refused(socket);
  });

  test('a signature over another nonce is refused', async () => {
    const machine = await newMachine();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    await readNonce(socket);
    const wrong = new Uint8Array(32).fill(7);
    socket.sendText(
      admitText(machine.publicKey, await signAdmission(machine.signer, 'host', machine.rid, wrong)),
    );
    await refused(socket);
  });

  test('the identity point (a small-order key) cannot hold a room, though its hash is the room id', async () => {
    // RFC 8032 verification accepts the all-identity signature under the identity key for ANY
    // message, so without the small-order refusal this proof would pass every other check.
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const universal = new Uint8Array(64);
    universal[0] = 1;
    const rid = await relayV2.ridOf(identityPoint);
    const socket = await Socket.open(hostUrl(worker, hex(rid)));
    await readNonce(socket);
    socket.sendText(admitText(identityPoint, universal));
    await refused(socket);
  });
});

describe('what a socket may say before it is admitted', () => {
  test.each([
    ['a binary frame', () => new Uint8Array([1, 2, 3])],
    ['a legacy register message', () => '{"type":"register"}'],
    ['an offer', () => '{"type":"offer","sdp":"v=0"}'],
    ['a relay message', () => '{"type":"relay","payload":"x"}'],
    ['text that is not JSON', () => 'hello'],
    ['an admission with an unknown key', () => '{"t":"admit","k":"x","s":"y","extra":1}'],
    ['an admission over the size limit', () => `{"t":"admit","pad":"${'x'.repeat(600)}"}`],
    ['the host commands', () => '{"t":"enroll","k":"AAAA"}'],
  ])('%s closes the socket', async (_name, make) => {
    const machine = await newMachine();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    await readNonce(socket);
    const message = make();
    if (typeof message === 'string') socket.sendText(message);
    else socket.sendBinary(message);
    await refused(socket);
  });

  test('a second admission message closes the admitted host', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    host.control.sendText(admitText(machine.publicKey, new Uint8Array(64).fill(1)));
    await refused(host.control);
  });

  test('a stranger who never speaks is closed when the admission deadline passes', async () => {
    const machine = await newMachine();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    await readNonce(socket);
    expect(socket.isClosed).toBe(false);
    await advanceClock(worker, machine.ridHex, 11_000);
    await runAlarm(worker, machine.ridHex);
    await refused(socket);
  });

  test('the runtime alarm closes an idle stranger without the clock or alarm seam', async () => {
    await worker.stop();
    worker = await startWorker({ ADMIT_TIMEOUT_MS: '400' });
    const machine = await newMachine();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    await readNonce(socket);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([
        socket.closed,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still open'), 4000);
        }),
      ]);
      expect(closed).toEqual(REFUSED);
    } finally {
      clearTimeout(timer);
    }
  });

  test('a socket still inside its deadline is not closed by the alarm', async () => {
    const machine = await newMachine();
    const socket = await Socket.open(hostUrl(worker, machine.ridHex));
    await readNonce(socket);
    await advanceClock(worker, machine.ridHex, 5_000);
    await runAlarm(worker, machine.ridHex);
    expect(socket.isClosed).toBe(false);
    const state = await roomState(worker, machine.ridHex);
    expect(state.sockets).toHaveLength(1);
    expect(state.alarm).not.toBeNull();
  });
});

describe('a socket left behind by the previous Worker', () => {
  test('is closed on its first message: its attachment is not one this room understands', async () => {
    const machine = await newMachine();
    const socket = await Socket.open(`${worker.wsUrl}/__room/${machine.ridHex}/__legacy`);
    socket.sendText('{"type":"register"}');
    await refused(socket);
  });
});

describe('the edge ping', () => {
  test('the literal text ping is answered with pong without waking the object', async () => {
    const machine = await newMachine();
    const host = await FakeHost.start(worker, machine);
    const before = (await roomSeen(worker, machine.ridHex)).length;
    expect(await host.ping()).toBe('pong');
    const seen = await roomSeen(worker, machine.ridHex);
    // the object saw the admission and nothing for the ping
    expect(seen).toHaveLength(before);
    expect(host.control.isClosed).toBe(false);
  });
});

describe('routes', () => {
  test('only the three v2 routes upgrade', async () => {
    const machine = await newMachine();
    const rid = machine.ridHex;
    const base = worker.wsUrl;
    expect(await upgradeStatus(`${base}/v3/host/${rid}`)).toBe(404);
    expect(await upgradeStatus(`${base}/v1/host/${rid}`)).toBe(404);
    expect(await upgradeStatus(`${base}/v2/host/${rid.toUpperCase()}`)).toBe(404);
    expect(await upgradeStatus(`${base}/v2/host/${rid.slice(2)}`)).toBe(404);
    expect(await upgradeStatus(`${base}/v2/pipe/${rid}`)).toBe(404);
    expect(await upgradeStatus(`${base}/connect/ABCD-2345`)).toBe(404);
  });

  test('a route without a WebSocket upgrade is refused', async () => {
    const machine = await newMachine();
    const res = await fetch(`${worker.url}/v2/host/${machine.ridHex}`, {
      keepalive: false,
    } as RequestInit);
    expect(res.status).toBe(426);
  });

  test('a pipe for a connection nobody is waiting on is refused after the host proof', async () => {
    const machine = await newMachine();
    await FakeHost.start(worker, machine);
    const socket = await Socket.open(
      `${worker.wsUrl}/v2/pipe/${machine.ridHex}/${'ab'.repeat(16)}`,
    );
    await admit(socket, machine, 'host', machine.rid);
    await refused(socket);
  });
});
