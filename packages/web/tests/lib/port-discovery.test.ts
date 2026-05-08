/**
 * Tests for the daemon port discovery helper used by Connect (#393).
 *
 * Real Bun HTTP servers on dynamic ports; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
  buildWsUrl,
  discoverDaemonPort,
  parseHostInput,
} from '../../src/lib/port-discovery';

function authInfoServer() {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/auth-info') {
        return new Response(JSON.stringify({ authRequired: false, fingerprint: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
}

describe('parseHostInput', () => {
  test('plain hostname has no explicit port', () => {
    expect(parseHostInput('localhost')).toEqual({
      kind: 'host',
      hostname: 'localhost',
      explicitPort: null,
    });
  });

  test('hostname with port surfaces the explicit port', () => {
    expect(parseHostInput('192.168.1.5:18770')).toEqual({
      kind: 'host',
      hostname: '192.168.1.5',
      explicitPort: 18770,
    });
  });

  test('trims surrounding whitespace', () => {
    expect(parseHostInput('  myhost:18765  ')).toEqual({
      kind: 'host',
      hostname: 'myhost',
      explicitPort: 18765,
    });
  });

  test('treats invalid port suffix as no explicit port', () => {
    expect(parseHostInput('host:abc')).toEqual({
      kind: 'host',
      hostname: 'host',
      explicitPort: null,
    });
    expect(parseHostInput('host:99999')).toEqual({
      kind: 'host',
      hostname: 'host',
      explicitPort: null,
    });
    expect(parseHostInput('host:0')).toEqual({
      kind: 'host',
      hostname: 'host',
      explicitPort: null,
    });
  });

  test('passes ws:// URLs through unchanged', () => {
    expect(parseHostInput('ws://foo:18765/ws')).toEqual({
      kind: 'wsurl',
      url: 'ws://foo:18765/ws',
    });
    expect(parseHostInput('wss://foo/ws')).toEqual({
      kind: 'wsurl',
      url: 'wss://foo/ws',
    });
  });

  test('bare IPv6 literal has no explicit port', () => {
    // Without brackets we can't tell which colon delimits the port, so
    // we never infer one. Users can supply `[::1]:18770` to force one.
    expect(parseHostInput('::1')).toEqual({
      kind: 'host',
      hostname: '::1',
      explicitPort: null,
    });
    expect(parseHostInput('fe80::1')).toEqual({
      kind: 'host',
      hostname: 'fe80::1',
      explicitPort: null,
    });
  });

  test('bracketed IPv6 with optional port', () => {
    expect(parseHostInput('[::1]')).toEqual({
      kind: 'host',
      hostname: '::1',
      explicitPort: null,
    });
    expect(parseHostInput('[::1]:18770')).toEqual({
      kind: 'host',
      hostname: '::1',
      explicitPort: 18770,
    });
  });
});

describe('buildWsUrl', () => {
  test('builds ws://host:port/ws for plain host', () => {
    const parsed = parseHostInput('localhost');
    expect(buildWsUrl(parsed, 18765)).toBe('ws://localhost:18765/ws');
  });

  test('brackets bare IPv6 hosts', () => {
    const parsed = parseHostInput('::1');
    expect(buildWsUrl(parsed, 18765)).toBe('ws://[::1]:18765/ws');
  });

  test('does not double-bracket already-bracketed hosts', () => {
    const parsed = parseHostInput('[::1]');
    expect(buildWsUrl(parsed, 18770)).toBe('ws://[::1]:18770/ws');
  });

  test('passes wsurl through verbatim', () => {
    const parsed = parseHostInput('ws://foo/ws');
    expect(buildWsUrl(parsed, 12345)).toBe('ws://foo/ws');
  });
});

describe('discoverDaemonPort', () => {
  test('finds the only daemon in the range', async () => {
    const server = authInfoServer();
    try {
      const found = await discoverDaemonPort('127.0.0.1', {
        basePort: server.port,
        portRange: 5,
        timeoutMs: 800,
      });
      expect(found).toBe(server.port);
    } finally {
      server.stop();
    }
  });

  test('finds a daemon when it sits past the base port', async () => {
    // Sibling daemons usually sit at base+1/base+2 in real life; the
    // scan must not stop at the first refused-connection.
    const server = authInfoServer();
    try {
      const basePort = server.port - 3;
      const found = await discoverDaemonPort('127.0.0.1', {
        basePort,
        portRange: 6,
        timeoutMs: 800,
      });
      expect(found).toBe(server.port);
    } finally {
      server.stop();
    }
  });

  test('returns one of the responding ports when multiple daemons answer', async () => {
    // Two siblings at base and base+1; whoever wins the race is fine.
    const a = authInfoServer();
    const b = authInfoServer();
    try {
      const basePort = Math.min(a.port, b.port);
      const found = await discoverDaemonPort('127.0.0.1', {
        basePort,
        portRange: Math.abs(a.port - b.port) + 2,
        timeoutMs: 800,
      });
      expect([a.port, b.port]).toContain(found);
    } finally {
      a.stop();
      b.stop();
    }
  });

  test('returns null when no daemon answers in the range', async () => {
    // High-port range that should be empty on the test box.
    const found = await discoverDaemonPort('127.0.0.1', {
      basePort: 49100,
      portRange: 4,
      timeoutMs: 200,
    });
    expect(found).toBeNull();
  });

  test('returns null when the abort signal is already aborted', async () => {
    const server = authInfoServer();
    const ctl = new AbortController();
    ctl.abort();
    try {
      const found = await discoverDaemonPort('127.0.0.1', {
        basePort: server.port,
        portRange: 1,
        timeoutMs: 800,
        signal: ctl.signal,
      });
      expect(found).toBeNull();
    } finally {
      server.stop();
    }
  });

  test('returns null when portRange is zero', async () => {
    const found = await discoverDaemonPort('127.0.0.1', {
      basePort: 18765,
      portRange: 0,
    });
    expect(found).toBeNull();
  });

  test('default range constants match the daemon defaults', () => {
    // These are duplicated client-side; if the daemon ever changes them,
    // this test should fail to remind us to update both.
    expect(DEFAULT_BASE_PORT).toBe(18765);
    expect(DEFAULT_PORT_RANGE).toBe(20);
  });

  test('aborts loser fetches when one port wins the race', async () => {
    // Track whether the slow server's request handler observed an abort.
    // If `winner.abort()` does not propagate through the per-probe
    // controller, the slow handler runs to completion and the flag stays
    // false, even if `discoverDaemonPort` returned the fast port.
    let slowAborted = false;
    const slow = Bun.serve({
      port: 0,
      async fetch(req) {
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            slowAborted = true;
            resolve();
            return;
          }
          req.signal.addEventListener(
            'abort',
            () => {
              slowAborted = true;
              resolve();
            },
            { once: true },
          );
          setTimeout(resolve, 1500);
        });
        if (req.signal.aborted) return new Response('aborted', { status: 499 });
        return new Response(JSON.stringify({ authRequired: false, fingerprint: null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const fast = authInfoServer();
    try {
      const basePort = Math.min(slow.port, fast.port);
      const found = await discoverDaemonPort('127.0.0.1', {
        basePort,
        portRange: Math.abs(slow.port - fast.port) + 2,
        timeoutMs: 2000,
      });
      expect(found).toBe(fast.port);
      // Allow the abort event loop to flush.
      await new Promise((r) => setTimeout(r, 50));
      expect(slowAborted).toBe(true);
    } finally {
      slow.stop();
      fast.stop();
    }
  });

  test('per-probe timeout fires against a hung server', async () => {
    // Server accepts the connection but never replies. Without the
    // per-probe timer, the scan would hang indefinitely.
    const hung = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const start = Date.now();
      const found = await discoverDaemonPort('127.0.0.1', {
        basePort: hung.port,
        portRange: 1,
        timeoutMs: 150,
      });
      const elapsed = Date.now() - start;
      expect(found).toBeNull();
      // Generous upper bound; the point is "didn't hang for 1.5s default".
      expect(elapsed).toBeLessThan(1000);
    } finally {
      hung.stop();
    }
  });

  test('outer signal aborted mid-flight cancels the scan promptly', async () => {
    const hung = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    try {
      const start = Date.now();
      const found = await discoverDaemonPort('127.0.0.1', {
        basePort: hung.port,
        portRange: 1,
        timeoutMs: 5000,
        signal: ctl.signal,
      });
      const elapsed = Date.now() - start;
      expect(found).toBeNull();
      expect(elapsed).toBeLessThan(800);
    } finally {
      hung.stop();
    }
  });
});
