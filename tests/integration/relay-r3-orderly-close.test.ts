/**
 * The hub's orderly close (#1225), on an in-process `HubRelay` with the real local Worker and a
 * resumed device: after its BYE the hub leaves the pipe open, at most `ORDERLY_CLOSE_GRACE_MS`,
 * for the far side to close it.
 */
import { expect, test } from 'bun:test';
import { generateId, now, relayV2, serialize } from '@remi/shared';
import { ORDERLY_CLOSE_GRACE_MS } from '../../packages/daemon/src/remote/hub-relay.ts';
import { resumed } from './relay-r3-fixture.ts';

type Running = Awaited<ReturnType<typeof resumed>>;

/** The hub's next frame on this channel must be its authenticated BYE. */
async function hubBye(running: Running): Promise<void> {
  expect(await running.channel.receive(await running.socket.binary())).toBeNull();
}

async function until(done: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

test('stop() waits for a pipe that is still in its orderly grace', async () => {
  const running = await resumed();
  try {
    await running.channel.bye();
    await hubBye(running);
    // The client does not close, so the hub's pipe is in its grace when the hub stops.
    const started = Date.now();
    await running.relay.stop();
    expect(Date.now() - started).toBeGreaterThan(ORDERLY_CLOSE_GRACE_MS / 2);
    await until(
      () => running.logs.includes('Relay pipe closed by the hub (1000)'),
      'the hub to close the pipe itself',
    );
  } finally {
    await running.cleanup();
  }
}, 15000);

test('a client that closes after the BYE exchange ends the hub wait at once', async () => {
  const running = await resumed();
  try {
    await running.channel.bye();
    await hubBye(running);
    running.socket.close(1000);
    await until(
      () => running.logs.some((line) => line.startsWith('Relay pipe closed by the far side')),
      'the far-side close to reach the hub',
    );
    // The close that waited for the far side settles now, not at the end of the grace: stop()
    // awaits every close still running, so it returns at once.
    const started = Date.now();
    await running.relay.stop();
    expect(Date.now() - started).toBeLessThan(ORDERLY_CLOSE_GRACE_MS / 2);
  } finally {
    await running.cleanup();
  }
}, 15000);

test('a failure close reaches the client at once, with no grace', async () => {
  const running = await resumed();
  try {
    const started = Date.now();
    // Text after the channel is ready is refused with the failure close.
    running.socket.sendText('pong');
    const closed = await running.socket.closed;
    expect(Date.now() - started).toBeLessThan(ORDERLY_CLOSE_GRACE_MS / 2);
    expect(closed.code).toBe(relayV2.FAILURE_CLOSE.code);
  } finally {
    await running.cleanup();
  }
}, 15000);

test('after the hub ends the stream, a request from the peer is neither answered nor acted on', async () => {
  const running = await resumed();
  try {
    const fingerprint = running.devices.list()[0]?.fingerprint;
    if (!fingerprint) throw new Error('the resumed device is not enrolled');
    // The hub ends the stream itself: its stop is an orderly close of every pipe.
    const stopping = running.relay.stop();
    await hubBye(running);
    // The peer asks for something with an effect: revoking its own device.
    const revoke = {
      type: 'relay_device_revoke_request' as const,
      id: generateId(),
      timestamp: now(),
      fingerprint,
    };
    await running.channel.send(new TextEncoder().encode(serialize(revoke)));
    // A negative check, so a short settle: no answer comes back.
    expect(await running.socket.quiet(300)).toBe(true);
    // The client does not close: on Bun 1.3.11 its own close can reset the connection and lose
    // what it sent (#1225), which would let this pass for the wrong reason. The hub closes the
    // pipe after its grace instead.
    await running.channel.bye();
    await stopping;
    // And nothing was done: the device is still enrolled and authorized.
    expect(running.devices.isEnrolled(running.device.publicKeyRaw)).toBe(true);
    expect(
      running.trust.loadAuthorizedKeys().keys.some((key) => key.fingerprint === fingerprint),
    ).toBe(true);
  } finally {
    await running.cleanup();
  }
}, 15000);

test('a client that answers the hub BYE with its own leaves the hub a clean stream end', async () => {
  const running = await resumed();
  try {
    const stopping = running.relay.stop();
    await hubBye(running);
    // The web client answers the hub's BYE with its own and then closes. This client does not
    // close: on Bun 1.3.11 its own close can reset the connection and lose the BYE it just sent
    // (#1225), which is the test client's runtime, not the hub's behavior. The hub closes the
    // pipe after its grace instead, having read the reply.
    await running.channel.bye();
    await stopping;
    await until(
      () => running.logs.some((line) => line.startsWith('Relay pipe closed by the hub (1000)')),
      'the hub to close the pipe after its grace',
    );
    // The verdict is logged only when the stream did not end cleanly; a negative check, so a
    // short settle after the close the verdict follows.
    await Bun.sleep(200);
    expect(running.logs.filter((line) => line.startsWith('Relay delivery uncertain'))).toEqual([]);
  } finally {
    await running.cleanup();
  }
}, 15000);
