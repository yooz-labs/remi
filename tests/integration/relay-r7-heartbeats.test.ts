/** Observe actual decrypted traffic at the real hub; no substitute heartbeat handler. */
import { expect, test } from 'bun:test';
import { type PongMessage, createHello, createPing, deserialize, relayV2 } from '@remi/shared';
import type { Connection } from '../../packages/daemon/src/server/connection.ts';
import { Mailbox } from '../../packages/signaling/tests/e2e/endpoints.ts';
import { RelayMachineChannel } from '../../packages/web/src/lib/relay-machine-channel.ts';
import { resumed } from './relay-r3-fixture.ts';

test('the shipping relay client answers an actual encrypted machine Ping with its exact pingId', async () => {
  const connections = new Mailbox<string>();
  const owned = await resumed({ onConnect: (id) => connections.push(id) });
  await connections.next(); // The fixture's original raw channel.
  const ready = new Mailbox<boolean>();
  const pings = new Mailbox<string>();
  const pongs = new Mailbox<PongMessage>();
  const signer = await relayV2.signerFromKey(
    owned.device.privateKey,
    new Uint8Array(Buffer.from(owned.device.publicKeyRaw, 'base64')),
  );
  const machine = await owned.trust.unlock();
  const client = RelayMachineChannel.resume(
    {
      relayUrl: owned.worker.wsUrl,
      machinePublicKey: Buffer.from(machine.publicKeyRaw, 'base64').toString('base64url'),
    },
    signer,
    () => true,
    {
      onPhase: (phase) => {
        if (phase === 'connected') ready.push(true);
      },
      onMessage: (message) => {
        if (message.type === 'ping') pings.push(message.id);
      },
    },
  );
  let connection: Connection | undefined;
  let handle: Connection['handleMessage'] | undefined;
  try {
    await client.start();
    expect(await ready.next()).toBe(true);
    expect(client.send(createHello('owned-r7-heartbeat', '2'))).toBe(true);
    const cid = await connections.next();
    const peers = (owned.relay as unknown as { peers: Map<string, { connection?: Connection }> })
      .peers;
    connection = peers.get(cid)?.connection;
    if (!connection) throw new Error('Real machine Connection was not installed');
    handle = connection.handleMessage;
    const actual = connection;
    const original = handle;
    // Observe after actual Worker forwarding and Channel authentication, then
    // execute the original Connection method with the exact same input.
    actual.handleMessage = (text) => {
      const message = deserialize(text);
      if (message?.type === 'pong') pongs.push(message);
      original.call(actual, text);
    };
    const ping = createPing();
    expect(owned.relay.sendRaw(cid, ping)).toBe(true);
    expect(await pings.next(500)).toBe(ping.id);
    const pong = await pongs.next(500);
    expect(pong.pingId).toBe(ping.id);
    expect(pong.id).not.toBe(ping.id);
    expect(client.connected).toBe(true);
  } finally {
    if (connection && handle) connection.handleMessage = handle;
    await client.close();
    await owned.cleanup();
  }
}, 15000);
