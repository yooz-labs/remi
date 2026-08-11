/**
 * Tests for SessionRegistry - session lifecycle management.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { MessageAPI } from '../src/api/message-api.ts';
import type { PTYSession } from '../src/pty/pty-session.ts';
import { SessionRegistry } from '../src/session/session-registry.ts';

function createMockPTY(): PTYSession {
  return {
    id: generateId(),
    close: mock(() => Promise.resolve()),
  } as unknown as PTYSession;
}

function createMockMessageAPI(bulletCount = 0): MessageAPI {
  return {
    bulletCount,
    handleMessage: mock(() => {}),
    handleMessageUpdate: mock(() => {}),
    reset: mock(() => {}),
  } as unknown as MessageAPI;
}

describe('SessionRegistry', () => {
  let registry: SessionRegistry;
  let events: {
    onSessionCreated: ReturnType<typeof mock>;
    onSessionClosed: ReturnType<typeof mock>;
    onSessionOrphaned: ReturnType<typeof mock>;
    onSessionResumed: ReturnType<typeof mock>;
    onQuestionsChanged: ReturnType<typeof mock>;
    onAttachStateChanged: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    events = {
      onSessionCreated: mock(() => {}),
      onSessionClosed: mock(() => {}),
      onSessionOrphaned: mock(() => {}),
      onSessionResumed: mock(() => {}),
      onQuestionsChanged: mock(() => {}),
      onAttachStateChanged: mock(() => {}),
    };

    registry = new SessionRegistry(
      { orphanTimeoutMs: 100 }, // Short timeout for testing
      events,
    );
  });

  afterEach(async () => {
    await registry.shutdown();
  });

  describe('registerSession()', () => {
    test('registers a new session', () => {
      const sessionId = generateId();
      const pty = createMockPTY();
      const messageApi = createMockMessageAPI();

      registry.registerSession(sessionId, '/test/dir', pty, messageApi);

      expect(registry.sessionCount).toBe(1);
      expect(registry.getSession(sessionId)).toBeDefined();
      expect(events.onSessionCreated).toHaveBeenCalledWith(sessionId);
    });

    test('session starts with no attached connections', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      const session = registry.getSession(sessionId);
      expect(session?.attachedConnections.size).toBe(0);
      expect(session?.lastDisconnectedAt).toBeNull();
    });
  });

  describe('pending questions (#437)', () => {
    const mkQuestion = (id: string, agentId?: string) => ({
      id: id as ReturnType<typeof generateId>,
      text: `${id}?`,
      options: [],
      allowsFreeText: true,
      isAnswered: false,
      ...(agentId !== undefined && { agentId }),
    });

    test('add/remove keep concurrent questions independent', () => {
      const sid = generateId();
      registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
      const q1 = generateId();
      const q2 = generateId();
      registry.addQuestion(sid, mkQuestion(q1));
      registry.addQuestion(sid, mkQuestion(q2, 'sub-7'));
      expect(registry.getSession(sid)?.currentQuestions.size).toBe(2);

      registry.removeQuestion(sid, q1);
      expect(registry.getQuestion(sid, q1)).toBeNull();
      expect(registry.getQuestion(sid, q2)?.text).toBe(`${q2}?`);
    });

    test('clearQuestions drops all', () => {
      const sid = generateId();
      registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.addQuestion(sid, mkQuestion(generateId()));
      registry.addQuestion(sid, mkQuestion(generateId()));
      registry.clearQuestions(sid);
      expect(registry.getSession(sid)?.currentQuestions.size).toBe(0);
    });

    test('evicts the OLDEST when MAX_PENDING_QUESTIONS exceeded', () => {
      const sid = generateId();
      registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) {
        const id = generateId();
        ids.push(id);
        registry.addQuestion(sid, mkQuestion(id));
      }
      const map = registry.getSession(sid)?.currentQuestions;
      expect(map?.size).toBe(8); // capped
      expect(registry.getQuestion(sid, ids[0] as string)).toBeNull(); // oldest gone
      expect(registry.getQuestion(sid, ids[8] as string)?.text).toBe(`${ids[8]}?`); // newest kept
    });

    test('re-adding an existing id refreshes it to newest (survives eviction)', () => {
      const sid = generateId();
      registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const id = generateId();
        ids.push(id);
        registry.addQuestion(sid, mkQuestion(id));
      }
      // Refresh the oldest, then add one more: the refreshed one must survive
      // and the now-oldest (ids[1]) must be evicted.
      registry.addQuestion(sid, mkQuestion(ids[0] as string));
      registry.addQuestion(sid, mkQuestion(generateId()));
      expect(registry.getQuestion(sid, ids[0] as string)).not.toBeNull();
      expect(registry.getQuestion(sid, ids[1] as string)).toBeNull();
    });

    test('attachConnection result replays all pending questions', () => {
      const sid = generateId();
      registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
      const q1 = generateId();
      const q2 = generateId();
      registry.addQuestion(sid, mkQuestion(q1));
      registry.addQuestion(sid, mkQuestion(q2, 'sub-7'));

      const result = registry.attachConnection(sid, generateId());
      expect(result.currentQuestions.map((q) => q.id)).toEqual([q1, q2]);
    });

    describe('onQuestionsChanged (#786/#787)', () => {
      test('fires with the full current set on addQuestion', () => {
        const sid = generateId();
        registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
        const q1 = generateId();
        registry.addQuestion(sid, mkQuestion(q1));
        expect(events.onQuestionsChanged).toHaveBeenLastCalledWith(sid, [mkQuestion(q1)]);

        const q2 = generateId();
        registry.addQuestion(sid, mkQuestion(q2, 'sub-7'));
        expect(events.onQuestionsChanged).toHaveBeenLastCalledWith(sid, [
          mkQuestion(q1),
          mkQuestion(q2, 'sub-7'),
        ]);
      });

      test('fires with the reduced set on removeQuestion', () => {
        const sid = generateId();
        registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
        const q1 = generateId();
        const q2 = generateId();
        registry.addQuestion(sid, mkQuestion(q1));
        registry.addQuestion(sid, mkQuestion(q2));
        events.onQuestionsChanged.mockClear();

        registry.removeQuestion(sid, q1);
        expect(events.onQuestionsChanged).toHaveBeenCalledTimes(1);
        expect(events.onQuestionsChanged).toHaveBeenCalledWith(sid, [mkQuestion(q2)]);
      });

      test('fires with an empty array on clearQuestions', () => {
        const sid = generateId();
        registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
        registry.addQuestion(sid, mkQuestion(generateId()));
        events.onQuestionsChanged.mockClear();

        registry.clearQuestions(sid);
        expect(events.onQuestionsChanged).toHaveBeenCalledWith(sid, []);
      });

      test('does not fire for a sessionId that does not match the registered session', () => {
        const sid = generateId();
        registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
        registry.addQuestion(
          'unknown-session' as ReturnType<typeof generateId>,
          mkQuestion(generateId()),
        );
        registry.removeQuestion('unknown-session' as ReturnType<typeof generateId>, generateId());
        registry.clearQuestions('unknown-session' as ReturnType<typeof generateId>);
        expect(events.onQuestionsChanged).not.toHaveBeenCalled();
      });
    });

    // Real subprocess (like session-store-concurrency.test.ts): Bun's
    // os.homedir() resolves once at process startup, so a fresh subprocess
    // with HOME set in its spawn env is the only reliable way to point the
    // trace module (session/question-trace.ts) at a throwaway directory --
    // mutating process.env.HOME in THIS process would not be seen by it. See
    // tests/session/question-trace.test.ts for the module's own unit tests;
    // this suite instead proves the WIRING from SessionRegistry is correct.
    describe('question-lifecycle trace (#808, wiring)', () => {
      function readTraceLines(home: string): Record<string, unknown>[] {
        const tracePath = path.join(home, '.remi', 'question-trace.jsonl');
        if (!fs.existsSync(tracePath)) return [];
        return fs
          .readFileSync(tracePath, 'utf-8')
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l));
      }

      test('add/remove/clear/evict each emit the expected trace record', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-registry-trace-test-'));
        try {
          const worker = path.join(import.meta.dir, 'session/session-registry-trace-worker.ts');
          const proc = Bun.spawn(['bun', worker], {
            env: { ...process.env, HOME: tmpHome, REMI_QUESTION_TRACE: '1' },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const code = await proc.exited;
          const stdout = await new Response(proc.stdout).text();
          if (code !== 0) {
            throw new Error(`worker exited ${code}: ${await new Response(proc.stderr).text()}`);
          }
          const { q1, q2, oldestEvicted } = JSON.parse(stdout.trim()) as {
            q1: string;
            q2: string;
            oldestEvicted: string;
          };

          const lines = readTraceLines(tmpHome);

          const addQ1 = lines.find((l) => l['action'] === 'add' && l['questionId'] === q1);
          expect(addQ1).toMatchObject({ signal: 'unknown', isSubagent: false });

          const addQ2 = lines.find((l) => l['action'] === 'add' && l['questionId'] === q2);
          expect(addQ2).toMatchObject({
            signal: 'permission_request',
            agentId: 'sub-2',
            isSubagent: true,
          });

          const removeQ1 = lines.find((l) => l['action'] === 'remove' && l['questionId'] === q1);
          expect(removeQ1).toMatchObject({
            signal: 'user_answer',
            toolName: 'Bash',
            throughFunnel: true,
          });

          const clearQ2 = lines.find(
            (l) =>
              l['action'] === 'remove' &&
              l['questionId'] === q2 &&
              l['signal'] === 'session_restart',
          );
          expect(clearQ2).toMatchObject({ throughFunnel: true });

          const eviction = lines.find((l) => l['signal'] === 'lru_eviction');
          expect(eviction).toMatchObject({
            action: 'remove',
            questionId: oldestEvicted,
            throughFunnel: true,
          });
        } finally {
          fs.rmSync(tmpHome, { recursive: true, force: true });
        }
      });

      test('disabled by default (no REMI_QUESTION_TRACE): no file is written', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-registry-trace-test-'));
        try {
          const worker = path.join(import.meta.dir, 'session/session-registry-trace-worker.ts');
          // Rebuild from scratch (rather than `delete`) so this run can never
          // inherit REMI_QUESTION_TRACE from the parent test process's own env.
          const { REMI_QUESTION_TRACE: _inherited, ...rest } = process.env;
          const env = { ...rest, HOME: tmpHome };
          const proc = Bun.spawn(['bun', worker], { env, stdout: 'pipe', stderr: 'pipe' });
          const code = await proc.exited;
          if (code !== 0) {
            throw new Error(`worker exited ${code}: ${await new Response(proc.stderr).text()}`);
          }
          expect(fs.existsSync(path.join(tmpHome, '.remi', 'question-trace.jsonl'))).toBe(false);
        } finally {
          fs.rmSync(tmpHome, { recursive: true, force: true });
        }
      });
    });
  });

  describe('attachConnection()', () => {
    test('attaches connection to session', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      const result = registry.attachConnection(sessionId, connectionId);

      expect(result.success).toBe(true);
      expect(result.isResume).toBe(false);
      expect(result.replayMessages).toEqual([]);
      expect(result.attachState).toBe('attached');

      const session = registry.getSession(sessionId);
      expect(session?.attachedConnections.has(connectionId)).toBe(true);
    });

    test('returns error for non-existent session', () => {
      const result = registry.attachConnection(generateId(), generateId());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Session not found');
    });

    test('getSessionForConnection works after attach', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);

      const session = registry.getSessionForConnection(connectionId);
      expect(session?.sessionId).toBe(sessionId);
    });

    test('getSessionForConnection returns undefined for a connection that never attached', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      expect(registry.getSessionForConnection(generateId())).toBeUndefined();
    });
  });

  describe('multi-attach: any connected client can read and write (#795)', () => {
    test('a second connection attaching does NOT displace the first — both are attached', () => {
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      const resultA = registry.attachConnection(sessionId, connA);
      const resultB = registry.attachConnection(sessionId, connB);

      expect(resultA.success).toBe(true);
      expect(resultA.attachState).toBe('attached');
      expect(resultB.success).toBe(true);
      expect(resultB.attachState).toBe('attached');

      // Both connections independently resolve to the SAME session for
      // reads and writes -- neither is read-only.
      expect(registry.getSessionForConnection(connA)?.sessionId).toBe(sessionId);
      expect(registry.getSessionForConnection(connB)?.sessionId).toBe(sessionId);

      const session = registry.getSession(sessionId);
      expect(session?.attachedConnections.size).toBe(2);
      expect(session?.attachedConnections.has(connA)).toBe(true);
      expect(session?.attachedConnections.has(connB)).toBe(true);
    });

    test('a third, fourth, ... connection can all attach at once', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      const conns = Array.from({ length: 5 }, () => generateId());

      for (const c of conns) {
        const result = registry.attachConnection(sessionId, c);
        expect(result.success).toBe(true);
        expect(result.attachState).toBe('attached');
      }

      const session = registry.getSession(sessionId);
      expect(session?.attachedConnections.size).toBe(5);
      for (const c of conns) {
        expect(registry.getSessionForConnection(c)?.sessionId).toBe(sessionId);
      }
    });

    test('a second connection joining an already-attached session is NOT a "resume"', () => {
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, connA);
      const resultB = registry.attachConnection(sessionId, connB);

      // isResume is about the session having had ZERO attached connections
      // before, not about "someone else is already here".
      expect(resultB.isResume).toBe(false);
      expect(events.onSessionResumed).not.toHaveBeenCalled();
    });

    test('detaching one of several attached connections leaves the others attached', () => {
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);

      registry.detachConnection(connA);

      // B is still attached and can read/write; the session is NOT orphaned.
      expect(registry.getSessionForConnection(connA)).toBeUndefined();
      expect(registry.getSessionForConnection(connB)?.sessionId).toBe(sessionId);
      expect(registry.getSession(sessionId)?.attachedConnections.size).toBe(1);
      expect(events.onSessionOrphaned).not.toHaveBeenCalled();
    });

    test('the session only orphans once the LAST attached connection detaches', () => {
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);

      registry.detachConnection(connA);
      expect(events.onSessionOrphaned).not.toHaveBeenCalled();

      registry.detachConnection(connB);
      expect(events.onSessionOrphaned).toHaveBeenCalledTimes(1);
      expect(events.onSessionOrphaned).toHaveBeenCalledWith(sessionId);
      expect(registry.getSession(sessionId)?.attachedConnections.size).toBe(0);
    });

    test('detaching an already-detached connection is a no-op', () => {
      const sessionId = generateId();
      const connA = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connA);
      registry.detachConnection(connA);
      events.onSessionOrphaned.mockClear();

      registry.detachConnection(connA);
      expect(events.onSessionOrphaned).not.toHaveBeenCalled();
    });

    test('a fresh attach after everyone left IS a resume', () => {
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connA);
      registry.detachConnection(connA);

      const result = registry.attachConnection(sessionId, connB);

      expect(result.isResume).toBe(true);
      expect(events.onSessionResumed).toHaveBeenCalledWith(sessionId, connB);
    });
  });

  describe('detachConnection()', () => {
    test('detaches connection and marks session orphaned', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);

      registry.detachConnection(connectionId);

      const session = registry.getSession(sessionId);
      expect(session?.attachedConnections.size).toBe(0);
      expect(session?.lastDisconnectedAt).not.toBeNull();
      expect(events.onSessionOrphaned).toHaveBeenCalledWith(sessionId);
    });

    test('getSessionForConnection returns undefined after detach', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      expect(registry.getSessionForConnection(connectionId)).toBeUndefined();
    });

    test('orphaned session is closed after timeout', async () => {
      const sessionId = generateId();
      const connectionId = generateId();
      const pty = createMockPTY();
      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      // Wait for timeout (100ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(registry.getSession(sessionId)).toBeUndefined();
      expect(events.onSessionClosed).toHaveBeenCalledWith(sessionId, 'timeout');
      expect(pty.close).toHaveBeenCalled();
    });
  });

  describe('canResume()', () => {
    test('returns false for non-existent session', () => {
      expect(registry.canResume(generateId())).toBe(false);
    });

    test('returns true for a session with an attached connection (#795: attach is always allowed)', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, generateId());

      expect(registry.canResume(sessionId)).toBe(true);
    });

    test('returns true for orphaned session', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      expect(registry.canResume(sessionId)).toBe(true);
    });
  });

  describe('resume flow', () => {
    test('resuming clears orphan timeout', async () => {
      const sessionId = generateId();
      const connectionId1 = generateId();
      const connectionId2 = generateId();
      const pty = createMockPTY();

      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId1);
      registry.detachConnection(connectionId1);

      // Resume before timeout
      const result = registry.attachConnection(sessionId, connectionId2);

      expect(result.success).toBe(true);
      expect(result.isResume).toBe(true);
      expect(events.onSessionResumed).toHaveBeenCalledWith(sessionId, connectionId2);

      // Wait past the original timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Session should still exist
      expect(registry.getSession(sessionId)).toBeDefined();
      expect(pty.close).not.toHaveBeenCalled();
    });

    test('resume replays last 200 messages (not just undelivered)', () => {
      const sessionId = generateId();
      const connectionId1 = generateId();
      const connectionId2 = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI(5));
      registry.attachConnection(sessionId, connectionId1);

      // Record some messages
      const msg1: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      const msg2: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      registry.recordOutgoingMessage(sessionId, msg1);
      registry.recordOutgoingMessage(sessionId, msg2);

      // Detach and record more messages while disconnected
      registry.detachConnection(connectionId1);
      const msg3: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      registry.recordOutgoingMessage(sessionId, msg3);

      // Resume - now replays ALL messages (up to 200), not just undelivered
      const result = registry.attachConnection(sessionId, connectionId2);

      expect(result.success).toBe(true);
      expect(result.isResume).toBe(true);
      expect(result.replayMessages.length).toBe(3);
      expect(result.replayMessages).toContain(msg1);
      expect(result.replayMessages).toContain(msg2);
      expect(result.replayMessages).toContain(msg3);
      expect(result.nextBulletId).toBe(6);
    });
  });

  describe('recordOutgoingMessage()', () => {
    test('stores messages in history', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, generateId());

      const msg: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      registry.recordOutgoingMessage(sessionId, msg);

      const session = registry.getSession(sessionId);
      expect(session?.messageHistory.length).toBe(1);
      expect(session?.lastDeliveredIndex).toBe(0);
    });

    test('prunes history when exceeding max', () => {
      const registryWithSmallHistory = new SessionRegistry({ maxReplayHistory: 5 });
      const sessionId = generateId();
      registryWithSmallHistory.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockMessageAPI(),
      );
      registryWithSmallHistory.attachConnection(sessionId, generateId());

      // Add 10 messages
      for (let i = 0; i < 10; i++) {
        registryWithSmallHistory.recordOutgoingMessage(sessionId, {
          type: 'ping',
          id: generateId(),
          timestamp: now(),
        });
      }

      const session = registryWithSmallHistory.getSession(sessionId);
      expect(session?.messageHistory.length).toBe(5);
    });
  });

  describe('updateStatus()', () => {
    test('updates session status', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.updateStatus(sessionId, 'thinking');

      const session = registry.getSession(sessionId);
      expect(session?.currentStatus).toBe('thinking');
    });
  });

  describe('closeSession()', () => {
    test('closes session and emits event', () => {
      const sessionId = generateId();
      const pty = createMockPTY();
      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI());

      registry.closeSession(sessionId, 'forced');

      expect(registry.getSession(sessionId)).toBeUndefined();
      expect(events.onSessionClosed).toHaveBeenCalledWith(sessionId, 'forced');
      expect(pty.close).toHaveBeenCalled();
    });

    test('handlePTYExit closes session with pty_exit reason', () => {
      const sessionId = generateId();
      const pty = createMockPTY();
      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI());

      registry.handlePTYExit(sessionId);

      expect(events.onSessionClosed).toHaveBeenCalledWith(sessionId, 'pty_exit');
    });
  });

  describe('orphanedCount', () => {
    test('counts orphaned session', () => {
      const sessionId = generateId();
      const connectionId = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      expect(registry.orphanedCount).toBe(1);
    });

    test('returns 0 when session is connected', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, generateId());

      expect(registry.orphanedCount).toBe(0);
    });
  });

  describe('registerSession() single-session enforcement', () => {
    test('throws when registering a second session', () => {
      registry.registerSession(generateId(), '/test/dir', createMockPTY(), createMockMessageAPI());

      expect(() => {
        registry.registerSession(
          generateId(),
          '/test/dir2',
          createMockPTY(),
          createMockMessageAPI(),
        );
      }).toThrow('Session already registered');
    });

    test('can register again after session is closed', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.closeSession(sessionId, 'forced');

      const newSessionId = generateId();
      registry.registerSession(newSessionId, '/test/dir2', createMockPTY(), createMockMessageAPI());
      expect(registry.sessionCount).toBe(1);
      expect(registry.getSession(newSessionId)).toBeDefined();
    });
  });

  describe('locallyOwned sessions', () => {
    test('locally owned session skips orphan timeout on detach', async () => {
      const sessionId = generateId();
      const connectionId = generateId();
      const pty = createMockPTY();

      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI(), true);
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      // Wait well past the orphan timeout (100ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Session should still exist (not killed by timeout)
      expect(registry.getSession(sessionId)).toBeDefined();
      expect(pty.close).not.toHaveBeenCalled();
      expect(events.onSessionOrphaned).toHaveBeenCalledWith(sessionId);
      expect(events.onSessionClosed).not.toHaveBeenCalled();
    });

    test('locally owned session reports active status and canAttach without connection', () => {
      const sessionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockMessageAPI(),
        true,
      );

      const sessions = registry.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe('active');
      expect(sessions[0]?.canAttach).toBe(true);
    });

    test('orphanedCount excludes locally-owned sessions', () => {
      const localSessionId = generateId();
      registry.registerSession(
        localSessionId,
        '/test/dir',
        createMockPTY(),
        createMockMessageAPI(),
        true,
      );

      // Locally-owned session with no connection should not count as orphaned
      expect(registry.orphanedCount).toBe(0);

      // Even after attach+detach, locally-owned session is not orphaned
      const connectionId = generateId();
      registry.attachConnection(localSessionId, connectionId);
      registry.detachConnection(connectionId);
      expect(registry.orphanedCount).toBe(0);
    });

    test('non-locally-owned session reports orphaned status without connection', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      const sessions = registry.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe('orphaned');
    });
  });

  describe('explicit detach (tmux-style)', () => {
    test('explicit detach skips orphan timeout', async () => {
      const sessionId = generateId();
      const connectionId = generateId();
      const pty = createMockPTY();

      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId, true);

      // Wait well past the orphan timeout (100ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Session should still exist (not killed by timeout)
      expect(registry.getSession(sessionId)).toBeDefined();
      expect(pty.close).not.toHaveBeenCalled();
      expect(events.onSessionOrphaned).toHaveBeenCalledWith(sessionId);
      expect(events.onSessionClosed).not.toHaveBeenCalled();
    });

    test('explicit detach sets explicitlyDetached flag', () => {
      const sessionId = generateId();
      const connectionId = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId, true);

      const session = registry.getSession(sessionId);
      expect(session?.explicitlyDetached).toBe(true);
    });

    test('non-explicit detach does not set explicitlyDetached flag', () => {
      const sessionId = generateId();
      const connectionId = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      const session = registry.getSession(sessionId);
      expect(session?.explicitlyDetached).toBe(false);
    });

    test('reattach clears explicitlyDetached flag', () => {
      const sessionId = generateId();
      const conn1 = generateId();
      const conn2 = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, conn1);
      registry.detachConnection(conn1, true);

      const beforeAttach = registry.getSession(sessionId);
      expect(beforeAttach?.explicitlyDetached).toBe(true);

      registry.attachConnection(sessionId, conn2);

      const afterAttach = registry.getSession(sessionId);
      expect(afterAttach?.explicitlyDetached).toBe(false);
    });

    test('explicitly detached session reports "detached" status in listSessions', () => {
      const sessionId = generateId();
      const connectionId = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId, true);

      const sessions = registry.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe('detached');
    });

    test('non-explicit detach reports "orphaned" status', () => {
      const sessionId = generateId();
      const connectionId = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId, false);

      const sessions = registry.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe('orphaned');
    });

    test('explicitly detached session is re-attachable', () => {
      const sessionId = generateId();
      const conn1 = generateId();

      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, conn1);
      registry.detachConnection(conn1, true);

      expect(registry.canResume(sessionId)).toBe(true);

      const conn2 = generateId();
      const result = registry.attachConnection(sessionId, conn2);
      expect(result.success).toBe(true);
      expect(result.isResume).toBe(true);
    });
  });

  describe('persistent sessions (#637)', () => {
    // 6th registerSession arg is `persistent` (tmux-style keep-alive).
    test('persistent session skips orphan timeout on detach', async () => {
      const sessionId = generateId();
      const connectionId = generateId();
      const pty = createMockPTY();

      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI(), false, true);
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      // Wait well past the orphan timeout (100ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Session should still exist (not killed by timeout)
      expect(registry.getSession(sessionId)).toBeDefined();
      expect(pty.close).not.toHaveBeenCalled();
      expect(events.onSessionOrphaned).toHaveBeenCalledWith(sessionId);
      expect(events.onSessionClosed).not.toHaveBeenCalled();
    });

    test('persistent session reports "detached" status without connection', () => {
      const sessionId = generateId();
      const connectionId = generateId();

      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockMessageAPI(),
        false,
        true,
      );
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      const sessions = registry.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe('detached');
      expect(sessions[0]?.canAttach).toBe(true);
    });

    test('persistent session is re-attachable after disconnect', () => {
      const sessionId = generateId();
      const conn1 = generateId();

      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockMessageAPI(),
        false,
        true,
      );
      registry.attachConnection(sessionId, conn1);
      registry.detachConnection(conn1);

      expect(registry.canResume(sessionId)).toBe(true);
      const result = registry.attachConnection(sessionId, generateId());
      expect(result.success).toBe(true);
      expect(result.isResume).toBe(true);
    });

    test('orphanedCount excludes persistent sessions', () => {
      const sessionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockMessageAPI(),
        false,
        true,
      );

      expect(registry.orphanedCount).toBe(0);

      const connectionId = generateId();
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);
      expect(registry.orphanedCount).toBe(0);
    });

    test('non-persistent session still times out (default behavior preserved)', async () => {
      const sessionId = generateId();
      const connectionId = generateId();
      const pty = createMockPTY();

      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI(), false, false);
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(pty.close).toHaveBeenCalled();
      expect(events.onSessionClosed).toHaveBeenCalledWith(sessionId, 'timeout');
    });

    test('persistent session is closed when the Claude process exits (pty_exit)', () => {
      // Persistence must NOT keep a session alive after Claude itself exits;
      // pty_exit is the primary lifecycle-ending event for a persistent session.
      const sessionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockMessageAPI(),
        false,
        true,
      );

      registry.handlePTYExit(sessionId);

      expect(registry.getSession(sessionId)).toBeUndefined();
      expect(events.onSessionClosed).toHaveBeenCalledWith(sessionId, 'pty_exit');
    });

    test('persistent + explicit detach stays detached with no timeout', async () => {
      const sessionId = generateId();
      const connectionId = generateId();
      const pty = createMockPTY();

      registry.registerSession(sessionId, '/test/dir', pty, createMockMessageAPI(), false, true);
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId, true);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(registry.getSession(sessionId)).toBeDefined();
      expect(pty.close).not.toHaveBeenCalled();
      const sessions = registry.listSessions();
      expect(sessions[0]?.status).toBe('detached');
    });
  });

  describe('shutdown()', () => {
    test('closes the session', async () => {
      const pty = createMockPTY();
      registry.registerSession(generateId(), '/test', pty, createMockMessageAPI());

      await registry.shutdown();

      expect(pty.close).toHaveBeenCalled();
      expect(registry.sessionCount).toBe(0);
    });

    test('is safe to call with no session', async () => {
      await registry.shutdown();
      expect(registry.sessionCount).toBe(0);
    });
  });

  // #1038: the status snapshot's `attached`/`queuedCount` are derived from
  // `attachedConnections`, and nothing on an attach path calls
  // updateRemiStatus -- so this event is the ONLY thing that tells the
  // StatusWriter a phone arrived. It is emitted from the two lines that
  // mutate the set (rather than from any caller) precisely so it cannot be
  // missed on a path someone forgets to wire; these prove both of them, and
  // that it is NOT edge-only like onSessionResumed/onSessionOrphaned.
  describe('onAttachStateChanged (#1038)', () => {
    function liveSession(): UUID {
      const sid = registry.createSessionId();
      registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());
      return sid;
    }

    test('fires on attach', () => {
      const sid = liveSession();
      registry.attachConnection(sid, generateId());
      expect(events.onAttachStateChanged).toHaveBeenCalledTimes(1);
    });

    test('fires on detach', () => {
      const sid = liveSession();
      const conn = generateId();
      registry.attachConnection(sid, conn);
      registry.detachConnection(conn);
      expect(events.onAttachStateChanged).toHaveBeenCalledTimes(2);
    });

    test('fires for a SECOND attach, which is not a resume', () => {
      // onSessionResumed only fires on the zero->nonzero edge. The derived
      // fields change on every membership change, so this must not be
      // edge-scoped too.
      const sid = liveSession();
      registry.attachConnection(sid, generateId());
      registry.attachConnection(sid, generateId());
      expect(events.onAttachStateChanged).toHaveBeenCalledTimes(2);
    });

    test('fires for a detach that leaves others attached, which is not an orphan', () => {
      // The mirror case, and the one the ordering inside detachConnection
      // gets wrong if the emit is placed after the still-attached early
      // return.
      const sid = liveSession();
      const first = generateId();
      registry.attachConnection(sid, first);
      registry.attachConnection(sid, generateId());
      registry.detachConnection(first);
      expect(events.onSessionOrphaned).not.toHaveBeenCalled();
      expect(events.onAttachStateChanged).toHaveBeenCalledTimes(3);
    });

    test('does not fire for a detach of a connection that was never attached', () => {
      const sid = liveSession();
      registry.attachConnection(sid, generateId());
      registry.detachConnection(generateId()); // unknown connection: no-op
      expect(events.onAttachStateChanged).toHaveBeenCalledTimes(1);
    });
  });
});
