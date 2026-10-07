/**
 * The hub's orderly close (#1225), on an in-process `HubRelay` with the real local Worker and a
 * resumed device: after its BYE the hub leaves the pipe open, at most `ORDERLY_CLOSE_GRACE_MS`,
 * for the far side to close it.
 */
import { expect, test } from 'bun:test';
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
