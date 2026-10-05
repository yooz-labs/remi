/**
 * Pin tests for the routes of the Worker that R2 (#1197) keeps unchanged:
 * `/health`, the CORS preflight, the 404 fallback and the legacy `/push`
 * authentication. They are green before and after R2; if R2 breaks one, the
 * break is a decision and not an accident.
 *
 * The legacy `/push` stays until push privacy (R5) ships: a daemon built before
 * then still POSTs a plaintext push with `Authorization: Bearer <PUSH_SECRET>`.
 * What stays exactly: the route, the bearer check (only when `PUSH_SECRET` is
 * set), the body shape, the per-isolate rate limiters and the APNS forwarding.
 */

import { describe, expect, test } from 'bun:test';
import worker from '../src/index.ts';

const ENV = {
  CONNECTIONS: {},
  MAX_CONNECTIONS_PER_ROOM: '2',
  CONNECTION_TIMEOUT_MS: '300000',
};

const call = (path: string, init: RequestInit = {}, env: object = ENV): Promise<Response> =>
  worker.fetch(new Request(`https://signaling.example${path}`, init), env as never);

describe('unchanged routes', () => {
  test('/health answers ok with an ISO timestamp', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  test('the CORS preflight allows any origin for GET, POST and OPTIONS', async () => {
    const res = await call('/push', { method: 'OPTIONS' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
  });

  test('an unknown path is a 404', async () => {
    const res = await call('/no-such-route');
    expect(res.status).toBe(404);
  });

  test('GET /push is not the push route', async () => {
    const res = await call('/push');
    expect(res.status).toBe(404);
  });
});

describe('legacy /push authentication', () => {
  const body = JSON.stringify({ token: 'device-token', title: 'T', body: 'B' });
  const post = (headers: Record<string, string>, env: object) =>
    call('/push', { method: 'POST', headers, body }, { ...env, LEGACY_PUSH_ENABLED: 'true' });

  test('with PUSH_SECRET set, a request with no Authorization header is refused', async () => {
    const res = await post({ 'CF-Connecting-IP': '203.0.113.50' }, { ...ENV, PUSH_SECRET: 's1' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('UNAUTHORIZED');
  });

  test('with PUSH_SECRET set, a wrong bearer is refused', async () => {
    const res = await post(
      { Authorization: 'Bearer wrong', 'CF-Connecting-IP': '203.0.113.51' },
      { ...ENV, PUSH_SECRET: 's2' },
    );
    expect(res.status).toBe(401);
  });

  test('with PUSH_SECRET set, the right bearer passes authentication', async () => {
    // No APNS credentials are configured, so a request that gets past the bearer
    // check stops at APNS_NOT_CONFIGURED: that is how a pass is told from a refusal.
    const res = await post(
      { Authorization: 'Bearer s3', 'CF-Connecting-IP': '203.0.113.52' },
      { ...ENV, PUSH_SECRET: 's3' },
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('APNS_NOT_CONFIGURED');
  });

  test('explicit legacy opt-in without PUSH_SECRET is refused', async () => {
    const res = await post({ 'CF-Connecting-IP': '203.0.113.53' }, ENV);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('UNAUTHORIZED');
  });
  test('legacy bearer alone cannot opt in to the plaintext route', async () => {
    const res = await call(
      '/push',
      { method: 'POST', headers: { Authorization: 'Bearer owned' }, body },
      { ...ENV, PUSH_SECRET: 'owned' },
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: 'LEGACY_PUSH_DISABLED' });
  });
});
