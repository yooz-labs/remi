/**
 * Worker-level tests for the NSE dynamic-category contract (#719).
 *
 * Drives the worker's `fetch` directly (no miniflare; bun's runtime provides
 * `crypto.subtle` and `fetch`, which we stub for the Apple call). Confirms:
 *   - `dynOptions: true` + non-empty `options` sets BOTH `mutable-content: 1`
 *     in the aps dict AND a `dynCategory: "1"` data field, alongside the
 *     unchanged `opt_0..opt_N` fields and the static `category`.
 *   - the flag is STRICTLY ADDITIVE: absent (or false, or no options) produces
 *     a payload with no `mutable-content` / `dynCategory` at all — byte-
 *     identical to a pre-#719 push.
 * Each test uses a unique CF-Connecting-IP to dodge the module-level per-IP
 * push rate limiter.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import worker from '../src/index.ts';

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

describe('/push NSE dynamic-category contract (#719)', () => {
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
        'CF-Connecting-IP': `203.0.113.${100 + ipCounter}`,
      },
      body: JSON.stringify(body),
    });
  }

  test('dynOptions + options sets mutable-content and dynCategory alongside the static category', async () => {
    const res = await worker.fetch(
      pushRequest({
        token: 'device-abc',
        title: 'T',
        body: 'B',
        questionId: 'q-1',
        category: 'REMI_YNA',
        options: ['Yes', 'Yes, always', 'No'],
        dynOptions: true,
      }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(appleRequests).toHaveLength(1);
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect(parsed.aps['mutable-content']).toBe(1);
    expect(parsed.aps.category).toBe('REMI_YNA'); // static fallback still present
    expect(parsed['dynCategory']).toBe('1');
    expect(parsed['opt_0']).toBe('Yes');
    expect(parsed['opt_1']).toBe('Yes, always');
    expect(parsed['opt_2']).toBe('No');
  });

  test('dynOptions is a no-op without any options (nothing for the NSE to build)', async () => {
    const res = await worker.fetch(
      pushRequest({
        token: 'device-abc',
        title: 'T',
        body: 'B',
        questionId: 'q-2',
        dynOptions: true,
      }),
      env as never,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect(parsed.aps['mutable-content']).toBeUndefined();
    expect(parsed['dynCategory']).toBeUndefined();
  });

  test('absent dynOptions is byte-identical to a pre-#719 push (no mutable-content, no dynCategory)', async () => {
    const res = await worker.fetch(
      pushRequest({
        token: 'device-abc',
        title: 'T',
        body: 'B',
        questionId: 'q-3',
        category: 'REMI_MULTI',
        options: ['Postgres', 'SQLite', 'MySQL', 'MongoDB'],
      }),
      env as never,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect(parsed.aps['mutable-content']).toBeUndefined();
    expect(parsed['dynCategory']).toBeUndefined();
    expect(parsed.aps.category).toBe('REMI_MULTI');
    expect(parsed['opt_3']).toBe('MongoDB');
  });

  test('dynOptions: false is a no-op (explicit false, not just absent)', async () => {
    const res = await worker.fetch(
      pushRequest({
        token: 'device-abc',
        title: 'T',
        body: 'B',
        questionId: 'q-4',
        options: ['Yes', 'No'],
        dynOptions: false,
      }),
      env as never,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect(parsed.aps['mutable-content']).toBeUndefined();
    expect(parsed['dynCategory']).toBeUndefined();
  });
});
