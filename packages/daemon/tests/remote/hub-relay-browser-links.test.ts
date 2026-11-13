/** Real Worker/HubRelay/ChildProxy -> actual browser service/producer; no web acceptance claim. */
import { expect, test } from 'bun:test';
import { createHello, createIdentity, unlockIdentity } from '@remi/shared';
import { relayBrowserFixture, until } from '../helpers/browser-link-service-fixture.ts';

test('enrolled encrypted relay receiver selects actual child producer and explicitly releases', async () => {
  const f = await relayBrowserFixture();
  try {
    const { send, next, machineHello } = await f.connect();
    expect(machineHello.acknowledgment).toMatchObject({
      type: 'ack',
      ack: { messageId: machineHello.requestId, state: 'delivered' },
    });
    await send(createHello('owned-device', '2.0.0', { resumeSessionId: f.sessionId }));
    const hello = await next();
    expect(hello.type).toBe('hello_ack');
    const request = {
      type: 'browser_link_receiver_request' as const,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      binding: f.context().binding,
      seq: 1,
      action: 'select' as const,
    };
    await send(request);
    const selected = await next();
    expect(selected.type).toBe('browser_link_receiver_result');
    if (selected.type !== 'browser_link_receiver_result')
      throw Error('Missing actual receiver result');
    expect(selected.outcome).toBe('selected');
    expect(hello.type === 'hello_ack' && hello.capabilities).toContain('browser_links');
    const url = 'https://example.test/t4-browser?literal=%26owned';
    const producer = Bun.spawn([f.producer.browserPath, url], {
      env: f.files.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await producer.exited).toBe(0);
    expect(await new Response(producer.stdout).text()).toBe('');
    expect(await new Response(producer.stderr).text()).toBe('');
    const candidate = await next();
    expect(candidate.type).toBe('browser_link_candidate');
    if (candidate.type !== 'browser_link_candidate')
      throw Error('Missing actual producer candidate');
    expect(candidate.url).toBe(url);
    expect(candidate.leaseId).toBe(selected.outcome === 'selected' ? selected.leaseId : 'missing');
    await send({ ...request, id: crypto.randomUUID(), seq: 2, action: 'release' });
    const released = await next();
    expect(released.type === 'browser_link_receiver_result' && released.outcome).toBe('released');
    expect(f.logs.join('\n')).not.toContain(url);
  } finally {
    await f.close();
  }
}, 30000);

test('two enrolled relay devices have exclusive receiver ownership, then consumed child loss retires its channel', async () => {
  const other = await unlockIdentity(await createIdentity());
  const f = await relayBrowserFixture([other]);
  try {
    const a = await f.connect();
    const b = await f.connect(other);
    for (const peer of [a, b]) {
      await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
      expect((await peer.next()).type).toBe('hello_ack');
    }
    const request = () => ({
      type: 'browser_link_receiver_request' as const,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      binding: f.context().binding,
      seq: 1,
      action: 'select' as const,
    });
    await a.send(request());
    const first = await a.next();
    expect(first.type === 'browser_link_receiver_result' && first.outcome).toBe('selected');
    await b.send(request());
    const second = await b.next();
    expect(second.type === 'browser_link_receiver_result' && second.outcome).toBe('selected');
    const ended = await a.next();
    expect(ended.type === 'browser_link_receiver_ended' && ended.reason).toBe('replaced');
    expect(f.service.offer(f.context(), 'https://example.test/second-device-only')).toBe(true);
    const candidate = await b.next();
    expect(candidate.type === 'browser_link_candidate' && candidate.url).toBe(
      'https://example.test/second-device-only',
    );
    expect(await a.socket.quiet(80)).toBe(true);
    await f.adapter.stop(); // Real child socket loss, no replacement/fresh sequence namespace.
    await until(() => a.socket.isClosed && b.socket.isClosed, 'consumed machine channels retired');
    expect(f.relay.connectionCount).toBe(0);
    expect(f.service.offer(f.context(), 'https://example.test/after-child-loss')).toBe(false);
  } finally {
    await f.close();
  }
}, 30000);

for (const kind of ['malformed-browser', 'host-direction', 'file-download'] as const)
  test(`encrypted relay preserves unavailable browser-child behavior for ${kind}`, async () => {
    const f = await relayBrowserFixture();
    try {
      const peer = await f.connect();
      await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
      expect((await peer.next()).type).toBe('hello_ack');
      const envelope = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: f.sessionId,
      };
      const message =
        kind === 'malformed-browser'
          ? {
              ...envelope,
              type: 'browser_link_receiver_request',
              binding: f.context().binding,
              seq: 1,
              action: 'select',
              extra: true,
            }
          : kind === 'host-direction'
            ? {
                ...envelope,
                type: 'browser_link_receiver_ended',
                leaseId: crypto.randomUUID(),
                reason: 'released',
              }
            : {
                ...envelope,
                type: 'file_fetch_begin',
                binding: f.context().binding,
                relativePath: 'owned.txt',
              };
      // Send original encrypted bytes, without serializer repair or unknown-field dropping.
      await peer.channel.send(new TextEncoder().encode(JSON.stringify(message)));
      if (kind === 'file-download') {
        const response = await peer.next();
        expect(response.type === 'error' && response.code).toBe('INVALID_MESSAGE');
        expect(peer.socket.isClosed).toBe(false);
        expect(f.relay.connectionCount).toBe(1);
      } else {
        await until(() => peer.socket.isClosed, 'strict encrypted refusal');
        expect(f.relay.connectionCount).toBe(0);
      }
      expect(f.service.offer(f.context(), 'https://example.test/denied')).toBe(false);
    } finally {
      await f.close();
    }
  }, 15000);
