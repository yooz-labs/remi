import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import type { StartSessionOutcome } from '../../../src/cli/handlers/create-session-events.ts';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import {
  AmbiguousSessionIdentityError,
  SessionStore,
  type StoredSession,
} from '../../../src/session/session-store.ts';
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
  let logged: string[];

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
    logged = [];
    configureLogger({ writeLog: (line: string) => logged.push(line) });
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
  ) {
    return createResumeSessionHandlers({
      childSessions: null,
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
      childSessions: null,
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
    // The cause is the host's business (it can hold a path or a lock holder): the log has it.
    expect(msg.error).not.toContain('sessions.json');
    expect(logged.join('\n')).toContain('sessions.json is unreadable');
  });

  test('does not fall through transcript discovery after an ambiguous binding', async () => {
    const ambiguousBindingStore = {
      getResumableByClaudeSessionId: () => {
        throw new AmbiguousSessionIdentityError('Claude', 'ambiguous-claude', 2);
      },
    } as unknown as SessionBindingStore;
    const noFallbackDiscovery = {
      findTranscriptBySessionId: () => {
        throw new Error('transcript fallback must not run');
      },
    } as unknown as TranscriptDiscovery;
    const handlers = createResumeSessionHandlers({
      childSessions: null,
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

  // #1124, #1129: the hub (`remi serve`) is session-less and must never run Claude itself, so a
  // resume through it starts a child session daemon with `--resume`, through the same path a create
  // request uses. These drive the real handler with the same `childSessions` wiring cli.ts passes
  // in hub mode (a function that starts a child), and a stored, resumable session is seeded so
  // that, with no guard, the handler WOULD reach createNewSession. The end-to-end version against
  // a real hub process is tests/integration/hub-resume.test.ts.
  describe('hub mode (#1129)', () => {
    const CHILD = '77777777-7777-4777-8777-777777777777' as UUID;
    let projectDir: string;
    let asked: Array<{ directory: string | undefined; extra: unknown }>;
    let outcome: StartSessionOutcome | Error;
    /** Holds a start open, so two requests can be in flight at once. */
    let gate: Promise<void>;
    let clock: number;

    beforeEach(() => {
      asked = [];
      outcome = { ok: true, sessionId: CHILD, port: 19931 };
      gate = Promise.resolve();
      clock = 1_000_000;
    });

    function seedResumable(overrides: Partial<StoredSession> = {}): {
      remiSessionId: UUID;
      claudeSessionId: string;
    } {
      projectDir = path.join(tmpDir, 'hub-resume-project');
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
        ...overrides,
      });
      return { remiSessionId, claudeSessionId };
    }

    /** The hub's handler: no `createNewSession` (it throws if reached), a child starter that records. */
    function hubHandlers() {
      return createResumeSessionHandlers({
        childSessions: async (directory, extra) => {
          asked.push({ directory, extra });
          await gate;
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
        now: () => clock,
        harnessId: 'claude',
        harnesses: () => ['claude'],
        sessionRegistry,
        sessionStore,
        bindingStore,
        transcriptDiscovery,
        harness: new ClaudeHarness(transcriptDiscovery),
        createNewSession: async () => {
          throw new Error('createNewSession must not be called in hub mode');
        },
        send,
      });
    }

    function response() {
      expect(sendCalls).toHaveLength(1);
      return sendCalls[0]?.message as {
        type: string;
        success: boolean;
        requestId: UUID;
        sessionId?: UUID;
        port?: number;
        error?: string;
        errorCode?: string;
      };
    }

    test('starts a child session daemon with --resume in the stored directory and answers with its port', async () => {
      const { remiSessionId, claudeSessionId } = seedResumable();

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(asked).toEqual([
        { directory: projectDir, extra: { args: ['--resume', claudeSessionId] } },
      ]);
      const msg = response();
      expect(sendCalls[0]?.connectionId).toBe(CID);
      expect(msg.type).toBe('resume_session_response');
      expect(msg.success).toBe(true);
      expect(msg.requestId).toBe(REQ);
      expect(msg.sessionId).toBe(CHILD);
      expect(msg.port).toBe(19931);
      expect('error' in msg).toBe(false);
      expect('errorCode' in msg).toBe(false);
    });

    test('the hub itself holds no session and attaches nobody: the session lives in the child', async () => {
      const { remiSessionId } = seedResumable();

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      // One message, the response: no hello_ack for a session this process does not own.
      expect(sendCalls).toHaveLength(1);
      expect(sessionRegistry.activeSession).toBeNull();
      expect(sessionRegistry.getSession(CHILD)).toBeUndefined();
    });

    test('resolves a Claude session id (not just a Remi id) the same way', async () => {
      const { claudeSessionId } = seedResumable();

      await hubHandlers().onResumeSessionRequest(CID, claudeSessionId, REQ);

      expect(asked).toEqual([
        { directory: projectDir, extra: { args: ['--resume', claudeSessionId] } },
      ]);
      expect(response().success).toBe(true);
    });

    test('an unknown session is the ordinary not-found failure and starts nothing', async () => {
      await hubHandlers().onResumeSessionRequest(CID, 'no-such-session', REQ);

      expect(asked).toEqual([]);
      const msg = response();
      expect(msg.success).toBe(false);
      expect(msg.error).toBe(
        'Session no-such-session not found. No Claude session ID available for resume.',
      );
      expect('errorCode' in msg).toBe(false);
      expect('port' in msg).toBe(false);
    });

    test("another harness's record is never resumed with Claude's flag", async () => {
      const { remiSessionId } = seedResumable({
        claudeSessionId: null,
        harness: 'codex',
        harnessSessionId: '01950000-0000-7000-8000-0000000000aa',
      });

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(asked).toEqual([]);
      expect(response().success).toBe(false);
    });

    test('a project directory that is gone is a failure and starts nothing', async () => {
      const { remiSessionId } = seedResumable();
      fs.rmSync(projectDir, { recursive: true, force: true });

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(asked).toEqual([]);
      const msg = response();
      expect(msg.success).toBe(false);
      expect(msg.error).toContain('Project directory not found');
    });

    test("a refusal from the child start (an allowlist, a session a live one holds) is the response's error, with no port", async () => {
      const { remiSessionId } = seedResumable();
      outcome = {
        ok: false,
        error: 'That Claude session is already open in a live remi session on the host',
      };

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      const msg = response();
      expect(msg.success).toBe(false);
      expect(msg.error).toBe(
        'That Claude session is already open in a live remi session on the host',
      );
      expect(msg.sessionId).toBeUndefined();
      expect('port' in msg).toBe(false);
    });

    test('a child start that throws answers with the generic text, never the cause', async () => {
      const { remiSessionId } = seedResumable();
      outcome = new Error('spawn /home/someone/bin/remi ENOENT');

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      const msg = response();
      expect(msg.success).toBe(false);
      expect(msg.error).toBe(
        "The session could not be started on the host; the host's remi log has the reason.",
      );
      expect(logged.join('\n')).toContain('ENOENT');
    });

    test('a store that cannot be read is an explicit failure and starts nothing', async () => {
      const throwingStore = {
        findByRemiSessionId: () => {
          throw new Error('store unreadable');
        },
      } as unknown as SessionStore;
      const handlers = createResumeSessionHandlers({
        childSessions: async (directory, extra) => {
          asked.push({ directory, extra });
          return { ok: true, sessionId: CHILD, port: 19931 };
        },
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

      await handlers.onResumeSessionRequest(CID, 'whatever', REQ);

      expect(asked).toEqual([]);
      expect(response().success).toBe(false);
      // The requester reads a fixed text; the cause (a path, a lock holder) is in the log.
      expect(response().error).not.toContain('store unreadable');
      expect(logged.join('\n')).toContain('store unreadable');
    });

    test('the requested id reaches the log written out, never as raw control characters', async () => {
      await hubHandlers().onResumeSessionRequest(CID, 'x\u001b[2Jy\u202Ez', REQ);

      const line = logged.find((l) => l.includes('Resume session request')) ?? '';
      expect(line).not.toContain('\u001b');
      expect(line).not.toContain('\u202E');
      expect(line).toContain('\\u001B');
    });

    // The #1308 review.

    test.each([[undefined], [null], [['a']], [5]])(
      'a session id that is not text (%p) is a failure response, not a throw, and starts nothing',
      async (id) => {
        await hubHandlers().onResumeSessionRequest(CID, id as never, REQ);

        expect(asked).toEqual([]);
        expect(response().success).toBe(false);
        expect(response().error).toBe('The request does not name a session to resume.');
      },
    );

    test('a Claude session id with several exited rows resumes from the newest, in the directory it last ran in', async () => {
      const claudeSessionId = '66666666-6666-4666-8666-666666666666';
      const older = path.join(tmpDir, 'older-project');
      const newer = path.join(tmpDir, 'newer-project');
      fs.mkdirSync(older, { recursive: true });
      fs.mkdirSync(newer, { recursive: true });
      const row = (projectPath: string, startedAt: string): StoredSession => ({
        remiSessionId: crypto.randomUUID() as UUID,
        claudeSessionId,
        projectPath,
        port: 0,
        pid: null,
        startedAt,
        exitedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
        exitCode: 0,
      });
      sessionStore.save(row(older, '2026-10-01T00:00:00.000Z'));
      sessionStore.save(row(newer, '2026-10-02T00:00:00.000Z'));

      await hubHandlers().onResumeSessionRequest(CID, claudeSessionId, REQ);

      expect(asked).toEqual([{ directory: newer, extra: { args: ['--resume', claudeSessionId] } }]);
      expect(response().success).toBe(true);
    });

    test('an unreadable store is a fixed text to the requester, naming the id the requester sent', async () => {
      const throwingStore = {
        findByRemiSessionId: () => {
          throw new Error('Malformed session store /Users/someone/.remi/sessions.json: bad');
        },
      } as unknown as SessionStore;
      const handlers = createResumeSessionHandlers({
        childSessions: async () => ({ ok: true, sessionId: CHILD, port: 19931 }),
        harnessId: 'claude',
        harnesses: () => ['claude'],
        sessionRegistry,
        sessionStore: throwingStore,
        bindingStore,
        transcriptDiscovery,
        harness: new ClaudeHarness(transcriptDiscovery),
        createNewSession: async () => undefined,
        send,
      });

      await handlers.onResumeSessionRequest(CID, 'abc', REQ);

      expect(response().error).toBe(
        "Cannot resolve session abc: the host's session records could not be read.",
      );
      expect(logged.join('\n')).toContain('/Users/someone/.remi/sessions.json');
    });

    test('a long or hostile id is capped and written out in what the requester reads back', async () => {
      await hubHandlers().onResumeSessionRequest(CID, `x\u001b[2J${'y'.repeat(500)}`, REQ);

      const error = response().error ?? '';
      expect(error).not.toContain('\u001b');
      expect(error.length).toBeLessThan(200);
      expect(error).toContain('x\\u001B[2J');
    });

    test("a record of another harness is never resumed with Claude's flag, even if it carries a Claude id", async () => {
      const { remiSessionId } = seedResumable({
        harness: 'codex',
        harnessSessionId: '01950000-0000-7000-8000-0000000000aa',
      });

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(asked).toEqual([]);
      expect(response().success).toBe(false);
      expect(response().error).toContain('another harness');
    });

    test('a stored id that is not a UUID is not sent to Claude, and the requester is told why', async () => {
      const { remiSessionId } = seedResumable({ claudeSessionId: 'not-a-uuid' });

      await hubHandlers().onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(asked).toEqual([]);
      expect(response().success).toBe(false);
      expect(response().error).toBe(
        "That session's Claude id is not a valid session id, so it cannot be resumed.",
      );
    });

    test('a session found only as a transcript resumes in the directory the transcript recorded, dashes and all', async () => {
      const claudeSessionId = '99999999-9999-4999-8999-999999999999';
      const real = path.join(tmpDir, 'yooz-engine');
      fs.mkdirSync(real, { recursive: true });
      const projectDir = path.join(projectsDir, '-tmp-yooz-engine');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, `${claudeSessionId}.jsonl`),
        `${JSON.stringify({ type: 'user', sessionId: claudeSessionId, cwd: real, message: {} })}\n`,
      );

      await hubHandlers().onResumeSessionRequest(CID, claudeSessionId, REQ);

      expect(asked).toEqual([{ directory: real, extra: { args: ['--resume', claudeSessionId] } }]);
    });

    test('the same session asked for twice at once starts one child, and the second is told it was just resumed', async () => {
      const { remiSessionId } = seedResumable();
      let release: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handlers = hubHandlers();

      const first = handlers.onResumeSessionRequest(CID, remiSessionId, REQ);
      await handlers.onResumeSessionRequest(
        CID,
        remiSessionId,
        'req22222-0000-0000-0000-000000000000' as UUID,
      );
      release();
      await first;

      expect(asked).toHaveLength(1);
      expect(sendCalls).toHaveLength(2);
      const [refused, answered] = sendCalls.map((c) => c.message) as unknown as Array<{
        success: boolean;
        error?: string;
        port?: number;
      }>;
      expect(refused?.success).toBe(false);
      expect(refused?.error).toBe(
        'That session was just resumed on the host; open it from the session list.',
      );
      expect(answered?.success).toBe(true);
      expect(answered?.port).toBe(19931);
    });

    test('a start that failed frees the session at once; a success holds it for a short while only', async () => {
      const { remiSessionId } = seedResumable();
      const handlers = hubHandlers();

      outcome = { ok: false, error: 'No port.' };
      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);
      outcome = { ok: true, sessionId: CHILD, port: 19931 };
      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);
      expect(asked).toHaveLength(2);

      sendCalls = [];
      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);
      expect(asked).toHaveLength(2);
      expect(response().success).toBe(false);

      sendCalls = [];
      clock += 60_000;
      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);
      expect(asked).toHaveLength(3);
      expect(response().success).toBe(true);
    });

    test('a different session is not held up by one being resumed', async () => {
      const { remiSessionId } = seedResumable();
      const handlers = hubHandlers();
      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);

      const otherClaude = '12121212-1212-4212-8212-121212121212';
      const otherDir = path.join(tmpDir, 'other-project');
      fs.mkdirSync(otherDir, { recursive: true });
      sessionStore.save({
        remiSessionId: crypto.randomUUID() as UUID,
        claudeSessionId: otherClaude,
        projectPath: otherDir,
        port: 0,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: new Date().toISOString(),
        exitCode: 0,
      });
      sendCalls = [];
      await handlers.onResumeSessionRequest(CID, otherClaude, REQ);

      expect(asked).toHaveLength(2);
      expect(response().success).toBe(true);
    });
  });

  describe('a session daemon or wrapper (childSessions null)', () => {
    test('resumes in its own process: spawns with --resume and answers with no port', async () => {
      const projectDir = path.join(tmpDir, 'own-process-project');
      fs.mkdirSync(projectDir, { recursive: true });
      const remiSessionId = 'abababab-abab-abab-abab-abababababab' as UUID;
      const claudeSessionId = '88888888-8888-4888-8888-888888888888';
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
      const spawned: string[][] = [];
      const handlers = makeHandlers(async (sessionId, _dir, _send, extraArgs) => {
        spawned.push([...extraArgs]);
        sessionRegistry.registerSession(sessionId, '/resumed/dir', fakePTY(), fakeMessageAPI());
        return undefined;
      });

      await handlers.onResumeSessionRequest(CID, remiSessionId, REQ);

      expect(spawned).toEqual([['--resume', claudeSessionId]]);
      const response = sendCalls.find((c) => c.message.type === 'resume_session_response')
        ?.message as { success: boolean; errorCode?: string; port?: number };
      expect(response.success).toBe(true);
      expect('errorCode' in response).toBe(false);
      expect('port' in response).toBe(false);
    });

    test.each([[undefined], [null], [['a']]])(
      'a session id that is not text (%p) is a failure response, not a throw',
      async (id) => {
        await makeHandlers().onResumeSessionRequest(CID, id as never, REQ);

        expect(sendCalls).toHaveLength(1);
        const msg = sendCalls[0]?.message as { success: boolean; error?: string };
        expect(msg.success).toBe(false);
        expect(msg.error).toBe('The request does not name a session to resume.');
      },
    );

    test('a failure carries no errorCode (wire shape unchanged)', async () => {
      const handlers = makeHandlers();
      await handlers.onResumeSessionRequest(CID, 'unknown-session', REQ);
      const msg = sendCalls[0]?.message as { success: boolean; errorCode?: string };
      expect(msg.success).toBe(false);
      expect('errorCode' in msg).toBe(false);
    });
  });
});
