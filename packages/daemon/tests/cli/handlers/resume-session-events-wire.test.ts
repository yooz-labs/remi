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
import type { HarnessId, HelloAckMessage, ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
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

describe('resume acks name the harnesses (#1179)', () => {
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
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function handlers(harnesses: () => readonly HarnessId[]) {
    return createResumeSessionHandlers({
      hubMode: false,
      harnesses,
      sessionRegistry,
      sessionStore,
      bindingStore: new SessionBindingStore(sessionStore),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      createNewSession: async (sessionId) => {
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
    // Never a binding, so never an identity: the field would be a guess.
    for (const key of ['harness', 'harnessSessionId', 'claudeSessionId']) {
      expect(key in (acks()[0] as object)).toBe(false);
    }
  });
});
