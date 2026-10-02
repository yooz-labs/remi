import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, QuestionOption, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { createInputHandlers, trackerScreenDeps } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { AUQ_KEYS } from '../../../src/hooks/auq-answer.ts';
import { optionsFromSuggestions } from '../../../src/hooks/hook-event-bridge.ts';
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
 *
 * The same goes for the #1134 screen-numbering guard, which refuses an option
 * value the screen's menu does not show: here the screen shows the menu the
 * registered card describes, numbered the same way, which is what the
 * tracker observes when the card was built from the screen. Because it always
 * mirrors the card, every test using it passes the guard trivially (#1134
 * review): mismatches, in range and out of range, are covered by the
 * `#1134 screen-numbering guard` block, which wires its own screen.
 */
let registryForScreen: SessionRegistry | undefined;
const PROMPT_ON_SCREEN = {
  isPromptObservedOnPTY: () => true,
  observedPromptOptions: (sessionId: UUID) =>
    [...(registryForScreen?.getSession(sessionId)?.currentQuestions.values() ?? [])].flatMap(
      (q) => q.options,
    ),
};
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
    registryForScreen = sessionRegistry;
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

    describe('gate retirement (#673, #1125)', () => {
      // The answer path removes and dismisses the card itself, so it tells the
      // session's gate to stop tracking the escalation's tool signature;
      // otherwise the tool run that follows a "Yes" would resolve (and
      // re-dismiss) a card that is already gone.
      function setup(): { sessionId: UUID; retired: UUID[]; submits: string[] } {
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
        return { sessionId, retired: [], submits: ptyCapture.submits };
      }

      test('a delivered answer retires the question at the gate and submits the digit', async () => {
        const { sessionId, retired, submits } = setup();
        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          retireQuestion: (sid, qid) => {
            expect(sid).toBe(sessionId);
            retired.push(qid);
          },
        });
        await handlers.onAnswer(CID, sessionId, QID, 'Yes');
        expect(retired).toEqual([QID]);
        expect(submits).toEqual(['1']);
      });

      test('a cancel retires the question too', async () => {
        const { sessionId, retired } = setup();
        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          retireQuestion: (_sid, qid) => {
            retired.push(qid);
          },
        });
        await handlers.onAnswer(CID, sessionId, QID, '', undefined, { cancel: true });
        expect(retired).toEqual([QID]);
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      });

      test('a stale answer (card already gone) still retires it, and submits nothing', async () => {
        const { sessionId, retired, submits } = setup();
        sessionRegistry.removeQuestion(sessionId, QID, 'test');
        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          retireQuestion: (_sid, qid) => {
            retired.push(qid);
          },
        });
        await handlers.onAnswer(CID, sessionId, QID, 'Yes');
        expect(retired).toEqual([QID]);
        expect(submits).toEqual([]);
      });

      test('a throwing retireQuestion never blocks the answer', async () => {
        const { sessionId, submits } = setup();
        const handlers = createInputHandlers({
          ...PROMPT_ON_SCREEN,
          sessionRegistry,
          bindingStore,
          send,
          retireQuestion: () => {
            throw new Error('test: gate gone');
          },
        });
        await handlers.onAnswer(CID, sessionId, QID, 'No');
        expect(submits).toEqual(['2']);
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      });
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

        test('no prompt on screen: refuses to submit, reports STALE_ANSWER', async () => {
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
            ...PROMPT_ON_SCREEN,
          });

          await handlers.onAnswer(CID, sessionId, QID, '1');
          expect(ptyCapture.submits).toEqual(['1']);
          expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
        });
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

    /**
     * #1134: a phone "No" (value 4, from a card numbered by the hook) over a
     * 3-option dialog: Claude ignored the digit and the Enter after it
     * confirmed "1. Yes". An option value is now typed only when the menu on
     * screen shows it. Free text and the release-a-hold path are unchanged.
     */
    describe('#1134 screen-numbering guard', () => {
      const HOOK_NUMBERED = [
        { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
        {
          value: '2',
          label: 'Yes, allow directory /w',
          isRecommended: false,
          isYes: true,
          isNo: false,
        },
        {
          value: '3',
          label: 'Yes, switch to acceptEdits mode',
          isRecommended: false,
          isYes: true,
          isNo: false,
        },
        { value: '4', label: 'No', isRecommended: false, isYes: false, isNo: true },
      ];
      const SCREEN = [
        { value: '1', label: 'Yes', isRecommended: true, isYes: false, isNo: false },
        {
          value: '2',
          label: 'Yes, and always allow access to /w',
          isRecommended: false,
          isYes: false,
          isNo: false,
        },
        { value: '3', label: 'No', isRecommended: false, isYes: false, isNo: false },
      ];

      function setUpCard(
        options: typeof HOOK_NUMBERED,
        extra: { held?: boolean; allowsFreeText?: boolean } = {},
      ) {
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
          text: 'Allow Bash: touch e5-marker.txt',
          options,
          allowsFreeText: false,
          isAnswered: false,
          source: 'permission_request',
          ...extra,
        });
        return { sessionId, ptyCapture };
      }

      test('a card value the screen does not show: nothing typed, STALE_ANSWER, card cleared', async () => {
        const { sessionId, ptyCapture } = setUpCard(HOOK_NUMBERED);
        const logs: string[] = [];
        configureLogger({ writeLog: (msg) => logs.push(msg) });
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'No');

        expect(ptyCapture.submits).toEqual([]);
        const errors = sendCalls.filter((c) => c.message.type === 'error');
        expect(errors).toHaveLength(1);
        expect((errors[0]?.message as { code?: string }).code).toBe('STALE_ANSWER');
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
        expect(logs.some((m) => m.includes('"4" is not an option on screen [1, 2, 3]'))).toBe(true);
      });

      test('the relay reports the same refusal as stale, with no error frame', async () => {
        const { sessionId, ptyCapture } = setUpCard(HOOK_NUMBERED);
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        expect(await handlers.relayAnswer(sessionId, QID, '4')).toBe('stale');
        expect(ptyCapture.submits).toEqual([]);
        expect(sendCalls).toHaveLength(0);
      });

      test('a value the screen shows is typed as before', async () => {
        const { sessionId, ptyCapture } = setUpCard(SCREEN);
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'No');

        expect(ptyCapture.submits).toEqual(['3']);
        expect(sendCalls.filter((c) => c.message.type === 'error')).toHaveLength(0);
      });

      test('an unwired screen read refuses an option answer (fails toward not typing)', async () => {
        const { sessionId, ptyCapture } = setUpCard(SCREEN);
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
        });

        await handlers.onAnswer(CID, sessionId, QID, '1');

        expect(ptyCapture.submits).toEqual([]);
      });

      test('a card stamped held whose hook is NOT held is checked too', async () => {
        // A passthrough escalation is pushed through `pushHeldHook` and so
        // stamped `held`, but no hold exists: its answer is a typed digit in
        // the hook's numbering, exactly the case the guard exists for.
        const { sessionId, ptyCapture } = setUpCard(HOOK_NUMBERED, { held: true });
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'No');

        expect(ptyCapture.submits).toEqual([]);
      });

      // Lead decision on the #1134 review: free text into a numbered menu is
      // refused too. Claude ignores the text and the Enter after it confirms
      // the highlighted option, usually "1. Yes".
      test('free text into a menu, on a card that takes no free text: refused, nothing typed', async () => {
        const { sessionId, ptyCapture } = setUpCard(SCREEN);
        const logs: string[] = [];
        configureLogger({ writeLog: (msg) => logs.push(msg) });
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'no, use rm -i instead');

        expect(ptyCapture.submits).toEqual([]);
        const errors = sendCalls.filter((c) => c.message.type === 'error');
        expect(errors).toHaveLength(1);
        expect((errors[0]?.message as { code?: string }).code).toBe('STALE_ANSWER');
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
        expect(logs.some((m) => m.includes('free text (21 chars) into the option menu'))).toBe(
          true,
        );
      });

      test('the relay refuses free text into a menu the same way', async () => {
        const { sessionId, ptyCapture } = setUpCard(SCREEN);
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        expect(await handlers.relayAnswer(sessionId, QID, 'whatever')).toBe('stale');
        expect(ptyCapture.submits).toEqual([]);
      });

      test('free text is typed when the card takes free text, even over a menu', async () => {
        const { sessionId, ptyCapture } = setUpCard(SCREEN, { allowsFreeText: true });
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'a custom answer');

        expect(ptyCapture.submits).toEqual(['a custom answer']);
      });

      test('free text is typed when no menu is on screen (a free-text prompt)', async () => {
        const { sessionId, ptyCapture } = setUpCard(SCREEN);
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => [],
        });

        await handlers.onAnswer(CID, sessionId, QID, 'my-widget');

        expect(ptyCapture.submits).toEqual(['my-widget']);
      });

      test('free text on a card with no options is typed even over a menu', async () => {
        const { sessionId, ptyCapture } = setUpCard([]);
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => SCREEN,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'my-widget');

        expect(ptyCapture.submits).toEqual(['my-widget']);
      });

      /**
       * #1134 review: the value existing on screen is not enough, it must MEAN
       * the same choice there. These cards and screens agree on which values
       * exist and disagree on what they are, which the old `PROMPT_ON_SCREEN`
       * (a screen mirroring the card) could never exercise.
       */
      describe('option identity (option-mismatch)', () => {
        const opt = (value: string, label: string, extra: Partial<QuestionOption> = {}) => ({
          value,
          label,
          isRecommended: false,
          isYes: false,
          isNo: false,
          ...extra,
        });

        async function answerOver(
          card: QuestionOption[],
          screen: QuestionOption[],
          answer: string,
        ): Promise<{ submits: string[]; logs: string[] }> {
          const { sessionId, ptyCapture } = setUpCard(card);
          const logs: string[] = [];
          configureLogger({ writeLog: (msg) => logs.push(msg) });
          const handlers = createInputHandlers({
            sessionRegistry,
            bindingStore,
            send,
            isPromptObservedOnPTY: () => true,
            observedPromptOptions: () => screen,
          });
          await handlers.onAnswer(CID, sessionId, QID, answer);
          return { submits: ptyCapture.submits, logs };
        }

        const fallbackCard = [opt('1', 'Yes', { isYes: true }), opt('2', 'No', { isNo: true })];
        const claudeThree = [
          opt('1', 'Yes'),
          opt('2', 'Yes, and always allow access to /w from this project'),
          opt('3', 'No'),
        ];

        test('probe B: a hook-numbered "No" (2) over the screen\'s standing allow is refused', async () => {
          const { submits, logs } = await answerOver(fallbackCard, claudeThree, 'No');
          expect(submits).toEqual([]);
          expect(logs.some((m) => m.includes('"2" means a different option on screen'))).toBe(true);
          const errors = sendCalls.filter((c) => c.message.type === 'error');
          expect((errors[0]?.message as { code?: string }).code).toBe('STALE_ANSWER');
        });

        test('probe B, matching answer: "Yes" still types 1', async () => {
          const { submits } = await answerOver(fallbackCard, claudeThree, 'Yes');
          expect(submits).toEqual(['1']);
        });

        const exitPlanCard = [
          opt('1', 'Yes, and auto-accept edits'),
          opt('2', 'Yes, and manually approve edits'),
          opt('3', 'No, keep planning'),
        ];

        test('probe A: ExitPlanMode "No, keep planning" (3) over a screen with a clear-context row is refused', async () => {
          const screen = [
            opt('1', 'Yes, clear context and auto-accept edits'),
            opt('2', 'Yes, auto-accept edits'),
            opt('3', 'Yes, manually approve edits'),
            opt('4', 'No, keep planning'),
          ];
          const { submits, logs } = await answerOver(exitPlanCard, screen, 'No, keep planning');
          expect(submits).toEqual([]);
          expect(logs.some((m) => m.includes('"3" means a different option on screen'))).toBe(true);
        });

        test('probe A, matching numbering: "No, keep planning" types 3', async () => {
          const screen = [
            opt('1', 'Yes,andauto-acceptedits'),
            opt('2', 'Yes,andmanuallyapproveedits'),
            opt('3', 'No,keepplanning'),
          ];
          const { submits } = await answerOver(exitPlanCard, screen, 'No, keep planning');
          expect(submits).toEqual(['3']);
        });

        test('picks with no Yes/No word must match by label', async () => {
          const card = [opt('1', 'PostgreSQL'), opt('2', 'MySQL')];
          const swapped = [opt('1', 'MySQL'), opt('2', 'PostgreSQL')];
          expect((await answerOver(card, swapped, 'PostgreSQL')).submits).toEqual([]);
        });

        test('label spacing lost by the parse (#1137) does not cause a refusal', async () => {
          const card = [opt('1', 'Submit answers'), opt('2', 'Chat about this')];
          const screen = [opt('1', 'Submitanswers'), opt('2', 'Chataboutthis')];
          expect((await answerOver(card, screen, 'Chat about this')).submits).toEqual(['2']);
        });

        test('an AskUserQuestion pick matches its screen row with the description folded in', async () => {
          const card = [
            opt('1', 'Red', { description: 'The color red' }),
            opt('2', 'Green', { description: 'The color green' }),
          ];
          const screen = [opt('1', 'Red The color red'), opt('2', 'Green Thecolorgreen')];
          expect((await answerOver(card, screen, 'Green')).submits).toEqual(['2']);
        });

        /**
         * Round-4 review probes. Each pair shares a value and a Yes/No class
         * or a long prefix, and means a different thing; the guard fails
         * closed (labels must be equal), so every one is refused and the user
         * answers at the terminal.
         */
        test.each([
          ['"Yes" vs "Yes, and don\'t ask again"', 'Yes', "Yes, and don't ask again for: git *"],
          ['"No" vs "No, refine with Ultraplan"', 'No', 'No, refine with Ultraplan in the cloud'],
          [
            'a long shared prefix: /tmp/x vs /etc/...',
            'Yes, allow reading from /tmp/x',
            'Yes, allow reading from /etc/ssh during this session',
          ],
          ['"Yes, use pnpm" vs "Yes, use npm"', 'Yes, use pnpm', 'Yes, use npm'],
          [
            'a prefix: "Option one for A" vs "... (recommended)"',
            'Option one for A',
            'Option one for A (recommended)',
          ],
        ])('refuses %s', async (_name, cardLabel, screenLabel) => {
          const card = [opt('1', cardLabel), opt('2', 'Something else')];
          const screen = [opt('1', screenLabel), opt('2', 'Something else')];
          const { submits, logs } = await answerOver(card, screen, '1');
          expect(submits).toEqual([]);
          expect(logs.some((m) => m.includes('"1" means a different option on screen'))).toBe(true);
        });

        test("the e4-echo-classic held-card shape: the hook's mode switch is not the screen's", async () => {
          // A Write prompt whose only suggestion was setMode acceptEdits; the
          // card is the hook's, the screen is the live parse (collapsed
          // spacing). Option 2 is a mode switch on both, worded differently,
          // so typing it is refused; the identical "Yes" and "No" still type.
          const { options: card } = optionsFromSuggestions([
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          ]);
          const screen = [
            opt('1', 'Yes'),
            opt(
              '2',
              'Yes,andswitchtoacceptedits(auto-approvefileeditsandcommonfilecommands)forthissession(shift+tab)',
            ),
            opt('3', 'No'),
          ];
          expect((await answerOver(card, screen, '2')).submits).toEqual([]);
        });

        test('the e4-echo-classic shape: an identical "No" still types its digit', async () => {
          const { options: card } = optionsFromSuggestions([
            { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
          ]);
          const screen = [
            opt('1', 'Yes'),
            opt('2', 'Yes,andswitchtoaccepteditsforthissession'),
            opt('3', 'No'),
          ];
          expect((await answerOver(card, screen, 'No')).submits).toEqual(['3']);
        });

        test('a short label that differs is refused (the accepted cost of failing closed)', async () => {
          const card = [opt('1', 'Red'), opt('2', 'Blue')];
          const screen = [opt('1', 'Reddish brown'), opt('2', 'Blue')];
          expect((await answerOver(card, screen, 'Red')).submits).toEqual([]);
        });
      });

      test('probe D: free text on a held-stamped card is refused before anything is typed', async () => {
        // A card pushed by id (`pushHeldHook`) is stamped `held`. Before #1125
        // that could be a real hold, released before typing, which skipped the
        // screen check; nothing holds now, but the refusal still guards these
        // passthrough cards even when no menu has been observed yet.
        const { sessionId, ptyCapture } = setUpCard(HOOK_NUMBERED, { held: true });
        const logs: string[] = [];
        configureLogger({ writeLog: (msg) => logs.push(msg) });
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => null,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'approve it');

        expect(ptyCapture.submits).toEqual([]);
        const errors = sendCalls.filter((c) => c.message.type === 'error');
        expect((errors[0]?.message as { code?: string }).code).toBe('STALE_ANSWER');
        expect(logs.some((m) => m.includes('free text (10 chars) on a held card'))).toBe(true);
        expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      });

      test('an option answer on a held-stamped card is screen-checked like any other', async () => {
        // No hold to release (#1125), so nothing exempts it: with no menu
        // observed, the digit is refused rather than typed blind.
        const { sessionId, ptyCapture } = setUpCard(HOOK_NUMBERED, { held: true });
        const handlers = createInputHandlers({
          sessionRegistry,
          bindingStore,
          send,
          isPromptObservedOnPTY: () => true,
          observedPromptOptions: () => null,
        });

        await handlers.onAnswer(CID, sessionId, QID, 'Yes, switch to acceptEdits mode');

        expect(ptyCapture.submits).toEqual([]);
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

      const retired: UUID[] = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...PROMPT_ON_SCREEN,
        retireQuestion: (_sid, qid) => {
          retired.push(qid);
        },
      });
      // Pick Green (index 1): expect DOWN then ENTER, then closure -> question gone.
      await handlers.onAnswer(CID, sessionId, QID, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [1] }],
      });

      expect(ptyCapture.writes).toEqual([AUQ_KEYS.DOWN, AUQ_KEYS.ENTER]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
      // #1125: the gate stops tracking it, so the AskUserQuestion PostToolUse
      // that follows does not dismiss the answered card a second time.
      expect(retired).toEqual([QID]);
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
      // Pass a bogus sessionId, handler should still find the session via connection.
      // An option value, not free text: free text into an option menu is refused
      // since #1134, and this test is about the session lookup.
      await handlers.onAnswer(CID, 'bogus000-0000-0000-0000-000000000000' as UUID, QID, 'y');

      expect(ptyCapture.submits).toEqual(['y']);
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
      // answer for a question that has already been answered or replaced.
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

    test('the label "Yes, always" submits the option VALUE (index), not the label', async () => {
      // The PTY submit must be the digit Claude's native prompt expects ("2"),
      // NOT "Yes, always".
      const ptyCapture = { writes: [] as string[], submits: [] as string[] };
      const sessionId = makeSession();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        fakePTY(ptyCapture),
        fakeMessageAPI(new Map()),
      );
      addYesNoAlwaysQuestion(sessionId);

      const retired: UUID[] = [];
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
        retireQuestion: (_s, q) => {
          retired.push(q);
        },
      });

      await handlers.onAnswer(CID, sessionId, QID, 'Yes, always'); // sent as a LABEL

      // The gate stops tracking the answered escalation (#673).
      expect(retired).toEqual([QID]);
      expect(ptyCapture.submits).toEqual(['2']); // index, not the label
    });

    test('a label answer submits the option VALUE (index) into the native prompt', async () => {
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
      });

      // The digit "3" must be submitted, not the label "No".
      await handlers.onAnswer(CID, sessionId, QID, 'No');

      expect(ptyCapture.submits).toEqual(['3']);
    });

    test('a numeric value answer still submits that value (back-compat)', async () => {
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
      });

      await handlers.onAnswer(CID, sessionId, QID, 'my-widget');

      expect(ptyCapture.submits).toEqual(['my-widget']);
    });

    test('logs a label->value resolution, and refuses an unresolved label over a menu (FIX 1A, #1134)', async () => {
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
      });

      // Label resolves to a different value -> logged as a translation.
      await handlers.onAnswer(CID, sessionId, QID, 'No');
      expect(logs.some((m) => m.includes('[Answer] resolved "No" -> "3"'))).toBe(true);

      // A label that matches no option (options present) is free text: still
      // logged as unmatched, but no longer submitted verbatim. Lead decision on
      // #1134 review: a card with options that takes no free text, over a
      // numbered menu on screen, refuses free text, because Claude ignores the
      // text and the Enter confirms the highlighted option, usually "1. Yes".
      addYesNoAlwaysQuestion(sessionId);
      logs.length = 0;
      await handlers.onAnswer(CID, sessionId, QID, 'Maybe');
      expect(logs.some((m) => m.includes('[Answer] "Maybe" matched no option (3)'))).toBe(true);
      expect(logs.some((m) => m.includes('free text (5 chars) into the option menu'))).toBe(true);
      expect(ptyCapture.submits).not.toContain('Maybe');
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
  /**
   * #1134 review, probe C: a lock-screen tap arrives on two channels by design
   * (`RemiAnswerRelay` POSTs AND hands the tap to the Capacitor handler). The
   * card stays registered until the submit finishes, so both deliveries used
   * to pass the lookup and type the digit twice. The PTY below takes 50 ms per
   * submit so the second delivery lands inside the first's window.
   */
  /**
   * #1134 review: the screen deps used to be hand-copied into tests from
   * `cli.ts`, so deleting the production line left every test green. Both now
   * use `trackerScreenDeps`; these pin the helper against a real tracker and
   * pin that `cli.ts` hands it to `createInputHandlers`.
   */
  describe('trackerScreenDeps (#1134 review)', () => {
    test("reads the session's own tracker", () => {
      const tracker = new QuestionPresenceTracker(() => undefined);
      const deps = trackerScreenDeps((sid) => (sid === 'sid-a' ? tracker : undefined));
      const screen = {
        id: generateId(),
        text: 'Do you want to proceed?',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: false, isNo: false },
          { value: '2', label: 'No', isRecommended: false, isYes: false, isNo: false },
        ],
        allowsFreeText: true,
        isAnswered: false,
      };
      tracker.onPTYPromptVisible(screen);

      expect(deps.isPromptObservedOnPTY?.('sid-a' as UUID)).toBe(true);
      expect(deps.observedPromptOptions?.('sid-a' as UUID)).toEqual(screen.options);
      expect(deps.isPromptCurrent?.('sid-a' as UUID, screen.id, screen.text)).toBe(true);
    });

    test('no tracker for the session reads as nothing observed', () => {
      const deps = trackerScreenDeps(() => undefined);
      expect(deps.isPromptObservedOnPTY?.('sid-x' as UUID)).toBe(false);
      expect(deps.observedPromptOptions?.('sid-x' as UUID)).toBeNull();
      expect(deps.isPromptCurrent?.('sid-x' as UUID, 'q', 't')).toBe(false);
    });

    /** Strip comments, so a commented-out spread cannot satisfy the check. */
    function stripComments(src: string): string {
      return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
    }

    /** 'ok', or why `src`'s `createInputHandlers({...})` call does not use the
     *  helper for its screen deps. */
    function wiringVerdict(src: string): string {
      const start = src.indexOf('createInputHandlers({');
      if (start < 0) return 'no createInputHandlers call';
      const end = src.indexOf('\n});', start);
      if (end < 0) return 'no end of the call';
      const call = stripComments(src.slice(start, end));
      // Its own line, nothing else on it.
      const spread =
        /^[ \t]*\.\.\.trackerScreenDeps\(\(sessionId\) => sessionTrackers\.get\(sessionId\)\),?[ \t]*$/m.exec(
          call,
        );
      if (!spread) return 'spread missing';
      // A later key of any shape (property, method shorthand, shorthand)
      // would override the helper's dep.
      const after = call.slice(spread.index + spread[0].length);
      if (/\b(isPromptCurrent|isPromptObservedOnPTY|observedPromptOptions)\b/.test(after)) {
        return 'overridden after the spread';
      }
      return 'ok';
    }

    const cliSource = fs.readFileSync(
      path.join(import.meta.dir, '..', '..', '..', 'src', 'cli.ts'),
      'utf8',
    );
    const SPREAD = '  ...trackerScreenDeps((sessionId) => sessionTrackers.get(sessionId)),';

    test('cli.ts wires it into the answer handlers', () => {
      expect(wiringVerdict(cliSource)).toBe('ok');
    });

    // Round-4 review: the first version of this check passed a commented-out
    // spread and a method-shorthand override.
    test.each([
      ['deleted', (s: string) => s.replace(`${SPREAD}\n`, ''), 'spread missing'],
      [
        'line-commented',
        (s: string) => s.replace(SPREAD, `  // ${SPREAD.trim()}`),
        'spread missing',
      ],
      [
        'block-commented',
        (s: string) => s.replace(SPREAD, `  /* ${SPREAD.trim()} */`),
        'spread missing',
      ],
      [
        'overridden by a property',
        (s: string) => s.replace(SPREAD, `${SPREAD}\n  isPromptCurrent: () => true,`),
        'overridden after the spread',
      ],
      [
        'overridden by a method shorthand',
        (s: string) => s.replace(SPREAD, `${SPREAD}\n  isPromptCurrent() { return true; },`),
        'overridden after the spread',
      ],
      [
        'overridden by a shorthand property',
        (s: string) => s.replace(SPREAD, `${SPREAD}\n  observedPromptOptions,`),
        'overridden after the spread',
      ],
    ])('the check fails when the spread is %s', (_name, mutate, verdict) => {
      const mutated = mutate(cliSource);
      expect(mutated).not.toBe(cliSource);
      expect(wiringVerdict(mutated)).toBe(verdict);
    });
  });

  describe('concurrent deliveries of one answer (#1134 review)', () => {
    function slowSession(opts: { submitFails?: boolean } = {}): {
      sessionId: UUID;
      submits: string[];
    } {
      const submits: string[] = [];
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(
        sessionId,
        '/test/dir',
        {
          id: generateId(),
          write: () => {},
          submitInput: async (content: string) => {
            await new Promise((r) => setTimeout(r, 50));
            if (opts.submitFails) throw new Error('test: PTY write failed');
            submits.push(content);
          },
          close: async () => {},
        } as unknown as PTYSession,
        fakeMessageAPI(new Map()),
      );
      sessionRegistry.addQuestion(sessionId, {
        id: QID,
        text: 'Allow Bash: ls',
        options: [
          { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: '2', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });
      return { sessionId, submits };
    }

    test('the same answer on two channels types once; the second reports delivered', async () => {
      const { sessionId, submits } = slowSession();
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
      });

      // The in-app tap sends the value, the relay the label: one answer.
      const first = handlers.onAnswer(CID, sessionId, QID, '1');
      const second = handlers.relayAnswer(sessionId, QID, 'Yes');
      const [, secondOutcome] = await Promise.all([first, second]);

      expect(submits).toEqual(['1']);
      expect(secondOutcome).toBe('delivered');
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(0);
    });

    test("a duplicate reports the first delivery's outcome: a failed submit is not 'delivered'", async () => {
      // Round-4 review: the duplicate used to report 'delivered'
      // unconditionally, so a lock-screen tap whose first channel failed
      // read as answered on the other.
      const { sessionId, submits } = slowSession({ submitFails: true });
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
      });

      const first = handlers.relayAnswer(sessionId, QID, '1');
      const second = handlers.relayAnswer(sessionId, QID, 'Yes');
      const [firstResult, secondResult] = await Promise.allSettled([first, second]);

      expect(firstResult.status).toBe('rejected');
      expect(secondResult).toEqual({ status: 'fulfilled', value: 'stale' });
      expect(submits).toEqual([]);
    });

    test('a different answer while one is being applied is refused', async () => {
      const { sessionId, submits } = slowSession();
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
      });

      const first = handlers.relayAnswer(sessionId, QID, 'Yes');
      const second = handlers.relayAnswer(sessionId, QID, 'No');
      const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

      expect(submits).toEqual(['1']);
      expect(firstOutcome).toBe('delivered');
      expect(secondOutcome).toBe('stale');
    });

    test('the claim is released when the answer settles, even when the card survives it', async () => {
      // Selections for a non-structured question escalate and KEEP the card,
      // so a second identical attempt reaches the claim check: a leaked claim
      // would report it 'delivered' silently instead of escalating again.
      const { sessionId } = slowSession();
      const handlers = createInputHandlers({
        ...PROMPT_ON_SCREEN,
        sessionRegistry,
        bindingStore,
        send,
      });
      const selections = [{ questionIndex: 0, optionIndices: [0] }];

      await handlers.onAnswer(CID, sessionId, QID, '', undefined, { selections });
      await handlers.onAnswer(CID, sessionId, QID, '', undefined, { selections });

      const codes = sendCalls
        .filter((c) => c.message.type === 'error')
        .map((c) => (c.message as { code?: string }).code);
      expect(codes).toEqual(['AUQ_NOT_STRUCTURED', 'AUQ_NOT_STRUCTURED']);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestions.size).toBe(1);
    });
  });

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
});
