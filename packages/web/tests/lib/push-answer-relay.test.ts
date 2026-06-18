/**
 * Tests for the connection-independent answer relay (#575, P4a).
 *
 * `relayAnswerDirect` is exercised against a REAL Bun HTTP server (no network
 * mocks). The auth branches need a real identity in localStorage, so a tiny
 * in-memory Storage shim is installed (an environment shim, not a logic mock);
 * real Ed25519 keys are generated via the shared crypto.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createIdentity, serializeIdentity } from '@remi/shared';
import { answerUrl, relayAnswerDirect } from '../../src/lib/push-answer-relay';

// Minimal in-memory localStorage so identity-client can read/write a real
// identity. This is the runtime environment, not a stub of any logic under test.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const store = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = store;

describe('answerUrl', () => {
  test('converts ws:// to http:// and targets /answer', () => {
    expect(answerUrl('ws://localhost:18765/ws')).toBe('http://localhost:18765/answer');
  });

  test('converts wss:// to https://', () => {
    expect(answerUrl('wss://example.com:8443/ws')).toBe('https://example.com:8443/answer');
  });

  test('throws on unsupported scheme', () => {
    expect(() => answerUrl('http://localhost:18765/ws')).toThrow();
  });
});

describe('relayAnswerDirect (#575 P4a)', () => {
  beforeEach(() => {
    store.clear();
  });
  afterEach(() => {
    store.clear();
  });

  function startServer(handler: (req: Request) => Response | Promise<Response>) {
    return Bun.serve({ port: 0, fetch: handler });
  }

  test('no-auth daemon: posts the answer and returns delivered', async () => {
    let received: { sessionId: string; questionId: string; answer: string } | null = null;
    const server = startServer(async (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/answer' && req.method === 'POST') {
        received = (await req.json()) as typeof received;
        return new Response(JSON.stringify({ result: 'delivered' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('nope', { status: 404 });
    });
    try {
      const result = await relayAnswerDirect({
        wsUrl: `ws://127.0.0.1:${server.port}/ws`,
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: false,
      });
      expect(result).toEqual({ kind: 'delivered' });
      expect(received).toEqual({ sessionId: 's1', questionId: 'q1', answer: 'Yes' });
    } finally {
      server.stop();
    }
  });

  test('daemon refusal (stale) returns rejected — caller must NOT fall back', async () => {
    const server = startServer(
      () =>
        new Response(JSON.stringify({ result: 'stale' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      const result = await relayAnswerDirect({
        wsUrl: `ws://127.0.0.1:${server.port}/ws`,
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: false,
      });
      expect(result.kind).toBe('rejected');
    } finally {
      server.stop();
    }
  });

  test('HTTP 401 returns auth-failed (NOT rejected) so the caller can fall back to the WS handshake', async () => {
    const server = startServer(
      () =>
        new Response(JSON.stringify({ result: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      const result = await relayAnswerDirect({
        wsUrl: `ws://127.0.0.1:${server.port}/ws`,
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: false,
      });
      expect(result.kind).toBe('auth-failed');
    } finally {
      server.stop();
    }
  });

  test('daemon not directly reachable returns unreachable (caller may fall back to WS)', async () => {
    // Port 1 is virtually never open.
    const result = await relayAnswerDirect({
      wsUrl: 'ws://127.0.0.1:1/ws',
      sessionId: 's1',
      questionId: 'q1',
      answer: 'Yes',
      authRequired: false,
      timeoutMs: 400,
    });
    expect(result.kind).toBe('unreachable');
  });

  test('auth required + encrypted identity => needs-passphrase, no request sent', async () => {
    // Store a passphrase-encrypted identity; the relay cannot sign without a prompt.
    const encrypted = await createIdentity('correct horse battery staple');
    store.setItem('remi-identity', serializeIdentity(encrypted));

    let hit = false;
    const server = startServer(() => {
      hit = true;
      return new Response(JSON.stringify({ result: 'delivered' }));
    });
    try {
      const result = await relayAnswerDirect({
        wsUrl: `ws://127.0.0.1:${server.port}/ws`,
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: true,
      });
      expect(result.kind).toBe('needs-passphrase');
      expect(hit).toBe(false); // failed fast, never reached the daemon
    } finally {
      server.stop();
    }
  });

  test('auth required + NO stored identity => needs-passphrase, no request sent (FIX 5)', async () => {
    // store is cleared in beforeEach; no identity exists. isIdentityEncrypted()
    // returns false in this case, so the relay must check hasIdentity() too.
    let hit = false;
    const server = startServer(() => {
      hit = true;
      return new Response(JSON.stringify({ result: 'delivered' }));
    });
    try {
      const result = await relayAnswerDirect({
        wsUrl: `ws://127.0.0.1:${server.port}/ws`,
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: true,
      });
      expect(result.kind).toBe('needs-passphrase');
      expect(hit).toBe(false);
    } finally {
      server.stop();
    }
  });

  test('auth required + unencrypted identity: signs and the daemon receives the auth block', async () => {
    const unencrypted = await createIdentity(); // no passphrase => signable without a prompt
    store.setItem('remi-identity', serializeIdentity(unencrypted));

    let body: {
      sessionId?: string;
      auth?: { signature?: string; clientPublicKey?: string; clientFingerprint?: string };
    } | null = null;
    const server = startServer(async (req) => {
      body = (await req.json()) as typeof body;
      return new Response(JSON.stringify({ result: 'delivered' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const result = await relayAnswerDirect({
        wsUrl: `ws://127.0.0.1:${server.port}/ws`,
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: true,
      });
      expect(result).toEqual({ kind: 'delivered' });
      expect(body?.auth?.clientPublicKey).toBe(unencrypted.publicKey);
      expect(body?.auth?.clientFingerprint).toBe(unencrypted.fingerprint);
      expect(typeof body?.auth?.signature).toBe('string');
      expect((body?.auth?.signature ?? '').length).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  });
});
