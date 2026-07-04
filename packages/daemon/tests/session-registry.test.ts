/**
 * Tests for SessionRegistry - session lifecycle management.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProtocolMessage } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { MessageAPI } from '../src/api/message-api.ts';
import type { PTYSession } from '../src/pty/pty-session.ts';
import type { AttachResult } from '../src/session/session-registry.ts';
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
    onConnectionPromoted: ReturnType<typeof mock>;
    onConnectionReclaimed: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    events = {
      onSessionCreated: mock(() => {}),
      onSessionClosed: mock(() => {}),
      onSessionOrphaned: mock(() => {}),
      onSessionResumed: mock(() => {}),
      onConnectionPromoted: mock(() => {}),
      onConnectionReclaimed: mock(() => {}),
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

    test('session starts with no connection', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      const session = registry.getSession(sessionId);
      expect(session?.activeConnectionId).toBeNull();
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

      const session = registry.getSession(sessionId);
      expect(session?.activeConnectionId).toBe(connectionId);
    });

    test('returns error for non-existent session', () => {
      const result = registry.attachConnection(generateId(), generateId());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Session not found');
    });

    test('queues second connection when session already has one', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, generateId());

      const result = registry.attachConnection(sessionId, generateId());

      // Second connection is queued (read-only with replay) rather than rejected
      expect(result.success).toBe(true);
      expect(result.isResume).toBe(true);
    });

    test('getSessionForConnection works after attach', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);

      const session = registry.getSessionForConnection(connectionId);
      expect(session?.sessionId).toBe(sessionId);
    });

    test('getSessionForConnection returns undefined for queued (read-only) connection', () => {
      // Exclusive write lock: only the active connection sees the session via
      // this lookup. Queued connections receive replay through attachConnection
      // but cannot write input/answer/resize that would race the active
      // client. Locking this contract prevents a future refactor from silently
      // re-introducing the input-race bug.
      const sessionId = generateId();
      const activeConnId = generateId();
      const queuedConnId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, activeConnId);

      // Second attach: queued.
      const queuedAttach = registry.attachConnection(sessionId, queuedConnId);
      expect(queuedAttach.success).toBe(true);
      expect(queuedAttach.replayMessages).toBeDefined();

      // Active still owns the session for writes.
      expect(registry.getSessionForConnection(activeConnId)?.sessionId).toBe(sessionId);
      // Queued must NOT.
      expect(registry.getSessionForConnection(queuedConnId)).toBeUndefined();
    });

    test('attachState is "attached" for a fresh (non-busy) attach', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      const result = registry.attachConnection(sessionId, generateId());

      expect(result.attachState).toBe('attached');
    });

    test('attachState is "queued" when the session already has an active connection', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, generateId());

      const result = registry.attachConnection(sessionId, generateId());

      expect(result.attachState).toBe('queued');
    });
  });

  describe('same-device lock reclaim (#662)', () => {
    test('reconnect with the SAME deviceId reclaims the lock instead of queuing', () => {
      const sessionId = generateId();
      const staleConn = generateId();
      const newConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, staleConn, 'device-A');
      const result = registry.attachConnection(sessionId, newConn, 'device-A');

      expect(result.success).toBe(true);
      expect(result.attachState).toBe('attached');
      expect(registry.waitingConnectionCount).toBe(0);

      const session = registry.getSession(sessionId);
      expect(session?.activeConnectionId).toBe(newConn);
      // The new connection now holds the write lock...
      expect(registry.getSessionForConnection(newConn)?.sessionId).toBe(sessionId);
      // ...and the stale one no longer does (it was evicted, not queued).
      expect(registry.getSessionForConnection(staleConn)).toBeUndefined();
    });

    test('fires onConnectionReclaimed with the stale and new connection ids', () => {
      const sessionId = generateId();
      const staleConn = generateId();
      const newConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, staleConn, 'device-A');
      registry.attachConnection(sessionId, newConn, 'device-A');

      expect(events.onConnectionReclaimed).toHaveBeenCalledTimes(1);
      expect(events.onConnectionReclaimed).toHaveBeenCalledWith(sessionId, staleConn, newConn);
    });

    test('a DIFFERENT deviceId still queues behind the active connection', () => {
      const sessionId = generateId();
      const activeConn = generateId();
      const otherConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, activeConn, 'device-A');
      const result = registry.attachConnection(sessionId, otherConn, 'device-B');

      expect(result.success).toBe(true);
      expect(result.attachState).toBe('queued');
      expect(registry.waitingConnectionCount).toBe(1);
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(activeConn);
      expect(events.onConnectionReclaimed).not.toHaveBeenCalled();
    });

    test("an UNDEFINED deviceId keeps today's behavior: queues, never reclaims", () => {
      const sessionId = generateId();
      const activeConn = generateId();
      const otherConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      // Active connection attached WITHOUT a deviceId (older client).
      registry.attachConnection(sessionId, activeConn);
      const result = registry.attachConnection(sessionId, otherConn);

      expect(result.success).toBe(true);
      expect(result.attachState).toBe('queued');
      expect(registry.waitingConnectionCount).toBe(1);
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(activeConn);
      expect(events.onConnectionReclaimed).not.toHaveBeenCalled();
    });

    test('a NEW connection with a deviceId does not reclaim when the active connection has none', () => {
      const sessionId = generateId();
      const activeConn = generateId();
      const otherConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      // Active connection has no deviceId (e.g. an older client); the new
      // connection sending one must not be treated as a match against "no
      // device on record" — queue as normal.
      registry.attachConnection(sessionId, activeConn);
      const result = registry.attachConnection(sessionId, otherConn, 'device-A');

      expect(result.attachState).toBe('queued');
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(activeConn);
      expect(events.onConnectionReclaimed).not.toHaveBeenCalled();
    });

    test('reclaimed session replays full history to the new connection', () => {
      const sessionId = generateId();
      const staleConn = generateId();
      const newConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI(3));

      registry.attachConnection(sessionId, staleConn, 'device-A');
      const msg: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      registry.recordOutgoingMessage(sessionId, msg);

      const result = registry.attachConnection(sessionId, newConn, 'device-A');

      expect(result.replayMessages).toContain(msg);
      expect(result.nextBulletId).toBe(4);
    });

    test('after reclaim, detaching the stale connection id is a no-op (does not orphan)', () => {
      const sessionId = generateId();
      const staleConn = generateId();
      const newConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, staleConn, 'device-A');
      registry.attachConnection(sessionId, newConn, 'device-A');

      // The stale connection's own disconnect (e.g. its socket finally
      // errors out after being evicted) must not clobber the new connection's
      // lock: activeConnectionId no longer equals staleConn, so this is a no-op.
      registry.detachConnection(staleConn);

      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(newConn);
      expect(events.onSessionOrphaned).not.toHaveBeenCalled();
    });

    test('after reclaim, a genuinely different device attaching later still queues', () => {
      const sessionId = generateId();
      const staleConn = generateId();
      const newConn = generateId();
      const otherDeviceConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, staleConn, 'device-A');
      registry.attachConnection(sessionId, newConn, 'device-A');

      const result = registry.attachConnection(sessionId, otherDeviceConn, 'device-B');

      expect(result.attachState).toBe('queued');
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(newConn);
    });

    test('a FIFO-promoted connection carries its deviceId forward as activeDeviceId', () => {
      // Without this, only the FIRST-ever active connection's device could
      // ever be reclaimed; a connection reached via the waiting-queue
      // promotion path would silently lose reclaim protection.
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, connA); // active, no deviceId
      registry.attachConnection(sessionId, connB, 'device-B'); // queued, WITH deviceId

      // A disconnects -> B is FIFO-promoted to active.
      registry.detachConnection(connA);
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(connB);

      expect(events.onConnectionPromoted).toHaveBeenCalledTimes(1);
      const call = events.onConnectionPromoted.mock.calls[0] as
        | [string, string, AttachResult]
        | undefined;
      expect(call?.[2].attachState).toBe('attached');
    });

    test('a promoted-then-stale connection is still reclaimable by the same device', () => {
      // The exact scenario the queue-deviceId fix targets: connB starts
      // queued (not the original active connection), gets promoted when
      // connA disconnects, and THEN itself goes stale. A genuine reconnect
      // from device-B must still reclaim rather than queue behind connB.
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      const connBReconnect = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, connA, 'device-A');
      registry.attachConnection(sessionId, connB, 'device-B'); // queued with deviceId

      registry.detachConnection(connA); // connB promoted to active
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(connB);

      // connB goes stale (e.g. reaped by the pong timeout) and device-B
      // reconnects as a brand new connection.
      const result = registry.attachConnection(sessionId, connBReconnect, 'device-B');

      expect(result.success).toBe(true);
      expect(result.attachState).toBe('attached');
      expect(registry.waitingConnectionCount).toBe(0);
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(connBReconnect);
      // The promoted-then-stale connection was evicted, not queued behind.
      expect(registry.getSessionForConnection(connB)).toBeUndefined();
      expect(events.onConnectionReclaimed).toHaveBeenCalledWith(sessionId, connB, connBReconnect);
    });

    test('a promoted connection without a deviceId still just queues on reconnect (no false reclaim)', () => {
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      const connC = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, connA); // active, no deviceId
      registry.attachConnection(sessionId, connB); // queued, no deviceId either

      registry.detachConnection(connA); // connB promoted; activeDeviceId stays null
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(connB);

      const result = registry.attachConnection(sessionId, connC, 'device-C');

      expect(result.attachState).toBe('queued');
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(connB);
      expect(events.onConnectionReclaimed).not.toHaveBeenCalled();
    });
  });

  describe('fingerprint-bound reclaim (#671)', () => {
    test('matching deviceId + matching clientFingerprint reclaims (auth on)', () => {
      const sessionId = generateId();
      const staleConn = generateId();
      const newConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, staleConn, 'device-A', 'fp-alice');
      const result = registry.attachConnection(sessionId, newConn, 'device-A', 'fp-alice');

      expect(result.success).toBe(true);
      expect(result.attachState).toBe('attached');
      expect(registry.waitingConnectionCount).toBe(0);
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(newConn);
      expect(registry.getSessionForConnection(staleConn)).toBeUndefined();
      expect(events.onConnectionReclaimed).toHaveBeenCalledWith(sessionId, staleConn, newConn);
    });

    test('matching deviceId + DIFFERENT clientFingerprint is refused: queues, no eviction', () => {
      const sessionId = generateId();
      const activeConn = generateId();
      const attackerConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      // Legitimate device authenticates and holds the lock.
      registry.attachConnection(sessionId, activeConn, 'device-A', 'fp-alice');

      // A different authenticated peer replays/guesses the same deviceId but
      // cannot produce the same fingerprint. Must be refused: queued, not
      // evicted.
      const result = registry.attachConnection(sessionId, attackerConn, 'device-A', 'fp-mallory');

      expect(result.success).toBe(true);
      expect(result.attachState).toBe('queued');
      expect(registry.waitingConnectionCount).toBe(1);
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(activeConn);
      expect(registry.getSessionForConnection(activeConn)?.sessionId).toBe(sessionId);
      expect(events.onConnectionReclaimed).not.toHaveBeenCalled();
    });

    test('matching deviceId + active has a fingerprint but reconnect sends none: refused', () => {
      // A downgrade attempt: the legitimate device authenticated once, but a
      // later hello for the same deviceId arrives with no clientFingerprint
      // at all (e.g. an unauthenticated connection). Must not reclaim.
      const sessionId = generateId();
      const activeConn = generateId();
      const attackerConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, activeConn, 'device-A', 'fp-alice');
      const result = registry.attachConnection(sessionId, attackerConn, 'device-A');

      expect(result.attachState).toBe('queued');
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(activeConn);
      expect(events.onConnectionReclaimed).not.toHaveBeenCalled();
    });

    test('matching deviceId with NO fingerprint on either side still reclaims (auth off)', () => {
      // Localhost-only daemons (or loopback-exempt peers) never authenticate,
      // so neither side ever carries a clientFingerprint. Falls back to
      // today's deviceId-only reclaim.
      const sessionId = generateId();
      const staleConn = generateId();
      const newConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, staleConn, 'device-A');
      const result = registry.attachConnection(sessionId, newConn, 'device-A');

      expect(result.success).toBe(true);
      expect(result.attachState).toBe('attached');
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(newConn);
      expect(events.onConnectionReclaimed).toHaveBeenCalledWith(sessionId, staleConn, newConn);
    });

    test('a FIFO-promoted connection carries its clientFingerprint forward for later reclaim checks', () => {
      // Mirrors the deviceId-through-promotion fix (#662): a connection
      // promoted from the waiting queue must keep the SAME identity bar for
      // a later reclaim attempt against it, not silently downgrade to
      // deviceId-only just because it arrived via promotion.
      const sessionId = generateId();
      const connA = generateId();
      const connB = generateId();
      const attackerConn = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());

      registry.attachConnection(sessionId, connA); // active, no identity
      registry.attachConnection(sessionId, connB, 'device-B', 'fp-bob'); // queued, authenticated

      registry.detachConnection(connA); // connB promoted to active
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(connB);
      expect(registry.getSession(sessionId)?.activeClientFingerprint).toBe('fp-bob');

      // An attacker guesses device-B's id but cannot produce fp-bob.
      const spoofed = registry.attachConnection(sessionId, attackerConn, 'device-B', 'fp-mallory');
      expect(spoofed.attachState).toBe('queued');
      expect(registry.getSession(sessionId)?.activeConnectionId).toBe(connB);
      expect(events.onConnectionReclaimed).not.toHaveBeenCalled();

      // The real device-B reconnecting with the matching fingerprint still
      // reclaims normally.
      const genuine = registry.attachConnection(sessionId, generateId(), 'device-B', 'fp-bob');
      expect(genuine.attachState).toBe('attached');
      expect(events.onConnectionReclaimed).toHaveBeenCalledTimes(1);
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
      expect(session?.activeConnectionId).toBeNull();
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

    test('returns false for connected session', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, generateId());

      expect(registry.canResume(sessionId)).toBe(false);
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

  describe('waiting connection promotion', () => {
    const sessionId = generateId();
    const connA = generateId();
    const connB = generateId();
    const connC = generateId();

    beforeEach(() => {
      registry.registerSession(sessionId, '/tmp/test', createMockPTY(), createMockMessageAPI());
    });

    test('queues connection when session is busy (with read-only replay)', () => {
      registry.attachConnection(sessionId, connA);
      const result = registry.attachConnection(sessionId, connB);

      // Queued connections now succeed with read-only replay access
      expect(result.success).toBe(true);
      expect(result.isResume).toBe(true);
      expect(registry.waitingConnectionCount).toBe(1);
    });

    test('does not queue same connection twice', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);
      registry.attachConnection(sessionId, connB); // duplicate

      expect(registry.waitingConnectionCount).toBe(1);
    });

    test('auto-promotes waiting connection when active disconnects', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB); // queued

      registry.detachConnection(connA);

      // connB should now be active
      const session = registry.getSessionForConnection(connB);
      expect(session).toBeDefined();
      expect(session?.activeConnectionId).toBe(connB);
      expect(registry.waitingConnectionCount).toBe(0);
    });

    test('fires onConnectionPromoted when promoting', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);

      registry.detachConnection(connA);

      expect(events.onConnectionPromoted).toHaveBeenCalledTimes(1);
      const call = events.onConnectionPromoted.mock.calls[0] as
        | [string, string, AttachResult]
        | undefined;
      expect(call).toBeDefined();
      const [sid, cid, result] = call as [string, string, AttachResult];
      expect(sid).toBe(sessionId);
      expect(cid).toBe(connB);
      expect(result.success).toBe(true);
    });

    test('does not fire onSessionOrphaned when promoting', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);

      registry.detachConnection(connA);

      // onSessionOrphaned should NOT fire because connB was promoted
      expect(events.onSessionOrphaned).not.toHaveBeenCalled();
    });

    test('promotes in FIFO order', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);
      registry.attachConnection(sessionId, connC);

      expect(registry.waitingConnectionCount).toBe(2);

      // A disconnects -> B promoted
      registry.detachConnection(connA);
      expect(registry.getSessionForConnection(connB)).toBeDefined();
      expect(registry.waitingConnectionCount).toBe(1);

      // B disconnects -> C promoted
      registry.detachConnection(connB);
      expect(registry.getSessionForConnection(connC)).toBeDefined();
      expect(registry.waitingConnectionCount).toBe(0);
    });

    test('removes waiting connection on disconnect before promotion', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);
      registry.attachConnection(sessionId, connC);

      // B disconnects before being promoted
      registry.removeWaitingConnection(connB);
      expect(registry.waitingConnectionCount).toBe(1);

      // A disconnects -> C promoted (B was removed)
      registry.detachConnection(connA);
      expect(registry.getSessionForConnection(connC)).toBeDefined();
    });

    test('detachConnection also removes from waiting queue', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);

      // detach connB which is in waiting queue, not active
      registry.detachConnection(connB);
      expect(registry.waitingConnectionCount).toBe(0);

      // A disconnects -> no one to promote, becomes orphaned
      registry.detachConnection(connA);
      expect(events.onSessionOrphaned).toHaveBeenCalled();
    });

    test('orphans session when no waiting connections remain', () => {
      registry.attachConnection(sessionId, connA);

      registry.detachConnection(connA);

      // No waiting connections, should fire orphaned event
      expect(events.onSessionOrphaned).toHaveBeenCalled();
    });

    test('promoted connection gets isResume and replay messages', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);

      // A disconnects, making session orphaned briefly
      registry.detachConnection(connA);
      // B was auto-promoted via the queue

      expect(events.onConnectionPromoted).toHaveBeenCalledTimes(1);
      const call = events.onConnectionPromoted.mock.calls[0] as
        | [string, string, AttachResult]
        | undefined;
      expect(call).toBeDefined();
      const [, , result] = call as [string, string, AttachResult];
      expect(result.success).toBe(true);
      // isResume is true because lastDisconnectedAt was set before promotion
      expect(result.isResume).toBe(true);
    });

    test('promoted connection receives all recent replay messages', () => {
      registry.attachConnection(sessionId, connA);

      // Record messages while A is connected
      const msg1 = {
        type: 'session_update',
        id: generateId(),
        timestamp: now(),
      } as ProtocolMessage;
      const msg2 = {
        type: 'session_update',
        id: generateId(),
        timestamp: now(),
      } as ProtocolMessage;
      registry.recordOutgoingMessage(sessionId, msg1);
      registry.recordOutgoingMessage(sessionId, msg2);

      // Detach A
      registry.detachConnection(connA);

      // Record more messages while orphaned
      const msg3 = {
        type: 'session_update',
        id: generateId(),
        timestamp: now(),
      } as ProtocolMessage;
      registry.recordOutgoingMessage(sessionId, msg3);

      // B attaches - now gets ALL recent messages (up to 200), not just undelivered
      const result = registry.attachConnection(sessionId, connB);
      expect(result.success).toBe(true);
      expect(result.replayMessages.length).toBe(3);
    });

    test('onSessionResumed fires during promotion', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);

      registry.detachConnection(connA);

      expect(events.onSessionResumed).toHaveBeenCalledTimes(1);
      expect(events.onSessionResumed).toHaveBeenCalledWith(sessionId, connB);
    });

    test('waiting queue is cleared when session is closed', () => {
      registry.attachConnection(sessionId, connA);
      registry.attachConnection(sessionId, connB);
      registry.attachConnection(sessionId, connC);

      expect(registry.waitingConnectionCount).toBe(2);

      registry.closeSession(sessionId, 'forced');

      expect(registry.waitingConnectionCount).toBe(0);
    });

    test('skips dead waiters when onConnectionPromoted callback throws', () => {
      // Override events to throw on first promotion, succeed on second
      let callCount = 0;
      const throwingRegistry = new SessionRegistry(
        { orphanTimeoutMs: 100 },
        {
          onConnectionPromoted: () => {
            callCount++;
            if (callCount === 1) throw new Error('connection dead');
          },
        },
      );

      const sid = generateId();
      throwingRegistry.registerSession(sid, '/tmp/test', createMockPTY(), createMockMessageAPI());
      throwingRegistry.attachConnection(sid, connA);
      throwingRegistry.attachConnection(sid, connB);
      throwingRegistry.attachConnection(sid, connC);

      // A disconnects -> B promotion throws -> C gets promoted
      throwingRegistry.detachConnection(connA);

      expect(callCount).toBe(2);
      expect(throwingRegistry.getSessionForConnection(connC)).toBeDefined();
    });
  });
});
