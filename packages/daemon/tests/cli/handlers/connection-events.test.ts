import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import type { CurrentOwnedSession } from '../../../src/cli/current-session.ts';
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

function fakeMessageAPI(bulletCount = 0): MessageAPI {
  return {
    getFullBulletContent: () => null,
    bulletCount,
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

  function makeHandlers(currentOwnedSession: () => CurrentOwnedSession | null = () => null) {
    return createConnectionHandlers({
      sessionRegistry,
      currentOwnedSession,
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
        platformData: { kind: 'websocket' },
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
        platformData: { kind: 'websocket' },
      });

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string };
      expect(msg.type).toBe('hello_ack');
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(CID);
      expect(cancelOrphanCalls).toBe(1);
    });

    test('helloAck carries the authoritative current binding (#499)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);
      const current: CurrentOwnedSession = {
        sessionId,
        claudeSessionId: '22222222-2222-2222-2222-222222222222' as UUID,
        transcriptPath: '/p/22222222-2222-2222-2222-222222222222.jsonl',
      };

      await makeHandlers(() => current).onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      const ack = sendCalls[0]?.message as {
        type: string;
        claudeSessionId?: string | null;
        transcriptPath?: string | null;
      };
      expect(ack.type).toBe('hello_ack');
      expect(ack.claudeSessionId).toBe(current.claudeSessionId);
      expect(ack.transcriptPath).toBe(current.transcriptPath);
    });

    test('query-mode clients get a helloAck without attaching', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', mode: 'query' },
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
          kind: 'websocket',
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

    test('attaches when resumeSessionId matches the primary session', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', resumeSessionId: sessionId },
      });

      // No error; helloAck sent and attach succeeded.
      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string; sessionId?: UUID };
      expect(msg.type).toBe('hello_ack');
      expect(msg.sessionId).toBe(sessionId);
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(CID);
      expect(cancelOrphanCalls).toBe(1);
    });

    test('helloAck reports replay metadata and replayBatch follows when history exists', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI(3));
      setPrimarySessionId(sessionId);

      // Attach + detach to leave a "previous session" with history; the next
      // attach goes through the resume path with replayMessages populated.
      const previousConn = generateId();
      sessionRegistry.attachConnection(sessionId, previousConn);
      const m1: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      const m2: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      sessionRegistry.recordOutgoingMessage(sessionId, m1);
      sessionRegistry.recordOutgoingMessage(sessionId, m2);
      sessionRegistry.detachConnection(previousConn);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      expect(sendCalls).toHaveLength(2);
      const ack = sendCalls[0]?.message as {
        type: string;
        isResume?: boolean;
        replayCount?: number;
        nextBulletId?: number;
      };
      expect(ack.type).toBe('hello_ack');
      expect(ack.isResume).toBe(true);
      expect(ack.replayCount).toBe(2);
      expect(ack.nextBulletId).toBe(4);

      const replay = sendCalls[1]?.message as {
        type: string;
        messages?: readonly ProtocolMessage[];
      };
      expect(replay.type).toBe('replay_batch');
      expect(replay.messages?.length).toBe(2);
    });

    test('second concurrent connection is queued and still receives helloAck + replay', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI(2));
      setPrimarySessionId(sessionId);

      // First connection takes the active slot.
      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn);
      const recorded: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      sessionRegistry.recordOutgoingMessage(sessionId, recorded);

      // Second connection arrives while the first is still active.
      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      // Active connection is still the first; CID is queued.
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(firstConn);
      expect(sessionRegistry.waitingConnectionCount).toBe(1);

      // Queued client still gets helloAck + replay so it can render history.
      expect(sendCalls).toHaveLength(2);
      const ack = sendCalls[0]?.message as {
        type: string;
        isResume?: boolean;
        replayCount?: number;
      };
      expect(ack.type).toBe('hello_ack');
      expect(ack.isResume).toBe(true);
      expect(ack.replayCount).toBe(1);

      const replay = sendCalls[1]?.message as {
        type: string;
        messages?: readonly ProtocolMessage[];
      };
      expect(replay.type).toBe('replay_batch');
      expect(replay.messages?.length).toBe(1);
    });

    test('query-mode connection does not displace an existing active connection', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', mode: 'query' },
      });

      // Active connection stays; query-mode client did not grab the slot or
      // queue (utility clients ls/kill should not contend for write access).
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(firstConn);
      expect(sessionRegistry.waitingConnectionCount).toBe(0);
      expect(sendCalls).toHaveLength(1);
      const ack = sendCalls[0]?.message as { type: string; isResume?: boolean };
      expect(ack.type).toBe('hello_ack');
      // Plain helloAck (no resume info) since we skipped attachConnection.
      expect(ack.isResume).toBeUndefined();
      expect(cancelOrphanCalls).toBe(0);
    });

    test('omitted platformData is treated like no metadata fields', async () => {
      // Adapters with no platform-specific extras (e.g. simple ones) may pass
      // metadata without a platformData field at all. The handler must not
      // crash and should auto-attach exactly like an empty platformData.
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, { adapterType: 'websocket' });

      expect(sendCalls).toHaveLength(1);
      expect((sendCalls[0]?.message as { type: string }).type).toBe('hello_ack');
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(CID);
    });

    test('tracks the connection on the AdapterRegistry before any branch decision', async () => {
      // No primary session = NO_SESSION error path; tracking still happens.
      await makeHandlers().onConnect(CID, {
        adapterType: 'telegram',
        platformData: { kind: 'websocket' },
      });
      expect(trackedConnections).toEqual([{ id: CID, type: 'telegram' }]);
      expect(connectionAddedCount).toBe(1);
    });

    test('helloAck reports attachState "attached" for a fresh attach (#662)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', deviceId: 'device-A' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.type).toBe('hello_ack');
      expect(ack.attachState).toBe('attached');
    });

    test('helloAck reports attachState "queued" for a second connection without a matching deviceId (#662)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn, 'device-A');

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', deviceId: 'device-B' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.type).toBe('hello_ack');
      expect(ack.attachState).toBe('queued');
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(firstConn);
    });

    test('same deviceId reclaims the lock instead of queuing behind its own stale connection (#662)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      // First connection from this device takes the active slot.
      const staleConn = generateId();
      sessionRegistry.attachConnection(sessionId, staleConn, 'device-A');

      // Same device reconnects (e.g. after a dead-socket blip) as a new
      // connection carrying the SAME deviceId.
      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', deviceId: 'device-A' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.type).toBe('hello_ack');
      expect(ack.attachState).toBe('attached');
      // The lock moved to the new connection; nothing is queued.
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(CID);
      expect(sessionRegistry.waitingConnectionCount).toBe(0);
      expect(sessionRegistry.getSessionForConnection(staleConn)).toBeUndefined();
    });

    test('same deviceId + matching clientFingerprint reclaims (#671, auth on)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      const staleConn = generateId();
      sessionRegistry.attachConnection(sessionId, staleConn, 'device-A', 'fp-alice');

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', deviceId: 'device-A', clientFingerprint: 'fp-alice' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.attachState).toBe('attached');
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(CID);
      expect(sessionRegistry.waitingConnectionCount).toBe(0);
      expect(sessionRegistry.getSessionForConnection(staleConn)).toBeUndefined();
    });

    test('same deviceId + DIFFERENT clientFingerprint is refused: queues, does not evict (#671)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      // Legitimate device holds the lock after authenticating.
      const activeConn = generateId();
      sessionRegistry.attachConnection(sessionId, activeConn, 'device-A', 'fp-alice');

      // A different authenticated peer replays the same deviceId but cannot
      // produce the matching fingerprint (it authenticated with its OWN key).
      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', deviceId: 'device-A', clientFingerprint: 'fp-mallory' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.attachState).toBe('queued');
      // Legitimate device keeps the lock; nothing was evicted.
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(activeConn);
      expect(sessionRegistry.getSessionForConnection(activeConn)?.sessionId).toBe(sessionId);
    });

    test('same deviceId with no clientFingerprint on either side still reclaims (#671, auth off)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      // Localhost daemon / loopback-exempt peer: no authenticator, so no
      // clientFingerprint is ever produced on either side.
      const staleConn = generateId();
      sessionRegistry.attachConnection(sessionId, staleConn, 'device-A');

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', deviceId: 'device-A' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.attachState).toBe('attached');
      expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).toBe(CID);
      expect(sessionRegistry.getSessionForConnection(staleConn)).toBeUndefined();
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

    test('does not reach into deviceTokens on disconnect (regression #286)', async () => {
      // The connection-events handler must not be able to clean up APNS
      // device tokens on disconnect — push notifications are the suspended-
      // app path, so dropping tokens at WS close kills the only case they
      // exist for. The argument is structural: ConnectionHandlerDeps does
      // not surface a deviceTokens map. Lock that with a static-source check
      // so a future refactor that re-adds the field (and a delete() call)
      // fails this test rather than silently regressing the user-visible
      // suspended-app push case.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const handlerPath = path.resolve(
        import.meta.dir,
        '../../../src/cli/handlers/connection-events.ts',
      );
      const source = fs.readFileSync(handlerPath, 'utf8');
      expect(source).not.toMatch(/deviceTokens/);
    });
  });
});
