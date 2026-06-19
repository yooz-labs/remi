/**
 * #591: the relay adapter routes a connection-independent (lock-screen) answer
 * forwarded by the signaling Worker. Unlike a peer's relay message it carries its
 * own Ed25519 `auth` block (there is no connected / handshake-authenticated WS
 * peer), which the adapter verifies before dispatching via onAnswerRelay.
 *
 * Uses REAL Ed25519 keys + a real Authenticator + a real IdentityStore (no mocks).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIdentity, sign, unlockIdentity } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';
import { RelayAdapter } from '../src/remote/relay-adapter.ts';

const SID = 'aaaaaaaa-0000-0000-0000-000000000000' as UUID;
const QID = 'bbbbbbbb-0000-0000-0000-000000000000' as UUID;
const ANSWER = 'yes';

interface Relayed {
  sessionId: UUID;
  questionId: UUID;
  answer: string;
  claudeSessionId?: UUID | undefined;
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-relay-answer-test-'));
}

async function signAuth(
  privateKey: CryptoKey,
  pub: string,
  fingerprint: string,
  message: string,
): Promise<{ signature: string; clientPublicKey: string; clientFingerprint: string }> {
  const data = new TextEncoder().encode(message).buffer as ArrayBuffer;
  const signature = await sign(privateKey, data);
  return { signature, clientPublicKey: pub, clientFingerprint: fingerprint };
}

function handle(adapter: RelayAdapter, msg: Record<string, unknown>): Promise<void> {
  return (
    adapter as unknown as { handleRelayedAnswer: (m: Record<string, unknown>) => Promise<void> }
  ).handleRelayedAnswer(msg);
}

function recordingEvents(calls: Relayed[]): object {
  return {
    onAnswerRelay: async (
      sessionId: UUID,
      questionId: UUID,
      answer: string,
      claudeSessionId?: UUID,
    ) => {
      calls.push({ sessionId, questionId, answer, claudeSessionId });
      return 'delivered' as const;
    },
  };
}

describe('relay-adapter self-authenticating answer (#591)', () => {
  let tmpDir: string;
  let authenticator: Authenticator;
  let clientPriv: CryptoKey;
  let clientPub: string;
  let clientFp: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    const store = new IdentityStore(tmpDir);
    await store.generate();
    const serverIdentity = await store.unlock();

    const clientFile = await createIdentity();
    const clientUnlocked = await unlockIdentity(clientFile);
    clientPriv = clientUnlocked.privateKey;
    clientPub = clientFile.publicKey;
    clientFp = clientFile.fingerprint;
    await store.addAuthorizedKey(clientPub, 'Test Phone');

    authenticator = new Authenticator({ identity: serverIdentity, identityStore: store });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  function authedAdapter(calls: Relayed[]): RelayAdapter {
    return new RelayAdapter(
      {
        signalingUrl: 'wss://ignored.example.com',
        code: 'ABCD-1234',
        rotateCode: false as const,
        authenticator,
      },
      recordingEvents(calls),
    );
  }

  test('valid signature -> dispatched via onAnswerRelay', async () => {
    const calls: Relayed[] = [];
    const auth = await signAuth(clientPriv, clientPub, clientFp, `${SID}|${QID}|${ANSWER}`);
    await handle(authedAdapter(calls), {
      type: 'answer',
      sessionId: SID,
      questionId: QID,
      answer: ANSWER,
      claudeSessionId: 'cccccccc-0000-0000-0000-000000000000',
      auth,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId: SID, questionId: QID, answer: ANSWER });
    expect(calls[0]?.claudeSessionId).toBe('cccccccc-0000-0000-0000-000000000000' as UUID);
  });

  test('signature over a DIFFERENT answer -> rejected (no dispatch)', async () => {
    const calls: Relayed[] = [];
    // sign 'no' but submit 'yes' — the canonical message won't match
    const auth = await signAuth(clientPriv, clientPub, clientFp, `${SID}|${QID}|no`);
    await handle(authedAdapter(calls), {
      type: 'answer',
      sessionId: SID,
      questionId: QID,
      answer: ANSWER,
      auth,
    });
    expect(calls).toHaveLength(0);
  });

  test('missing auth block -> rejected when authenticator is configured', async () => {
    const calls: Relayed[] = [];
    await handle(authedAdapter(calls), {
      type: 'answer',
      sessionId: SID,
      questionId: QID,
      answer: ANSWER,
      auth: {},
    });
    expect(calls).toHaveLength(0);
  });

  test('missing required fields -> dropped', async () => {
    const calls: Relayed[] = [];
    const auth = await signAuth(clientPriv, clientPub, clientFp, `${SID}||`);
    await handle(authedAdapter(calls), { type: 'answer', sessionId: SID, auth });
    expect(calls).toHaveLength(0);
  });

  test('no authenticator (rotating no-auth) -> dispatched code-gated, no signature needed', async () => {
    const calls: Relayed[] = [];
    const adapter = new RelayAdapter(
      { signalingUrl: 'wss://ignored.example.com' },
      recordingEvents(calls),
    );
    await handle(adapter, { type: 'answer', sessionId: SID, questionId: QID, answer: ANSWER });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId: SID, questionId: QID, answer: ANSWER });
  });
});
