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

test('close drains real crypto wrapper tail and never applies queued post-close input', async () => {
  let calls = 0;
  const running = await resumed({
    onSessionListRequest: () => {
      calls++;
    },
  });
  const peers = (
    running.relay as unknown as {
      peers: Map<string, { channel: import('@remi/shared').relayV2.Channel }>;
    }
  ).peers;
  const peer = [...peers.values()][0];
  if (!peer) throw new Error('ready peer missing');
  const receive = peer.channel.receive.bind(peer.channel);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let first = true;
  // Delay the adapter's call into the real crypto, never replace its result or checks.
  peer.channel.receive = async (frame) => {
    if (first) {
      first = false;
      enter();
      await gate;
    }
    return receive(frame);
  };
  try {
    await running.channel.send(new TextEncoder().encode(serialize(createSessionListRequest())));
    await entered;
    await running.channel.bye();
    running.socket.close();
    await running.socket.closed;
    await Bun.sleep(30);
    release();
    await Bun.sleep(30);
    expect(calls).toBe(0);
    expect(running.logs.some((message) => message.includes('Relay delivery uncertain'))).toBe(
      false,
    );
  } finally {
    release();
    await running.cleanup();
  }
}, 10000);
