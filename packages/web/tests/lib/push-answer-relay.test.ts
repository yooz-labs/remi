/**
 * Tests for the connection-independent answer relay (#575, P4a).
 *
 * `relayAnswerDirect` is exercised against a REAL Bun HTTP server (no network
 * mocks). The auth branches need a real identity in localStorage, so a tiny
 * in-memory Storage shim is installed (an environment shim, not a logic mock);
 * real Ed25519 keys are generated via the shared crypto.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createIdentity,
  generateAnswerKeyPair,
  openSealedAnswer,
  serializeIdentity,
} from '@remi/shared';
import {
  answerUrl,
  relayAnswerDirect,
  relayAnswerViaSignaling,
  signalingAnswerUrl,
} from '../../src/lib/push-answer-relay';

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
        // Pre-#875 daemon: publishes no answer key, so there is nothing to
        // seal to. The sealed path has its own tests below.
        sealRequired: false,
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
        // Pre-#875 daemon: publishes no answer key, so there is nothing to
        // seal to. The sealed path has its own tests below.
        sealRequired: false,
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
        // Pre-#875 daemon: publishes no answer key, so there is nothing to
        // seal to. The sealed path has its own tests below.
        sealRequired: false,
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
        sealRequired: false,
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
        sealRequired: false,
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
        sealRequired: false,
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

describe('signalingAnswerUrl (#591)', () => {
  test('converts wss:// to https:// and targets /answer/{code}', () => {
    expect(signalingAnswerUrl('wss://remi-signaling.example/', 'WXYZ-2345')).toBe(
      'https://remi-signaling.example/answer/WXYZ-2345',
    );
  });

  test('keeps https:// as-is', () => {
    expect(signalingAnswerUrl('https://sig.example', 'WXYZ-2345')).toBe(
      'https://sig.example/answer/WXYZ-2345',
    );
  });

  test('throws on unsupported scheme', () => {
    expect(() => signalingAnswerUrl('ftp://sig.example', 'WXYZ-2345')).toThrow();
  });
});

describe('relayAnswerViaSignaling (#591)', () => {
  beforeEach(() => {
    store.clear();
  });
  afterEach(() => {
    store.clear();
  });

  function startServer(handler: (req: Request) => Response | Promise<Response>) {
    return Bun.serve({ port: 0, fetch: handler });
  }

  test('no-auth: POSTs to /answer/{code} and returns delivered', async () => {
    let path = '';
    let received: { sessionId: string; questionId: string; answer: string } | null = null;
    const server = startServer(async (req) => {
      const u = new URL(req.url);
      path = u.pathname;
      if (req.method === 'POST') {
        received = (await req.json()) as typeof received;
        return new Response(JSON.stringify({ result: 'delivered' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('nope', { status: 404 });
    });
    try {
      const result = await relayAnswerViaSignaling({
        signalingUrl: `http://127.0.0.1:${server.port}`,
        code: 'WXYZ-2345',
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: false,
        // Pre-#875 daemon: publishes no answer key, so there is nothing to
        // seal to. The sealed path has its own tests below.
        sealRequired: false,
      });
      expect(result).toEqual({ kind: 'delivered' });
      expect(path).toBe('/answer/WXYZ-2345');
      expect(received).toEqual({ sessionId: 's1', questionId: 'q1', answer: 'Yes' });
    } finally {
      server.stop();
    }
  });

  test('503 no-peer maps to unreachable (caller may fall back to WS)', async () => {
    const server = startServer(
      () =>
        new Response(JSON.stringify({ result: 'no-peer' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      const result = await relayAnswerViaSignaling({
        signalingUrl: `http://127.0.0.1:${server.port}`,
        code: 'WXYZ-2345',
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: false,
        // Pre-#875 daemon: publishes no answer key, so there is nothing to
        // seal to. The sealed path has its own tests below.
        sealRequired: false,
      });
      expect(result.kind).toBe('unreachable');
    } finally {
      server.stop();
    }
  });

  test('auth required + unencrypted identity: signs and the Worker receives the auth block', async () => {
    const unencrypted = await createIdentity();
    store.setItem('remi-identity', serializeIdentity(unencrypted));
    let body: {
      auth?: { signature?: string; clientPublicKey?: string; clientFingerprint?: string };
    } | null = null;
    const server = startServer(async (req) => {
      body = (await req.json()) as typeof body;
      return new Response(JSON.stringify({ result: 'delivered' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    try {
      const result = await relayAnswerViaSignaling({
        signalingUrl: `http://127.0.0.1:${server.port}`,
        code: 'WXYZ-2345',
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: true,
        sealRequired: false,
      });
      expect(result).toEqual({ kind: 'delivered' });
      expect(body?.auth?.clientPublicKey).toBe(unencrypted.publicKey);
      expect(typeof body?.auth?.signature).toBe('string');
    } finally {
      server.stop();
    }
  });

  test('bad signaling url => unreachable', async () => {
    const result = await relayAnswerViaSignaling({
      signalingUrl: 'ftp://bad',
      code: 'WXYZ-2345',
      sessionId: 's1',
      questionId: 'q1',
      answer: 'Yes',
      authRequired: false,
    });
    expect(result.kind).toBe('unreachable');
  });

  test('502 send-failed maps to unreachable (caller may fall back to WS)', async () => {
    const server = startServer(
      () =>
        new Response(JSON.stringify({ result: 'send-failed' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      const result = await relayAnswerViaSignaling({
        signalingUrl: `http://127.0.0.1:${server.port}`,
        code: 'WXYZ-2345',
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: false,
        // Pre-#875 daemon: publishes no answer key, so there is nothing to
        // seal to. The sealed path has its own tests below.
        sealRequired: false,
      });
      expect(result.kind).toBe('unreachable');
    } finally {
      server.stop();
    }
  });

  test('410 room-expired maps to rejected (stale code, do not retry)', async () => {
    const server = startServer(
      () =>
        new Response(JSON.stringify({ result: 'room-expired' }), {
          status: 410,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      const result = await relayAnswerViaSignaling({
        signalingUrl: `http://127.0.0.1:${server.port}`,
        code: 'WXYZ-2345',
        sessionId: 's1',
        questionId: 'q1',
        answer: 'Yes',
        authRequired: false,
        // Pre-#875 daemon: publishes no answer key, so there is nothing to
        // seal to. The sealed path has its own tests below.
        sealRequired: false,
      });
      expect(result.kind).toBe('rejected');
    } finally {
      server.stop();
    }
  });

  describe('sealed answers (#875)', () => {
    test('with a pinned key the Worker receives an opaque envelope', async () => {
      const daemon = await generateAnswerKeyPair();
      let received: Record<string, unknown> | null = null;
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          received = (await req.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ result: 'delivered' }), { status: 200 });
        },
      });
      try {
        const result = await relayAnswerViaSignaling({
          signalingUrl: `http://127.0.0.1:${server.port}`,
          code: 'WXYZ-2345',
          // Hyphenated UUIDs, NOT short tokens. The assertions below check the
          // base64 envelope does not CONTAIN these. Base64's alphabet includes
          // s, q and 1, so 's1'/'q1' appear in a ~250-char random envelope
          // roughly 6% of the time each -- this test failed on unrelated PRs at
          // about that rate. '-' is outside the base64 alphabet, so a
          // hyphenated UUID can never occur by chance. `shared/tests/
          // sealed-answer.test.ts` already used full UUIDs for this reason.
          sessionId: '0199f3a1-0000-7000-8000-000000000001',
          questionId: '0199f3a1-0000-7000-8000-000000000002',
          answer: 'Yes, deploy',
          authRequired: false,
          answerEncryptionKey: daemon.publicKeyBase64,
        });
        expect(result).toEqual({ kind: 'delivered' });

        // The Worker's entire view.
        const body = received as unknown as Record<string, unknown>;
        const wire = JSON.stringify(body);
        expect(wire).not.toContain('Yes, deploy');
        expect(wire).not.toContain('0199f3a1-0000-7000-8000-000000000001');
        expect(wire).not.toContain('0199f3a1-0000-7000-8000-000000000002');
        expect(typeof body['sealed']).toBe('string');
        expect(typeof body['ephemeralPublicKey']).toBe('string');

        // ...and the daemon still gets everything it needs.
        const opened = (await openSealedAnswer(
          daemon.privateKeyPkcs8Base64,
          body as unknown as { ephemeralPublicKey: string; sealed: string },
        )) as Record<string, unknown>;
        expect(opened['sessionId']).toBe('0199f3a1-0000-7000-8000-000000000001');
        expect(opened['answer']).toBe('Yes, deploy');
      } finally {
        server.stop();
      }
    });

    test('without a pinned key it refuses instead of sending plaintext', async () => {
      // The whole point: a fallback here would hand the Worker the answer.
      let called = false;
      const server = Bun.serve({
        port: 0,
        fetch: () => {
          called = true;
          return new Response(JSON.stringify({ result: 'delivered' }), { status: 200 });
        },
      });
      try {
        const result = await relayAnswerViaSignaling({
          signalingUrl: `http://127.0.0.1:${server.port}`,
          code: 'WXYZ-2345',
          sessionId: 's1',
          questionId: 'q1',
          answer: 'Yes',
          authRequired: false,
        });
        expect(result.kind).toBe('unreachable');
        expect(called).toBe(false);
      } finally {
        server.stop();
      }
    });

    test('the auth block is sealed too, so the Worker cannot see who answered', async () => {
      // Signing needs an identity present, same setup the auth tests above use.
      const unencrypted = await createIdentity();
      store.setItem('remi-identity', serializeIdentity(unencrypted));
      const daemon = await generateAnswerKeyPair();
      let received: Record<string, unknown> | null = null;
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          received = (await req.json()) as Record<string, unknown>;
          return new Response(JSON.stringify({ result: 'delivered' }), { status: 200 });
        },
      });
      try {
        await relayAnswerViaSignaling({
          signalingUrl: `http://127.0.0.1:${server.port}`,
          code: 'WXYZ-2345',
          sessionId: 's1',
          questionId: 'q1',
          answer: 'Yes',
          authRequired: true,
          answerEncryptionKey: daemon.publicKeyBase64,
        });
        const body = received as unknown as Record<string, unknown>;
        expect(JSON.stringify(body)).not.toContain('clientFingerprint');
        const opened = (await openSealedAnswer(
          daemon.privateKeyPkcs8Base64,
          body as unknown as { ephemeralPublicKey: string; sealed: string },
        )) as Record<string, unknown>;
        expect(opened['auth']).toBeTruthy();
      } finally {
        server.stop();
      }
    });
  });
});
