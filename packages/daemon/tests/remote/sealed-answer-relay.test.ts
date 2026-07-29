/**
 * Sealed lock-screen answers, through the real relay path (#875).
 *
 * Drives a real `RelayAdapter` with a real answer key, feeding it exactly what
 * the Worker forwards. The point is not that the crypto works, which
 * `shared/tests/sealed-answer.test.ts` covers, but that the daemon opens what
 * the phone sealed and refuses everything else.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateAnswerKeyPair, sealAnswer, sign, toBase64 } from '@remi/shared';
import type { AnswerKeyPair } from '@remi/shared';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { RelayAdapter, type RelayTransport } from '../../src/remote/relay-adapter.ts';

class StubTransport implements RelayTransport {
  readonly sent: string[] = [];
  isConnected = true;
  connectionCode: string | null = 'TEST-CODE';
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the emitter's shape
  on(event: string, cb: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  sendRelay(payload: string): void {
    this.sent.push(payload);
  }
  connect(): void {}
  close(): void {}
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

describe('daemon opens sealed lock-screen answers', () => {
  let dir: string;
  let transport: StubTransport;
  let adapter: RelayAdapter | null = null;
  let answerKey: AnswerKeyPair;
  let delivered: { sessionId: string; questionId: string; answer: string }[];
  let clientPublicKeyRaw: string;
  let clientFingerprint: string;
  let signBody: (message: string) => Promise<string>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-sealed-'));
    transport = new StubTransport();
    answerKey = await generateAnswerKeyPair();
    delivered = [];

    const store = new IdentityStore(dir);
    await store.generate('serverpass');
    const identity = await store.unlock('serverpass');
    const authenticator = new Authenticator({
      identity,
      identityStore: store,
      tofuMode: 'auto-accept',
    });

    // A phone the daemon already trusts.
    const clientStore = new IdentityStore(path.join(dir, 'client'));
    await clientStore.generate('clientpass');
    const clientIdentity = await clientStore.unlock('clientpass');
    clientPublicKeyRaw = clientIdentity.publicKeyRaw;
    clientFingerprint = clientIdentity.fingerprint;
    await store.addAuthorizedKey(clientPublicKeyRaw, 'test-phone');
    signBody = (message: string) =>
      sign(clientIdentity.privateKey, new TextEncoder().encode(message).buffer as ArrayBuffer);

    adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: 'wss://example.invalid',
        code: 'TEST-CODE',
        rotateCode: false,
        authenticator,
        createTransport: () => transport,
      },
      {
        onAnswerRelay: async (sessionId, questionId, answer) => {
          delivered.push({ sessionId, questionId, answer });
          return 'delivered';
        },
      },
    );
    adapter.setAnswerKey(answerKey);
    await adapter.start();
  });

  afterEach(async () => {
    await adapter?.stop();
    adapter = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Exactly what the Worker forwards for a sealed answer. */
  async function forwardSealed(
    body: Record<string, unknown>,
    key = answerKey.publicKeyBase64,
  ): Promise<void> {
    const envelope = await sealAnswer(key, body);
    transport.emit('relay', JSON.stringify({ type: 'answer', ...envelope }));
    await settle();
  }

  async function signedBody(answer: string): Promise<Record<string, unknown>> {
    const sessionId = '0199f3a1-0000-7000-8000-000000000001';
    const questionId = '0199f3a1-0000-7000-8000-000000000002';
    return {
      sessionId,
      questionId,
      answer,
      auth: {
        signature: await signBody(`${sessionId}|${questionId}|${answer}`),
        clientPublicKey: clientPublicKeyRaw,
        clientFingerprint,
      },
    };
  }

  test('a sealed answer from a trusted phone is delivered', async () => {
    await forwardSealed(await signedBody('yes'));
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.answer).toBe('yes');
  });

  test('the signature inside is still verified after opening', async () => {
    // Sealing hides the answer from the Worker; it does not excuse the phone
    // from proving who it is. A body whose signature covers different text
    // must not be honored.
    const body = await signedBody('yes');
    await forwardSealed({ ...body, answer: 'no' });
    expect(delivered.length).toBe(0);
  });

  test('an answer sealed to a different daemon is refused', async () => {
    const other = await generateAnswerKeyPair();
    await forwardSealed(await signedBody('yes'), other.publicKeyBase64);
    expect(delivered.length).toBe(0);
  });

  test('a tampered envelope is refused', async () => {
    const envelope = await sealAnswer(answerKey.publicKeyBase64, await signedBody('yes'));
    const bytes = new Uint8Array(Buffer.from(envelope.sealed, 'base64'));
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    transport.emit(
      'relay',
      JSON.stringify({
        type: 'answer',
        ephemeralPublicKey: envelope.ephemeralPublicKey,
        sealed: Buffer.from(bytes).toString('base64'),
      }),
    );
    await settle();
    expect(delivered.length).toBe(0);
  });

  test('a daemon with no answer key refuses rather than guessing', async () => {
    // Its own transport: sharing the outer one would let the keyed adapter
    // answer and the assertion would pass for the wrong reason.
    const bareTransport = new StubTransport();
    let bareDelivered = 0;
    const bare = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: 'wss://example.invalid',
        code: 'TEST-CODE',
        rotateCode: true,
        createTransport: () => bareTransport,
      },
      {
        onAnswerRelay: async () => {
          bareDelivered++;
          return 'delivered';
        },
      },
    );
    await bare.start();
    const envelope = await sealAnswer(answerKey.publicKeyBase64, await signedBody('yes'));
    bareTransport.emit('relay', JSON.stringify({ type: 'answer', ...envelope }));
    await settle();
    expect(bareDelivered).toBe(0);
    await bare.stop();
  });

  test('the plaintext shape still works', async () => {
    // A client that predates sealing keeps functioning; the daemon decides
    // what it honors, and the Worker no longer decides anything.
    const body = await signedBody('yes');
    transport.emit('relay', JSON.stringify({ type: 'answer', ...body }));
    await settle();
    expect(delivered.length).toBe(1);
  });

  test('the sealed envelope really is opaque', async () => {
    // Same assertion the Worker's own view would produce.
    const body = await signedBody('deploy to production');
    const envelope = await sealAnswer(answerKey.publicKeyBase64, body);
    const wire = JSON.stringify({ type: 'answer', ...envelope });
    expect(wire).not.toContain('deploy to production');
    expect(wire).not.toContain(body['sessionId'] as string);
    expect(wire).not.toContain(clientFingerprint);
    void toBase64;
  });
});
