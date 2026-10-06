/** Actual client wrapper -> real Worker -> source hub; no fake gateway or crypto. */
import { expect, test } from 'bun:test';
import {
  type ProtocolMessage,
  createHello,
  createUserInput,
  generateId,
  now,
  relayV2,
} from '@remi/shared';
import { Mailbox } from '../../signaling/tests/e2e/endpoints';
import { RelayMachineChannel } from '../src/lib/relay-machine-channel';
import { ownedRelayOffer, registerOwnedRelayFixtureCleanup } from './helpers/relay-hub';
registerOwnedRelayFixtureCleanup();

async function nextType(inbox: Mailbox<ProtocolMessage>, type: ProtocolMessage['type']) {
  for (let i = 0; i < 64; i++) {
    const message = await inbox.next();
    expect(message.type).not.toBe('raw_pty_output');
    if (message.type === type) return message;
  }
  throw new Error('expected semantic response');
}

test('client awaits exact local confirmation, uses one semantic channel and resumes enrolled identity', async () => {
  const local = await ownedRelayOffer();
  const { signer } = await relayV2.generateIdentity();
  const ready = new Mailbox<boolean>();
  const messages = new Mailbox<ProtocolMessage>();
  const failures: Error[] = [];
  const endings = new Mailbox<relayV2.StreamEnd>();
  let current = true;
  const client = await RelayMachineChannel.pair(
    String(local.offer['token']),
    signer,
    () => current,
    {
      onPhase: phase => { if (phase === 'connected') ready.push(true); },
      onMessage: (message) => messages.push(message),
      onError: (error) => failures.push(error),
      onClose: (end) => endings.push(end),
    },
  );
  await client.start();
  try {
    const compare = await local.inbox.next();
    expect(compare['t']).toBe('compare');
    expect(client.connected).toBe(false);
    expect(await ready.quiet(25)).toBe(true);
    local.ws.send(
      JSON.stringify({
        t: 'confirm',
        id: 'owned-r4',
        offerId: local.offer['offerId'],
        connectionId: compare['connectionId'],
        fingerprint: compare['fingerprint'],
        accept: true,
      }),
    );
    expect(await ready.next()).toBe(true);
    expect(client.send(createHello('owned-r4', '2'))).toBe(true);
    const hello = await nextType(messages, 'hello_ack');
    expect(hello.type === 'hello_ack' && hello.sessionId).toBeNull();
    const id = generateId();
    expect(client.send({ type: 'relay_devices_request', id, timestamp: now() })).toBe(true);
    const devices = await nextType(messages, 'relay_devices_response');
    expect(devices.type === 'relay_devices_response' && devices.requestId).toBe(id);
    expect(devices.type === 'relay_devices_response' && devices.devices).toHaveLength(1);
    expect(client.send(createUserInput('missing-session', 'x'.repeat(relayV2.MAX_PLAINTEXT)))).toBe(
      false,
    );
    expect(client.connected).toBe(true);
    for (let i = 0; i < relayV2.MAX_PENDING_SENDS; i++) {
      expect(
        client.send({ type: 'relay_devices_request', id: generateId(), timestamp: now() }),
      ).toBe(true);
    }
    expect(client.send({ type: 'relay_devices_request', id: generateId(), timestamp: now() })).toBe(
      false,
    );
    for (let i = 0; i < relayV2.MAX_PENDING_SENDS; i++)
      await nextType(messages, 'relay_devices_response');
    expect(client.connected).toBe(true);
    await client.close();
    expect(await endings.next()).toBe('clean');
    const resumed = RelayMachineChannel.resume(client.pin, signer, () => current, {
      onPhase: phase => { if (phase === 'connected') ready.push(true); },
      onMessage: (message) => messages.push(message),
      onError: (error) => failures.push(error),
    });
    try {
      await resumed.start();
      expect(await ready.next()).toBe(true);
      expect(resumed.send(createHello('owned-r4', '2'))).toBe(true);
      expect((await nextType(messages, 'hello_ack')).type).toBe('hello_ack');
      current = false;
      expect(resumed.send(createHello('owned-r4', '2'))).toBe(false);
    } finally {
      await resumed.close();
    }
    expect(failures).toHaveLength(0);
  } finally {
    current = false;
    await client.close();
  }
}, 20000);

test('real relay transport waits for durable READY continuation before connecting', async () => {
  const { RelayTransport } = await import('../src/lib/relay-transport');
  const local = await ownedRelayOffer();
  const { signer } = await relayV2.generateIdentity();
  const entered = new Mailbox<boolean>();
  const connected = new Mailbox<boolean>();
  const statuses: string[] = [];
  let finish: (() => void) | undefined;
  const persistence = new Promise<void>(resolve => { finish = resolve; });
  let current = true;
  const client = new RelayTransport(async events => RelayMachineChannel.pair(
    String(local.offer['token']), signer, () => current, events,
  ), () => current, false, {
    onReady: async () => { entered.push(true); await persistence; },
    onStatus: status => { statuses.push(status); if (status === 'connected') connected.push(true); },
  });
  try {
    await client.connect();
    const compare = await local.inbox.next();
    expect(compare['t']).toBe('compare');
    local.ws.send(JSON.stringify({ t: 'confirm', id: local.offer['id'], offerId: local.offer['offerId'],
      connectionId: compare['connectionId'], fingerprint: compare['fingerprint'], accept: true }));
    expect(await entered.next()).toBe(true);
    expect(statuses).not.toContain('connected');
    expect(client.isConnected).toBe(false);
    finish?.();
    expect(await connected.next()).toBe(true);
    expect(client.isConnected).toBe(true);
  } finally {
    finish?.(); current = false; client.disconnect();
  }
}, 20000);
