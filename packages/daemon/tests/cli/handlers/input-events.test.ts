import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createInputHandlers } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

/**
 * Minimal PTY/MessageAPI fakes, loosely inspired by the cast-through-unknown
 * pattern in `tests/session-registry.test.ts` (`createMockPTY` / `createMockMessageAPI`).
 * Extended here to capture writes/submits so handlers can be asserted on
 * observable behavior. Real PTYSession would spawn a shell; real MessageAPI
 * would install callbacks. These fakes cover only the surface the handlers
 * actually call: `write`, `submitInput`, `close` (called by
 * `sessionRegistry.shutdown()` in `afterEach`), and `getFullBulletContent`.
 */
function fakePTY(capture: {
  writes: string[];
  submits: string[];
  writeError?: Error;
  submitError?: Error;
}): PTYSession {
  return {
    id: generateId(),
    write: (content: string) => {
      if (capture.writeError) throw capture.writeError;
      capture.writes.push(content);
    },
    submitInput: async (content: string) => {
      if (capture.submitError) throw capture.submitError;
      capture.submits.push(content);
    },
    close: async () => {},
  } as unknown as PTYSession;
}

function fakeMessageAPI(bulletMap: Map<number, string | null>): MessageAPI {
  return {
    getFullBulletContent: (bulletId: number) => bulletMap.get(bulletId) ?? null,
  } as unknown as MessageAPI;
}

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const QID = 'ques0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

describe('createInputHandlers', () => {
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let tmpDir: string;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let send: (connectionId: UUID, message: ProtocolMessage) => boolean;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-input-events-'));
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    sendCalls = [];
    send = (connectionId, message) => {
      sendCalls.push({ connectionId, message });
      return true;
    };
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('onUserInput', () => {
    test('routes raw input to pty.write (no Enter appended)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.attachConnection(sessionId, CID);

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onUserInput(CID, sessionId, '\x1b[A', true);

      expect(ptyCapture.writes).toEqual(['\x1b[A']);
      expect(ptyCapture.submits).toEqual([]);
    });

    test('routes structured input to pty.submitInput (appends Enter)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.attachConnection(sessionId, CID);

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onUserInput(CID, sessionId, 'hello world', false);

      expect(ptyCapture.submits).toEqual(['hello world']);
      expect(ptyCapture.writes).toEqual([]);
    });

    test('logs and returns when no session is attached to the connection', async () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });

      await handlers.onUserInput(
        CID,
        'nosn0000-0000-0000-0000-000000000000' as UUID,
        'ignored',
        false,
      );

      expect(logs.some((m) => m.includes('No session found for connection'))).toBe(true);
    });

    test('swallows pty.write errors and logs them (raw path)', async () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const ptyCapture = {
        writes: [] as string[],
        submits: [] as string[],
        writeError: new Error('broken pipe'),
      };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.attachConnection(sessionId, CID);

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      // Should not throw
      await handlers.onUserInput(CID, sessionId, 'x', true);

      expect(
        logs.some((m) => m.includes('[PTY] raw write failed') && m.includes('broken pipe')),
      ).toBe(true);
    });
  });

  describe('onAnswer', () => {
    test('submits answer via pty and clears the pending question', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'yes?',
        options: [
          { value: 'yes', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'no', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onAnswer(CID, sessionId, QID, 'yes');

      expect(ptyCapture.submits).toEqual(['yes']);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('a throwing submitInput still consumes the question (no zombie) and propagates the error', async () => {
      // Defense against double-submit on retry: even if the PTY submit throws,
      // the question must be removed exactly once (finally), and the error must
      // surface to the caller rather than being swallowed.
      const ptyCapture = {
        writes: [] as string[],
        submits: [] as string[],
        submitError: new Error('pty closed'),
      };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'proceed?',
        options: [
          { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await expect(handlers.onAnswer(CID, sessionId, QID, 'y')).rejects.toThrow('pty closed');

      // No zombie question left behind for a retry to double-submit.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('falls back to connection lookup when sessionId is unknown', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.attachConnection(sessionId, CID);
      // Pre-seed a question so we can assert the fallback path clears it on
      // the REAL session's id, not on the bogus arg it was handed.
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'proceed?',
        options: [
          { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      // Pass a bogus sessionId, handler should still find the session via connection
      await handlers.onAnswer(CID, 'bogus000-0000-0000-0000-000000000000' as UUID, QID, 'hello');

      expect(ptyCapture.submits).toEqual(['hello']);
      // Question must be cleared on the real session id, not the bogus one.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('drops answer when no question is pending (stale APNS push answer)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      // No updateQuestion call: currentQuestion stays null. APNS tokens persist
      // across disconnect (#286), so a delayed lock-screen tap can deliver an
      // answer for a question that has already been auto-approved or replaced.
      // The handler must NOT submit anything to the live PTY in that case, and
      // must signal the drop back to the iOS client so the user is not left
      // wondering whether their tap landed.

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onAnswer(CID, sessionId, QID, 'hi');

      expect(ptyCapture.submits).toEqual([]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      const errors = sendCalls.filter((c) => c.message.type === 'error');
      expect(errors).toHaveLength(1);
      expect((errors[0]?.message as unknown as { code: string }).code).toBe('STALE_ANSWER');
    });

    test('drops answer when questionId does not match active question', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'current?',
        options: [
          { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const stale = 'stal0000-0000-0000-0000-000000000000' as UUID;
      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onAnswer(CID, sessionId, stale, 'yes');

      expect(ptyCapture.submits).toEqual([]);
      // Active question stays pending; only the matching answer removes it.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.has(QID)).toBe(true);
      const errors = sendCalls.filter((c) => c.message.type === 'error');
      expect(errors).toHaveLength(1);
      const errMsg = errors[0]?.message as unknown as {
        code: string;
        details?: { pendingQuestionIds: string[] };
      };
      expect(errMsg.code).toBe('STALE_ANSWER');
      expect(errMsg.details?.pendingQuestionIds).toContain(QID);
    });

    test('two concurrent questions: answering one leaves the other answerable (#437)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      const q2 = 'q2000000-0000-0000-0000-000000000000' as UUID;
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'main?',
        options: [],
        allowsFreeText: true,
        isAnswered: false,
      });
      sessionRegistry.addQuestion(sessionId, {
        id: q2,
        text: 'subagent?',
        options: [],
        allowsFreeText: true,
        isAnswered: false,
        agentId: 'sub-7',
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      // Answer the first; it should inject and be removed, the second stays.
      await handlers.onAnswer(CID, sessionId, QID, 'one');
      expect(ptyCapture.submits).toEqual(['one']);
      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
      const after1 = sessionRegistry.getSession(sessionId)?.currentQuestions;
      expect(after1?.has(QID)).toBe(false);
      expect(after1?.has(q2)).toBe(true);

      // Answer the second; no STALE_ANSWER, injected and removed.
      await handlers.onAnswer(CID, sessionId, q2, 'two');
      expect(ptyCapture.submits).toEqual(['one', 'two']);
      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('logs when neither sessionId nor connectionId maps to a session', async () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });

      await handlers.onAnswer(CID, 'miss0000-0000-0000-0000-000000000000' as UUID, QID, 'y');

      expect(logs.some((m) => m.includes('No session found'))).toBe(true);
    });
  });

  describe('onAnswer held-permission resolution (Model B, #573)', () => {
    function addYesNoQuestion(sessionId: UUID): void {
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Allow Bash: git push',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: '2', label: 'Yes, always', isRecommended: false, isYes: true, isNo: false },
          { value: '3', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });
    }

    test('Yes answer maps to allow, resolves the held hook, and SKIPS the PTY submit', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoQuestion(sessionId);

      const held: Array<{ sessionId: UUID; questionId: UUID; decision: 'allow' | 'deny' }> = [];
      const cancels: Array<{ sessionId: UUID; questionId: UUID; reason: string }> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: (s, q, d) => {
          held.push({ sessionId: s, questionId: q, decision: d });
          return true; // a hold existed and was resolved
        },
        cancelAutoApproveForQuestion: (s, q, reason) =>
          cancels.push({ sessionId: s, questionId: q, reason }),
      });

      await handlers.onAnswer(CID, sessionId, QID, '1'); // option 1 = Yes

      expect(held).toEqual([{ sessionId, questionId: QID, decision: 'allow' }]);
      expect(ptyCapture.submits).toEqual([]); // held -> no PTY submit
      // #617: the answer cancels exactly this question's eval (frees the GPU).
      expect(cancels).toEqual([{ sessionId, questionId: QID, reason: 'user-answered' }]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('No answer maps to deny and resolves the held hook', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoQuestion(sessionId);

      const held: Array<'allow' | 'deny'> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: (_s, _q, d) => {
          held.push(d);
          return true;
        },
      });

      await handlers.onAnswer(CID, sessionId, QID, '3'); // option 3 = No

      expect(held).toEqual(['deny']);
      expect(ptyCapture.submits).toEqual([]);
    });

    test('"Yes, always" releases the held hook to passthrough and submits the digit (FIX 1)', async () => {
      // "always" cannot be expressed by the binary hook response, so it must NOT
      // resolve the hold as a one-time allow; instead the hook is released to
      // passthrough and the digit is submitted into the native prompt.
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoQuestion(sessionId);

      const resolveDecisions: Array<'allow' | 'deny'> = [];
      const released: UUID[] = [];
      const cancels: Array<{ sessionId: UUID; questionId: UUID; reason: string }> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        // A held hook exists, but resolveHeldPermission must NOT be consulted for
        // "always" (decision === null), so it would return true if wrongly called.
        resolveHeldPermission: (_s, _q, d) => {
          resolveDecisions.push(d);
          return true;
        },
        releaseHeldAsPassthrough: (_s, q) => {
          released.push(q);
          return true; // a hold existed and was popped to passthrough
        },
        cancelAutoApproveForQuestion: (s, q, reason) =>
          cancels.push({ sessionId: s, questionId: q, reason }),
      });

      await handlers.onAnswer(CID, sessionId, QID, '2'); // option 2 = Yes, always

      expect(resolveDecisions).toEqual([]); // never resolved as a one-time allow
      expect(released).toEqual([QID]); // hook released to passthrough
      expect(ptyCapture.submits).toEqual(['2']); // digit submitted into the native prompt
      // #617: still cancels this question's eval (frees the GPU).
      expect(cancels).toEqual([{ sessionId, questionId: QID, reason: 'user-answered' }]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('a non-held answer still scoped-cancels its own question and submits to the PTY (#617)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoQuestion(sessionId);

      const cancels: Array<{ sessionId: UUID; questionId: UUID; reason: string }> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => false, // no hold for this question
        releaseHeldAsPassthrough: () => false, // no hold to release either
        cancelAutoApproveForQuestion: (s, q, reason) =>
          cancels.push({ sessionId: s, questionId: q, reason }),
      });

      await handlers.onAnswer(CID, sessionId, QID, '1');

      expect(ptyCapture.submits).toEqual(['1']); // falls back to the PTY path
      // #617: every answer fires the per-question cancel. It is now SAFE because
      // the gate scopes it by eval id (cancelEvalForQuestion is a no-op when no
      // eval is tracked for this question) — the wrong-victim protection moved
      // from this gate-on-hadHold into the gate's per-eval scoping (tested there).
      expect(cancels).toEqual([{ sessionId, questionId: QID, reason: 'user-answered' }]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('a free-text answer (no yes/no option match) takes the PTY path', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'name?',
        options: [],
        allowsFreeText: true,
        isAnswered: false,
      });

      let resolveHeldCalled = false;
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => {
          resolveHeldCalled = true;
          return true;
        },
        releaseHeldAsPassthrough: () => false, // no hold for a free-text prompt
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Alice');

      // No yes/no option matched -> decision is null -> resolveHeld not consulted.
      expect(resolveHeldCalled).toBe(false);
      expect(ptyCapture.submits).toEqual(['Alice']);
    });

    test('without the held-permission deps wired, onAnswer behaves exactly as before', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoQuestion(sessionId);

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onAnswer(CID, sessionId, QID, '1');

      expect(ptyCapture.submits).toEqual(['1']); // PTY path, no held resolution
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });
  });

  describe('onAnswer value-or-label resolution (#574)', () => {
    function addYesNoAlwaysQuestion(sessionId: UUID): void {
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Allow Bash: git push',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: '2', label: 'Yes, always', isRecommended: false, isYes: true, isNo: false },
          { value: '3', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });
    }

    function makeSession(): UUID {
      const sessionId = sessionRegistry.createSessionId();
      return sessionId;
    }

    test('a label "No" (phone display) resolves to deny via the held hook', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoAlwaysQuestion(sessionId);

      const held: Array<'allow' | 'deny'> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: (_s, _q, d) => {
          held.push(d);
          return true;
        },
      });

      // The phone sent the LABEL, not the value.
      await handlers.onAnswer(CID, sessionId, QID, 'No');

      expect(held).toEqual(['deny']); // resolved by label
      expect(ptyCapture.submits).toEqual([]); // held -> no PTY submit
    });

    test('a label "Yes" resolves to allow via the held hook (no PTY submit)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoAlwaysQuestion(sessionId);

      const held: Array<'allow' | 'deny'> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: (_s, _q, d) => {
          held.push(d);
          return true;
        },
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(held).toEqual(['allow']);
      expect(ptyCapture.submits).toEqual([]);
    });

    test('the label "Yes, always" releases to passthrough and submits the option VALUE (index), not the label', async () => {
      // Phase-2 "always" rule preserved: a label-sent "always" still cannot be
      // expressed by the binary response, so it pops to passthrough; the PTY
      // submit must be the digit Claude's native prompt expects ("2"), NOT "Yes, always".
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoAlwaysQuestion(sessionId);

      const released: UUID[] = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => {
          throw new Error('resolveHeldPermission must not be called for "always"');
        },
        releaseHeldAsPassthrough: (_s, q) => {
          released.push(q);
          return true;
        },
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes, always'); // sent as a LABEL

      expect(released).toEqual([QID]);
      expect(ptyCapture.submits).toEqual(['2']); // index, not the label
    });

    test('non-held PTY path: a label answer submits the option VALUE (index) into the native prompt', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoAlwaysQuestion(sessionId);

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        // No hold for this question on either path.
        resolveHeldPermission: () => false,
        releaseHeldAsPassthrough: () => false,
      });

      // "No" is no-shaped -> decision 'deny', but no hold exists, so it falls to
      // the PTY path; the digit "3" must be submitted, not the label "No".
      await handlers.onAnswer(CID, sessionId, QID, 'No');

      expect(ptyCapture.submits).toEqual(['3']);
    });

    test('non-held PTY path: a numeric value answer still submits that value (back-compat)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoAlwaysQuestion(sessionId);

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => false,
        releaseHeldAsPassthrough: () => false,
      });

      // A Telegram/in-app client still sends the value "1"; it resolves to the
      // same option and submits "1".
      await handlers.onAnswer(CID, sessionId, QID, '1');

      expect(ptyCapture.submits).toEqual(['1']);
    });

    test('multi-choice pick by label submits the picked index, not the label', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      // A multi-choice prompt (ExitPlanMode-style) with non-binary labels.
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'How should I proceed?',
        options: [
          { value: '1', label: 'Keep planning', isRecommended: false, isYes: false, isNo: false },
          { value: '2', label: 'Accept the plan', isRecommended: true, isYes: false, isNo: false },
          { value: '3', label: 'Cancel', isRecommended: false, isYes: false, isNo: false },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => false, // non-binary -> decision null -> not consulted
        releaseHeldAsPassthrough: () => false,
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Accept the plan'); // label pick

      expect(ptyCapture.submits).toEqual(['2']); // index for Claude's native prompt
    });

    test('a free-text answer with no option match is submitted verbatim', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'What should I name it?',
        options: [],
        allowsFreeText: true,
        isAnswered: false,
      });

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => false,
        releaseHeldAsPassthrough: () => false,
      });

      await handlers.onAnswer(CID, sessionId, QID, 'my-widget');

      expect(ptyCapture.submits).toEqual(['my-widget']);
    });

    test('logs a label->value resolution and an unresolved-label verbatim submit (FIX 1A)', async () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoAlwaysQuestion(sessionId);

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => false,
        releaseHeldAsPassthrough: () => false,
      });

      // Label resolves to a different value -> logged as a translation.
      await handlers.onAnswer(CID, sessionId, QID, 'No');
      expect(logs.some((m) => m.includes('[Answer] resolved "No" -> "3"'))).toBe(true);

      // A label that matches no option (options present) -> logged as verbatim submit.
      addYesNoAlwaysQuestion(sessionId);
      logs.length = 0;
      await handlers.onAnswer(CID, sessionId, QID, 'Maybe');
      expect(logs.some((m) => m.includes('[Answer] "Maybe" matched no option (3)'))).toBe(true);
      expect(ptyCapture.submits).toContain('Maybe');
    });
  });

  describe('onBulletExpandRequest', () => {
    test('sends NOT_FOUND when session is missing', () => {
      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });

      handlers.onBulletExpandRequest(CID, 'noses000-0000-0000-0000-000000000000' as UUID, 1, REQ);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message;
      expect(msg?.type).toBe('error');
      expect((msg as { code?: string } | undefined)?.code).toBe('NOT_FOUND');
    });

    test('sends CONTENT_EXPIRED when the bullet is not in the MessageAPI cache', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY({ writes: [], submits: [] }),
        fakeMessageAPI(new Map()),
      );

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      handlers.onBulletExpandRequest(CID, sessionId, 99, REQ);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message;
      expect(msg?.type).toBe('error');
      expect((msg as { code?: string } | undefined)?.code).toBe('CONTENT_EXPIRED');
    });

    test('sends bullet_expand_response with full content when found', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY({ writes: [], submits: [] }),
        fakeMessageAPI(new Map([[7, 'full expanded content']])),
      );

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      handlers.onBulletExpandRequest(CID, sessionId, 7, REQ);

      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.message.type).toBe('bullet_expand_response');
    });
  });

  describe('STALE_BINDING guard (#429)', () => {
    function registerSessionWithBinding(claudeId: string): {
      sessionId: UUID;
      capture: { writes: string[]; submits: string[] };
    } {
      const capture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(capture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.attachConnection(sessionId, CID);
      sessionStore.save({
        remiSessionId: sessionId,
        claudeSessionId: claudeId,
        projectPath: '/test/dir',
        port: 0,
        pid: 0,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      return { sessionId, capture };
    }

    test('answer with matching claudeSessionId is forwarded', async () => {
      const bound = '11111111-2222-3333-4444-555555555555' as UUID;
      const { sessionId, capture } = registerSessionWithBinding(bound);
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'go?',
        options: [{ value: 'y', label: 'Y', isRecommended: true, isYes: true, isNo: false }],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onAnswer(CID, sessionId, QID, 'y', bound);

      expect(capture.submits).toEqual(['y']);
      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
    });

    test('answer with stale claudeSessionId is refused with STALE_BINDING', async () => {
      const bound = '11111111-2222-3333-4444-555555555555' as UUID;
      const stale = '99999999-aaaa-bbbb-cccc-dddddddddddd' as UUID;
      const { sessionId, capture } = registerSessionWithBinding(bound);
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'go?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onAnswer(CID, sessionId, QID, 'y', stale);

      expect(capture.submits).toEqual([]);
      const errs = sendCalls.filter((c) => c.message.type === 'error');
      expect(errs).toHaveLength(1);
      const err = errs[0]?.message as { code?: string; details?: Record<string, unknown> };
      expect(err.code).toBe('STALE_BINDING');
      expect(err.details?.['boundClaudeSessionId']).toBe(bound);
      expect(err.details?.['incomingClaudeSessionId']).toBe(stale);
    });

    test('answer without claudeSessionId (legacy client) is accepted', async () => {
      const bound = '11111111-2222-3333-4444-555555555555' as UUID;
      const { sessionId, capture } = registerSessionWithBinding(bound);
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'go?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onAnswer(CID, sessionId, QID, 'y');

      expect(capture.submits).toEqual(['y']);
      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
    });

    test('user_input with stale claudeSessionId is refused', async () => {
      const bound = '11111111-2222-3333-4444-555555555555' as UUID;
      const stale = '99999999-aaaa-bbbb-cccc-dddddddddddd' as UUID;
      const { sessionId, capture } = registerSessionWithBinding(bound);

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      await handlers.onUserInput(CID, sessionId, 'ls', false, stale);

      expect(capture.submits).toEqual([]);
      expect(capture.writes).toEqual([]);
      expect(sendCalls.filter((c) => c.message.type === 'error').length).toBe(1);
    });

    test('client-sent claudeSessionId but no daemon binding yet: accept (race window)', async () => {
      // Pre-spawn save in production makes this rare, but the contract
      // is fail-open for the race window. Construct it by registering
      // a session without saving the store entry.
      const capture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(capture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.attachConnection(sessionId, CID);
      // Deliberately do NOT call sessionStore.save here.
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'go?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      });
      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });

      const claudeId = '11111111-2222-3333-4444-555555555555' as UUID;
      await handlers.onAnswer(CID, sessionId, QID, 'y', claudeId);

      expect(capture.submits).toEqual(['y']);
      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
    });
  });

  // The connection-independent HTTP /answer relay (#575, P4a) shares the exact
  // same routing core as onAnswer, but reports a structured outcome instead of
  // sending error frames over a (non-existent) connection.
  describe('relayAnswer (HTTP /answer relay, #575 P4a)', () => {
    test('routes a free-text answer through the same PTY-submit core and returns delivered', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'proceed?',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: '2', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      const outcome = await handlers.relayAnswer(sessionId, QID, 'Yes');

      expect(outcome).toBe('delivered');
      // The phone sends the label; the relay resolves it back to the option value.
      expect(ptyCapture.submits).toEqual(['1']);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      // No connection, so no error frames are ever sent over the relay path.
      expect(sendCalls).toHaveLength(0);
    });

    test('resolves a HELD binary permission via the hook response (no PTY submit)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Allow Bash: git push',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: '2', label: 'Yes, always', isRecommended: false, isYes: true, isNo: false },
          { value: '3', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const held: Array<{ decision: 'allow' | 'deny' }> = [];
      const cancels: Array<{ questionId: UUID; reason: string }> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: (_s, _q, d) => {
          held.push({ decision: d });
          return true;
        },
        cancelAutoApproveForQuestion: (_s, q, reason) => cancels.push({ questionId: q, reason }),
      });

      const outcome = await handlers.relayAnswer(sessionId, QID, '1');

      expect(outcome).toBe('delivered');
      expect(held).toEqual([{ decision: 'allow' }]); // resolved via the held hook
      expect(ptyCapture.submits).toEqual([]); // held => no PTY submit
      // #617: the relay answer also frees the GPU, scoped to this question.
      expect(cancels).toEqual([{ questionId: QID, reason: 'user-answered' }]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('a throwing submit still consumes the question and propagates (route maps to 500)', async () => {
      const ptyCapture = {
        writes: [] as string[],
        submits: [] as string[],
        submitError: new Error('pty closed'),
      };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'proceed?',
        options: [{ value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false }],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      // The relay surfaces the throw (the HTTP route turns it into a 500).
      await expect(handlers.relayAnswer(sessionId, QID, 'Yes')).rejects.toThrow('pty closed');
      // Question consumed exactly once despite the throw.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('returns session-not-found for an unknown session (no error frame)', async () => {
      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      const outcome = await handlers.relayAnswer(
        'unknown0-0000-0000-0000-000000000000' as UUID,
        QID,
        'Yes',
      );
      expect(outcome).toBe('session-not-found');
      expect(sendCalls).toHaveLength(0);
    });

    test('returns stale when the question is no longer active (delayed lock-screen tap)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      // No question added: the relay must report stale rather than submitting.
      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      const outcome = await handlers.relayAnswer(sessionId, QID, 'Yes');

      expect(outcome).toBe('stale');
      expect(ptyCapture.submits).toEqual([]);
      expect(sendCalls).toHaveLength(0);
    });

    test('returns stale-binding when the claudeSessionId has rotated', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionStore.save({
        remiSessionId: sessionId,
        claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        projectPath: '/test/dir',
        port: 18765,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'proceed?',
        options: [],
        allowsFreeText: true,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });
      const outcome = await handlers.relayAnswer(
        sessionId,
        QID,
        'Yes',
        '99999999-8888-7777-6666-555555555555' as UUID,
      );

      expect(outcome).toBe('stale-binding');
      expect(ptyCapture.submits).toEqual([]);
    });
  });

  describe('onQuestionResolved cross-client dismissal (#585 P7)', () => {
    function registerWithQuestion(questionId: UUID): UUID {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: questionId,
        text: 'proceed?',
        options: [
          { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });
      return sessionId;
    }

    test('fires onQuestionResolved once with the answered ids on the delivered path', async () => {
      const sessionId = registerWithQuestion(QID);
      const resolved: Array<{ sessionId: UUID; questionId: UUID }> = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        onQuestionResolved: (s, q) => resolved.push({ sessionId: s, questionId: q }),
      });

      await handlers.onAnswer(CID, sessionId, QID, 'y');

      expect(resolved).toEqual([{ sessionId, questionId: QID }]);
    });

    test('does NOT fire for a stale answer (nothing was consumed)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      // No question registered -> the answer is stale.
      const resolved: UUID[] = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        onQuestionResolved: (_s, q) => resolved.push(q),
      });

      await handlers.onAnswer(CID, sessionId, QID, 'y');

      expect(resolved).toEqual([]);
    });

    test('a throwing onQuestionResolved never breaks answer handling', async () => {
      const sessionId = registerWithQuestion(QID);
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        onQuestionResolved: () => {
          throw new Error('broadcast boom');
        },
      });

      // The answer still delivers and the question is still consumed despite the
      // throwing broadcast (it is guarded in the finally).
      await expect(handlers.onAnswer(CID, sessionId, QID, 'y')).resolves.toBe(undefined);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });
  });
});
