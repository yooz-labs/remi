/**
 * The relay accepts nothing without an authenticator (#1193).
 *
 * Before this change a daemon that registered with the signaling Worker, which
 * every install did, accepted a peer the moment the Worker reported one and
 * took its plaintext messages, gated only by the 30-bit room code. No shipped
 * client can use the relay, so the path had no user and one attacker-shaped
 * door. These drive the REAL `RelayAdapter` through its `createTransport` seam
 * with real crypto and assert the door is shut on both paths:
 *
 * - a peer the Worker reports (`peer-connected`), and
 * - frames that arrive with no accepted peer. The Worker forwards a `relay`
 *   frame from a socket that never sent `join` straight to the host, so this
 *   path needs no peer at all (`connection-room.ts`, `getPeer` accepts any
 *   other socket and `handleSignaling` does not check the sender's role).
 *
 * The positive controls run the same payloads against a permanent-code adapter
 * after a real key exchange, so a refusal here cannot come from a payload the
 * adapter would have rejected anyway.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import { generateAnswerKeyPair, sealAnswer, sign } from '@remi/shared';
import type { AnswerKeyPair, UUID } from '@remi/shared';
import type { AdapterEvents } from '../../src/adapters/connection-adapter.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { RelayAdapter } from '../../src/remote/relay-adapter.ts';
import {
  RecordingTransport,
  makeAuthenticator,
  settle,
  startAuthenticatedRelayPeer,
} from './relay-test-peer.ts';

/** The payload the issue names: a single keystroke typed into the live session. */
const KEYSTROKE = { type: 'user_input', sessionId: 'x', content: '1\r', raw: true };
const ROOM_CODE = 'ABCD-2345';
const SIGNALING_URL = 'wss://relay-test.example.invalid/connect';

/** Capture what the adapter logs without printing it, and without touching what it does. */
function captureConsole(): { lines: () => string[]; restore: () => void } {
  const captured: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    }),
  );
  return {
    lines: () => captured,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

interface Calls {
  connects: number;
  userInputs: unknown[][];
  answers: unknown[][];
  relayedAnswers: unknown[][];
}

function recordingEvents(calls: Calls): Partial<AdapterEvents> {
  return {
    onConnect: () => {
      calls.connects++;
    },
    onUserInput: (...args: unknown[]) => {
      calls.userInputs.push(args);
    },
    onAnswer: (...args: unknown[]) => {
      calls.answers.push(args);
    },
    onAnswerRelay: async (...args: unknown[]) => {
      calls.relayedAnswers.push(args);
      return 'delivered' as const;
    },
  };
}

describe('relay adapter without an authenticator (the default shape)', () => {
  let transport: RecordingTransport;
  let adapter: RelayAdapter;
  let calls: Calls;
  let answerKey: AnswerKeyPair;
  let log: ReturnType<typeof captureConsole>;

  beforeEach(async () => {
    log = captureConsole();
    calls = { connects: 0, userInputs: [], answers: [], relayedAnswers: [] };
    transport = new RecordingTransport();
    answerKey = await generateAnswerKeyPair();
    adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: SIGNALING_URL,
        code: ROOM_CODE,
        rotateCode: true,
        createTransport: () => transport,
      },
      recordingEvents(calls),
    );
    // An answer key makes a relayed lock-screen answer openable, so a refusal
    // below cannot be "the daemon had no key to open it".
    adapter.setAnswerKey(answerKey);
    await adapter.start();
  });

  afterEach(async () => {
    await adapter.stop();
    log.restore();
  });

  test('a peer is refused: onConnect never fires and the peer is told why', async () => {
    transport.emit('peer-connected', 'client');
    await settle();

    expect(calls.connects).toBe(0);
    expect(adapter.connectionCount).toBe(0);
    expect(transport.sent).toHaveLength(1);
    const reply = JSON.parse(transport.sent[0] as string) as {
      type: string;
      success: boolean;
      error?: string;
    };
    expect(reply.type).toBe('auth_result');
    expect(reply.success).toBe(false);
    expect(reply.error).toBe('RELAY_AUTH_REQUIRED');
  });

  test('every peer is refused, not only the first', async () => {
    for (let i = 0; i < 3; i++) {
      transport.emit('peer-connected', 'client');
      transport.emit('peer-disconnected', 'client');
    }
    await settle();
    expect(calls.connects).toBe(0);
    expect(transport.sent).toHaveLength(3);
  });

  test('the refusal is logged once per peer and carries no secret', async () => {
    const before = log.lines().length;
    transport.emit('peer-connected', 'client');
    await settle();

    const refusals = log.lines().slice(before);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('refused');
    expect(refusals[0]).toContain('--auth --permanent-code');
    for (const line of log.lines()) {
      expect(line).not.toContain(ROOM_CODE);
      expect(line).not.toContain(SIGNALING_URL);
    }
  });

  test('a keystroke payload with no peer never reaches the input handler', async () => {
    transport.emit('relay', JSON.stringify(KEYSTROKE));
    await settle();
    expect(calls.userInputs).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  test('a keystroke payload after a refused peer never reaches the input handler', async () => {
    transport.emit('peer-connected', 'client');
    await settle();
    transport.emit('relay', JSON.stringify(KEYSTROKE));
    await settle();
    expect(calls.userInputs).toHaveLength(0);
  });

  test('an answer payload with no peer is not dispatched, unsigned or with an empty auth block', async () => {
    // The lock-screen answer path needs no peer; without an authenticator it
    // used to trust the room code alone (`handleRelayedAnswer`).
    const answer = { sessionId: 's', questionId: 'q', answer: 'Yes' };
    transport.emit('relay', JSON.stringify({ type: 'answer', ...answer, auth: {} }));
    transport.emit('relay', JSON.stringify({ type: 'answer', ...answer }));
    await settle();
    expect(calls.relayedAnswers).toHaveLength(0);
    expect(calls.answers).toHaveLength(0);
  });

  test('a real signature from an authorized key is honored with an authenticator and dropped without one', async () => {
    // The strongest form of "signed or not": the answer carries a genuine
    // Ed25519 signature from a key the daemon's store authorizes. With an
    // authenticator on that store it is delivered; the adapter under test has
    // none, and must drop it all the same.
    const made = await makeAuthenticator();
    try {
      const clientStore = new IdentityStore(path.join(made.dir, 'client'));
      await clientStore.generate('clientpass');
      const client = await clientStore.unlock('clientpass');
      await made.store.addAuthorizedKey(client.publicKeyRaw, 'test-phone');
      const sessionId = '0199f3a1-0000-7000-8000-000000000001';
      const questionId = '0199f3a1-0000-7000-8000-000000000002';
      const body = {
        type: 'answer',
        sessionId,
        questionId,
        answer: 'Yes',
        auth: {
          signature: await sign(
            client.privateKey,
            new TextEncoder().encode(`${sessionId}|${questionId}|Yes`).buffer as ArrayBuffer,
          ),
          clientPublicKey: client.publicKeyRaw,
          clientFingerprint: client.fingerprint,
        },
      };

      // Control: an adapter that has the authenticator delivers it.
      const controlCalls: Calls = { connects: 0, userInputs: [], answers: [], relayedAnswers: [] };
      const controlTransport = new RecordingTransport();
      const control = new RelayAdapter(
        {
          enabled: true,
          signalingUrl: SIGNALING_URL,
          code: ROOM_CODE,
          rotateCode: false,
          authenticator: made.authenticator,
          createTransport: () => controlTransport,
        },
        recordingEvents(controlCalls),
      );
      await control.start();
      controlTransport.emit('relay', JSON.stringify(body));
      await settle(() => controlCalls.relayedAnswers.length > 0);
      await control.stop();
      expect(controlCalls.relayedAnswers).toHaveLength(1);

      // Under test: no authenticator, same frame.
      transport.emit('relay', JSON.stringify(body));
      await settle();
      expect(calls.relayedAnswers).toHaveLength(0);
    } finally {
      made.remove();
    }
  });

  test('a sealed answer with no peer is not opened or dispatched', async () => {
    const envelope = await sealAnswer(answerKey.publicKeyBase64, {
      sessionId: 's',
      questionId: 'q',
      answer: 'Yes',
    });
    transport.emit('relay', JSON.stringify({ type: 'answer', ...envelope }));
    await settle();
    expect(calls.relayedAnswers).toHaveLength(0);
  });

  test('an auth_response with no challenge outstanding is dropped without a reply', async () => {
    transport.emit('relay', JSON.stringify({ type: 'auth_response', clientPublicKey: 'x' }));
    await settle();
    expect(transport.sent).toHaveLength(0);
    expect(calls.connects).toBe(0);
  });

  test('frames are dropped with one log line, however many arrive', async () => {
    const before = log.lines().length;
    for (let i = 0; i < 5; i++) transport.emit('relay', JSON.stringify(KEYSTROKE));
    await settle();
    expect(log.lines().slice(before)).toHaveLength(1);
  });

  test('nothing leaves but the refusal frame, whatever the daemon tries to send', async () => {
    transport.emit('peer-connected', 'client');
    await settle();
    const frame = {
      type: 'agent_output',
      id: '0199f3a1-0000-7000-8000-000000000001',
      timestamp: new Date().toISOString(),
      sessionId: '0199f3a1-0000-7000-8000-000000000002',
      content: 'a secret in the output',
      // biome-ignore lint/suspicious/noExplicitAny: minimal literal for the test
    } as any;

    expect(adapter.sendRaw('0199f3a1-0000-7000-8000-000000000003' as UUID, frame)).toBe(false);
    adapter.broadcast(frame);
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).not.toContain('a secret in the output');
    expect(JSON.parse(transport.sent[0] as string).type).toBe('auth_result');
  });

  test('the startup notice says no relay client can connect and what to use instead', () => {
    const notice = log.lines().find((line) => line.includes('no relay client can connect'));
    expect(notice).toBeDefined();
    expect(notice).toContain('--auth --permanent-code');
    expect(notice).toContain('SSH tunnel');
    expect(notice).toContain('daemon.bind');
    // One or two lines, and nothing a reader could use to find the room.
    expect((notice as string).split('\n').length).toBeLessThanOrEqual(2);
    expect(notice).not.toContain(ROOM_CODE);
    expect(notice).not.toContain(SIGNALING_URL);
  });

  test('the room code is not printed when nobody can use it', () => {
    transport.emit('registered', ROOM_CODE, new Date().toISOString());
    transport.emit('open');
    transport.emit('code-rotated', 'WXYZ-6789');
    for (const line of log.lines()) {
      expect(line).not.toContain(ROOM_CODE);
      expect(line).not.toContain('WXYZ-6789');
    }
  });
});

describe('relay adapter with an authenticator (permanent code), the unchanged path', () => {
  let log: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    log = captureConsole();
  });

  afterEach(() => {
    log.restore();
  });

  test('the same keystroke payload, sealed after a real key exchange, DOES reach the input handler', async () => {
    const calls: Calls = { connects: 0, userInputs: [], answers: [], relayedAnswers: [] };
    const peer = await startAuthenticatedRelayPeer(recordingEvents(calls));
    try {
      expect(calls.connects).toBe(1);
      await peer.send(KEYSTROKE, () => calls.userInputs.length > 0);
      expect(calls.userInputs).toHaveLength(1);
      // onUserInput(connectionId, sessionId, content, raw, ...)
      expect(calls.userInputs[0]?.slice(1, 4)).toEqual(['x', '1\r', true]);
    } finally {
      await peer.dispose();
    }
  });

  test('the same payload sent in the clear after the key exchange is still refused', async () => {
    const calls: Calls = { connects: 0, userInputs: [], answers: [], relayedAnswers: [] };
    const peer = await startAuthenticatedRelayPeer(recordingEvents(calls));
    try {
      peer.transport.emit('relay', JSON.stringify(KEYSTROKE));
      await settle();
      expect(calls.userInputs).toHaveLength(0);
    } finally {
      await peer.dispose();
    }
  });

  test('no startup notice is printed, and the room code is, because a client can use it', async () => {
    const peer = await startAuthenticatedRelayPeer({});
    try {
      peer.transport.emit('registered', ROOM_CODE, new Date().toISOString());
      expect(log.lines().some((line) => line.includes('no relay client can connect'))).toBe(false);
      expect(log.lines().some((line) => line.includes(ROOM_CODE))).toBe(true);
    } finally {
      await peer.dispose();
    }
  });
});

// #1193 review F1: the permanent-code mode authenticates a key, but by default
// (trust on first use, `tofuMode: 'auto-accept'`) it ADDS any unknown key it is
// shown to the authorized keys. So anyone who knows the room code is admitted on
// their first connection. This change does not widen into a behavior change;
// it makes the property loud at boot, with the way to turn it off.
describe('permanent-code mode warns that trust on first use admits unknown keys', () => {
  let log: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    log = captureConsole();
  });

  afterEach(() => {
    log.restore();
  });

  async function startWith(tofuMode: 'auto-accept' | 'reject'): Promise<string[]> {
    const made = await makeAuthenticator(tofuMode);
    const transport = new RecordingTransport();
    const adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: SIGNALING_URL,
        code: ROOM_CODE,
        rotateCode: false,
        authenticator: made.authenticator,
        createTransport: () => transport,
      },
      {},
    );
    try {
      await adapter.start();
      return log.lines();
    } finally {
      await adapter.stop();
      made.remove();
    }
  }

  test('with trust on first use (the default) it says unknown keys are added, and how to stop that', async () => {
    const lines = await startWith('auto-accept');
    const warning = lines.find((line) => line.includes('authorized keys'));
    expect(warning).toBeDefined();
    expect(warning).toContain('first connection');
    expect(warning).toContain('--no-tofu');
    // One or two lines, and nothing a reader could use to find the room.
    expect((warning as string).split('\n').length).toBeLessThanOrEqual(2);
    expect(warning).not.toContain(ROOM_CODE);
    expect(warning).not.toContain(SIGNALING_URL);
  });

  test('with --no-tofu (reject) there is no such warning', async () => {
    const lines = await startWith('reject');
    expect(lines.some((line) => line.includes('authorized keys'))).toBe(false);
  });
});
