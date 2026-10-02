/**
 * `createSessionHandlers` reads its Claude values from the harness (#1163).
 *
 * `session-events.test.ts` already pins that a Claude Stop types `/exit` and
 * that a listed session carries its transcript path, but it cannot tell a
 * handler that asks the harness from one that still hardcodes Claude's value:
 * both produce the same bytes for Claude. These tests give the handler a
 * harness with a different exit input, with none, and with a different
 * transcript path, so only a handler that routes through the harness passes.
 *
 * Each harness here is a real `Harness` whose other members delegate to
 * `ClaudeHarness`; only the member under test differs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createSessionHandlers } from '../../../src/cli/handlers/session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness, type Harness } from '../../../src/harness/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

describe('createSessionHandlers, driven by the harness (#1163)', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let handlersRef: { resolveStopOnClose: (sessionId: UUID) => void } | null;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let claude: ClaudeHarness;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-stop-harness-'));
    handlersRef = null;
    sessionRegistry = new SessionRegistry(
      { orphanTimeoutMs: 1000 },
      { onSessionClosed: (sessionId) => handlersRef?.resolveStopOnClose(sessionId) },
    );
    sendCalls = [];
    claude = new ClaudeHarness(
      new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'claude-projects') }),
    );
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A real harness; only the exit input differs from Claude's. */
  function harnessWithExitInput(gracefulExitInput: string | null): Harness {
    return {
      gracefulExitInput,
      resumeArgs: (id) => claude.resumeArgs(id),
      transcriptPath: (projectPath, id) => claude.transcriptPath(projectPath, id),
    };
  }

  /** A real harness; only the transcript path differs from Claude's. */
  function harnessWithTranscriptPath(
    transcriptPath: (projectPath: string, id: string) => string,
  ): Harness {
    return {
      gracefulExitInput: claude.gracefulExitInput,
      resumeArgs: (id) => claude.resumeArgs(id),
      transcriptPath,
    };
  }

  function stopSessionWith(harness: Harness) {
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
    sessionRegistry.registerSession(sessionId, '/test/dir', pty, {
      getFullBulletContent: () => null,
    } as unknown as MessageAPI);
    sessionRegistry.attachConnection(sessionId, CID);

    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const handlers = createSessionHandlers({
      sessionRegistry,
      bindingStore: new SessionBindingStore(sessionStore),
      transcriptDiscovery: new TranscriptDiscovery({
        projectsDir: path.join(tmpDir, 'claude-projects'),
      }),
      harness,
      liveSessionsRegistry: new SessionRegistryFile(tmpDir),
      currentPort: () => 8765,
      untrackConnection: () => {},
      onConnectionRemoved: () => {},
      send: (connectionId, message) => {
        sendCalls.push({ connectionId, message });
        return true;
      },
    });
    handlersRef = handlers;
    handlers.onKillSessionRequest(CID, sessionId, REQ);
    return { submitted, sessionId };
  }

  test("a Stop types the harness's own exit input, not a hardcoded /exit", () => {
    const { submitted, sessionId } = stopSessionWith(harnessWithExitInput('/quit'));

    expect(submitted).toEqual(['/quit']);
    // Graceful: the session stays up and nothing is acked until it closes.
    expect(sessionRegistry.getSession(sessionId)).toBeDefined();
    expect(sendCalls).toHaveLength(0);
  });

  test('a harness with no exit input force-closes at once and types nothing', () => {
    const { submitted, sessionId } = stopSessionWith(harnessWithExitInput(null));

    expect(submitted).toEqual([]);
    expect(sessionRegistry.getSession(sessionId)).toBeUndefined();
    // The same ack a graceful Stop sends once the session closes.
    expect(sendCalls).toHaveLength(1);
    const ack = sendCalls[0]?.message as { type: string; success: boolean; requestId: UUID };
    expect(ack.type).toBe('kill_session_response');
    expect(ack.success).toBe(true);
    expect(ack.requestId).toBe(REQ);
    expect(sendCalls[0]?.connectionId).toBe(CID);
  });

  test("ClaudeHarness's exit input still types /exit through the same handler", () => {
    const { submitted } = stopSessionWith(claude);

    expect(submitted).toEqual(['/exit']);
  });

  test("a listed session's transcriptPath comes from the harness, not a hardcoded derivation", () => {
    const claudeId = '66666666-6666-4666-8666-666666666666';
    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(
      sessionId,
      '/test/dir',
      {
        id: generateId(),
        write: () => {},
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession,
      { getFullBulletContent: () => null } as unknown as MessageAPI,
    );
    sessionStore.save({
      remiSessionId: sessionId,
      claudeSessionId: claudeId,
      projectPath: '/test/dir',
      port: 8765,
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    createSessionHandlers({
      sessionRegistry,
      bindingStore: new SessionBindingStore(sessionStore),
      transcriptDiscovery: new TranscriptDiscovery({
        projectsDir: path.join(tmpDir, 'claude-projects'),
      }),
      harness: harnessWithTranscriptPath((projectPath, id) => `/stand-in/${projectPath}/${id}`),
      liveSessionsRegistry: new SessionRegistryFile(tmpDir),
      currentPort: () => 8765,
      untrackConnection: () => {},
      onConnectionRemoved: () => {},
      send: (connectionId, message) => {
        sendCalls.push({ connectionId, message });
        return true;
      },
    }).onSessionListRequest(CID, REQ, false);

    const response = sendCalls[0]?.message as unknown as {
      type: string;
      sessions: Array<{ claudeSessionId?: string; transcriptPath?: string }>;
    };
    expect(response.type).toBe('session_list_response');
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0]?.claudeSessionId).toBe(claudeId);
    expect(response.sessions[0]?.transcriptPath).toBe(`/stand-in//test/dir/${claudeId}`);
  });
});
