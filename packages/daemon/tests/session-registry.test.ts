/**
 * Tests for SessionRegistry - session lifecycle management.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProtocolMessage } from '@remi/shared';
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
  };

  beforeEach(() => {
    events = {
      onSessionCreated: mock(() => {}),
      onSessionClosed: mock(() => {}),
      onSessionOrphaned: mock(() => {}),
      onSessionResumed: mock(() => {}),
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

    test('returns error if session already has connection', () => {
      const sessionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, generateId());

      const result = registry.attachConnection(sessionId, generateId());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Session already has active connection');
    });

    test('getSessionForConnection works after attach', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(sessionId, '/test/dir', createMockPTY(), createMockMessageAPI());
      registry.attachConnection(sessionId, connectionId);

      const session = registry.getSessionForConnection(connectionId);
      expect(session?.sessionId).toBe(sessionId);
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

    test('resume returns replay messages', () => {
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

      // Resume
      const result = registry.attachConnection(sessionId, connectionId2);

      expect(result.success).toBe(true);
      expect(result.isResume).toBe(true);
      expect(result.replayMessages.length).toBe(1);
      expect(result.replayMessages[0]).toBe(msg3);
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
});
