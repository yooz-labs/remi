/**
 * Tests for SessionRegistry - session lifecycle management.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProtocolMessage } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { MessageAPI } from '../src/api/message-api.ts';
import type { OutputProcessor } from '../src/parser/output-processor.ts';
import type { PTYSession } from '../src/pty/pty-session.ts';
import { SessionRegistry } from '../src/session/session-registry.ts';

function createMockPTY(): PTYSession {
  return {
    id: generateId(),
    close: mock(() => Promise.resolve()),
  } as unknown as PTYSession;
}

function createMockProcessor(): OutputProcessor {
  return {
    process: mock(() => {}),
    flush: mock(() => {}),
  } as unknown as OutputProcessor;
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
      const processor = createMockProcessor();
      const messageApi = createMockMessageAPI();

      registry.registerSession(sessionId, '/test/dir', pty, processor, messageApi);

      expect(registry.sessionCount).toBe(1);
      expect(registry.getSession(sessionId)).toBeDefined();
      expect(events.onSessionCreated).toHaveBeenCalledWith(sessionId);
    });

    test('session starts with no connection', () => {
      const sessionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );

      const session = registry.getSession(sessionId);
      expect(session?.activeConnectionId).toBeNull();
      expect(session?.lastDisconnectedAt).toBeNull();
    });
  });

  describe('attachConnection()', () => {
    test('attaches connection to session', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );

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
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
      registry.attachConnection(sessionId, generateId());

      const result = registry.attachConnection(sessionId, generateId());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Session already has active connection');
    });

    test('getSessionForConnection works after attach', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
      registry.attachConnection(sessionId, connectionId);

      const session = registry.getSessionForConnection(connectionId);
      expect(session?.sessionId).toBe(sessionId);
    });
  });

  describe('detachConnection()', () => {
    test('detaches connection and marks session orphaned', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
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
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
      registry.attachConnection(sessionId, connectionId);
      registry.detachConnection(connectionId);

      expect(registry.getSessionForConnection(connectionId)).toBeUndefined();
    });

    test('orphaned session is closed after timeout', async () => {
      const sessionId = generateId();
      const connectionId = generateId();
      const pty = createMockPTY();
      registry.registerSession(
        sessionId,
        '/test/dir',
        pty,
        createMockProcessor(),
        createMockMessageAPI(),
      );
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
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
      registry.attachConnection(sessionId, generateId());

      expect(registry.canResume(sessionId)).toBe(false);
    });

    test('returns true for orphaned session', () => {
      const sessionId = generateId();
      const connectionId = generateId();
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
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

      registry.registerSession(
        sessionId,
        '/test/dir',
        pty,
        createMockProcessor(),
        createMockMessageAPI(),
      );
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

      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(5),
      );
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
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
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
        createMockProcessor(),
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
      registry.registerSession(
        sessionId,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );

      registry.updateStatus(sessionId, 'thinking');

      const session = registry.getSession(sessionId);
      expect(session?.currentStatus).toBe('thinking');
    });
  });

  describe('closeSession()', () => {
    test('closes session and emits event', () => {
      const sessionId = generateId();
      const pty = createMockPTY();
      registry.registerSession(
        sessionId,
        '/test/dir',
        pty,
        createMockProcessor(),
        createMockMessageAPI(),
      );

      registry.closeSession(sessionId, 'forced');

      expect(registry.getSession(sessionId)).toBeUndefined();
      expect(events.onSessionClosed).toHaveBeenCalledWith(sessionId, 'forced');
      expect(pty.close).toHaveBeenCalled();
    });

    test('handlePTYExit closes session with pty_exit reason', () => {
      const sessionId = generateId();
      const pty = createMockPTY();
      registry.registerSession(
        sessionId,
        '/test/dir',
        pty,
        createMockProcessor(),
        createMockMessageAPI(),
      );

      registry.handlePTYExit(sessionId);

      expect(events.onSessionClosed).toHaveBeenCalledWith(sessionId, 'pty_exit');
    });
  });

  describe('orphanedCount', () => {
    test('counts orphaned sessions', () => {
      const sessionId1 = generateId();
      const sessionId2 = generateId();
      const connectionId1 = generateId();

      registry.registerSession(
        sessionId1,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );
      registry.registerSession(
        sessionId2,
        '/test/dir',
        createMockPTY(),
        createMockProcessor(),
        createMockMessageAPI(),
      );

      registry.attachConnection(sessionId1, connectionId1);
      registry.attachConnection(sessionId2, generateId());
      registry.detachConnection(connectionId1);

      expect(registry.orphanedCount).toBe(1);
    });
  });

  describe('shutdown()', () => {
    test('closes all sessions', async () => {
      const pty1 = createMockPTY();
      const pty2 = createMockPTY();
      registry.registerSession(
        generateId(),
        '/test',
        pty1,
        createMockProcessor(),
        createMockMessageAPI(),
      );
      registry.registerSession(
        generateId(),
        '/test',
        pty2,
        createMockProcessor(),
        createMockMessageAPI(),
      );

      await registry.shutdown();

      expect(pty1.close).toHaveBeenCalled();
      expect(pty2.close).toHaveBeenCalled();
      expect(registry.sessionCount).toBe(0);
    });
  });
});
