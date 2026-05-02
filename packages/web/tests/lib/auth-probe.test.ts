/**
 * Tests for the pre-flight /auth-info probe used by the Connect modal (#257).
 */

import { describe, expect, test } from 'bun:test';
import { authInfoUrl, probeAuthInfo } from '../../src/lib/auth-probe';

describe('authInfoUrl', () => {
  test('converts ws:// to http://', () => {
    expect(authInfoUrl('ws://localhost:18765/ws')).toBe('http://localhost:18765/auth-info');
  });

  test('converts wss:// to https://', () => {
    // URL strips the default port (443 for https), so the output drops it too.
    expect(authInfoUrl('wss://example.com:443/ws')).toBe('https://example.com/auth-info');
  });

  test('preserves non-default port for wss', () => {
    expect(authInfoUrl('wss://example.com:8443/ws')).toBe(
      'https://example.com:8443/auth-info',
    );
  });

  test('preserves non-default ports', () => {
    expect(authInfoUrl('ws://192.168.1.5:18770/ws')).toBe(
      'http://192.168.1.5:18770/auth-info',
    );
  });

  test('handles IPv6 host', () => {
    // URL parsing keeps brackets in the host string
    expect(authInfoUrl('ws://[::1]:18765/ws')).toBe('http://[::1]:18765/auth-info');
  });

  test('throws on unsupported scheme', () => {
    expect(() => authInfoUrl('http://localhost:18765/ws')).toThrow();
    expect(() => authInfoUrl('ftp://localhost:18765/')).toThrow();
  });
});

describe('probeAuthInfo', () => {
  // Spin up a tiny real HTTP server per test (no mocks).
  function startServer(handler: (req: Request) => Response | Promise<Response>) {
    return Bun.serve({ port: 0, fetch: handler });
  }

  test('returns parsed AuthInfo on 200', async () => {
    const server = startServer((req) => {
      const u = new URL(req.url);
      if (u.pathname === '/auth-info') {
        return new Response(
          JSON.stringify({ authRequired: true, fingerprint: 'AB:CD' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    });
    try {
      const info = await probeAuthInfo(`ws://127.0.0.1:${server.port}/ws`);
      expect(info).toEqual({ authRequired: true, fingerprint: 'AB:CD' });
    } finally {
      server.stop();
    }
  });

  test('returns AuthInfo with null fingerprint when daemon has no auth', async () => {
    const server = startServer(() =>
      new Response(JSON.stringify({ authRequired: false, fingerprint: null }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      const info = await probeAuthInfo(`ws://127.0.0.1:${server.port}/ws`);
      expect(info).toEqual({ authRequired: false, fingerprint: null });
    } finally {
      server.stop();
    }
  });

  test('returns null on non-200 response', async () => {
    const server = startServer(() => new Response('nope', { status: 500 }));
    try {
      const info = await probeAuthInfo(`ws://127.0.0.1:${server.port}/ws`);
      expect(info).toBeNull();
    } finally {
      server.stop();
    }
  });

  test('returns null on malformed JSON', async () => {
    const server = startServer(() =>
      new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    );
    try {
      const info = await probeAuthInfo(`ws://127.0.0.1:${server.port}/ws`);
      expect(info).toBeNull();
    } finally {
      server.stop();
    }
  });

  test('returns null when authRequired field is wrong type', async () => {
    const server = startServer(() =>
      new Response(JSON.stringify({ authRequired: 'yes please', fingerprint: null }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    try {
      const info = await probeAuthInfo(`ws://127.0.0.1:${server.port}/ws`);
      expect(info).toBeNull();
    } finally {
      server.stop();
    }
  });

  test('returns null on network error (port not listening)', async () => {
    // Port 1 is virtually never open. Probe should reject and we return null.
    const info = await probeAuthInfo('ws://127.0.0.1:1/ws', { timeoutMs: 500 });
    expect(info).toBeNull();
  });

  test('respects timeout when server hangs', async () => {
    // Server never responds to /auth-info; probe should abort and return null.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise(() => {
        // never resolves
      }),
    });
    try {
      const start = Date.now();
      const info = await probeAuthInfo(`ws://127.0.0.1:${server.port}/ws`, {
        timeoutMs: 100,
      });
      const elapsed = Date.now() - start;
      expect(info).toBeNull();
      expect(elapsed).toBeLessThan(2000);
    } finally {
      server.stop();
    }
  });

  test('returns null for unsupported scheme', async () => {
    // authInfoUrl throws; probeAuthInfo catches and returns null.
    const info = await probeAuthInfo('http://example.com/');
    expect(info).toBeNull();
  });
});
