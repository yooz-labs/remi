import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import type { CurrentOwnedSession } from '../../../src/cli/current-session.ts';
import { createConnectionHandlers } from '../../../src/cli/handlers/connection-events.ts';
import { HubClientTracker } from '../../../src/cli/hub-client-tracker.ts';
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
      remiVersion: '9.9.9-test',
    });
  }

  describe('onConnect', () => {
    test('tracks connection and sends a session-less hello_ack when no primary session exists (#542)', async () => {
      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      expect(trackedConnections).toEqual([{ id: CID, type: 'websocket' }]);
      expect(connectionAddedCount).toBe(1);
      // A hub daemon (or an ordinary daemon in the brief pre-session window)
      // acks the connection with sessionId: null instead of erroring, so a
      // client can sit connected until a session is created (#542).
      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as {
        type: string;
        sessionId?: unknown;
        daemonVersion?: unknown;
      };
      expect(msg.type).toBe('hello_ack');
      expect(msg.sessionId).toBeNull();
      // Connection-time acks carry the daemon's binary version (#539).
      expect(msg.daemonVersion).toBe('9.9.9-test');
    });

    test('a primary session set still attaches normally (regression, #542)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as {
        type: string;
        sessionId?: unknown;
        daemonVersion?: unknown;
      };
      expect(msg.type).toBe('hello_ack');
      expect(msg.sessionId).toBe(sessionId);
      // Every connection-time ack path stamps the binary version (#539).
      expect(msg.daemonVersion).toBe('9.9.9-test');
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.has(CID)).toBe(true);
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
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.has(CID)).toBe(true);
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
      const queryAck = sendCalls[0]?.message as { type: string; daemonVersion?: unknown };
      expect(queryAck.type).toBe('hello_ack');
      // The query-mode/no-attach ack path also stamps the version (#539).
      expect(queryAck.daemonVersion).toBe('9.9.9-test');
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.size).toBe(0);
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
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.size).toBe(0);
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
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.has(CID)).toBe(true);
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

    test('#753: pending questions are re-sent as LIVE question messages after attach', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      // One question answered before this attach (must NOT be re-sent), one
      // still pending (must arrive as a live `question` message).
      const answeredId = generateId();
      sessionRegistry.addQuestion(sessionId, {
        id: answeredId,
        text: 'old, already answered?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      });
      sessionRegistry.removeQuestion(sessionId, answeredId);
      const pendingId = generateId();
      sessionRegistry.addQuestion(sessionId, {
        id: pendingId,
        text: 'Allow Bash: git push',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      });

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      const questionMsgs = sendCalls.filter((c) => c.message.type === 'question');
      expect(questionMsgs).toHaveLength(1);
      const q = questionMsgs[0]?.message as { question: { id: UUID; text: string } };
      expect(q.question.id).toBe(pendingId);
      expect(q.question.text).toBe('Allow Bash: git push');
      // Ordering: hello_ack first, live questions after (and after any replay).
      expect(sendCalls[0]?.message.type).toBe('hello_ack');
      expect(sendCalls[sendCalls.length - 1]?.message.type).toBe('question');
    });

    test('second concurrent connection also attaches (not queued) and receives helloAck + replay (#795)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI(2));
      setPrimarySessionId(sessionId);

      // First connection attaches.
      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn);
      const recorded: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
      sessionRegistry.recordOutgoingMessage(sessionId, recorded);

      // Second connection arrives while the first is still attached.
      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      // Both connections are attached -- no exclusivity, no queue.
      const session = sessionRegistry.getSession(sessionId);
      expect(session?.attachedConnections.has(firstConn)).toBe(true);
      expect(session?.attachedConnections.has(CID)).toBe(true);
      expect(session?.attachedConnections.size).toBe(2);
      // CID can read AND write immediately.
      expect(sessionRegistry.getSessionForConnection(CID)?.sessionId).toBe(sessionId);

      // The second connection still gets helloAck + replay so it can render
      // history, exactly as before -- only the write-exclusivity is gone.
      expect(sendCalls).toHaveLength(2);
      const ack = sendCalls[0]?.message as {
        type: string;
        isResume?: boolean;
        replayCount?: number;
        attachState?: string;
      };
      expect(ack.type).toBe('hello_ack');
      expect(ack.attachState).toBe('attached');
      expect(ack.replayCount).toBe(1);

      const replay = sendCalls[1]?.message as {
        type: string;
        messages?: readonly ProtocolMessage[];
      };
      expect(replay.type).toBe('replay_batch');
      expect(replay.messages?.length).toBe(1);
    });

    test('query-mode connection does not attach at all', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket', mode: 'query' },
      });

      // The attached connection stays; query-mode client (ls/kill) does not
      // attach at all -- it never contends for a slot because there is none.
      const session = sessionRegistry.getSession(sessionId);
      expect(session?.attachedConnections.has(firstConn)).toBe(true);
      expect(session?.attachedConnections.has(CID)).toBe(false);
      expect(session?.attachedConnections.size).toBe(1);
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
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.has(CID)).toBe(true);
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

    test('helloAck reports attachState "attached" for a fresh attach', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.type).toBe('hello_ack');
      expect(ack.attachState).toBe('attached');
    });

    test('helloAck reports attachState "attached" for a SECOND connection too (#795: no more queued state)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      setPrimarySessionId(sessionId);

      const firstConn = generateId();
      sessionRegistry.attachConnection(sessionId, firstConn);

      await makeHandlers().onConnect(CID, {
        adapterType: 'websocket',
        platformData: { kind: 'websocket' },
      });

      const ack = sendCalls[0]?.message as { type: string; attachState?: string };
      expect(ack.type).toBe('hello_ack');
      expect(ack.attachState).toBe('attached');
      const session = sessionRegistry.getSession(sessionId);
      expect(session?.attachedConnections.has(firstConn)).toBe(true);
      expect(session?.attachedConnections.has(CID)).toBe(true);
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
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.has(CID)).toBe(false);
    });

    test('detaching one of two attached connections leaves the other attached (#795)', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      const otherConn = generateId();
      sessionRegistry.attachConnection(sessionId, otherConn);
      sessionRegistry.attachConnection(sessionId, CID);

      await makeHandlers().onDisconnect(CID, 'client closed');

      const session = sessionRegistry.getSession(sessionId);
      expect(session?.attachedConnections.has(CID)).toBe(false);
      expect(session?.attachedConnections.has(otherConn)).toBe(true);
      expect(sessionRegistry.getSessionForConnection(otherConn)?.sessionId).toBe(sessionId);
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

/**
 * Hub census wiring (#650): the REAL createConnectionHandlers feeding a REAL
 * HubClientTracker via onPeerConnect/onPeerDisconnect — exactly how cli.ts
 * wires a hub. The relay metadata literal matches what RelayAdapter actually
 * emits on peer-connected/auth-success (remote/relay-adapter.ts).
 */
describe('onPeerConnect/onPeerDisconnect feed the hub census (#650)', () => {
  const RELAY_CID = 'conn0000-relay-0000-0000-000000000001' as UUID;

  beforeEach(() => {
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    __resetSessionStateForTests();
  });

  test('a relay client counts remote through the real handler; disconnect decrements', async () => {
    const sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    try {
      const sent: Array<{ connectionId: UUID; message: ProtocolMessage }> = [];
      const broadcasts: ProtocolMessage[] = [];
      const tracker = new HubClientTracker({
        send: (connectionId, message) => {
          sent.push({ connectionId, message });
        },
        broadcast: (message) => broadcasts.push(message),
        getCensus: () => ({ sessions: 0, questions: [] }),
        getAutostartState: () => 'none',
        hubVersion: '9.9.9-test',
      });
      const handlers = createConnectionHandlers({
        sessionRegistry,
        currentOwnedSession: () => null,
        trackConnection: () => {},
        untrackConnection: () => {},
        onConnectionAdded: () => {},
        onConnectionRemoved: () => {},
        cancelOrphanTimeout: () => {},
        send: (connectionId, message) => {
          sent.push({ connectionId, message });
          return true;
        },
        remiVersion: '9.9.9-test',
        onPeerConnect: (connectionId, metadata) => tracker.onConnect(connectionId, metadata),
        onPeerDisconnect: (connectionId) => tracker.onDisconnect(connectionId),
      });

      await handlers.onConnect(RELAY_CID, {
        adapterType: 'relay',
        displayName: 'Remote Client',
        platformData: { kind: 'relay', code: 'ABC123' },
      });

      // The hello_ack is sent directly; the census (a count CHANGE, so it
      // travels as a broadcast, which reaches the new connection too) tags
      // the relay client remote. onPeerConnect runs synchronously after the
      // ack send, so wire order is hello_ack then hub_status.
      const ackFrames = sent.filter((s) => s.connectionId === RELAY_CID).map((s) => s.message.type);
      expect(ackFrames).toContain('hello_ack');
      expect(broadcasts).toHaveLength(1);
      const census = broadcasts.at(-1) as { remoteClients: number; localClients: number };
      expect(census.remoteClients).toBe(1);
      expect(census.localClients).toBe(0);

      await handlers.onDisconnect(RELAY_CID, 'peer closed');
      const after = broadcasts.at(-1) as { remoteClients: number };
      expect(after.remoteClients).toBe(0);
    } finally {
      await sessionRegistry.shutdown();
    }
  });
});
