import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deserialize } from '@remi/shared';
import { resumed } from '../../../../tests/integration/relay-r3-fixture.ts';
import { encodeBrowserLinkFrame } from '../../../shared/src/browser-links.ts';
import {
  type BrowserFixture,
  type BrowserFixtureResources,
  browserFixture,
  until,
} from '../helpers/browser-link-service-fixture.ts';
const fixtures: BrowserFixture[] = [];
async function fixture(options: Parameters<typeof browserFixture>[0] = {}) {
  const f = await browserFixture(options);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

// Independent drain keeps the original failing cleanup witnesses from leaking their real resources.
async function drainObserved(owned: BrowserFixtureResources | undefined) {
  if (!owned) return;
  owned.producer.retire();
  owned.service.close();
  try {
    await owned.adapter.stop();
  } finally {
    for (const pty of owned.ptys) await pty.close();
    await Promise.all(owned.consumerExits);
    await owned.producer.close();
    owned.files.cleanup();
  }
}

test('fixture occupied-port startup rejection owns the actual consumer/producer/files unwind', async () => {
  const blocker = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('owned occupied port'),
  });
  const observed: { value?: BrowserFixtureResources } = {};
  const launcherAtExit: boolean[] = [];
  let browserPath = '';
  let startupFailure: unknown;
  try {
    await expect(
      browserFixture({
        port: blocker.port as number,
        observe(owned) {
          observed.value = owned;
          browserPath = owned.producer.browserPath;
          for (const exited of owned.consumerExits)
            void exited.then(() => launcherAtExit.push(existsSync(browserPath)));
        },
      }).catch((error) => {
        startupFailure = error;
        throw error;
      }),
    ).rejects.toThrow();
    expect(startupFailure).toHaveProperty('code', 'EADDRINUSE');
    const owned = observed.value;
    if (!owned) throw new Error('Owned construction did not reach the actual Adapter');
    expect(owned.ptys.every((pty) => pty.sessionState === 'exited')).toBe(true);
    expect(launcherAtExit).toEqual([true]);
    expect(existsSync(dirname(browserPath))).toBe(false);
    expect(existsSync(owned.files.directory)).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${blocker.port}/health`)).text()).toBe(
      'owned occupied port',
    );
  } finally {
    try {
      await drainObserved(observed.value);
    } finally {
      blocker.stop(true);
    }
  }
}, 15000);

test('fixture teardown aggregates a real record fault and still drains all later owned resources', async () => {
  const observed: { value?: BrowserFixtureResources } = {};
  const launcherAtExit: boolean[] = [];
  const f = await browserFixture({
    observe(owned) {
      observed.value = owned;
      const browserPath = owned.producer.browserPath;
      for (const exited of owned.consumerExits)
        void exited.then(() => launcherAtExit.push(existsSync(browserPath)));
    },
  });
  const file = join(f.files.home, 'local-endpoints', `${f.port}.json`);
  let original: string | undefined;
  try {
    original = readFileSync(file, 'utf8');
    const endpoint = JSON.parse(original) as { privatePort: number };
    const browserPath = f.producer.browserPath;
    writeFileSync(file, '{ corrupt owned fixture record');
    let failure: unknown;
    try {
      await f.close();
    } catch (error) {
      failure = error;
    }
    expect({
      aggregate: failure instanceof AggregateError,
      consumerEnded: f.pty.sessionState === 'exited',
      producerRemoved: !existsSync(dirname(browserPath)),
      filesRemoved: !existsSync(f.files.directory),
    }).toEqual({ aggregate: true, consumerEnded: true, producerRemoved: true, filesRemoved: true });
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      failure instanceof AggregateError &&
        failure.errors.some(
          (error) =>
            error instanceof Error &&
            error.message === 'Local daemon endpoint record operation failed',
        ),
    ).toBe(true);
    expect(f.pty.sessionState).toBe('exited');
    expect(launcherAtExit).toEqual([true]);
    expect(existsSync(dirname(browserPath))).toBe(false);
    expect(existsSync(f.files.directory)).toBe(false);
    await expect(
      fetch(`https://127.0.0.1:${f.port}/health`, { tls: { ca: f.files.ca } }),
    ).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${endpoint.privatePort}/health`)).rejects.toThrow();
    await f.close();
  } finally {
    try {
      if (original !== undefined && existsSync(file)) writeFileSync(file, original);
    } finally {
      await drainObserved(observed.value);
    }
  }
}, 15000);

test('actual listener closure stamps TLS/plain/private regardless of spoofed request headers', async () => {
  const tls = await fixture();
  const signed = await tls.client();
  expect(signed.connection()?.connectionListenerTransport).toBe('public-tls');
  expect((await signed.submit(signed.request(1))).outcome).toBe('selected');
  const privatePeer = await tls.client({ capability: true, private: true });
  expect(privatePeer.connection()?.connectionListenerTransport).toBe('private-control');
  expect(tls.service.isAvailable(privatePeer.id)).toBe(false);
  privatePeer.ws.send(encodeBrowserLinkFrame(privatePeer.request(1)));
  await until(() => privatePeer.ws.readyState === WebSocket.CLOSED, 'private capability refusal');
  expect(privatePeer.browser.length).toBe(0);
  const publicCap = await tls.client({ capability: true });
  expect(publicCap.connection()?.connectionListenerTransport).toBe('public-tls');
  expect(tls.service.isAvailable(publicCap.id)).toBe(false);
  publicCap.ws.send(encodeBrowserLinkFrame(publicCap.request(1)));
  await until(() => publicCap.ws.readyState === WebSocket.CLOSED, 'public capability refusal');
  const plain = await fixture({ tls: false });
  const forged = await plain.client({
    headers: {
      'x-forwarded-proto': 'https',
      forwarded: 'proto=https',
      'x-remi-transport': 'public-tls',
    },
  });
  expect(forged.connection()?.connectionListenerTransport).toBe('public-plain');
  const refused = await forged.submit(forged.request(1));
  expect(refused.outcome === 'refused' && refused.code).toBe('unavailable');
  expect(plain.service.isAvailable(forged.id)).toBe(false);
}, 15000);

test('no installed browser callback retains legacy parse rejection without ACK or dedupe', async () => {
  const f = await fixture({ installed: false });
  const peer = await f.client();
  const request = peer.request(1);
  peer.ws.send(encodeBrowserLinkFrame(request));
  await until(() => peer.received.some((m) => m.type === 'error'), 'legacy unknown browser result');
  expect(peer.received.some((m) => m.type === 'error' && m.code === 'INVALID_MESSAGE')).toBe(true);
  expect(peer.browser.length).toBe(0);
  peer.ws.send(encodeBrowserLinkFrame(request));
  await until(
    () =>
      peer.received.filter((m) => m.type === 'error' && m.code === 'INVALID_MESSAGE').length === 2,
    'legacy repeat parse rejection',
  );
  expect(
    peer.received.some((m) => m.type === 'ack' && JSON.stringify(m).includes(request.id)),
  ).toBe(false);
  expect(peer.ws.readyState).toBe(WebSocket.OPEN);
}, 15000);

test('installed original string/binary ingress handles escaped/reordered requests before ACK/dedupe', async () => {
  const f = await fixture();
  const peer = await f.client();
  const request = peer.request(1);
  const encoded = encodeBrowserLinkFrame(request);
  const escaped = encoded.replace(
    'browser_link_receiver_request',
    'browser\\u005flink_receiver_request',
  );
  peer.ws.send(new TextEncoder().encode(escaped));
  await until(
    () => peer.browser.some((m) => m.type === 'browser_link_receiver_result'),
    'binary escaped request',
  );
  const first = peer.browser.find((m) => m.type === 'browser_link_receiver_result');
  expect(first?.outcome).toBe('selected');
  const { type, ...fields } = request;
  peer.ws.send(JSON.stringify({ ...fields, type }));
  await until(
    () => peer.browser.filter((m) => m.type === 'browser_link_receiver_result').length === 2,
    'same request receipt',
  );
  expect(peer.browser.filter((m) => m.type === 'browser_link_receiver_result')[1]).toEqual(first);
  peer.ws.send(
    JSON.stringify({
      ...request,
      binding: {
        harnessSessionId: request.binding.harnessSessionId,
        harness: request.binding.harness,
      },
    }),
  );
  await until(
    () => peer.browser.filter((m) => m.type === 'browser_link_receiver_result').length === 3,
    'nested member order preserves receipt identity',
  );
  expect(peer.browser.filter((m) => m.type === 'browser_link_receiver_result')[2]).toEqual(first);
  expect(
    peer.received.some((m) => m.type === 'ack' && JSON.stringify(m).includes(request.id)),
  ).toBe(false);
}, 15000);

test('unidentified BOM/invalid UTF8 keeps generic parse rejection, with no browser ACK/effect', async () => {
  const f = await fixture();
  const peer = await f.client();
  const request = peer.request(1);
  for (const frame of [`\ufeff${encodeBrowserLinkFrame(request)}`, new Uint8Array([255, 254])]) {
    const previous = peer.received.filter((m) => m.type === 'error').length;
    peer.ws.send(frame);
    await until(
      () => peer.received.filter((m) => m.type === 'error').length > previous,
      'generic original parse rejection',
    );
  }
  expect(peer.ws.readyState).toBe(WebSocket.OPEN);
  expect(peer.browser.length).toBe(0);
  expect(
    peer.received.some((m) => m.type === 'ack' && JSON.stringify(m).includes(request.id)),
  ).toBe(false);
}, 15000);

test('actual enrolled relay refuses an unregistered child without displacing a direct TLS lease', async () => {
  const f = await fixture();
  const direct = await f.client();
  await direct.submit(direct.request(1));
  let invoked = 0;
  const remote = await resumed({
    onBrowserLinkReceiver(id, request) {
      invoked++;
      f.service.handleReceiver(id, request);
    },
  });
  try {
    await remote.channel.send(new TextEncoder().encode(encodeBrowserLinkFrame(direct.request(1))));
    const bytes = await remote.channel.receive(await remote.socket.binary());
    const response = bytes
      ? deserialize(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
      : null;
    expect(response?.type === 'error' && response.code).toBe('SESSION_NOT_FOUND');
    expect(response?.type === 'error' && response.details?.['sessionId']).toBe(
      direct.request(1).sessionId,
    );
    expect(remote.socket.isClosed).toBe(false);
    expect(invoked).toBe(0);
    expect(f.service.isAvailable(remote.cid)).toBe(false);
    expect(f.service.offer(f.context(), 'https://example.invalid/still-direct')).toBe(true);
    await until(
      () => direct.browser.some((m) => m.type === 'browser_link_candidate'),
      'original direct lease',
    );
  } finally {
    await remote.cleanup();
  }
}, 15000);

test('strict browser original-unit counterexamples close before generic ACK or effects', async () => {
  const f = await fixture();
  for (const variant of [
    'duplicate-first',
    'duplicate-last',
    'unknown',
    'lone-surrogate',
    'late-binary',
    'invalid-utf8',
    'host-direction',
  ]) {
    const peer = await f.client();
    const request = peer.request(1);
    const raw = encodeBrowserLinkFrame(request);
    let frame: string | Uint8Array = raw;
    if (variant === 'duplicate-first') frame = `{"type":"hello",${raw.slice(1)}`;
    if (variant === 'duplicate-last') frame = `${raw.slice(0, -1)},"t\\u0079pe":"hello"}`;
    if (variant === 'unknown') frame = `${raw.slice(0, -1)},"unknown":true}`;
    if (variant === 'lone-surrogate') frame = raw.replace(request.id, '\\ud800');
    if (variant === 'late-binary')
      frame = new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(65536), ...request }));
    if (variant === 'invalid-utf8')
      frame = new Uint8Array([...new TextEncoder().encode(raw.slice(0, -1)), 255, 125]);
    if (variant === 'host-direction')
      frame = encodeBrowserLinkFrame({
        type: 'browser_link_candidate',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: f.sessionId,
        binding: request.binding,
        leaseId: randomUUID(),
        url: 'https://example.invalid/host-only',
        lifetimeMs: 120000,
      });
    peer.ws.send(frame);
    await until(() => peer.ws.readyState === WebSocket.CLOSED, `strict ${variant}`);
    expect(peer.browser.length).toBe(0);
    expect(
      peer.received.some((m) => m.type === 'ack' && JSON.stringify(m).includes(request.id)),
    ).toBe(false);
    expect(f.service.offer(f.context(), 'https://example.invalid/no-lease')).toBe(false);
  }
}, 15000);

test('real peer pressure makes dedicated send best effort without another queued attempt', async () => {
  const f = await fixture();
  const peer = await f.client();
  await peer.submit(peer.request(1));
  const connection = peer.connection();
  if (!connection) throw new Error('Owned actual connection absent');
  const socket = Reflect.get(connection, 'ws') as Bun.ServerWebSocket<unknown>;
  const message = {
    type: 'browser_link_candidate' as const,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: f.sessionId,
    binding: f.context().binding,
    leaseId: randomUUID(),
    url: `https://example.invalid/${'x'.repeat(3900)}`,
    lifetimeMs: 120000 as const,
  };
  // The real peer application cannot drain during this bounded synchronous burst; no send mock.
  let pressured = false;
  for (let i = 0; i < 8192; i++) {
    if (!connection.sendBrowserLinkFrame(message)) {
      pressured = socket.getBufferedAmount() > 0;
      break;
    }
  }
  expect(pressured, 'Unverified real pressure: bounded burst did not produce a queued socket').toBe(
    true,
  );
  const before = socket.getBufferedAmount();
  expect(before).toBeGreaterThan(0);
  expect(connection.sendBrowserLinkFrame(message)).toBe(false);
  expect(socket.getBufferedAmount()).toBe(before);
  peer.ws.close();
}, 15000);
