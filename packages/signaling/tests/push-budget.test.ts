/**
 * Worker-level tests for the /push rate-limit budget (epic #603 Phase 2, R3).
 *
 * Drives the worker's `fetch` directly (no miniflare; bun provides crypto.subtle
 * and fetch, which we stub for the Apple call). Confirms:
 *   - authenticated callers are NOT throttled at the old 5/60s per-IP limit
 *     (a power user's many daemons behind one NAT no longer 429);
 *   - unauthenticated callers keep the tight per-IP fallback;
 *   - dismiss pushes draw from a SEPARATE budget so they can't starve alerts;
 *   - a permanent token rejection is surfaced as a structured `tokenInvalid`.
 *
 * Each test uses a UNIQUE secret (authed) or a unique IP (unauthed) so its
 * rate-limit bucket is fresh despite the module-level limiters persisting across
 * tests in the run.
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
  PUSH_SECRET?: string;
}

describe('/push budget (#603 Phase 2)', () => {
  let baseEnv: Omit<TestEnv, 'PUSH_SECRET'>;
  let realFetch: typeof globalThis.fetch;
  // Configurable Apple response so a token-rejection case can be simulated.
  let appleStatus = 200;
  let appleBody = '';
  let secretCounter = 0;
  let ipCounter = 0;

  beforeEach(async () => {
    baseEnv = {
      CONNECTIONS: {},
      MAX_CONNECTIONS_PER_ROOM: '10',
      CONNECTION_TIMEOUT_MS: '60000',
      APNS_KEY_ID: 'TESTKEY123',
      APNS_TEAM_ID: 'TESTTEAM45',
      APNS_PRIVATE_KEY: await generateTestP8(),
      APNS_BUNDLE_ID: 'live.yooz.remi',
    };
    appleStatus = 200;
    appleBody = '';
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('push.apple.com')) {
        return new Response(appleBody, { status: appleStatus });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A unique PUSH_SECRET per call so each test gets a fresh auth rate bucket. */
  function freshSecret(): string {
    secretCounter += 1;
    return `test-secret-${secretCounter}`;
  }

  function alertReq(opts: { ip: string; secret?: string }): Request {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': opts.ip,
    };
    if (opts.secret) headers['Authorization'] = `Bearer ${opts.secret}`;
    return new Request('https://signaling.example/push', {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'device-abc', title: 'T', body: 'B', questionId: 'q-1' }),
    });
  }

  function dismissReq(opts: { ip: string; secret: string }): Request {
    return new Request('https://signaling.example/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': opts.ip,
        Authorization: `Bearer ${opts.secret}`,
      },
      body: JSON.stringify({ token: 'device-abc', questionId: 'q-1', dismiss: true }),
    });
  }

  test('authenticated alert pushes are NOT throttled at the old 5/60s (shared-NAT power user)', async () => {
    const secret = freshSecret();
    const env = { ...baseEnv, PUSH_SECRET: secret } as TestEnv;
    const ip = '198.51.100.7'; // same IP for all 6 (simulates many daemons, one NAT)
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await worker.fetch(alertReq({ ip, secret }), env as never);
      statuses.push(res.status);
    }
    // The old per-IP 5-limit would 429 the 6th; the raised per-identity budget
    // lets all six through.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  test('unauthenticated push keeps the tight per-IP fallback (6th is 429)', async () => {
    const env = { ...baseEnv } as TestEnv; // no PUSH_SECRET
    ipCounter += 1;
    const ip = `198.51.100.${100 + ipCounter}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await worker.fetch(alertReq({ ip }), env as never);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  test('dismiss pushes draw from a separate budget and are not starved by alerts', async () => {
    const secret = freshSecret();
    const env = { ...baseEnv, PUSH_SECRET: secret } as TestEnv;
    const ip = '198.51.100.50';
    // Exhaust the authenticated ALERT budget (PUSH_AUTH_LIMIT = 60).
    let lastAlert = 200;
    for (let i = 0; i < 61; i++) {
      const res = await worker.fetch(alertReq({ ip, secret }), env as never);
      lastAlert = res.status;
    }
    expect(lastAlert).toBe(429); // alert budget is now exhausted
    // A dismiss for the same identity still succeeds — separate budget.
    const dRes = await worker.fetch(dismissReq({ ip, secret }), env as never);
    expect(dRes.status).toBe(200);
  });

  test('unauthenticated dismiss uses the tight per-IP fallback, not the raised budget', async () => {
    const env = { ...baseEnv } as TestEnv; // no PUSH_SECRET
    ipCounter += 1;
    const ip = `198.51.100.${200 + ipCounter}`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const req = new Request('https://signaling.example/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ token: 'device-abc', questionId: 'q-1', dismiss: true }),
      });
      const res = await worker.fetch(req, env as never);
      statuses.push(res.status);
    }
    // The tight 5/60s fallback applies to unauthenticated dismisses too.
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  test('a permanent token rejection is surfaced as tokenInvalid:true (502)', async () => {
    const secret = freshSecret();
    const env = { ...baseEnv, PUSH_SECRET: secret } as TestEnv;
    appleStatus = 400;
    appleBody = '{"reason":"BadDeviceToken"}';
    const res = await worker.fetch(alertReq({ ip: '198.51.100.60', secret }), env as never);
    expect(res.status).toBe(502);
    const json = (await res.json()) as { success: boolean; error?: string; tokenInvalid?: boolean };
    expect(json.success).toBe(false);
    expect(json.tokenInvalid).toBe(true);
    expect(json.error).toContain('BadDeviceToken'); // reason kept for the Phase 1 classifier
  });

  test('a transient APNS failure is NOT flagged tokenInvalid', async () => {
    const secret = freshSecret();
    const env = { ...baseEnv, PUSH_SECRET: secret } as TestEnv;
    appleStatus = 503;
    appleBody = 'service unavailable';
    const res = await worker.fetch(alertReq({ ip: '198.51.100.61', secret }), env as never);
    expect(res.status).toBe(502);
    const json = (await res.json()) as { tokenInvalid?: boolean };
    expect(json.tokenInvalid).toBe(false);
  });
});
