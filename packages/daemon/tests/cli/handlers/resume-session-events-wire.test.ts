/**
 * The acks a resume sends carry the harnesses the daemon can start (#1179), as
 * every hello_ack does. A resume ack names no session binding (it never did),
 * so it names no harness identity either; it is the Claude path, since a
 * non-Claude daemon refuses resume before any ack.
 *
 * The handlers are the real ones over a real `SessionRegistry` and stores.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HarnessId,
  HelloAckMessage,
  ProtocolMessage,
  ResumeSessionResponseMessage,
  UUID,
} from '@remi/shared';
import { PROTOCOL_VERSION, generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { DAEMON_CAPABILITIES } from '../../../src/cli/capabilities.ts';
import {
  HUB_RESUME_UNSUPPORTED_CODE,
  createResumeSessionHandlers,
  harnessResumeUnsupportedMessage,
} from '../../../src/cli/handlers/resume-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const REMI_ID = 'abababab-abab-abab-abab-abababababab' as UUID;

const pty = (): PTYSession =>
  ({
    id: generateId(),
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  }) as unknown as PTYSession;
const messageApi = (): MessageAPI =>
  ({ getFullBulletContent: () => null }) as unknown as MessageAPI;

describe('resume acks name the harnesses, and a non-Claude daemon refuses resume (#1179)', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let discovery: TranscriptDiscovery;
  let sent: ProtocolMessage[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-resume-wire-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    discovery = new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'claude-projects') });
    sent = [];
    created.length = 0;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** `created` records every launch the handler asks `cli.ts`'s `createNewSession` for. */
  const created: UUID[] = [];
  function handlers(
    harnesses: () => readonly HarnessId[],
    harnessId: HarnessId = 'claude',
    capabilities?: readonly string[],
  ) {
    return createResumeSessionHandlers({
      childSessions: null,
      harnessId,
      harnesses,
      ...(capabilities !== undefined && { capabilities }),
      sessionRegistry,
      sessionStore,
      bindingStore: new SessionBindingStore(sessionStore),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      createNewSession: async (sessionId) => {
        created.push(sessionId);
        sessionRegistry.registerSession(sessionId, '/resumed/dir', pty(), messageApi());
      },
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
    });
  }
  const acks = () => sent.filter((m): m is HelloAckMessage => m.type === 'hello_ack');

  test('the ack for a session that is still live', async () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', pty(), messageApi());
    await handlers(() => ['claude', 'codex']).onResumeSessionRequest(CID, sessionId, REQ);
    expect(acks().map((a) => a.harnesses)).toEqual([['claude', 'codex']]);
    expect(acks().map((a) => [a.protocolVersion, a.capabilities])).toEqual([
      [PROTOCOL_VERSION, DAEMON_CAPABILITIES],
    ]);
  });

  test('the ack for a session resumed from the store', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    sessionStore.save({
      remiSessionId: REMI_ID,
      claudeSessionId: '44444444-4444-4444-8444-444444444444',
      projectPath: projectDir,
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
    await handlers(() => ['codex']).onResumeSessionRequest(CID, REMI_ID, REQ);
    expect(acks().map((a) => a.harnesses)).toEqual([['codex']]);
    expect(acks().map((a) => [a.protocolVersion, a.capabilities])).toEqual([
      [PROTOCOL_VERSION, DAEMON_CAPABILITIES],
    ]);
    // Never a binding, so never an identity: the field would be a guess.
    for (const key of ['harness', 'harnessSessionId', 'claudeSessionId']) {
      expect(key in (acks()[0] as object)).toBe(false);
    }
  });
  test('a capability list given to the handlers reaches the ack for a live session (#1237)', async () => {
    const live = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(live, '/test/dir', pty(), messageApi());
    await handlers(() => ['claude'], 'claude', ['x.one']).onResumeSessionRequest(CID, live, REQ);
    expect(acks().map((a) => a.capabilities)).toEqual([['x.one']]);
  });

  test('a capability list given to the handlers reaches the ack for a stored session (#1237)', async () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir);
    sessionStore.save({
      remiSessionId: REMI_ID,
      claudeSessionId: '44444444-4444-4444-8444-444444444444',
      projectPath: projectDir,
      port: 0,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
    await handlers(() => ['claude'], 'claude', ['x.one']).onResumeSessionRequest(CID, REMI_ID, REQ);
    expect(created).toHaveLength(1);
    expect(acks().map((a) => a.capabilities)).toEqual([['x.one']]);
  });

  describe('a daemon that hosts Codex', () => {
    const responses = () =>
      sent.filter((m): m is ResumeSessionResponseMessage => m.type === 'resume_session_response');

    function seedStoredSession(): void {
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir);
      sessionStore.save({
        remiSessionId: REMI_ID,
        claudeSessionId: '44444444-4444-4444-8444-444444444444',
        projectPath: projectDir,
        port: 0,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
    }

    test('refuses a resume of its own live session, attaching nothing and acking nothing', async () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', pty(), messageApi());
      await handlers(() => ['codex'], 'codex').onResumeSessionRequest(CID, sessionId, REQ);

      expect(responses()).toHaveLength(1);
      expect(responses()[0]?.success).toBe(false);
      expect(responses()[0]?.errorCode).toBe(HUB_RESUME_UNSUPPORTED_CODE);
      expect(responses()[0]?.requestId).toBe(REQ);
      expect(sent).toHaveLength(1);
      expect(sessionRegistry.getSession(sessionId)?.attachedConnections.has(CID)).toBe(false);
    });

    test('refuses a resume from the store without spawning Claude', async () => {
      seedStoredSession();
      await handlers(() => ['codex'], 'codex').onResumeSessionRequest(CID, REMI_ID, REQ);

      expect(responses()).toHaveLength(1);
      expect(responses()[0]?.success).toBe(false);
      expect(responses()[0]?.errorCode).toBe('UNSUPPORTED');
      expect(created).toEqual([]);
    });

    test('names the command that does work, and never echoes the request', async () => {
      const hostile = '<script>alert(1)</script>';
      await handlers(() => ['codex'], 'codex').onResumeSessionRequest(CID, hostile, REQ);
      const error = responses()[0]?.error ?? '';
      expect(error).toBe(harnessResumeUnsupportedMessage('codex'));
      expect(error).toContain('remi codex resume <thread id>');
      expect(error).not.toContain('script');
      expect(harnessResumeUnsupportedMessage('opencode')).toContain('opencode');
    });

    test('a Claude daemon still resumes the same stored session', async () => {
      seedStoredSession();
      await handlers(() => ['claude']).onResumeSessionRequest(CID, REMI_ID, REQ);
      expect(responses()[0]?.success).toBe(true);
      expect(created).toHaveLength(1);
    });
  });
});
