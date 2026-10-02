/**
 * Golden for the Claude transcript path (#1163, epic #1161 phase 2).
 *
 * The path `<projectsDir>/<project path with every "/" replaced by "-">/<claudeSessionId>.jsonl`
 * is built at four sites today: `expectedTranscriptPath` (the transcript
 * fallback), `makeCurrentSessionResolver`, the session-list decoration in
 * `createSessionHandlers`, and the durable-index fallback in
 * `createTranscriptHandlers`. Each assertion here compares against a literal
 * built by hand, never against `getProjectTranscriptDir`, so a change to how
 * the path is derived (including a different encoding of `.`) shows up as a
 * mismatch instead of agreeing with itself. The project path carries a dot on
 * purpose: only `/` is replaced, `.` survives.
 *
 * These tests passed on the source before the harness descriptor existed and
 * must keep passing unchanged in their assertions after it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import { SubagentViewRegistry } from '../../src/api/subagent-view-registry.ts';
import { makeCurrentSessionResolver } from '../../src/cli/current-session.ts';
import { createSessionHandlers } from '../../src/cli/handlers/session-events.ts';
import { createTranscriptHandlers } from '../../src/cli/handlers/transcript-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { expectedTranscriptPath } from '../../src/cli/transcript-fallback.ts';
import { ClaudeHarness } from '../../src/harness/index.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import type { TranscriptWatcher } from '../../src/transcript/transcript-watcher.ts';

const PROJECT = '/Users/x/my.proj';
const ENCODED_PROJECT_DIR = '-Users-x-my.proj';
const CLAUDE_ID = '33333333-3333-4333-8333-333333333333';
const REMI_ID = 'aaaaaaaa-0000-4000-8000-000000000000' as UUID;
const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

describe('Claude transcript path golden (#1163)', () => {
  let tmpDir: string;
  let projectsDir: string;
  let expectedPath: string;
  let discovery: TranscriptDiscovery;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let transcriptIndex: TranscriptIndex;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-transcript-golden-'));
    projectsDir = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    // Built by hand from the documented encoding, independent of any helper.
    expectedPath = `${projectsDir}/${ENCODED_PROJECT_DIR}/${CLAUDE_ID}.jsonl`;
    discovery = new TranscriptDiscovery({ projectsDir });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    transcriptIndex = new TranscriptIndex(path.join(tmpDir, 'transcript-index.json'));
    bindingStore = new SessionBindingStore(sessionStore, transcriptIndex);
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function saveBinding(remiSessionId: UUID): void {
    sessionStore.save({
      remiSessionId,
      claudeSessionId: CLAUDE_ID,
      projectPath: PROJECT,
      port: 18765,
      pid: 1,
      startedAt: new Date(0).toISOString(),
      exitedAt: null,
      exitCode: null,
    });
  }

  test('expectedTranscriptPath replaces only "/" in the project path', () => {
    expect(expectedTranscriptPath(discovery, PROJECT, CLAUDE_ID)).toBe(expectedPath);
  });

  test('makeCurrentSessionResolver builds the same path from the stored binding', () => {
    saveBinding(REMI_ID);

    const current = makeCurrentSessionResolver({
      getPrimarySessionId: () => REMI_ID,
      sessionStore,
      harness: new ClaudeHarness(discovery),
    })();

    expect(current?.transcriptPath).toBe(expectedPath);
  });

  test('createSessionHandlers decorates a listed session with the same path', () => {
    const sessionId = sessionRegistry.createSessionId();
    const pty = {
      id: generateId(),
      write: () => {},
      submitInput: async () => {},
      close: async () => {},
    } as unknown as PTYSession;
    const messageApi = { getFullBulletContent: () => null } as unknown as MessageAPI;
    sessionRegistry.registerSession(sessionId, PROJECT, pty, messageApi);
    saveBinding(sessionId);

    const sent: ProtocolMessage[] = [];
    createSessionHandlers({
      sessionRegistry,
      bindingStore,
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      liveSessionsRegistry: new SessionRegistryFile(tmpDir),
      currentPort: () => 18765,
      untrackConnection: () => {},
      onConnectionRemoved: () => {},
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
    }).onSessionListRequest(CID, REQ, false);

    const response = sent[0] as unknown as {
      type: string;
      sessions: Array<{ claudeSessionId?: string; transcriptPath?: string }>;
    };
    expect(response.type).toBe('session_list_response');
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0]?.claudeSessionId).toBe(CLAUDE_ID);
    expect(response.sessions[0]?.transcriptPath).toBe(expectedPath);
  });

  test('createTranscriptHandlers loads a purged session from the same path (durable index)', async () => {
    // The file exists ONLY at the hand-built path, and the index is the only
    // record of the session, so the handler can find it only by rebuilding
    // exactly that path from the indexed project path and Claude id.
    fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
    fs.writeFileSync(
      expectedPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: CLAUDE_ID,
        cwd: PROJECT,
        timestamp: new Date(0).toISOString(),
        message: { role: 'user', content: 'golden history' },
      })}\n`,
    );
    transcriptIndex.record(REMI_ID, CLAUDE_ID, PROJECT);
    expect(bindingStore.get(REMI_ID)).toBeNull();

    const sent: ProtocolMessage[] = [];
    createTranscriptHandlers({
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      transcriptWatchers: new Map<UUID, TranscriptWatcher>(),
      bindingStore,
      transcriptIndex,
      currentOwnedSession: () => null,
      subagentViews: new SubagentViewRegistry(),
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
    }).onTranscriptLoadRequest(CID, REMI_ID, REQ);

    const deadline = Date.now() + 2000;
    while (!sent.some((m) => m.type === 'transcript_load_complete')) {
      if (Date.now() > deadline) {
        throw new Error(
          `no transcript_load_complete; got ${JSON.stringify(sent.map((m) => m.type))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sent.some((m) => (m as { code?: string }).code === 'NOT_FOUND')).toBe(false);
  });
});
