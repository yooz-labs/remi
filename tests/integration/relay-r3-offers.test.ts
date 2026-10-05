import { expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import {
  Mailbox,
  Socket,
  admit,
  clientUrl,
  newIdentity,
} from '../../packages/signaling/tests/e2e/endpoints.ts';
import { resumed } from './relay-r3-fixture.ts';
async function offer(running: Awaited<ReturnType<typeof resumed>>, owner: string, id: string) {
  const inbox = new Mailbox<Record<string, unknown>>();
  running.relay.open(owner, (text) => inbox.push(JSON.parse(text)));
  running.relay.message(owner, JSON.stringify({ t: 'pair', id }));
  const value = await inbox.next();
  expect(value['t']).toBe('offer');
  const token = await relayV2.decodePairingToken(
    String(value['token']),
    Math.floor(Date.now() / 1000),
  );
  return { inbox, value, token };
}
async function startDevice(
  running: Awaited<ReturnType<typeof resumed>>,
  token: relayV2.PairingToken,
) {
  const device = await newIdentity();
  const rid = await relayV2.ridOf(token.machinePublicKey);
  const socket = await Socket.open(clientUrl(running.worker, Buffer.from(rid).toString('hex')));
  await admit(socket, device, 'client', rid, await relayV2.admitTag(token.secret));
  await socket.json();
  await socket.json();
  const start = await relayV2.clientStart(
    {
      machinePublicKey: token.machinePublicKey,
      device: device.signer,
      mode: 'pair',
      pairingSecret: token.secret,
      random: relayV2.systemRandom,
    },
    Date.now(),
  );
  socket.sendText(start.hello);
  const auth = await start.onHelloAck(await socket.text(), Date.now());
  return { device, socket, auth };
}
test('eight local offers refuse capacity without eviction and local owner close erases each secret', async () => {
  const running = await resumed();
  try {
    const inbox = new Mailbox<Record<string, unknown>>();
    running.relay.open('owner', (text) => inbox.push(JSON.parse(text)));
    for (let i = 0; i < 8; i++) {
      running.relay.message('owner', JSON.stringify({ t: 'pair', id: String(i) }));
      expect((await inbox.next())['t']).toBe('offer');
    }
    const offers = (
      running.relay as unknown as { offers: Map<string, { policy: relayV2.PairingOffer }> }
    ).offers;
    const originals = [...offers.values()];
    expect(originals).toHaveLength(8);
    running.relay.message('owner', JSON.stringify({ t: 'pair', id: 'ninth' }));
    expect((await inbox.next())['error']).toBe('PAIRING_CAPACITY');
    expect([...offers.values()]).toEqual(originals);
    running.relay.close('owner');
    expect(offers.size).toBe(0);
    expect(originals.every((item) => item.policy.secret.every((byte) => byte === 0))).toBe(true);
  } finally {
    await running.cleanup();
  }
}, 10000);
test('onAuth offer index resolves immutable ordered hello snapshot after another owner disappears', async () => {
  const running = await resumed();
  let socket: Socket | undefined;
  try {
    await offer(running, 'first', 'first');
    const second = await offer(running, 'second', 'second');
    const started = await startDevice(running, second.token);
    socket = started.socket;
    running.relay.close('first');
    socket.sendText(started.auth.auth);
    const compare = await second.inbox.next();
    expect(compare['t']).toBe('compare');
    expect(compare['fingerprint']).toBe(started.auth.fingerprint);
    running.relay.message(
      'second',
      JSON.stringify({
        t: 'confirm',
        id: 'second',
        offerId: second.value['offerId'],
        connectionId: compare['connectionId'],
        fingerprint: compare['fingerprint'],
        accept: true,
      }),
    );
    const ready = await socket.text();
    const channel = await started.auth.onReady(ready, Date.now(), {
      emit: (frame) => started.socket.sendBinary(frame),
      close: (code) => started.socket.close(code),
    });
    expect(
      running.devices.isEnrolled(Buffer.from(started.device.publicKey).toString('base64')),
    ).toBe(true);
    await channel.transportClosed();
  } finally {
    socket?.close();
    await running.cleanup();
  }
}, 10000);
test('mismatched exact confirmation cannot grant, and owner disconnect cancels pending human approval', async () => {
  const running = await resumed();
  let socket: Socket | undefined;
  try {
    const window = await offer(running, 'owner', 'pending');
    const started = await startDevice(running, window.token);
    socket = started.socket;
    socket.sendText(started.auth.auth);
    const compare = await window.inbox.next();
    expect(compare['t']).toBe('compare');
    running.relay.message(
      'owner',
      JSON.stringify({
        t: 'confirm',
        id: 'pending',
        offerId: window.value['offerId'],
        connectionId: compare['connectionId'],
        fingerprint: '0000-0000-0000-0000',
        accept: true,
      }),
    );
    expect((await window.inbox.next())['t']).toBe('error');
    expect(await socket.quiet(80)).toBe(true);
    running.relay.close('owner');
    expect((await socket.closed).code).toBe(relayV2.FAILURE_CLOSE.code);
    expect(running.trust.loadAuthorizedKeys().keys).toHaveLength(1);
  } finally {
    socket?.close();
    await running.cleanup();
  }
}, 10000);
