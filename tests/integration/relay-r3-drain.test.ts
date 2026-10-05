import { expect, test } from 'bun:test';
import { createSessionListRequest, createSessionListResponse, serialize } from '@remi/shared';
import { resumed } from './relay-r3-fixture.ts';

test('transport close drains wrapper-queued authenticated BYE behind an application wait', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const running = await resumed({
    onSessionListRequest: (cid, id) => {
      release = () => running.relay.sendRaw(cid, createSessionListResponse([], id));
      entered();
    },
  });
  try {
    await running.channel.send(new TextEncoder().encode(serialize(createSessionListRequest())));
    await started;
    await running.channel.bye();
    running.socket.close();
    await running.socket.closed;
    await Bun.sleep(30); // The actual Worker pipe close occurs while its wrapper tail is held.
    release();
    await Bun.sleep(30);
    expect(running.logs.some((message) => message.includes('Relay delivery uncertain'))).toBe(
      false,
    );
  } finally {
    release?.();
    await running.cleanup();
  }
}, 10000);
