/** Delay only the actual channel close; all gateways, channels and handshakes are real. */
import { expect, test } from 'bun:test';
import { type ProtocolMessage, createHello, generateId } from '@remi/shared';
import { resumedHub } from '../../daemon/tests/remote/hub-relay-fixture';
import { Mailbox } from '../../signaling/tests/e2e/endpoints';
import { RelayMachineChannel } from '../src/lib/relay-machine-channel';
import { RelayTransport } from '../src/lib/relay-transport';

test('two explicit recoveries while the actual prior close waits create one replacement', async () => {
  const hub = await resumedHub();
  const channels: RelayMachineChannel[] = [];
  const statuses: string[] = [];
  const connected = new Mailbox<boolean>();
  const messages = new Mailbox<ProtocolMessage>();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const client = new RelayTransport(
    async (events) => {
      const channel = RelayMachineChannel.resume(hub.pin, hub.signer, () => true, events);
      channels.push(channel);
      return channel;
    },
    () => true,
    false,
    {
      onStatus: (status) => {
        statuses.push(status);
        if (status === 'connected') connected.push(true);
      },
      onMessage: (message) => messages.push(message),
    },
    true,
  );
  try {
    await client.connect();
    expect(await connected.next()).toBe(true);
    expect(channels).toHaveLength(1);
    const prior = channels[0];
    if (!prior) throw new Error('Missing actual prior relay channel');
    const originalClose = prior.close.bind(prior);
    // Hold, then execute the real close. No response, READY or close result is fabricated.
    prior.close = async () => {
      entered.resolve();
      await release.promise;
      await originalClose();
    };
    const generation = client.structuredChatGeneration;
    expect(generation).not.toBeNull();
    client.forceReconnect();
    await entered.promise;
    client.forceReconnect();
    // Let a second asynchronous close continuation run before observing creation.
    await Promise.resolve();
    expect(client.structuredChatGeneration).toBeNull();
    expect(channels).toHaveLength(1);
    expect(statuses.at(-1)).toBe('reconnecting');
    release.resolve();
    expect(await connected.next()).toBe(true);
    expect(channels).toHaveLength(2);
    expect(client.structuredChatGeneration).not.toBe(generation);
    const hello = createHello(generateId(), 'owned recovered relay');
    expect(client.send(hello)).toBe(true);
    expect(await messages.next()).toMatchObject({ type: 'ack', ack: { messageId: hello.id } });
  } finally {
    release.resolve();
    client.disconnect();
    await Promise.allSettled(channels.map((channel) => channel.close()));
    await hub.cleanup();
  }
}, 15000);
