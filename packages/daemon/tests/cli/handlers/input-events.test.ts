import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createInputHandlers } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';

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
}): PTYSession {
  return {
    id: generateId(),
    write: (content: string) => {
      if (capture.writeError) throw capture.writeError;
      capture.writes.push(content);
    },
    submitInput: async (content: string) => {
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
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let send: (connectionId: UUID, message: ProtocolMessage) => boolean;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
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

      const handlers = createInputHandlers({ sessionRegistry, send });
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

      const handlers = createInputHandlers({ sessionRegistry, send });
      await handlers.onUserInput(CID, sessionId, 'hello world', false);

      expect(ptyCapture.submits).toEqual(['hello world']);
      expect(ptyCapture.writes).toEqual([]);
    });

    test('logs and returns when no session is attached to the connection', async () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const handlers = createInputHandlers({ sessionRegistry, send });

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

      const handlers = createInputHandlers({ sessionRegistry, send });
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
      sessionRegistry.updateQuestion(sessionId, {
        id: QID,
        text: 'yes?',
        options: [
          { value: 'yes', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'no', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, send });
      await handlers.onAnswer(CID, sessionId, QID, 'yes');

      expect(ptyCapture.submits).toEqual(['yes']);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestion).toBeNull();
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
      sessionRegistry.updateQuestion(sessionId, {
        id: QID,
        text: 'proceed?',
        options: [
          { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
          { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      });

      const handlers = createInputHandlers({ sessionRegistry, send });
      // Pass a bogus sessionId, handler should still find the session via connection
      await handlers.onAnswer(CID, 'bogus000-0000-0000-0000-000000000000' as UUID, QID, 'hello');

      expect(ptyCapture.submits).toEqual(['hello']);
      // Question must be cleared on the real session id, not the bogus one.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestion).toBeNull();
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

      const handlers = createInputHandlers({ sessionRegistry, send });
      await handlers.onAnswer(CID, sessionId, QID, 'hi');

      expect(ptyCapture.submits).toEqual([]);
      expect(sessionRegistry.getSession(sessionId)?.currentQuestion).toBeNull();
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
      sessionRegistry.updateQuestion(sessionId, {
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
      const handlers = createInputHandlers({ sessionRegistry, send });
      await handlers.onAnswer(CID, sessionId, stale, 'yes');

      expect(ptyCapture.submits).toEqual([]);
      // Active question stays in place; only the matching answer should clear it.
      expect(sessionRegistry.getSession(sessionId)?.currentQuestion?.id).toBe(QID);
      const errors = sendCalls.filter((c) => c.message.type === 'error');
      expect(errors).toHaveLength(1);
      const errMsg = errors[0]?.message as unknown as {
        code: string;
        details?: { activeQuestionId: string | null };
      };
      expect(errMsg.code).toBe('STALE_ANSWER');
      expect(errMsg.details?.activeQuestionId).toBe(QID);
    });

    test('logs when neither sessionId nor connectionId maps to a session', async () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const handlers = createInputHandlers({ sessionRegistry, send });

      await handlers.onAnswer(CID, 'miss0000-0000-0000-0000-000000000000' as UUID, QID, 'y');

      expect(logs.some((m) => m.includes('No session found'))).toBe(true);
    });
  });

  describe('onBulletExpandRequest', () => {
    test('sends NOT_FOUND when session is missing', () => {
      const handlers = createInputHandlers({ sessionRegistry, send });

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

      const handlers = createInputHandlers({ sessionRegistry, send });
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

      const handlers = createInputHandlers({ sessionRegistry, send });
      handlers.onBulletExpandRequest(CID, sessionId, 7, REQ);

      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.message.type).toBe('bullet_expand_response');
    });
  });
});
