/**
 * Worker-level tests for the /push dismissal contract (#585, P7).
 *
 * Drives the worker's `fetch` directly (no miniflare; bun's runtime provides
 * `crypto.subtle` and `fetch`, which we stub for the Apple call). Confirms FIX 4:
 * a `dismiss` push is accepted WITHOUT title/body (skips MISSING_FIELDS), while a
 * dismiss still requires `token`. Each test uses a unique CF-Connecting-IP to
 * dodge the module-level per-IP push rate limiter.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import worker from '../src/index.ts';

// A real EC P-256 PKCS8 key so createApnsJwt's crypto.subtle.importKey/sign
// succeed (the JWT itself is never verified here — we stub the Apple fetch).
async function generateTestP8(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

interface TestEnv {
  CONNECTIONS: unknown;
  MAX_CONNECTIONS_PER_ROOM: string;
  CONNECTION_TIMEOUT_MS: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
  APNS_BUNDLE_ID: string;
}

describe('/push dismissal contract (#585 P7 FIX 4)', () => {
  let env: TestEnv;
  let realFetch: typeof globalThis.fetch;
  let appleRequests: Array<{ url: string; headers: Headers; body: string }>;
  let ipCounter = 0;

  beforeEach(async () => {
    env = {
      CONNECTIONS: {},
      MAX_CONNECTIONS_PER_ROOM: '10',
      CONNECTION_TIMEOUT_MS: '60000',
      APNS_KEY_ID: 'TESTKEY123',
      APNS_TEAM_ID: 'TESTTEAM45',
      APNS_PRIVATE_KEY: await generateTestP8(),
      APNS_BUNDLE_ID: 'live.yooz.remi',
    };
    appleRequests = [];
    realFetch = globalThis.fetch;
    // Stub only the Apple APNS host; everything else is unused in these tests.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('push.apple.com')) {
        appleRequests.push({
          url,
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ''),
        });
        return new Response('', { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function pushRequest(body: Record<string, unknown>): Request {
    ipCounter += 1;
    return new Request('https://signaling.example/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': `203.0.113.${ipCounter}`,
      },
      body: JSON.stringify(body),
    });
  }

  test('a dismiss push WITHOUT title/body is accepted (skips MISSING_FIELDS)', async () => {
    const res = await worker.fetch(
      pushRequest({ token: 'device-abc', questionId: 'q-1', dismiss: true }),
      env as never,
    );
    expect(res.status).toBe(200);
    // It reached APNS: a single background dismissal with the collapse-id.
    expect(appleRequests).toHaveLength(1);
    expect(appleRequests[0]?.headers.get('apns-push-type')).toBe('background');
    expect(appleRequests[0]?.headers.get('apns-collapse-id')).toBe('q-1');
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect(parsed.aps['content-available']).toBe(1);
    expect(parsed.aps.alert).toBeUndefined();
  });

  test('a dismiss push still requires a token (MISSING_FIELDS otherwise)', async () => {
    const res = await worker.fetch(pushRequest({ questionId: 'q-1', dismiss: true }), env as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('MISSING_FIELDS');
    expect(appleRequests).toHaveLength(0);
  });

  test('a normal (non-dismiss) push still requires title and body', async () => {
    const res = await worker.fetch(pushRequest({ token: 'device-abc' }), env as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('MISSING_FIELDS');
  });
});
