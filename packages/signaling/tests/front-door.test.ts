/**
 * The Worker's front door (`index.ts`) with the REAL global limiter object and
 * the real routing. The two Durable Object namespaces are the only stand-ins, and
 * only as infrastructure: the room namespace records which room a request would
 * reach (the room itself is tested against workerd in `e2e/`), and a faulty
 * limiter namespace injects the failure whose handling is under test.
 */

import { describe, expect, test } from 'bun:test';
import worker from '../src/index.ts';
import { GlobalLimiter } from '../src/limiter.ts';

const RID = '00112233445566778899aabbccddeeff';
const OTHER = 'ffeeddccbbaa99887766554433221100';

function limiterNamespace(): unknown {
  const limiter = new GlobalLimiter();
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (url: string, init: RequestInit) => limiter.fetch(new Request(url, init)),
    }),
  };
}

function roomNamespace(reached: string[]): unknown {
  return {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async () => {
        reached.push(id);
        return new Response('room', { status: 200 });
      },
    }),
  };
}

const upgrade = (path: string, ip?: string): Request =>
  new Request(`https://relay.example${path}`, {
    headers: { Upgrade: 'websocket', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
  });

function setup(vars: Record<string, string> = {}) {
  const reached: string[] = [];
  const env = { CONNECTIONS: roomNamespace(reached), LIMITER: limiterNamespace(), ...vars };
  return { reached, call: (request: Request) => worker.fetch(request, env as never) };
}

describe('routing', () => {
  test('a valid route reaches the room named by the room id, whichever role it names', async () => {
    const { reached, call } = setup();
    expect((await call(upgrade(`/v2/host/${RID}`, '203.0.113.1'))).status).toBe(200);
    expect((await call(upgrade(`/v2/client/${RID}`, '203.0.113.1'))).status).toBe(200);
    expect((await call(upgrade(`/v2/pipe/${RID}/${OTHER}`, '203.0.113.1'))).status).toBe(200);
    expect(reached).toEqual([RID, RID, RID]);
  });

  test('a route without an upgrade is refused before the room', async () => {
    const { reached, call } = setup();
    const res = await call(new Request(`https://relay.example/v2/host/${RID}`));
    expect(res.status).toBe(426);
    expect(reached).toEqual([]);
  });

  test('other methods and malformed routes never reach a room', async () => {
    const { reached, call } = setup();
    const post = new Request(`https://relay.example/v2/host/${RID}`, { method: 'POST' });
    expect((await call(post)).status).toBe(404);
    expect((await call(upgrade(`/v2/host/${RID.toUpperCase()}`))).status).toBe(404);
    expect((await call(upgrade('/connect/ABCD-2345'))).status).toBe(404);
    expect(reached).toEqual([]);
  });
});

describe('limits at the front door', () => {
  test('a request with no address header is limited under a shared key, not waved through', async () => {
    const { reached, call } = setup({ LIMIT_IP_CLIENT: '2' });
    expect((await call(upgrade(`/v2/client/${RID}`))).status).toBe(200);
    expect((await call(upgrade(`/v2/client/${OTHER}`))).status).toBe(200);
    const third = await call(upgrade(`/v2/client/${RID}`));
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).toBe('60');
    expect(reached).toEqual([RID, OTHER]);
    // a request that does carry an address has a budget of its own
    expect((await call(upgrade(`/v2/client/${RID}`, '203.0.113.9'))).status).toBe(200);
  });

  test('the room budget counts every address together', async () => {
    const { call } = setup({ LIMIT_RID: '2' });
    expect((await call(upgrade(`/v2/client/${RID}`, '203.0.113.1'))).status).toBe(200);
    expect((await call(upgrade(`/v2/host/${RID}`, '203.0.113.2'))).status).toBe(200);
    expect((await call(upgrade(`/v2/client/${RID}`, '203.0.113.3'))).status).toBe(429);
    expect((await call(upgrade(`/v2/client/${OTHER}`, '203.0.113.3'))).status).toBe(200);
  });

  test('an unreachable limiter refuses the request instead of letting it through', async () => {
    const reached: string[] = [];
    const broken = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          throw new Error('the limiter object is unavailable');
        },
      }),
    };
    const env = { CONNECTIONS: roomNamespace(reached), LIMITER: broken };
    const res = await worker.fetch(upgrade(`/v2/host/${RID}`, '203.0.113.1'), env as never);
    expect(res.status).toBe(503);
    expect(reached).toEqual([]);
  });

  test('a limiter that answers anything but a verdict also refuses the request', async () => {
    const reached: string[] = [];
    const garbled = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ allowed: 'yes' }) }),
    };
    const env = { CONNECTIONS: roomNamespace(reached), LIMITER: garbled };
    const res = await worker.fetch(upgrade(`/v2/host/${RID}`, '203.0.113.1'), env as never);
    expect(res.status).toBe(503);
    expect(reached).toEqual([]);
  });
});

describe('the limiter object', () => {
  const ask = (limiter: GlobalLimiter, body: unknown): Promise<Response> =>
    limiter.fetch(
      new Request('https://limiter.invalid/check', { method: 'POST', body: JSON.stringify(body) }),
    );

  const verdict = async (limiter: GlobalLimiter, body: unknown): Promise<unknown> =>
    (await ask(limiter, body)).json() as Promise<unknown>;

  test('counts a key against its own budget and answers a verdict', async () => {
    const limiter = new GlobalLimiter();
    const body = { key: 'k', limit: 2, windowMs: 60_000 };
    expect(await verdict(limiter, body)).toEqual({ ok: true });
    expect(await verdict(limiter, body)).toEqual({ ok: true });
    expect(await verdict(limiter, body)).toEqual({ ok: false });
    expect(await verdict(limiter, { ...body, key: 'other' })).toEqual({ ok: true });
  });

  test('refuses a malformed request', async () => {
    const limiter = new GlobalLimiter();
    for (const body of [
      {},
      { key: '', limit: 1, windowMs: 60_000 },
      { key: 'k', limit: 0, windowMs: 60_000 },
      { key: 'k', limit: 1.5, windowMs: 60_000 },
      { key: 'k', limit: 1, windowMs: 0 },
      { key: 'k', limit: 1, windowMs: 1.5 },
      { key: 'k', limit: 1_000_001, windowMs: 60_000 },
      { key: 'k', limit: 1, windowMs: 1_000_001 },
      { key: 'k', limit: 1, windowMs: 99_999_999 },
      { key: 'x'.repeat(200), limit: 1, windowMs: 60_000 },
      'text',
    ]) {
      expect([body, (await ask(limiter, body)).status]).toEqual([body, 400]);
    }
  });
});
