import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { type PromptUpDeps, promptUpDeps } from '../../../src/cli/handlers/prompt-up.ts';
import { createSessionHandlers } from '../../../src/cli/handlers/session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { parseQuestion } from '../../../src/parser/question-parser.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/index.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../../parser/fixtures/claude-dialogs.ts';

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
const OTHER_CID = '0a000000-0000-0000-0000-000000000002' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const BOGUS = 'bogu0000-0000-0000-0000-000000000000' as UUID;

describe('createSessionHandlers', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let transcriptDiscovery: TranscriptDiscovery;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let send: (connectionId: UUID, message: ProtocolMessage) => boolean;
  let untrackCalls: UUID[];
  let connectionRemovedCount: number;
  // Mirrors the forward-ref wiring in cli.ts: the registry's onSessionClosed
  // drives the handlers' resolveStopOnClose. Set in makeHandlers (handlers do
  // not exist yet at registry-construction time).
  let registryOnClose: ((sessionId: UUID) => void) | null;
  const PORT = 8765;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-session-events-'));
    registryOnClose = null;
    sessionRegistry = new SessionRegistry(
      { orphanTimeoutMs: 1000 },
      { onSessionClosed: (sessionId) => registryOnClose?.(sessionId) },
    );
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
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

  function makeHandlers(opts: { exitFallbackMs?: number; screen?: PromptUpDeps } = {}) {
    const handlers = createSessionHandlers({
      sessionRegistry,
      bindingStore,
      transcriptDiscovery,
      harness: new ClaudeHarness(transcriptDiscovery),
      liveSessionsRegistry,
      currentPort: () => PORT,
      untrackConnection: (id) => {
        untrackCalls.push(id);
      },
      onConnectionRemoved: () => {
        connectionRemovedCount += 1;
      },
      send,
      ...opts.screen,
      ...(opts.exitFallbackMs !== undefined && { exitFallbackMs: opts.exitFallbackMs }),
    });
    registryOnClose = (sessionId) => handlers.resolveStopOnClose(sessionId);
    return handlers;
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

    test('decorates daemon sessions with claudeSessionId + transcriptPath (#429)', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      const claudeId = '11111111-2222-3333-4444-555555555555';
      sessionStore.save({
        remiSessionId: sessionId,
        claudeSessionId: claudeId,
        projectPath: '/test/dir',
        port: PORT,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });

      makeHandlers().onSessionListRequest(CID, REQ, false);

      const msg = sendCalls[0]?.message as unknown as {
        sessions: Array<{
          sessionId: string;
          claudeSessionId?: string;
          transcriptPath?: string;
        }>;
      };
      expect(msg.sessions).toHaveLength(1);
      expect(msg.sessions[0]?.claudeSessionId).toBe(claudeId);
      expect(msg.sessions[0]?.transcriptPath).toContain(`/${claudeId}.jsonl`);
    });

    test('falls back to undecorated entry when sessionStore lookup misses', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      // Deliberately do NOT call sessionStore.save.

      makeHandlers().onSessionListRequest(CID, REQ, false);

      const msg = sendCalls[0]?.message as unknown as {
        sessions: Array<{ claudeSessionId?: string; transcriptPath?: string }>;
      };
      expect(msg.sessions).toHaveLength(1);
      expect(msg.sessions[0]?.claudeSessionId).toBeUndefined();
      expect(msg.sessions[0]?.transcriptPath).toBeUndefined();
    });

    test('omits the current daemon port from daemonPorts', () => {
      // Register one session entry for a DIFFERENT port alongside ours.
      liveSessionsRegistry.register({
        sessionId: '0a001234-1234-1234-1234-123456789012',
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

    test('types /exit (graceful) and defers the success ack until the session closes', () => {
      const submitted: string[] = [];
      const pty = {
        id: generateId(),
        write: () => {},
        submitInput: async (text: string) => {
          submitted.push(text);
        },
        close: async () => {},
      } as unknown as PTYSession;
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', pty, fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, CID);

      const handlers = makeHandlers();
      handlers.onKillSessionRequest(CID, sessionId, REQ);

      // Graceful stop (#641): Claude is asked to /exit (which frees the daemon via
      // the PTY-exit path), not SIGKILLed; the session stays alive and NO ack is
      // sent until it actually closes — "success" must mean done, not initiated.
      expect(submitted).toEqual(['/exit']);
      expect(sessionRegistry.getSession(sessionId)).toBeDefined();
      expect(sendCalls).toHaveLength(0);

      // On close, the requester is acked success (no third-party notice: the
      // requester IS the active client).
      handlers.resolveStopOnClose(sessionId);
      expect(sendCalls).toHaveLength(1);
      const ack = sendCalls[0]?.message as { type: string; success: boolean };
      expect(ack.type).toBe('kill_session_response');
      expect(ack.success).toBe(true);
      expect(sendCalls[0]?.connectionId).toBe(CID);
    });

    test('on close, notifies a third-party active client with SESSION_ENDED then acks the requester', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, OTHER_CID);

      const handlers = makeHandlers();
      handlers.onKillSessionRequest(CID, sessionId, REQ);
      // Deferred: nothing is sent until the session actually closes (so the
      // SESSION_ENDED notice arrives after PTY output has stopped).
      expect(sendCalls).toHaveLength(0);

      handlers.resolveStopOnClose(sessionId);
      expect(sendCalls).toHaveLength(2);
      const notice = sendCalls[0]?.message as { type: string; code?: string };
      expect(notice.type).toBe('error');
      expect(notice.code).toBe('SESSION_ENDED');
      expect(sendCalls[0]?.connectionId).toBe(OTHER_CID);
      const ack = sendCalls[1]?.message as { type: string; success: boolean };
      expect(ack.type).toBe('kill_session_response');
      expect(ack.success).toBe(true);
      expect(sendCalls[1]?.connectionId).toBe(CID);
    });

    test('resolveStopOnClose is a no-op for a session with no pending stop', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());

      makeHandlers().resolveStopOnClose(sessionId);
      expect(sendCalls).toHaveLength(0);
    });

    test('a duplicate stop joins the in-flight one; both requesters are acked on close', () => {
      const submitted: string[] = [];
      const pty = {
        id: generateId(),
        write: () => {},
        submitInput: async (text: string) => {
          submitted.push(text);
        },
        close: async () => {},
      } as unknown as PTYSession;
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', pty, fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, CID);

      const handlers = makeHandlers();
      const REQ2 = 'req20000-0000-0000-0000-000000000000' as UUID;
      handlers.onKillSessionRequest(CID, sessionId, REQ);
      handlers.onKillSessionRequest(OTHER_CID, sessionId, REQ2);

      // Only ONE /exit is typed (the duplicate joins, it does not re-stop).
      expect(submitted).toEqual(['/exit']);
      expect(sendCalls).toHaveLength(0);

      // On close both requesters get a success ack against their own requestId.
      handlers.resolveStopOnClose(sessionId);
      const acks = sendCalls.map((c) => ({
        connectionId: c.connectionId,
        ...(c.message as unknown as { success: boolean; requestId: UUID }),
      }));
      expect(acks).toContainEqual(
        expect.objectContaining({ connectionId: CID, success: true, requestId: REQ }),
      );
      expect(acks).toContainEqual(
        expect.objectContaining({ connectionId: OTHER_CID, success: true, requestId: REQ2 }),
      );
    });

    test('forces close when /exit is not honored within the fallback window', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, CID);

      const handlers = makeHandlers({ exitFallbackMs: 5 });
      handlers.onKillSessionRequest(CID, sessionId, REQ);
      expect(sessionRegistry.getSession(sessionId)).toBeDefined();
      expect(sendCalls).toHaveLength(0);

      // PTY never exits (fake submitInput is a no-op); the fallback timer fires,
      // forces the close, and the registry's onSessionClosed (wired to
      // resolveStopOnClose in makeHandlers) acks the requester success.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(sessionRegistry.getSession(sessionId)).toBeUndefined();
      expect(sendCalls).toHaveLength(1);
      const ack = sendCalls[0]?.message as { type: string; success: boolean };
      expect(ack.type).toBe('kill_session_response');
      expect(ack.success).toBe(true);
      expect(sendCalls[0]?.connectionId).toBe(CID);
    });
  });

  /**
   * #1140: a Stop types "/exit" + Enter, and into a numbered selection menu
   * that Enter confirms the highlighted option (usually "1. Yes"). With a menu
   * on screen the Stop types nothing and force-closes. Real tracker (through
   * `promptUpDeps`, the wiring cli.ts uses, here with no gate: a hook-less
   * prompt) observing the real captured dialog through the real parser; the
   * terminal records what reaches it. The gate's half of the signal (#1155)
   * is tested end to end in hook-bridge-setup.test.ts.
   */
  describe('onKillSessionRequest with a prompt on screen (#1140)', () => {
    function stoppableSession() {
      const submitted: string[] = [];
      const pty = {
        id: generateId(),
        write: () => {},
        submitInput: async (text: string) => {
          submitted.push(text);
        },
        close: async () => {},
      } as unknown as PTYSession;
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', pty, fakeMessageAPI());
      sessionRegistry.attachConnection(sessionId, CID);
      const tracker = new QuestionPresenceTracker(() => undefined);
      const screen = promptUpDeps(
        () => undefined,
        (sid) => (sid === sessionId ? tracker : undefined),
      );
      return { submitted, sessionId, tracker, screen };
    }

    function observe(tracker: QuestionPresenceTracker, screenBytes: string): void {
      const parsed = parseQuestion(screenBytes);
      if (!parsed.question) throw new Error('the screen did not parse as a prompt');
      tracker.onPTYPromptVisible(parsed.question);
    }

    test('a numbered menu on screen: /exit is not typed, the session is force-closed and the requester acked', () => {
      const { submitted, sessionId, tracker, screen } = stoppableSession();
      observe(tracker, WRAPPED_DIRECTORY_DIALOG);
      expect(tracker.observedPromptOptions()?.map((o) => o.value)).toEqual(['1', '2', '3']);

      makeHandlers({ screen }).onKillSessionRequest(CID, sessionId, REQ);

      expect(submitted).toEqual([]);
      expect(sessionRegistry.getSession(sessionId)).toBeUndefined();
      expect(sendCalls).toHaveLength(1);
      const ack = sendCalls[0]?.message as { type: string; success: boolean; requestId: UUID };
      expect(ack.type).toBe('kill_session_response');
      expect(ack.success).toBe(true);
      expect(ack.requestId).toBe(REQ);
      expect(sendCalls[0]?.connectionId).toBe(CID);
    });

    test('a third-party client is told the session ended, before the requester is acked', () => {
      const { sessionId, tracker, screen } = stoppableSession();
      sessionRegistry.attachConnection(sessionId, OTHER_CID);
      observe(tracker, WRAPPED_DIRECTORY_DIALOG);

      makeHandlers({ screen }).onKillSessionRequest(CID, sessionId, REQ);

      const types = sendCalls.map((c) => ({
        to: c.connectionId,
        type: c.message.type,
        code: (c.message as { code?: string }).code,
      }));
      expect(types).toEqual([
        { to: OTHER_CID, type: 'error', code: 'SESSION_ENDED' },
        { to: CID, type: 'kill_session_response', code: undefined },
      ]);
    });

    test('a (y/n) prompt on screen takes the graceful /exit as before', () => {
      const { submitted, sessionId, tracker, screen } = stoppableSession();
      observe(tracker, 'Overwrite existing file? (y/n) ');
      expect(tracker.observedPromptOptions()?.map((o) => o.value)).toEqual(['y', 'n']);

      makeHandlers({ screen }).onKillSessionRequest(CID, sessionId, REQ);

      expect(submitted).toEqual(['/exit']);
      expect(sessionRegistry.getSession(sessionId)).toBeDefined();
      expect(sendCalls).toHaveLength(0);
    });

    test('nothing observed, and a menu cleared by a non-waiting status: /exit is typed', () => {
      const { submitted, sessionId, tracker, screen } = stoppableSession();
      observe(tracker, WRAPPED_DIRECTORY_DIALOG);
      tracker.onStatusChange('thinking');
      expect(tracker.observedPromptOptions()).toBeNull();

      makeHandlers({ screen }).onKillSessionRequest(CID, sessionId, REQ);

      expect(submitted).toEqual(['/exit']);
      expect(sessionRegistry.getSession(sessionId)).toBeDefined();
    });

    test('screen deps not wired: /exit is typed as before', () => {
      const { submitted, sessionId } = stoppableSession();

      makeHandlers().onKillSessionRequest(CID, sessionId, REQ);

      expect(submitted).toEqual(['/exit']);
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
