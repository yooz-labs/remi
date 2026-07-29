/**
 * Origin policy tests (#535).
 *
 * The unit half pins the policy decisions; the server half proves the daemon
 * actually enforces them, over a real Bun.serve on a real port with real
 * WebSocket upgrades and real fetches. No mocks: a policy that is correct in
 * isolation but unwired is exactly the bug being fixed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_ALLOWED_ORIGINS,
  HOSTED_WEB_ORIGIN,
  corsHeadersForOrigin,
  isAllowedOrigin,
} from '../../src/server/origin-policy.ts';
import { WebSocketServer } from '../../src/server/websocket-server.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

describe('isAllowedOrigin', () => {
  test('a native client sends no Origin and is allowed', () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  test('the literal string "null" is an opaque origin, not an absent one', () => {
    // A sandboxed iframe or a file:// page sends this. Treating it as "no
    // origin" would hand the bypass to the most suspicious contexts there are.
    expect(isAllowedOrigin('null')).toBe(false);
  });

  test("remi's own clients are allowed with no configuration", () => {
    expect(isAllowedOrigin(HOSTED_WEB_ORIGIN)).toBe(true);
    expect(isAllowedOrigin('capacitor://localhost')).toBe(true);
    expect(isAllowedOrigin('ionic://localhost')).toBe(true);
    for (const origin of DEFAULT_ALLOWED_ORIGINS) {
      expect(isAllowedOrigin(origin)).toBe(true);
    }
  });

  test('loopback dev servers are allowed on any port', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://localhost')).toBe(true);
    expect(isAllowedOrigin('https://localhost:4173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8080')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:5173')).toBe(true);
  });

  test('any other website is refused', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    expect(isAllowedOrigin('http://evil.example')).toBe(false);
    // A hostname that merely CONTAINS an allowed one must not pass.
    expect(isAllowedOrigin('https://remi.yooz.live.evil.example')).toBe(false);
    expect(isAllowedOrigin('https://notremi.yooz.live')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.example')).toBe(false);
    expect(isAllowedOrigin('https://localhost@evil.example')).toBe(false);
    // Scheme matters: the hosted client is https.
    expect(isAllowedOrigin('http://remi.yooz.live')).toBe(false);
  });

  test('a non-http scheme on a loopback host is not a loopback origin', () => {
    expect(isAllowedOrigin('ftp://localhost')).toBe(false);
    expect(isAllowedOrigin('evil://localhost')).toBe(false);
  });

  test('configured extras are allowed, exactly', () => {
    const extra = ['https://remi.example.com'];
    expect(isAllowedOrigin('https://remi.example.com', extra)).toBe(true);
    expect(isAllowedOrigin('https://remi.example.com.evil.test', extra)).toBe(false);
    expect(isAllowedOrigin('https://other.example.com', extra)).toBe(false);
  });

  test('garbage is refused rather than throwing', () => {
    expect(isAllowedOrigin('not a url')).toBe(false);
    expect(isAllowedOrigin('://')).toBe(false);
    expect(isAllowedOrigin(' https://remi.yooz.live')).toBe(false);
  });
});

describe('corsHeadersForOrigin', () => {
  test('echoes the caller origin and never a wildcard', () => {
    const headers = corsHeadersForOrigin('capacitor://localhost');
    expect(headers['Access-Control-Allow-Origin']).toBe('capacitor://localhost');
    expect(headers['Vary']).toBe('Origin');
    expect(Object.values(headers)).not.toContain('*');
  });

  test('no Origin means no CORS header at all', () => {
    expect(corsHeadersForOrigin(null)).toEqual({});
    expect(corsHeadersForOrigin(undefined)).toEqual({});
    expect(corsHeadersForOrigin('')).toEqual({});
  });
});

describe('WebSocketServer enforces the origin policy', () => {
  let server: WebSocketServer | null = null;
  let port = 0;

  afterEach(async () => {
    if (server?.running) await server.stop();
    server = null;
  });

  async function startServer(allowedOrigins: readonly string[] = []): Promise<void> {
    port = await reserveRange(1);
    server = new WebSocketServer({
      port,
      host: '127.0.0.1',
      allowedOrigins,
      // Swallow the rejection notice; the point here is the response, and a
      // passing test should not print a multi-line warning.
      logFn: () => {},
    });
    await server.start();
  }

  /** Open a WebSocket with an explicit Origin, resolving to 'open' or 'refused'. */
  function tryUpgrade(origin: string | null): Promise<'open' | 'refused'> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws`,
        origin === null ? undefined : ({ headers: { Origin: origin } } as never),
      );
      ws.addEventListener('open', () => {
        ws.close();
        resolve('open');
      });
      ws.addEventListener('error', () => resolve('refused'));
      ws.addEventListener('close', (ev) => {
        if (ev.code !== 1000) resolve('refused');
      });
    });
  }

  test('a hostile page cannot open a WebSocket', async () => {
    await startServer();
    expect(await tryUpgrade('https://evil.example')).toBe('refused');
    expect(server?.connectionCount).toBe(0);
  });

  test('the iOS WebView origin can', async () => {
    await startServer();
    expect(await tryUpgrade('capacitor://localhost')).toBe('open');
  });

  test('a native client sending no Origin can', async () => {
    await startServer();
    expect(await tryUpgrade(null)).toBe('open');
  });

  test('a configured extra origin can', async () => {
    await startServer(['https://remi.example.com']);
    expect(await tryUpgrade('https://remi.example.com')).toBe('open');
    expect(await tryUpgrade('https://evil.example')).toBe('refused');
  });

  test('a hostile page cannot POST an answer', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ questionId: 'q1', answer: 'yes' }),
    });
    expect(res.status).toBe(403);
  });

  test('a hostile page cannot preflight the answer endpoint', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/answer`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('a hostile page cannot read /auth-info or /health', async () => {
    await startServer();
    for (const p of ['/auth-info', '/health']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('the port-scan probe still works for the iOS app, without a wildcard', async () => {
    // This is what #393/#403 needed the wildcard for; echoing the caller's own
    // origin serves it and nothing else.
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/auth-info`, {
      headers: { Origin: 'capacitor://localhost' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    const body = (await res.json()) as { authRequired: boolean };
    expect(typeof body.authRequired).toBe('boolean');
  });

  test('a native probe gets no CORS header and still works', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
