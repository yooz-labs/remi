import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createConnectionHandlers } from '../../../src/cli/handlers/connection-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import {
  __resetSessionStateForTests,
  setPrimarySessionId,
} from '../../../src/cli/session-state.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';

/** Minimal fakes matching the pattern in session-registry.test.ts (casts through unknown). */
function fakePTY(): PTYSession {
  return {
    id: generateId(),
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

function fakeMessageAPI(): MessageAPI {
  return {
    getFullBulletContent: () => null,
  } as unknown as MessageAPI;
}

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;

describe('createConnectionHandlers', () => {
  let sessionRegistry: SessionRegistry;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let trackedConnections: Array<{ id: UUID; type: string }>;
  let untrackedConnections: UUID[];
  let connectionAddedCount: number;
  let connectionRemovedCount: number;
  let cancelOrphanCalls: number;

  function send(connectionId: UUID, message: ProtocolMessage): boolean {
    sendCalls.push({ connectionId, message });
    return true;
  }

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sendCalls = [];
    trackedConnections = [];
    untrackedConnections = [];
    connectionAddedCount = 0;
    connectionRemovedCount = 0;
    cancelOrphanCalls = 0;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    __resetSessionStateForTests();
    await sessionRegistry.shutdown();
  });

  function makeHandlers() {
    return createConnectionHandlers({
      sessionRegistry,
      trackConnection: (id, type) => {
        trackedConnections.push({ id, type });
      },
      untrackConnection: (id) => {
        untrackedConnections.push(id);
      },
      onConnectionAdded: () => {
        connectionAddedCount += 1;
      },
      onConnectionRemoved: () => {
        connectionRemovedCount += 1;
      },
      cancelOrphanTimeout: () => {
        cancelOrphanCalls += 1;
      },
      send,
    });
  }

  describe('onConnect', () => {
    test('tracks connection and sends NO_SESSION when no primary session exists', async () => {
      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: {},
      });

      expect(trackedConnections).toEqual([{ id: CID, type: 'websocket' }]);
      expect(connectionAddedCount).toBe(1);
      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string; code?: string };
      expect(msg.type).toBe('error');
      expect(msg.code).toBe('NO_SESSION');
    });

    test('auto-attaches and sends helloAck when a primary session exists (non-query)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: {},
      });

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string };
      expect(msg.type).toBe('hello_ack');
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(CID);
      expect(cancelOrphanCalls).toBe(1);
    });

    test('query-mode clients get a helloAck without attaching', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { mode: 'query' },
      });

      expect(sendCalls).toHaveLength(1);
      expect((sendCalls[0]?.message as { type: string }).type).toBe('hello_ack');
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBeNull();
      expect(cancelOrphanCalls).toBe(0);
    });

    test('rejects with SESSION_NOT_FOUND when resumeSessionId does not match primary', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: {
          resumeSessionId: 'mism0000-0000-0000-0000-000000000000' as UUID,
        },
      });

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string; code?: string };
      expect(msg.type).toBe('error');
      expect(msg.code).toBe('SESSION_NOT_FOUND');
      // Attach should NOT have happened.
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBeNull();
    });
  });

  describe('onDisconnect', () => {
    test('detaches from registry and decrements connection count', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, CID);

      await makeHandlers().onDisconnect(CID, 'client closed');

      expect(untrackedConnections).toEqual([CID]);
      expect(connectionRemovedCount).toBe(1);
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBeNull();
    });

    // The "device tokens persist across disconnect" invariant for #286 is
    // enforced structurally: ConnectionHandlerDeps no longer exposes a
    // deviceTokens map at all, so onDisconnect cannot mutate token state.
    // Adding a behavioral test here would be tautological — the token map is
    // neither passed in nor reachable from this handler. The behavioral test
    // (push fires while no client is attached) belongs in
    // message-api-setup.test.ts and requires injecting sendPushTrigger via
    // deps; tracked separately as a follow-up.
  });
});
