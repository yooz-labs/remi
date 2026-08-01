/**
 * Worker-level tests for the push `kind` passthrough (#968).
 *
 * The daemon needs each push class to arrive at the device NAMED, because the
 * classes are not otherwise distinguishable: a turn-complete push and a
 * subagent alert are both exactly `{token, title, body}` on the wire, and the
 * old discriminator was a negative test ("no questionId, no category") that
 * lumps them together. Confirms the worker forwards `kind` verbatim into the
 * APNS custom data, bounds it, and changes nothing else when it is absent.
 *
 * Same harness as `push-dyn-category.test.ts`: drives `worker.fetch` directly
 * with the Apple call stubbed, unique CF-Connecting-IP per test to dodge the
 * module-level per-IP push rate limiter.
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

describe('/push kind passthrough (#968)', () => {
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
        'CF-Connecting-IP': `198.51.100.${100 + ipCounter}`,
      },
      body: JSON.stringify(body),
    });
  }

  test('turn_complete and subagent_alert arrive distinguishable despite identical bodies', async () => {
    // The whole point: same token/title/body shape, told apart only by `kind`.
    const turn = await worker.fetch(
      pushRequest({
        token: 'device-abc',
        title: 'proj: turn complete',
        body: 'done',
        kind: 'turn_complete',
      }),
      env as never,
    );
    expect(turn.status).toBe(200);
    expect(JSON.parse(appleRequests[0]?.body ?? '{}')['kind']).toBe('turn_complete');

    const alert = await worker.fetch(
      pushRequest({
        token: 'device-abc',
        title: 'proj: turn complete',
        body: 'done',
        kind: 'subagent_alert',
      }),
      env as never,
    );
    expect(alert.status).toBe(200);
    expect(JSON.parse(appleRequests[1]?.body ?? '{}')['kind']).toBe('subagent_alert');
  });

  test('kind rides alongside a question push without disturbing category or opt_N', async () => {
    const res = await worker.fetch(
      pushRequest({
        token: 'device-abc',
        title: 'T',
        body: 'B',
        questionId: 'q-1',
        category: 'REMI_YN',
        options: ['Yes', 'No'],
        kind: 'question',
      }),
      env as never,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect(parsed['kind']).toBe('question');
    expect(parsed.aps.category).toBe('REMI_YN');
    expect(parsed['opt_0']).toBe('Yes');
    expect(parsed['opt_1']).toBe('No');
  });

  test('a dismiss push carries kind without gaining an alert', async () => {
    const res = await worker.fetch(
      pushRequest({ token: 'device-abc', questionId: 'q-1', dismiss: true, kind: 'dismiss' }),
      env as never,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect(parsed['kind']).toBe('dismiss');
    expect(parsed.aps['content-available']).toBe(1);
    expect(parsed.aps.alert).toBeUndefined();
  });

  test('absent kind produces a payload with no kind field at all', async () => {
    // Strictly additive: a daemon that predates #968 gets a byte-identical push.
    const res = await worker.fetch(
      pushRequest({ token: 'device-abc', title: 'T', body: 'B' }),
      env as never,
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(appleRequests[0]?.body ?? '{}');
    expect('kind' in parsed).toBe(false);
  });

  test('an unrecognized kind is forwarded, not rejected', async () => {
    // The worker only carries the value. Rejecting an unknown one would mean a
    // daemon adding a new push class needs a worker redeploy before ANY of its
    // pushes work -- a deploy-order trap for a field that is purely a label.
    const res = await worker.fetch(
      pushRequest({ token: 'device-abc', title: 'T', body: 'B', kind: 'something_new' }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(appleRequests[0]?.body ?? '{}')['kind']).toBe('something_new');
  });

  test('an over-long kind is capped so it cannot bloat the 4KB APNS payload', async () => {
    const res = await worker.fetch(
      pushRequest({ token: 'device-abc', title: 'T', body: 'B', kind: 'k'.repeat(500) }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(appleRequests[0]?.body ?? '{}')['kind']).toBe('k'.repeat(32));
  });

  test('an empty-string kind is dropped rather than sent as an empty field', async () => {
    const res = await worker.fetch(
      pushRequest({ token: 'device-abc', title: 'T', body: 'B', kind: '' }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect('kind' in JSON.parse(appleRequests[0]?.body ?? '{}')).toBe(false);
  });
});
