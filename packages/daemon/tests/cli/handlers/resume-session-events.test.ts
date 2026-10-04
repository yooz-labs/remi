import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import {
  HUB_RESUME_UNSUPPORTED_CODE,
  createResumeSessionHandlers,
  hubResumeUnsupportedMessage,
} from '../../../src/cli/handlers/resume-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { AmbiguousSessionIdentityError, SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

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
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

describe('createResumeSessionHandlers', () => {
  let tmpDir: string;
  let projectsDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let transcriptDiscovery: TranscriptDiscovery;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;

  function send(connectionId: UUID, message: ProtocolMessage): boolean {
    sendCalls.push({ connectionId, message });
    return true;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-resume-session-'));
    projectsDir = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    transcriptDiscovery = new TranscriptDiscovery({ projectsDir });
    sendCalls = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers(
    createNewSession: (
      sessionId: UUID,
      workingDirectory: string,
      sendMessage: (sid: UUID, msg: ProtocolMessage) => void,
      extraArgs: string[],
    ) => Promise<unknown> = async () => {
      throw new Error('createNewSession should not be called in this test');
    },
    hubMode = false,
  ) {
    return createResumeSessionHandlers({
      hubMode,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry,
      sessionStore,
      bindingStore,
      transcriptDiscovery,
      harness: new ClaudeHarness(transcriptDiscovery),
      createNewSession,
      send,
    });
  }

  test('attaches and replays when the target session is still live', async () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());

    const handlers = makeHandlers();
    await handlers.onResumeSessionRequest(CID, sessionId, REQ);

    // Expect at minimum: resume_session_response + hello_ack.
    const types = sendCalls.map((c) => c.message.type);
    expect(types).toContain('resume_session_response');
    expect(types).toContain('hello_ack');
    // Documented contract (#539): resume acks OMIT daemonVersion — only
    // connection-time and promotion acks carry it.
    const resumeAck = sendCalls.find((c) => c.message.type === 'hello_ack')?.message as {
      daemonVersion?: unknown;
    };
    expect('daemonVersion' in resumeAck).toBe(false);
    expect(sessionRegistry.getSession(sessionId)?.attachedConnections.has(CID)).toBe(true);
  });

  test('#753: re-sends pending questions as live messages on the still-alive attach path', async () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
    const pendingId = 'aaaaaaaa-1111-2222-3333-444444444444' as UUID;
    sessionRegistry.addQuestion(sessionId, {
      id: pendingId,
      text: 'Allow Bash: git push',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      held: true,
    });

    const handlers = makeHandlers();
    await handlers.onResumeSessionRequest(CID, sessionId, REQ);

    const questionMsgs = sendCalls.filter((c) => c.message.type === 'question');
    expect(questionMsgs).toHaveLength(1);
    const q = questionMsgs[0]?.message as { question: { id: UUID; held?: boolean } };
    expect(q.question.id).toBe(pendingId);
    expect(q.question.held).toBe(true); // held flag survives the re-send
  });

  test('rejects when another session is active and the target does not match', async () => {
    const activeId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(activeId, '/other/dir', fakePTY(), fakeMessageAPI());

    const handlers = makeHandlers();
    await handlers.onResumeSessionRequest(CID, '99999999-9999-9999-9999-999999999999', REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.type).toBe('resume_session_response');
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('already has an active session');
  });

  test('fails when no claude session id can be resolved from any source', async () => {
    const handlers = makeHandlers();
    await handlers.onResumeSessionRequest(CID, '77777777-7777-7777-7777-777777777777', REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.type).toBe('resume_session_response');
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('No Claude session ID available for resume');
  });

  test('reports durable lookup failures as an explicit resume response', async () => {
    const failingStore = {
      findByRemiSessionId: () => {
        throw new Error('sessions.json is unreadable');
      },
    } as unknown as SessionStore;
    const handlers = createResumeSessionHandlers({
      hubMode: false,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry,
      sessionStore: failingStore,
      bindingStore,
      transcriptDiscovery,
      harness: new ClaudeHarness(transcriptDiscovery),
      createNewSession: async () => undefined,
      send,
    });

    await handlers.onResumeSessionRequest(CID, 'unreadable-session', REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.type).toBe('resume_session_response');
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('Cannot resolve session unreadable-session');
    expect(msg.error).toContain('sessions.json is unreadable');
  });

  test('does not fall through transcript discovery after an ambiguous binding', async () => {
    const ambiguousBindingStore = {
      getByClaudeSessionId: () => {
        throw new AmbiguousSessionIdentityError('Claude', 'ambiguous-claude', 2);
      },
    } as unknown as SessionBindingStore;
    const noFallbackDiscovery = {
      findTranscriptBySessionId: () => {
        throw new Error('transcript fallback must not run');
      },
    } as unknown as TranscriptDiscovery;
    const handlers = createResumeSessionHandlers({
      hubMode: false,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry,
      sessionStore,
      bindingStore: ambiguousBindingStore,
      transcriptDiscovery: noFallbackDiscovery,
      harness: new ClaudeHarness(noFallbackDiscovery),
      createNewSession: async () => undefined,
      send,
    });

    await handlers.onResumeSessionRequest(CID, 'ambiguous-claude', REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.type).toBe('resume_session_response');
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('Ambiguous Claude session ID');
  });

  test('fails when the resolved project directory does not exist', async () => {
    // Store a mapping whose projectPath points somewhere that does not exist.
    sessionStore.save({
      remiSessionId: '88888888-8888-8888-8888-888888888888' as UUID,
      claudeSessionId: 'deadbeef-0000-0000-0000-000000000000',
      projectPath: path.join(tmpDir, 'does-not-exist'),
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    const handlers = makeHandlers();
    await handlers.onResumeSessionRequest(CID, '88888888-8888-8888-8888-888888888888', REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('Project directory not found');
  });

  test('calls createNewSession with --resume <claudeSessionId> when resolution succeeds', async () => {
    const realProjectDir = path.join(tmpDir, 'real-project');
    fs.mkdirSync(realProjectDir, { recursive: true });
    const claudeSessionId = '44444444-4444-4444-4444-444444444444';
    sessionStore.save({
      remiSessionId: 'abababab-abab-abab-abab-abababababab' as UUID,
      claudeSessionId,
      projectPath: realProjectDir,
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    const spawnHistory: Array<{ sessionId: UUID; extraArgs: string[] }> = [];
    const handlers = makeHandlers(
      async (sessionId, _workingDirectory, _sendMessage, extraArgs): Promise<unknown> => {
        spawnHistory.push({ sessionId, extraArgs: [...extraArgs] });
        // Simulate the side effect of a real createNewSession call:
        // the session must be registered in the SessionRegistry for
        // the handler's subsequent attachConnection to succeed.
        sessionRegistry.registerSession(sessionId, '/resumed/dir', fakePTY(), fakeMessageAPI());
        return undefined;
      },
    );

    await handlers.onResumeSessionRequest(CID, 'abababab-abab-abab-abab-abababababab', REQ);

    expect(spawnHistory).toHaveLength(1);
    expect(spawnHistory[0]?.extraArgs).toEqual(['--resume', claudeSessionId]);
    const types = sendCalls.map((c) => c.message.type);
    expect(types).toContain('resume_session_response');
    expect(types).toContain('hello_ack');
    const attachedId = spawnHistory[0]?.sessionId as UUID;
    expect(sessionRegistry.getSession(attachedId)?.attachedConnections.has(CID)).toBe(true);
  });

  test('closes the newly-spawned session and reports failure when createNewSession throws', async () => {
    const realProjectDir = path.join(tmpDir, 'real-project-2');
    fs.mkdirSync(realProjectDir, { recursive: true });
    sessionStore.save({
      remiSessionId: 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd' as UUID,
      claudeSessionId: '55555555-5555-5555-5555-555555555555',
      projectPath: realProjectDir,
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    const handlers = makeHandlers(async (sessionId) => {
      // Simulate partial registration before throwing (as a real createNewSession
      // might do if the PTY fails after MessageAPI is wired).
      sessionRegistry.registerSession(sessionId, realProjectDir, fakePTY(), fakeMessageAPI());
      throw new Error('PTY spawn failed');
    });

    await handlers.onResumeSessionRequest(CID, 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd', REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.type).toBe('resume_session_response');
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('PTY spawn failed');
    // Critical: the partially-created session must be cleaned up so a
    // retry can succeed.
    expect(sessionRegistry.activeSession).toBeNull();
  });

  // #1124: the hub (`remi serve`) is session-less and must never run Claude.
  // These drive the real handler with the same `hubMode` wiring cli.ts passes
  // (`hubMode: serveMode`). A stored, resumable session is seeded so that, with
  // no guard, the handler WOULD reach createNewSession. The end-to-end version
  // against a real hub process is tests/integration/hub-resume-guard.test.ts.
  describe('hub mode (#1124)', () => {
    function seedResumable(): { remiSessionId: UUID; claudeSessionId: string } {
      const projectDir = path.join(tmpDir, 'hub-resume-project');
      fs.mkdirSync(projectDir, { recursive: true });
      const remiSessionId = 'efefefef-efef-efef-efef-efefefefefef' as UUID;
      const claudeSessionId = '66666666-6666-4666-8666-666666666666';
      sessionStore.save({
        remiSessionId,
        claudeSessionId,
        projectPath: projectDir,
        port: 0,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: new Date().toISOString(),
        exitCode: 0,
      });
      return { remiSessionId, claudeSessionId };
    }

    test('refuses with a typed UNSUPPORTED resume response and never calls createNewSession', async () => {
      const { remiSessionId } = seedResumable();
      const spawned: string[][] = [];
      const handlers = makeHandlers(async (_sid, _dir, _send, extraArgs) => {
        spawned.push([...extraArgs]);
        return undefined;
      }, true);

      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(spawned).toEqual([]);
      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as {
        type: string;
        success: boolean;
        requestId: UUID;
        sessionId?: UUID;
        error?: string;
        errorCode?: string;
      };
      expect(sendCalls[0]?.connectionId).toBe(CID);
      expect(msg.type).toBe('resume_session_response');
      expect(msg.success).toBe(false);
      expect(msg.requestId).toBe(REQ);
      expect(msg.sessionId).toBeUndefined();
      expect(msg.errorCode).toBe(HUB_RESUME_UNSUPPORTED_CODE);
      expect(msg.errorCode).toBe('UNSUPPORTED');
      expect(msg.error).toBe(hubResumeUnsupportedMessage(remiSessionId));
      // Names the way that works today, and echoes the (UUID-shaped) id back
      // inside the command so it can be pasted as is.
      expect(msg.error).toContain(`remi --resume ${remiSessionId}`);
      // Nothing was registered: no session, and no connection attached.
      expect(sessionRegistry.activeSession).toBeNull();
    });

    test('refuses a Claude session id (not just a Remi id) the same way', async () => {
      const { claudeSessionId } = seedResumable();
      let called = false;
      const handlers = makeHandlers(async () => {
        called = true;
        return undefined;
      }, true);

      await handlers.onResumeSessionRequest(CID, claudeSessionId, REQ);

      expect(called).toBe(false);
      const msg = sendCalls[0]?.message as { success: boolean; errorCode?: string };
      expect(sendCalls).toHaveLength(1);
      expect(msg.success).toBe(false);
      expect(msg.errorCode).toBe('UNSUPPORTED');
    });

    test('refuses even for an unknown session id, before any store lookup runs', async () => {
      // Hub mode must not depend on resolving the session: a store that
      // throws on every read proves the guard comes first.
      const throwingStore = {
        findByRemiSessionId: () => {
          throw new Error('store must not be read in hub mode');
        },
      } as unknown as SessionStore;
      const handlers = createResumeSessionHandlers({
        hubMode: true,
        harnessId: 'claude',
        harnesses: () => ['claude'],
        sessionRegistry,
        sessionStore: throwingStore,
        bindingStore,
        transcriptDiscovery,
        harness: new ClaudeHarness(transcriptDiscovery),
        createNewSession: async () => {
          throw new Error('createNewSession must not be called in hub mode');
        },
        send,
      });

      await handlers.onResumeSessionRequest(CID, 'no-such-session', REQ);

      expect(sendCalls).toHaveLength(1);
      const msg = sendCalls[0]?.message as {
        success: boolean;
        errorCode?: string;
        error?: string;
      };
      expect(msg.success).toBe(false);
      expect(msg.errorCode).toBe('UNSUPPORTED');
      // Not UUID-shaped, so it is not echoed: the generic placeholder instead.
      expect(msg.error).toBe(hubResumeUnsupportedMessage('no-such-session'));
      expect(msg.error).toContain("'remi --resume <session>'");
      expect(msg.error).not.toContain('no-such-session');
    });

    test('never echoes arbitrary client input into the refusal message', async () => {
      const hostile = [
        "x'; echo pwned #",
        '$(touch /tmp/pwned)',
        '<script>alert(1)</script>',
        '11111111-2222-4333-8444-555555555555\n; reboot',
        '11111111-2222-4333-8444-5555555555555',
        'z1111111-2222-4333-8444-555555555555',
        '',
      ];
      const handlers = makeHandlers(async () => undefined, true);
      for (const input of hostile) {
        sendCalls = [];
        await handlers.onResumeSessionRequest(CID, input, REQ);
        const msg = sendCalls[0]?.message as { error?: string };
        expect(msg.error).toBe(hubResumeUnsupportedMessage('<session>'));
        if (input.length > 0) expect(msg.error).not.toContain(input);
      }
    });

    test('echoes a UUID-shaped id in either case and nothing else', () => {
      const lower = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
      const upper = lower.toUpperCase();
      expect(hubResumeUnsupportedMessage(lower)).toContain(`remi --resume ${lower}'`);
      expect(hubResumeUnsupportedMessage(upper)).toContain(`remi --resume ${upper}'`);
      expect(hubResumeUnsupportedMessage('not-a-uuid')).toContain("'remi --resume <session>'");
    });

    test('hubMode false behaves exactly like the session daemon: spawns with --resume', async () => {
      const { remiSessionId, claudeSessionId } = seedResumable();
      const spawned: string[][] = [];
      const handlers = makeHandlers(async (sessionId, _dir, _send, extraArgs) => {
        spawned.push([...extraArgs]);
        sessionRegistry.registerSession(sessionId, '/resumed/dir', fakePTY(), fakeMessageAPI());
        return undefined;
      }, false);

      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(spawned).toEqual([['--resume', claudeSessionId]]);
      const response = sendCalls.find((c) => c.message.type === 'resume_session_response')
        ?.message as { success: boolean; errorCode?: string };
      expect(response.success).toBe(true);
      expect('errorCode' in response).toBe(false);
    });

    test('a failure in a non-hub handler carries no errorCode (wire shape unchanged)', async () => {
      const handlers = makeHandlers();
      await handlers.onResumeSessionRequest(CID, 'unknown-session', REQ);
      const msg = sendCalls[0]?.message as { success: boolean; errorCode?: string };
      expect(msg.success).toBe(false);
      expect('errorCode' in msg).toBe(false);
    });
  });
});
