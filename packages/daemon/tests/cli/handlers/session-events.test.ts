import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createSessionHandlers } from '../../../src/cli/handlers/session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/index.ts';

/** Minimal fakes matching the pattern established in input-events.test.ts. */
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
const OTHER_CID = 'othr0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const BOGUS = 'bogu0000-0000-0000-0000-000000000000' as UUID;

describe('createSessionHandlers', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let transcriptDiscovery: TranscriptDiscovery;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let send: (connectionId: UUID, message: ProtocolMessage) => boolean;
  let untrackCalls: UUID[];
  let connectionRemovedCount: number;
  const PORT = 8765;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-session-events-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    liveSessionsRegistry = new SessionRegistryFile(tmpDir);
    transcriptDiscovery = new TranscriptDiscovery({
      projectsDir: path.join(tmpDir, 'claude-projects'),
    });
    sendCalls = [];
    send = (connectionId, message) => {
      sendCalls.push({ connectionId, message });
      return true;
    };
    untrackCalls = [];
    connectionRemovedCount = 0;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers() {
    return createSessionHandlers({
      sessionRegistry,
      sessionStore,
      transcriptDiscovery,
      liveSessionsRegistry,
      currentPort: () => PORT,
      untrackConnection: (id) => {
        untrackCalls.push(id);
      },
      onConnectionRemoved: () => {
        connectionRemovedCount += 1;
      },
      send,
    });
  }

  describe('onSessionListRequest', () => {
    test('returns the daemon-only list when includeExternal is false', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());

      makeHandlers().onSessionListRequest(CID, REQ, false);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as unknown as {
        type: string;
        sessions: unknown[];
      };
      expect(msg.type).toBe('session_list_response');
      expect(msg.sessions).toHaveLength(1);
    });

    test('omits the current daemon port from daemonPorts', () => {
      // Register one session entry for a DIFFERENT port alongside ours.
      liveSessionsRegistry.register({
        sessionId: 'othr1234-1234-1234-1234-123456789012',
        wsPort: 9999,
        pid: process.pid,
        hookPort: 0,
        projectPath: tmpDir,
        name: 'other',
        startedAt: new Date().toISOString(),
      });
      liveSessionsRegistry.register({
        sessionId: 'curr1234-1234-1234-1234-123456789012',
        wsPort: PORT,
        pid: process.pid,
        hookPort: 0,
        projectPath: tmpDir,
        name: 'current',
        startedAt: new Date().toISOString(),
      });

      makeHandlers().onSessionListRequest(CID, REQ, false);

      const msg = sendCalls[0]?.message as unknown as { daemonPorts?: number[] };
      expect(msg.daemonPorts).toEqual([9999]);
      expect(msg.daemonPorts).not.toContain(PORT);
    });
  });

  describe('onKillSessionRequest', () => {
    test('responds with failure when the session is unknown', () => {
      makeHandlers().onKillSessionRequest(CID, BOGUS, REQ);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string; success: boolean };
      expect(msg.type).toBe('kill_session_response');
      expect(msg.success).toBe(false);
    });

    test('closes the session and acks success when called by the active client', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, CID);

      makeHandlers().onKillSessionRequest(CID, sessionId, REQ);

      // Only an ack to the caller: no SESSION_ENDED error since the requester IS the active client.
      expect(sendCalls).toHaveLength(1);
      const ack = sendCalls[0]?.message as { type: string; success: boolean };
      expect(ack.type).toBe('kill_session_response');
      expect(ack.success).toBe(true);
      expect(sessionRegistry.getSession(sessionId)).toBeUndefined();
    });

    test('notifies a third-party attached client with SESSION_ENDED before killing', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, OTHER_CID);

      makeHandlers().onKillSessionRequest(CID, sessionId, REQ);

      expect(sendCalls).toHaveLength(2);
      const notice = sendCalls[0]?.message as { type: string; code?: string };
      expect(notice.type).toBe('error');
      expect(notice.code).toBe('SESSION_ENDED');
      expect(sendCalls[0]?.connectionId).toBe(OTHER_CID);
      const ack = sendCalls[1]?.message as { type: string; success: boolean };
      expect(ack.type).toBe('kill_session_response');
      expect(ack.success).toBe(true);
    });
  });

  describe('onDetachSession', () => {
    test('responds with failure when the session is unknown', () => {
      makeHandlers().onDetachSession(CID, BOGUS, REQ);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as { type: string; success: boolean };
      expect(msg.type).toBe('detach_session_ack');
      expect(msg.success).toBe(false);
    });

    test('responds with failure when the session is already detached', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      // No attachConnection: activeConnectionId stays null.

      makeHandlers().onDetachSession(CID, sessionId, REQ);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as {
        type: string;
        success: boolean;
        error?: string;
      };
      expect(msg.success).toBe(false);
      expect(msg.error).toBe('Session is already detached');
    });

    test('self-detach acks and releases the connection without untrack', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, CID);

      makeHandlers().onDetachSession(CID, sessionId, REQ);

      expect(sendCalls).toHaveLength(1);
      const ack = sendCalls[0]?.message as { type: string; success: boolean };
      expect(ack.success).toBe(true);
      // Self-detach path: onDisconnect will handle cleanup when the WebSocket actually closes.
      expect(untrackCalls).toEqual([]);
      expect(connectionRemovedCount).toBe(0);
    });

    test('third-party detach untracks the active connection and decrements the count', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, OTHER_CID);

      makeHandlers().onDetachSession(CID, sessionId, REQ);

      expect(sendCalls).toHaveLength(1);
      expect(untrackCalls).toEqual([OTHER_CID]);
      expect(connectionRemovedCount).toBe(1);
    });
  });
});
