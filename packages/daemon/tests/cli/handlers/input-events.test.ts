import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createInputHandlers } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { AUQ_KEYS } from '../../../src/hooks/auq-answer.ts';
import { appendPtyOutput, clearPtyOutput } from '../../../src/pty/output-buffer.ts';
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

/**
 * The #1002 guard refuses a PTY submit when no prompt is on screen, and
 * treats an unwired dep as "no prompt" (fail toward not injecting). Every
 * test below that exercises the PTY-submit path is describing the ordinary
 * case where Claude IS showing its prompt, so they say so explicitly rather
 * than inheriting the refusing default. The refusal itself is covered by its
 * own tests in the `#1002` block.
 */
const PROMPT_ON_SCREEN = { isPromptObservedOnPTY: () => true };
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onUserInput(CID, sessionId, 'hello world', false);

      expect(ptyCapture.submits).toEqual(['hello world']);
      expect(ptyCapture.writes).toEqual([]);
    });

    test('logs and returns when no session is attached to the connection', async () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      await handlers.onUserInput(
        CID,
        'nosn0000-0000-0000-0000-000000000000' as UUID,
        'ignored',
        false,
      );

      expect(logs.some((m) => m.includes('No session found for connection'))).toBe(true);
    });

    test('sends SESSION_NOT_FOUND when the session does not exist at all (#662)', async () => {
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      const missingSessionId = 'nosn0000-0000-0000-0000-000000000000' as UUID;

      await handlers.onUserInput(CID, missingSessionId, 'ignored', false);

      // Previously this input vanished with only a server-side log line; the
      // sender's UI showed it as "sent" with no error. Now an error is sent
      // back so the client can surface a failure instead of a silent drop.
      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string; code?: string };
      expect(msg.type).toBe('error');
      expect(msg.code).toBe('SESSION_NOT_FOUND');
    });

    test('a SECOND attached connection can also submit input (#795: no exclusive lock)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn);
      // CID is a SECOND connection attaching concurrently -- also attached,
      // not queued behind the first.
      sessionRegistry.attachConnection(sessionId, CID);

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onUserInput(firstConn, sessionId, 'from first', false);
      await handlers.onUserInput(CID, sessionId, 'from second', false);

      // Both submits landed -- neither connection was denied.
      expect(ptyCapture.submits).toEqual(['from first', 'from second']);
      expect(sendCalls).toHaveLength(0);
    });

    test('detaching one connection leaves the other still attached and able to type (#795)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn);
      sessionRegistry.attachConnection(sessionId, CID);

      // The first connection detaches (e.g. it closed its tab).
      sessionRegistry.detachConnection(firstConn);

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onUserInput(CID, sessionId, 'still typing', false);

      // CID's submit still lands -- it was never affected by the other
      // connection's detach.
      expect(ptyCapture.submits).toEqual(['still typing']);
      expect(sendCalls).toHaveLength(0);

      // The detached connection, meanwhile, can no longer submit.
      await handlers.onUserInput(firstConn, sessionId, 'too late', false);
      expect(ptyCapture.submits).toEqual(['still typing']);
      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string; code?: string };
      expect(msg.type).toBe('error');
      expect(msg.code).toBe('SESSION_NOT_FOUND');
    });

    test('sends SESSION_NOT_FOUND for a connection that never attached (e.g. query-mode misuse)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY({ writes: [], submits: [] }),
        fakeMessageAPI(new Map()),
      );
      // CID never attaches (as a query-mode connection would not).

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onUserInput(CID, sessionId, 'ignored', false);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as {
        type: string;
        code?: string;
        details?: { sessionId?: string; messageId?: string };
      };
      expect(msg.type).toBe('error');
      // New daemons never emit NOT_ACTIVE_CONNECTION (#795); the error code is
      // kept string-only for an older client talking to an older daemon.
      expect(msg.code).toBe('SESSION_NOT_FOUND');
      expect(msg.details?.sessionId).toBe(sessionId);
      // No messageId was passed in -- details must not carry a stray key.
      expect(msg.details?.messageId).toBeUndefined();
    });

    test('SESSION_NOT_FOUND details carry the rejected input message id (#681) for an unattached connection', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY({ writes: [], submits: [] }),
        fakeMessageAPI(new Map()),
      );
      // CID never attaches.

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      const droppedMessageId = generateId();
      await handlers.onUserInput(CID, sessionId, 'ignored', false, undefined, droppedMessageId);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as {
        type: string;
        code?: string;
        details?: { sessionId?: string; messageId?: string };
      };
      expect(msg.type).toBe('error');
      expect(msg.code).toBe('SESSION_NOT_FOUND');
      expect(msg.details?.sessionId).toBe(sessionId);
      // The specific dropped message's id, so the client can flip that ONE
      // bubble to 'failed'.
      expect(msg.details?.messageId).toBe(droppedMessageId);
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onAnswer(CID, sessionId, QID, 'yes');

      expect(ptyCapture.submits).toEqual(['yes']);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    describe('prompt-currency guard (#920)', () => {
      function addPtySourcedQuestion(sessionId: UUID): void {
        sessionRegistry.addQuestion(sessionId, {
          id: QID,
          text: 'Proceed? (y/n)',
          options: [
            { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
            { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
          ],
          allowsFreeText: false,
          isAnswered: false,
          source: 'pty',
        });
      }

      // A stale `source: 'pty'` card (#920: the residual leak cohort -- no
      // hook, so the active-question lookup alone cannot tell a live prompt
      // from one that scrolled off screen minutes ago) must NOT reach the
      // PTY, must clear itself, and must tell the client why.
      test('refuses the PTY submit and clears the card when the prompt is gone', async () => {
        const ptyCapture = { writes: [] as string[], submits: [] as string[] };
        const sessionId = sessionRegistry.createSessionId();
        sessionRegistry.registerSession(
          sessionId,
          '/test/dir',
          fakePTY(ptyCapture),
          fakeMessageAPI(new Map()),
        );
        addPtySourcedQuestion(sessionId);

        const resolvedCalls: Array<{ sessionId: UUID; questionId: UUID }> = [];
        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          isPromptCurrent: () => false, // the on-screen prompt is gone
          onQuestionResolved: (s, q) => resolvedCalls.push({ sessionId: s, questionId: q }),
        });

        await handlers.onAnswer(CID, sessionId, QID, 'y');

        expect(ptyCapture.submits).toEqual([]);
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
        const errors = sendCalls.filter((c) => c.message.type === 'error');
        expect(errors).toHaveLength(1);
        expect((errors[0]?.message as unknown as { code: string }).code).toBe('STALE_ANSWER');
        // The card must clear on every client (#585), not just refuse locally.
        expect(resolvedCalls).toEqual([{ sessionId, questionId: QID }]);
      });

      // The regression test that matters: a `source: 'pty'` card whose prompt
      // IS still on screen must submit exactly as before the guard existed.
      test('still submits normally when the prompt IS current', async () => {
        const ptyCapture = { writes: [] as string[], submits: [] as string[] };
        const sessionId = sessionRegistry.createSessionId();
        sessionRegistry.registerSession(
          sessionId,
          '/test/dir',
          fakePTY(ptyCapture),
          fakeMessageAPI(new Map()),
        );
        addPtySourcedQuestion(sessionId);

        const checked: Array<{ sessionId: UUID; questionId: UUID; ptyText: string }> = [];
        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          isPromptCurrent: (s, q, ptyText) => {
            checked.push({ sessionId: s, questionId: q, ptyText });
            return true;
          },
        });

        await handlers.onAnswer(CID, sessionId, QID, 'y');

        expect(ptyCapture.submits).toEqual(['y']);
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
        expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
        expect(checked).toEqual([{ sessionId, questionId: QID, ptyText: 'Proceed? (y/n)' }]);
      });

      // A hook-paired question's merged id/text are the HOOK's, never the raw
      // PTY parse (question-presence-tracker.ts consumeAndMerge), so a blanket
      // currency check would misfire on this cohort. The ID/TEXT guard is
      // scoped to `source === 'pty'` ONLY; proven with a spy that throws if
      // consulted.
      //
      // Renamed for #1002: this cohort IS checked now, just not by this dep —
      // `isPromptObservedOnPTY` asks the weaker "is anything on screen?", which
      // hook-paired cards CAN answer. The old name claimed the cohort was
      // unguarded, which was true and was the bug.
      test('a non-pty-sourced card is not checked by the id/text guard', async () => {
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
            { value: '2', label: 'No', isRecommended: false, isYes: false, isNo: true },
          ],
          allowsFreeText: false,
          isAnswered: false,
          source: 'permission_request',
        });

        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          isPromptCurrent: () => {
            throw new Error('isPromptCurrent must not be called for a non-pty source');
          },
        });

        await handlers.onAnswer(CID, sessionId, QID, '1');

        expect(ptyCapture.submits).toEqual(['1']);
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      });

      /**
       * #1002. Observed live: a bare `1` arrived in an unrelated session as a
       * chat message. The card was hook-sourced, its hold was already gone, so
       * `hadHold` was false and nothing released — and because the id/text
       * guard above is scoped to `source === 'pty'`, the digit went to the PTY
       * with nothing checked at all.
       */
      describe('#1002 no-prompt-on-screen guard for hook-sourced cards', () => {
        function addHookSourcedQuestion(sessionId: UUID): void {
          sessionRegistry.addQuestion(sessionId, {
            id: QID,
            text: 'Allow Bash: ls -la',
            options: [
              { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
              { value: '2', label: 'No', isRecommended: false, isYes: false, isNo: true },
            ],
            allowsFreeText: false,
            isAnswered: false,
            source: 'permission_request',
          });
        }

        test('no prompt on screen and no hold: refuses to submit, reports STALE_ANSWER', async () => {
          const ptyCapture = { writes: [] as string[], submits: [] as string[] };
          const sessionId = sessionRegistry.createSessionId();
          sessionRegistry.registerSession(
            sessionId,
            '/test/dir',
            fakePTY(ptyCapture),
            fakeMessageAPI(new Map()),
          );
          addHookSourcedQuestion(sessionId);

          const handlers = createInputHandlers({
            sessionRegistry,
            bindingStore,
            send,
            isPromptObservedOnPTY: () => false, // nothing on screen
          });

          await handlers.onAnswer(CID, sessionId, QID, '1');

          expect(ptyCapture.submits).toEqual([]); // the whole point: no stray digit
          expect(
            sendCalls.filter(
              (c) => c.message.type === 'error' && c.message.code === 'STALE_ANSWER',
            ),
          ).toHaveLength(1);
        });

        test('an unwired dep is treated as no prompt (fails toward not injecting)', async () => {
          const ptyCapture = { writes: [] as string[], submits: [] as string[] };
          const sessionId = sessionRegistry.createSessionId();
          sessionRegistry.registerSession(
            sessionId,
            '/test/dir',
            fakePTY(ptyCapture),
            fakeMessageAPI(new Map()),
          );
          addHookSourcedQuestion(sessionId);

          const handlers = createInputHandlers({ sessionRegistry, bindingStore, send });

          await handlers.onAnswer(CID, sessionId, QID, '1');
          expect(ptyCapture.submits).toEqual([]);
        });

        test('a prompt IS on screen: submits normally', async () => {
          const ptyCapture = { writes: [] as string[], submits: [] as string[] };
          const sessionId = sessionRegistry.createSessionId();
          sessionRegistry.registerSession(
            sessionId,
            '/test/dir',
            fakePTY(ptyCapture),
            fakeMessageAPI(new Map()),
          );
          addHookSourcedQuestion(sessionId);

          const handlers = createInputHandlers({
            sessionRegistry,
            bindingStore,
            send,
            isPromptObservedOnPTY: () => true,
          });

          await handlers.onAnswer(CID, sessionId, QID, '1');
          expect(ptyCapture.submits).toEqual(['1']);
          expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
        });

        /**
         * The condition that keeps this guard from breaking the legitimate
         * case. When the answer ITSELF pops a held hook to passthrough, Claude
         * is deliberately about to render its native prompt — so nothing is on
         * screen YET, and requiring presence here would refuse a good answer.
         */
        test('releasing a hold in this same call submits even with nothing on screen', async () => {
          const ptyCapture = { writes: [] as string[], submits: [] as string[] };
          const sessionId = sessionRegistry.createSessionId();
          sessionRegistry.registerSession(
            sessionId,
            '/test/dir',
            fakePTY(ptyCapture),
            fakeMessageAPI(new Map()),
          );
          addHookSourcedQuestion(sessionId);

          const handlers = createInputHandlers({
            sessionRegistry,
            bindingStore,
            send,
            releaseHeldAsPassthrough: () => true, // a hold existed, popped now
            isPromptObservedOnPTY: () => false, // prompt has not rendered yet
          });

          await handlers.onAnswer(CID, sessionId, QID, '1');
          expect(ptyCapture.submits).toEqual(['1']);
          expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
        });
      });

      // Held-hook answers resolve via the hook response and never PTY-submit
      // (the `hadHold` branch) -- the guard lives only on the `!hadHold`
      // PTY-submit branch, so it must never be consulted here, even for a
      // pty-sourced question with an (unusual but not impossible) hold.
      test('a held-hook answer is unaffected, even for a pty-sourced question', async () => {
        const ptyCapture = { writes: [] as string[], submits: [] as string[] };
        const sessionId = sessionRegistry.createSessionId();
        sessionRegistry.registerSession(
          sessionId,
          '/test/dir',
          fakePTY(ptyCapture),
          fakeMessageAPI(new Map()),
        );
        addPtySourcedQuestion(sessionId);

        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          resolveHeldPermission: () => true, // a hold existed and was resolved
          isPromptCurrent: () => {
            throw new Error('isPromptCurrent must not be called on the held-hook branch');
          },
        });

        await handlers.onAnswer(CID, sessionId, QID, 'y');

        expect(ptyCapture.submits).toEqual([]); // held -> no PTY submit
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
        expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
      });

      // #795: free-form PTY submission (raw keystrokes and structured input)
      // is a deliberate feature -- any attached client can type into the
      // session. The guard lives ONLY inside handleAnswer's card-submit
      // branch, never on onUserInput; proven with a spy that throws if
      // consulted.
      test('free-form user_input (raw and structured) is unaffected', async () => {
        const ptyCapture = { writes: [] as string[], submits: [] as string[] };
        const sessionId = sessionRegistry.createSessionId();
        sessionRegistry.registerSession(
          sessionId,
          '/test/dir',
          fakePTY(ptyCapture),
          fakeMessageAPI(new Map()),
        );
        sessionRegistry.attachConnection(sessionId, CID);

        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          isPromptCurrent: () => {
            throw new Error('isPromptCurrent must not be called for free-form user_input');
          },
        });

        await handlers.onUserInput(CID, sessionId, '\x1b[A', true);
        await handlers.onUserInput(CID, sessionId, 'hello world', false);

        expect(ptyCapture.writes).toEqual(['\x1b[A']);
        expect(ptyCapture.submits).toEqual(['hello world']);
      });
    });

    // #627: cancel/escape sends Esc to the PTY and clears the question — the
    // universal unstick, regardless of whether the prompt was understood.
    test('cancel sends Esc to the PTY and clears the question', async () => {
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
        text: 'Which design?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onAnswer(CID, sessionId, QID, '', undefined, { cancel: true });

      expect(ptyCapture.writes).toEqual([AUQ_KEYS.ESC]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    // #627: selections for a question that carries no structured `questions[]`
    // escalates (the user falls back to Cancel / terminal) WITHOUT removing it.
    test('selections on a non-structured question escalate, keeping the question', async () => {
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
        text: 'Allow Bash?',
        options: [{ value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false }],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onAnswer(CID, sessionId, QID, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [0] }],
      });

      expect(sendCalls.some((c) => c.message.type === 'error')).toBe(true);
      // The question stays so the user can still Cancel or answer in the terminal.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(1);
    });

    // #627: a structured single-select AUQ is driven via keystrokes; feeding the
    // closure marker into the output buffer (as a real Claude would) closes it.
    test('structured AskUserQuestion: drives keystrokes and closes on the marker', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      // PTY whose ENTER write makes "Claude" accept the answer (closure marker).
      const pty = {
        id: generateId(),
        write: (content: string) => {
          ptyCapture.writes.push(content);
          if (content === AUQ_KEYS.ENTER) {
            appendPtyOutput(sessionId, "⏺ User answered Claude's questions:  ⎿ · Color → Green");
          }
        },
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession;
      sessionRegistry.registerSession(sessionId, '/test/dir', pty, fakeMessageAPI(new Map()));
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Color: What is your favorite color?',
        options: [
          { value: '1', label: 'Red', isRecommended: true, isYes: false, isNo: false },
          { value: '2', label: 'Green', isRecommended: false, isYes: false, isNo: false },
          { value: '3', label: 'Blue', isRecommended: false, isYes: false, isNo: false },
        ],
        allowsFreeText: false,
        isAnswered: false,
        kind: 'multi_question',
        questions: [
          {
            header: 'Color',
            text: 'What is your favorite color?',
            multiSelect: false,
            options: [
              { value: '1', label: 'Red', isRecommended: true, isYes: false, isNo: false },
              { value: '2', label: 'Green', isRecommended: false, isYes: false, isNo: false },
              { value: '3', label: 'Blue', isRecommended: false, isYes: false, isNo: false },
            ],
          },
        ],
      });

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      // Pick Green (index 1): expect DOWN then ENTER, then closure -> question gone.
      await handlers.onAnswer(CID, sessionId, QID, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [1] }],
      });

      expect(ptyCapture.writes).toEqual([AUQ_KEYS.DOWN, AUQ_KEYS.ENTER]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    // #627: a TWO-question AUQ exercises the byIndex label assembly + the review
    // verification + submit, end-to-end through handleAnswer.
    test('structured two-question AUQ: drives, verifies the review, submits, closes', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      const REVIEW =
        'Review your answers● Q1? → Green● Q2? → Apple, CherryReady to submit your answers?❯ 1. Submit answers 2. Cancel';
      const CLOSED = "⏺ User answered Claude's questions:  ⎿ ·…";
      let writes = 0;
      // After the 9 planned keys (DOWN,ENTER | SPACE,DOWN,DOWN,SPACE,DOWN,DOWN,ENTER
      // — Q2 has optionCount=3, so "Submit" sits at row 4) the review appears; the
      // runner verifies it then sends ENTER, which closes the tool.
      const pty = {
        id: generateId(),
        write: (content: string) => {
          ptyCapture.writes.push(content);
          writes += 1;
          if (writes === 9) appendPtyOutput(sessionId, REVIEW);
          else if (writes >= 10 && content === AUQ_KEYS.ENTER) appendPtyOutput(sessionId, CLOSED);
        },
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession;
      sessionRegistry.registerSession(sessionId, '/test/dir', pty, fakeMessageAPI(new Map()));
      const opt = (value: string, label: string) => ({
        value,
        label,
        isRecommended: false,
        isYes: false,
        isNo: false,
      });
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Q1: Q1?',
        options: [opt('1', 'Red'), opt('2', 'Green'), opt('3', 'Blue')],
        allowsFreeText: false,
        isAnswered: false,
        kind: 'multi_question',
        questions: [
          {
            header: 'Q1',
            text: 'Q1?',
            multiSelect: false,
            options: [opt('1', 'Red'), opt('2', 'Green'), opt('3', 'Blue')],
          },
          {
            header: 'Q2',
            text: 'Q2?',
            multiSelect: true,
            options: [opt('1', 'Apple'), opt('2', 'Banana'), opt('3', 'Cherry')],
          },
        ],
      });

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      // Q1 -> Green (index 1); Q2 -> Apple + Cherry (indices 0, 2).
      await handlers.onAnswer(CID, sessionId, QID, '', undefined, {
        selections: [
          { questionIndex: 0, optionIndices: [1] },
          { questionIndex: 1, optionIndices: [0, 2] },
        ],
      });

      // Planned keys then the verified submit ENTER.
      expect(ptyCapture.writes).toEqual([
        AUQ_KEYS.DOWN,
        AUQ_KEYS.ENTER, // Q1 -> Green
        AUQ_KEYS.SPACE, // toggle Apple
        AUQ_KEYS.DOWN,
        AUQ_KEYS.DOWN,
        AUQ_KEYS.SPACE, // toggle Cherry (cursor now at row 2, optionCount=3)
        AUQ_KEYS.DOWN,
        AUQ_KEYS.DOWN, // past "Type something" to "Submit" (row optionCount+1=4)
        AUQ_KEYS.ENTER, // leave Q2 (-> review)
        AUQ_KEYS.ENTER, // submit (after review verified)
      ]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      clearPtyOutput(sessionId);
    });

    // Regression for #661: the AUQ success branch (outcome closed/submitted) must
    // consume the question exactly once EVEN IF cancelAutoApproveForQuestion
    // throws, mirroring the plain-answer path's try/finally below.
    test('a throwing cancelAutoApproveForQuestion still consumes the AUQ question and propagates', async () => {
      const sessionId = sessionRegistry.createSessionId();
      const pty = {
        id: generateId(),
        write: (content: string) => {
          if (content === AUQ_KEYS.ENTER) {
            appendPtyOutput(sessionId, "⏺ User answered Claude's questions:  ⎿ · Color → Green");
          }
        },
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession;
      sessionRegistry.registerSession(sessionId, '/test/dir', pty, fakeMessageAPI(new Map()));
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Color: What is your favorite color?',
        options: [
          { value: '1', label: 'Red', isRecommended: true, isYes: false, isNo: false },
          { value: '2', label: 'Green', isRecommended: false, isYes: false, isNo: false },
        ],
        allowsFreeText: false,
        isAnswered: false,
        kind: 'multi_question',
        questions: [
          {
            header: 'Color',
            text: 'What is your favorite color?',
            multiSelect: false,
            options: [
              { value: '1', label: 'Red', isRecommended: true, isYes: false, isNo: false },
              { value: '2', label: 'Green', isRecommended: false, isYes: false, isNo: false },
            ],
          },
        ],
      });

      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
        cancelAutoApproveForQuestion: () => {
          throw new Error('eval-cancel gone');
        },
      });
      await expect(
        handlers.onAnswer(CID, sessionId, QID, '', undefined, {
          selections: [{ questionIndex: 0, optionIndices: [1] }],
        }),
      ).rejects.toThrow('eval-cancel gone');

      // No zombie question left behind despite the throw.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      clearPtyOutput(sessionId);
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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

    test('a suggestion-derived "Yes, always allow" option threads suggestionIndex to resolveHeldPermission (#718)', async () => {
      // Unlike the legacy "Yes, always" string-suggestion label (FIX 1 above),
      // a #718 structured-suggestion-derived option carries a suggestionIndex,
      // so it CAN resolve the held hook (with a real updatedPermissions echo)
      // instead of falling back to the native PTY prompt.
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
        text: 'Allow Bash: rm -rf /tmp/foo',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          {
            value: '2',
            label: 'Yes, always allow: rm -rf /tmp/foo',
            isRecommended: false,
            isYes: true,
            isNo: false,
            suggestionIndex: 0,
          },
          { value: '3', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const held: Array<{ decision: 'allow' | 'deny'; suggestionIndex: number | undefined }> = [];
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: (_s, _q, d, suggestionIndex) => {
          held.push({ decision: d, suggestionIndex });
          return true;
        },
      });

      await handlers.onAnswer(CID, sessionId, QID, '2'); // the suggestion-derived option

      expect(held).toEqual([{ decision: 'allow', suggestionIndex: 0 }]);
      expect(ptyCapture.submits).toEqual([]); // held -> no PTY submit
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      await handlers.onAnswer(CID, sessionId, QID, 'y');

      expect(capture.submits).toEqual(['y']);
      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
    });

    test('user_input with stale claudeSessionId is refused', async () => {
      const bound = '11111111-2222-3333-4444-555555555555' as UUID;
      const stale = '99999999-aaaa-bbbb-cccc-dddddddddddd' as UUID;
      const { sessionId, capture } = registerSessionWithBinding(bound);

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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
        ...PROMPT_ON_SCREEN,
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      // The relay surfaces the throw (the HTTP route turns it into a 500).
      await expect(handlers.relayAnswer(sessionId, QID, 'Yes')).rejects.toThrow('pty closed');
      // Question consumed exactly once despite the throw.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test('returns session-not-found for an unknown session (no error frame)', async () => {
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
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

  // #752: every lock-screen tap fires two-to-three deliveries of the same
  // answer (native POST, Capacitor JS path, signaling relay). The first copy
  // wins; the losers must report 'delivered' — NOT 'stale' (HTTP 409), which
  // both client layers turned into a false "Answer not delivered" notification.
  describe('duplicate answer deliveries (#752)', () => {
    function registerYesNo(): { sessionId: UUID; ptyCapture: { submits: string[] } } {
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
          { value: '2', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });
      return { sessionId, ptyCapture };
    }

    test('a same-value relay duplicate after a relay success reports delivered, no re-submit', async () => {
      const { sessionId, ptyCapture } = registerYesNo();
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('delivered');
      expect(ptyCapture.submits).toEqual(['1']);

      // The losing channel's copy: same tap, question already consumed.
      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('delivered');
      expect(ptyCapture.submits).toEqual(['1']); // nothing re-submitted
    });

    test('cross-channel: a WS answer then its relay duplicate reports delivered', async () => {
      const { sessionId, ptyCapture } = registerYesNo();
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes'); // in-app WS copy wins
      expect(ptyCapture.submits).toEqual(['1']);

      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('delivered');
      expect(ptyCapture.submits).toEqual(['1']);
    });

    test('a WS duplicate sends NO STALE_ANSWER error frame', async () => {
      const { sessionId } = registerYesNo();
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');
      await handlers.onAnswer(CID, sessionId, QID, 'Yes'); // duplicate

      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
    });

    test('a CONFLICTING late answer (different value) still reports stale', async () => {
      const { sessionId, ptyCapture } = registerYesNo();
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('delivered');
      // A second device answered "No" after "Yes" already won: must fail loudly.
      expect(await handlers.relayAnswer(sessionId, QID, 'No')).toBe('stale');
      expect(ptyCapture.submits).toEqual(['1']);
    });

    test('a duplicate of a THROWING (never-applied) submit still reports stale', async () => {
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
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      await expect(handlers.relayAnswer(sessionId, QID, 'Yes')).rejects.toThrow('pty closed');
      // The answer was never applied, so its duplicate is NOT a success echo.
      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('stale');
    });

    test('an unknown question with no recorded answer still reports stale', async () => {
      const { sessionId } = registerYesNo();
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      const other = 'cccccccc-0000-0000-0000-000000000000' as UUID;
      expect(await handlers.relayAnswer(sessionId, other, 'Yes')).toBe('stale');
    });

    test('cross-surface: in-app answers with the VALUE, the push duplicate arrives as the LABEL', async () => {
      // The in-app card sends the option value ("1"); the push action sends
      // the label ("Yes"). Same tap, different spelling — the cache records
      // both at application time (#759 review finding 1).
      const { sessionId, ptyCapture } = registerYesNo();
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      await handlers.onAnswer(CID, sessionId, QID, '1'); // in-app value
      expect(ptyCapture.submits).toEqual(['1']);

      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('delivered'); // push label
      expect(await handlers.relayAnswer(sessionId, QID, 'No')).toBe('stale'); // conflict stays loud
    });

    test('a duplicate of a HELD-hook-resolved answer reports delivered', async () => {
      const { sessionId, ptyCapture } = registerYesNo();
      const held: Array<'allow' | 'deny'> = [];
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: (_s, _q, d) => {
          held.push(d);
          return true;
        },
      });

      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('delivered');
      expect(held).toEqual(['allow']); // resolved via the hook, no PTY submit
      expect(ptyCapture.submits).toEqual([]);

      expect(await handlers.relayAnswer(sessionId, QID, 'Yes')).toBe('delivered'); // duplicate
      expect(held).toEqual(['allow']); // hook not touched again
    });

    test('a duplicate AUQ selections delivery reports delivered', async () => {
      // Mirror the structured-AUQ harness: the PTY echoes the closure marker
      // on ENTER so the runner treats the answer as accepted.
      const sessionId = sessionRegistry.createSessionId();
      const writes: string[] = [];
      const pty = {
        id: generateId(),
        write: (content: string) => {
          writes.push(content);
          if (content === AUQ_KEYS.ENTER) {
            appendPtyOutput(sessionId, "⏺ User answered Claude's questions:  ⎿ · Color → Red");
          }
        },
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession;
      sessionRegistry.registerSession(sessionId, '/test/dir', pty, fakeMessageAPI(new Map()));
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Color: pick one',
        options: [{ value: '1', label: 'Red', isRecommended: true, isYes: false, isNo: false }],
        allowsFreeText: false,
        isAnswered: false,
        kind: 'multi_question',
        questions: [
          {
            header: 'Color',
            text: 'pick one',
            multiSelect: false,
            options: [{ value: '1', label: 'Red', isRecommended: true, isYes: false, isNo: false }],
          },
        ],
      });
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });
      const selections = [{ questionIndex: 0, optionIndices: [0] }];

      await handlers.onAnswer(CID, sessionId, QID, '', undefined, { selections });
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);

      // The losing channel re-delivers the same selections (WS path; the HTTP
      // relay never carries selections). A duplicate of an applied AUQ answer
      // must not produce a STALE_ANSWER / AUQ error frame.
      await handlers.onAnswer(CID, sessionId, QID, '', undefined, { selections });
      expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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
        ...PROMPT_ON_SCREEN,
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

  describe('recordPrecedent wiring (#976 prerequisite)', () => {
    type RecordCall = {
      sessionId: UUID;
      toolName: string;
      signature: string;
      decision: 'approved' | 'denied';
    };

    function registerPermissionQuestion(
      sessionId: UUID,
      overrides: Partial<Parameters<SessionRegistry['addQuestion']>[1]> = {},
    ): void {
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Allow Bash: git status',
        // #990: the untruncated signature `buildPermissionQuestion` would
        // compute for this same operation -- kept identical to `text`'s
        // embedded detail by default so the pre-#990 assertions below
        // ("recorded signature equals X") keep meaning the same thing; a
        // dedicated test below overrides this to differ from `text` and
        // proves the recorder reads THIS field, not `text`.
        precedentSignature: 'Bash: git status',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: '2', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
        source: 'permission_request',
        ...overrides,
      });
    }

    function setUp(): {
      sessionId: UUID;
      calls: RecordCall[];
      handlers: ReturnType<typeof createInputHandlers>;
    } {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      const calls: RecordCall[] = [];
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
        recordPrecedent: (sessionId, toolName, signature, decision) => {
          calls.push({ sessionId, toolName, signature, decision });
        },
      });
      return { sessionId, calls, handlers };
    }

    test('records an approval for an unambiguous Yes to a permission_request question', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId);

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(calls).toEqual([
        { sessionId, toolName: 'Bash', signature: 'Bash: git status', decision: 'approved' },
      ]);
    });

    test('records a denial for an unambiguous No to a permission_request question', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId);

      await handlers.onAnswer(CID, sessionId, QID, 'No');

      expect(calls).toEqual([
        { sessionId, toolName: 'Bash', signature: 'Bash: git status', decision: 'denied' },
      ]);
    });

    test('records the suggestion-derived "Yes, always allow" case as an approval', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId, {
        options: [
          {
            value: 'always',
            label: 'Yes, always allow: git status',
            isRecommended: true,
            isYes: true,
            isNo: false,
            suggestionIndex: 0,
          },
          { value: 'no', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
      });

      await handlers.onAnswer(CID, sessionId, QID, 'always');

      expect(calls).toEqual([
        { sessionId, toolName: 'Bash', signature: 'Bash: git status', decision: 'approved' },
      ]);
    });

    // #990: the core fix. `active.precedentSignature` -- not `active.text` --
    // is the recorded signature. Constructed so the two DISAGREE, so a
    // regression that reads `text` instead (or falls back to parsing it)
    // would record the wrong value and this test would catch it, not just
    // silently pass for the wrong reason.
    test('records from precedentSignature, not from the (possibly different) display text', async () => {
      const { sessionId, calls, handlers } = setUp();
      const longCommand = `cp ${'a'.repeat(200)} safe.ts`;
      registerPermissionQuestion(sessionId, {
        text: `Allow Bash: ${longCommand.slice(0, 117)}...`, // the truncated DISPLAY form
        precedentSignature: `Bash: ${longCommand}`, // the untruncated SIGNATURE form
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(calls).toEqual([
        { sessionId, toolName: 'Bash', signature: `Bash: ${longCommand}`, decision: 'approved' },
      ]);
    });

    // #990: the recorded tool name is DERIVED from the signature
    // (`toolNameFromSignature`), never hardcoded. Bash is the only
    // precedent-eligible tool `buildPermissionQuestion` emits today, so every
    // other test here would pass equally if `handleAnswer` recorded a constant
    // 'Bash' -- a latent gap the moment the eligible set grows. This pins the
    // derivation with a NON-Bash embedded name: a constant 'Bash' regresses it.
    test('derives the recorded tool name from the signature, not a hardcoded Bash', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId, {
        text: 'Allow Foo: bar baz',
        precedentSignature: 'Foo: bar baz',
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(calls).toEqual([
        { sessionId, toolName: 'Foo', signature: 'Foo: bar baz', decision: 'approved' },
      ]);
    });

    // #990 fail-closed: a `permission_request`-sourced question with NO
    // `precedentSignature` (a legacy `Question` predating this field, or any
    // future producer that forgets to set it) must record NOTHING -- never
    // fall back to parsing `text`, which is exactly the truncated-signature
    // collision #990 exists to close.
    test('does NOT record when precedentSignature is absent, even for an otherwise-parseable permission_request question', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId, { precedentSignature: undefined });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(calls).toEqual([]);
    });

    test('does NOT record for a non-permission_request source (source: pty), even with otherwise-parseable text', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      // Deliberately KEEP the default parseable "Allow Bash: git status" text
      // and change ONLY `source`, so this isolates the source guard itself --
      // unlike a PTY-shaped question's real text (e.g. "Proceed? (y/n)"),
      // which would also fail to parse and could pass this test even if the
      // source check were deleted (that confound is covered separately by
      // "a non-parseable text is refused regardless of source" below).
      registerPermissionQuestion(sessionId, { source: 'pty' });
      const calls: RecordCall[] = [];
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
        recordPrecedent: (sessionId, toolName, signature, decision) => {
          calls.push({ sessionId, toolName, signature, decision });
        },
        // `source: 'pty'` also trips the #920 prompt-currency guard earlier in
        // handleAnswer, which (with no `isPromptCurrent` wired) fails toward
        // "not current" and returns before ever reaching the precedent code --
        // that would make this test pass for the WRONG reason. Force it
        // current so the answer actually proceeds far enough to exercise the
        // `source === 'permission_request'` check this test targets.
        isPromptCurrent: () => true,
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(calls).toEqual([]);
    });

    test('does NOT record for a source-less question, even with otherwise-parseable text', async () => {
      const { sessionId, calls, handlers } = setUp();
      // Same isolation as the `source: 'pty'` case above: keep the default
      // parseable text, omit `source` entirely (StopFailure's real shape).
      registerPermissionQuestion(sessionId, { source: undefined });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(calls).toEqual([]);
    });

    test('does NOT record a source-less question with real (unparsable) StopFailure-shaped text', async () => {
      const { sessionId, calls, handlers } = setUp();
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Session stop failed (foo). Retry?',
        options: [
          { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      await handlers.onAnswer(CID, sessionId, QID, 'y');

      // Even though this question is isYes/isNo-shaped and would classify as
      // an unambiguous approve, its text is NOT a genuine tool+command
      // signature -- recording it would be exactly the unrecoverable mistake
      // the module's doc warns against. Missing `source` (not
      // 'permission_request') must refuse it.
      expect(calls).toEqual([]);
    });

    test('does NOT record for a bare "always" option with no suggestion to echo (ambiguous)', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId, {
        options: [
          { value: 'always', label: 'Yes, always', isRecommended: true, isYes: true, isNo: false },
          { value: 'no', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
      });

      await handlers.onAnswer(CID, sessionId, QID, 'always');

      expect(calls).toEqual([]);
    });

    test('does NOT record for a multi-choice pick, even with otherwise-parseable text', async () => {
      const { sessionId, calls, handlers } = setUp();
      // Isolates the `decision !== null` gate specifically: parseable text
      // ("Allow Bash: git status"), but pick-shaped options (no isYes/isNo),
      // so `mapAnswerToDecision` alone is what makes `decision` null here --
      // unlike the realistic ExitPlanMode text below, which would also fail
      // to parse and could pass even if that gate were deleted.
      registerPermissionQuestion(sessionId, {
        options: [
          { value: '1', label: 'Option A', isRecommended: true, isYes: false, isNo: false },
          { value: '2', label: 'Option B', isRecommended: false, isYes: false, isNo: false },
        ],
      });

      await handlers.onAnswer(CID, sessionId, QID, '1');

      expect(calls).toEqual([]);
    });

    test('does NOT record for a real ExitPlanMode-shaped multi-choice pick', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId, {
        text: 'Plan ready for review. How do you want to proceed?',
        options: [
          {
            value: '1',
            label: 'Yes, and auto-accept edits',
            isRecommended: true,
            isYes: false,
            isNo: false,
          },
          {
            value: '2',
            label: 'Yes, and manually approve edits',
            isRecommended: false,
            isYes: false,
            isNo: false,
          },
          {
            value: '3',
            label: 'No, keep planning',
            isRecommended: false,
            isYes: false,
            isNo: false,
          },
        ],
      });

      await handlers.onAnswer(CID, sessionId, QID, '1');

      expect(calls).toEqual([]);
    });

    test('does NOT record on cancel', async () => {
      const { sessionId, calls, handlers } = setUp();
      registerPermissionQuestion(sessionId);

      await handlers.onAnswer(CID, sessionId, QID, '', undefined, { cancel: true });

      expect(calls).toEqual([]);
    });

    test('does NOT record for a structured AskUserQuestion selections answer', async () => {
      const { sessionId, calls, handlers } = setUp();
      // No `questions` array -> handleAuqAnswer's immediate "not structured"
      // escalate path (no PTY keystroke loop, so this cannot hang) -- the
      // point under test is that ANY `extra.selections` answer routes to
      // handleAuqAnswer instead of the classify+record logic in the main
      // branch, which is a structural (early-return) property, not something
      // that depends on the AUQ run's own outcome.
      registerPermissionQuestion(sessionId);

      await handlers.onAnswer(CID, sessionId, QID, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [0] }],
      });

      expect(calls).toEqual([]);
    });

    test('absent recordPrecedent dependency never throws (additive, optional)', async () => {
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      registerPermissionQuestion(sessionId);
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
      });

      await expect(handlers.onAnswer(CID, sessionId, QID, 'Yes')).resolves.toBe(undefined);
      expect(ptyCapture.submits).toEqual(['1']);
    });

    test('a held-hook resolution (no PTY submit) still records precedent', async () => {
      const { sessionId, calls, handlers: _unused } = setUp();
      registerPermissionQuestion(sessionId);
      const recorded: RecordCall[] = [];
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
        resolveHeldPermission: () => true, // a hold existed and was resolved
        recordPrecedent: (sessionId, toolName, signature, decision) => {
          recorded.push({ sessionId, toolName, signature, decision });
        },
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes');

      expect(calls).toEqual([]); // the OTHER handlers instance never saw it
      expect(recorded).toEqual([
        { sessionId, toolName: 'Bash', signature: 'Bash: git status', decision: 'approved' },
      ]);
    });
  });
});
