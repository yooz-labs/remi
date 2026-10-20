/** Actual encrypted Worker/HubRelay/client boundaries; no model, fake gateway or crypto. */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ProtocolMessage, relayV2 } from '@remi/shared';
import type { ChatSubmitRequest, ChatSubmitResult } from '@remi/shared/structured-chat.ts';
import { resumedHub } from '../../daemon/tests/remote/hub-relay-fixture';
import { Mailbox } from '../../signaling/tests/e2e/endpoints';
import { RelayMachineChannel } from '../src/lib/relay-machine-channel';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
const request = (): ChatSubmitRequest => ({
  type: 'chat_submit_request',
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  sessionId: randomUUID(),
  seq: 1,
  binding: { harness: 'codex', harnessSessionId: randomUUID() },
  content: 'REMI_RELAY_FRAME_CONTROL',
});
const result = (): ChatSubmitResult => ({
  type: 'chat_submit_result',
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  sessionId: randomUUID(),
  requestId: randomUUID(),
  seq: 1,
  outcome: 'refused',
  code: 'unavailable',
});
const utf8 = (text: string) => new TextEncoder().encode(text);

async function clientWithOwnedHost() {
  const hub = await resumedHub();
  cleanup.push(hub.cleanup);
  // Wire fault injection uses the actual READY host Channel. It replaces no
  // gateway, crypto, parser or authentication logic and grants no new authority.
  const peers = (
    hub.relay as unknown as {
      peers: Map<string, { channel?: relayV2.Channel }>;
    }
  ).peers;
  const previous = new Set(peers.keys());
  const ready = new Mailbox<boolean>();
  const messages = new Mailbox<ProtocolMessage>();
  const endings = new Mailbox<relayV2.StreamEnd>();
  const client = RelayMachineChannel.resume(hub.pin, hub.signer, () => true, {
    onPhase: (phase) => {
      if (phase === 'connected') ready.push(true);
    },
    onMessage: (message) => messages.push(message),
    onClose: (end) => endings.push(end),
  });
  cleanup.push(() => client.close());
  await client.start();
  expect(await ready.next()).toBe(true);
  const host = [...peers].find(([id]) => !previous.has(id))?.[1].channel;
  if (!host) throw new Error('Actual READY host channel missing');
  return { hub, client, host, messages, endings };
}

test('canonical structured result crosses the actual encrypted client boundary', async () => {
  const { host, messages, client } = await clientWithOwnedHost();
  const value = result();
  await host.send(utf8(JSON.stringify(value)));
  expect(await messages.next()).toEqual(value);
  expect(client.connected).toBe(true);
}, 15000);

for (const [name, bytes] of [
  ['leading BOM', () => utf8(`\uFEFF${JSON.stringify(result())}`)],
  ['reversed request direction', () => utf8(JSON.stringify(request()))],
  [
    'duplicate result member',
    () => utf8(JSON.stringify(result()).replace('"seq":1', '"seq":1,"seq":1')),
  ],
  [
    'extra result member',
    () => utf8(JSON.stringify({ ...result(), sandbox: 'danger-full-access' })),
  ],
  ['invalid UTF-8', () => new Uint8Array([...utf8(JSON.stringify(result())), 0xff])],
] as const) {
  test(`client closes ${name} before an application callback`, async () => {
    const { host, messages, endings, client } = await clientWithOwnedHost();
    await host.send(bytes());
    expect(await endings.next(2000)).not.toBe('clean');
    expect(client.connected).toBe(false);
    expect(messages.drain()).toEqual([]);
  }, 15000);
}

test('existing hub strict codec rejects duplicate original members before routing', async () => {
  const hub = await resumedHub();
  cleanup.push(hub.cleanup);
  await hub.sendApplication(utf8(JSON.stringify(request()).replace('"seq":1', '"seq":1,"seq":1')));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([
      hub.closed,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
      }),
    ]);
    expect(closed).not.toBeNull();
  } finally {
    clearTimeout(timer);
  }
}, 15000);

test('existing hub routes a canonical request without claiming submission or ACK', async () => {
  const hub = await resumedHub();
  cleanup.push(hub.cleanup);
  expect(await hub.exchange(request())).toMatchObject({ type: 'error', code: 'SESSION_NOT_FOUND' });
}, 15000);
