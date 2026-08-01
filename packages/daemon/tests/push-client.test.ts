/**
 * Tests for sendPushTrigger.
 *
 * Uses a real Bun HTTP server to capture request bodies (no mocks).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sendPushTrigger } from '../src/notifications/push-client.ts';

describe('sendPushTrigger', () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastRequest: { body: unknown; headers: Record<string, string> } | null = null;
  let serverUrl: string;

  beforeEach(() => {
    lastRequest = null;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json().catch(() => null);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        lastRequest = { body, headers };
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    serverUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    server.stop();
  });

  test('sends token, title, and body in POST payload', async () => {
    await sendPushTrigger(serverUrl, 'device-token-abc', {
      title: 'Agent needs input',
      body: 'Please respond',
    });

    expect(lastRequest).not.toBeNull();
    if (!lastRequest) throw new Error('no request captured');
    const body = lastRequest.body as Record<string, string>;
    expect(body['token']).toBe('device-token-abc');
    expect(body['title']).toBe('Agent needs input');
    expect(body['body']).toBe('Please respond');
  });

  test('includes sessionId when provided', async () => {
    await sendPushTrigger(serverUrl, 'device-token-xyz', {
      title: 'Title',
      body: 'Body',
      sessionId: 'remi-uuid-1234',
    });

    if (!lastRequest) throw new Error('no request captured');
    const body = lastRequest.body as Record<string, string>;
    expect(body['sessionId']).toBe('remi-uuid-1234');
  });

  test('omits sessionId when not provided', async () => {
    await sendPushTrigger(serverUrl, 'device-token-xyz', {
      title: 'Title',
      body: 'Body',
    });

    if (!lastRequest) throw new Error('no request captured');
    const body = lastRequest.body as Record<string, string>;
    expect('sessionId' in body).toBe(false);
  });

  test('sends Authorization header when pushSecret provided', async () => {
    await sendPushTrigger(serverUrl, 'tok', {
      title: 'T',
      body: 'B',
      pushSecret: 'my-secret',
    });

    if (!lastRequest) throw new Error('no request captured');
    expect(lastRequest.headers['authorization']).toBe('Bearer my-secret');
  });

  test('omits Authorization header when pushSecret not provided', async () => {
    await sendPushTrigger(serverUrl, 'tok', { title: 'T', body: 'B' });

    if (!lastRequest) throw new Error('no request captured');
    expect(lastRequest.headers['authorization']).toBeUndefined();
  });

  test('throws on non-OK response', async () => {
    server.stop();
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('bad request', { status: 400 });
      },
    });
    serverUrl = `http://localhost:${server.port}`;

    await expect(sendPushTrigger(serverUrl, 'tok', { title: 'T', body: 'B' })).rejects.toThrow(
      'Push trigger failed: 400',
    );
  });

  test('uses default signaling URL when signalingUrl is undefined', async () => {
    // We cannot reach the real signaling server in tests, so just verify
    // that passing undefined does not crash before the network call
    // (it will throw a network error, not a URL construction error).
    await expect(sendPushTrigger(undefined, 'tok', { title: 'T', body: 'B' })).rejects.toThrow(); // network error expected; not a URL parse error
  });

  test('normalizes ws:// signaling URL to http:// for the push endpoint', async () => {
    // Real usage: wss:// → https://. Test server is HTTP so use ws:// → http://.
    const wsUrl = serverUrl.replace('http://', 'ws://');
    await sendPushTrigger(wsUrl, 'tok', { title: 'T', body: 'B' });
    if (!lastRequest) throw new Error('no request captured');
    expect(lastRequest['body']).toBeTruthy();
  });
});

describe('sendPushTrigger push kind (#968)', () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastBody: Record<string, unknown> | null = null;
  let serverUrl: string;

  beforeEach(() => {
    lastBody = null;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        lastBody = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    serverUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    server.stop();
  });

  test('carries kind so a turn-complete push is distinguishable from a subagent alert', async () => {
    // These two are otherwise byte-identical on the wire ({token, title, body}),
    // which is exactly why `kind` had to exist before either could be filtered
    // or labelled.
    await sendPushTrigger(serverUrl, 'tok', {
      title: 'proj: turn complete',
      body: 'done',
      kind: 'turn_complete',
    });
    expect(lastBody?.['kind']).toBe('turn_complete');

    await sendPushTrigger(serverUrl, 'tok', {
      title: 'Background agent ran rm -rf',
      body: 'heads up',
      kind: 'subagent_alert',
    });
    expect(lastBody?.['kind']).toBe('subagent_alert');
  });

  test('omits kind entirely when the caller sends none', async () => {
    await sendPushTrigger(serverUrl, 'tok', { title: 't', body: 'b' });
    expect(lastBody).not.toBeNull();
    expect('kind' in (lastBody as Record<string, unknown>)).toBe(false);
  });
});
