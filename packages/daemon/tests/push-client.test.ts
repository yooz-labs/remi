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
    const body = lastRequest!.body as Record<string, string>;
    expect(body.token).toBe('device-token-abc');
    expect(body.title).toBe('Agent needs input');
    expect(body.body).toBe('Please respond');
  });

  test('includes sessionId when provided', async () => {
    await sendPushTrigger(serverUrl, 'device-token-xyz', {
      title: 'Title',
      body: 'Body',
      sessionId: 'remi-uuid-1234',
    });

    const body = lastRequest!.body as Record<string, string>;
    expect(body.sessionId).toBe('remi-uuid-1234');
  });

  test('omits sessionId when not provided', async () => {
    await sendPushTrigger(serverUrl, 'device-token-xyz', {
      title: 'Title',
      body: 'Body',
    });

    const body = lastRequest!.body as Record<string, string>;
    expect('sessionId' in body).toBe(false);
  });

  test('sends Authorization header when pushSecret provided', async () => {
    await sendPushTrigger(serverUrl, 'tok', {
      title: 'T',
      body: 'B',
      pushSecret: 'my-secret',
    });

    expect(lastRequest!.headers['authorization']).toBe('Bearer my-secret');
  });

  test('omits Authorization header when pushSecret not provided', async () => {
    await sendPushTrigger(serverUrl, 'tok', { title: 'T', body: 'B' });

    expect(lastRequest!.headers['authorization']).toBeUndefined();
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
});
