import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import type { CurrentOwnedSession } from '../../../src/cli/current-session.ts';
import { createTranscriptHandlers } from '../../../src/cli/handlers/transcript-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';
import { TranscriptWatcher } from '../../../src/transcript/transcript-watcher.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

/**
 * Wait until the async transcript-read pipeline has published its final
 * envelope. The handler kicks off `watcher.start()` (promise) and fans out
 * send() calls from within a .then() block, so tests need to let the
 * microtask queue drain. A small polling loop keeps the test resilient to
 * the exact number of microtask turns the pipeline needs.
 */
async function waitForMessages(
  sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>,
  predicate: (calls: typeof sendCalls) => boolean,
  maxMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate(sendCalls)) {
    if (Date.now() - start > maxMs) {
      throw new Error(
        `waitForMessages timed out after ${maxMs}ms. sendCalls=${JSON.stringify(
          sendCalls.map((c) => c.message.type),
        )}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createTranscriptHandlers', () => {
  let tmpDir: string;
  let projectsDir: string;
  let transcriptDiscovery: TranscriptDiscovery;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;

  function send(connectionId: UUID, message: ProtocolMessage): boolean {
    sendCalls.push({ connectionId, message });
    return true;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-transcript-events-'));
    projectsDir = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    transcriptDiscovery = new TranscriptDiscovery({ projectsDir });
    transcriptWatchers = new Map();
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    sendCalls = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeHandlers(
    currentOwnedSession: () => CurrentOwnedSession | null = () => null,
    subagentViews: SubagentViewRegistry = new SubagentViewRegistry(),
  ) {
    return createTranscriptHandlers({
      transcriptDiscovery,
      transcriptWatchers,
      bindingStore,
      currentOwnedSession,
      subagentViews,
      send,
    });
  }

  function writeTranscript(claudeSessionId: string, entries: object[]): string {
    const projectDir = path.join(projectsDir, '-Users-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n'));
    return filePath;
  }

  test('sends NOT_FOUND when the session id has no transcript and no active watcher', async () => {
    makeHandlers().onTranscriptLoadRequest(CID, 'bogus0-0000-0000-0000-000000000000', REQ);

    // Synchronous early-return path; no microtasks needed.
    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; code?: string };
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('NOT_FOUND');
  });

  test('NOT_FOUND redirects to the daemon current session (#499)', async () => {
    // A stale request must not dead-end: the error carries the current session
    // so the client can re-bind + re-fetch instead of getting stuck.
    const current: CurrentOwnedSession = {
      sessionId: 'cccccccc-0000-0000-0000-000000000000' as UUID,
      claudeSessionId: '22222222-2222-2222-2222-222222222222' as UUID,
      transcriptPath: '/p/22222222-2222-2222-2222-222222222222.jsonl',
    };
    makeHandlers(() => current).onTranscriptLoadRequest(
      CID,
      'd8f1613d-15a3-4f16-94e2-667b740d5fd0',
      REQ,
    );

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as {
      code?: string;
      details?: Record<string, unknown>;
    };
    expect(msg.code).toBe('NOT_FOUND');
    expect(msg.details).toEqual({
      currentSessionId: current.sessionId,
      currentClaudeSessionId: current.claudeSessionId,
      currentTranscriptPath: current.transcriptPath,
    });
  });

  test('NOT_FOUND details omitted when the daemon has no owned session', async () => {
    makeHandlers(() => null).onTranscriptLoadRequest(
      CID,
      'bogus0-0000-0000-0000-000000000000',
      REQ,
    );
    const msg = sendCalls[0]?.message as { code?: string; details?: unknown };
    expect(msg.code).toBe('NOT_FOUND');
    expect(msg.details).toBeUndefined();
  });

  test('resolves a subagent view by agentId and loads its transcript (#499 phase 3)', async () => {
    // The client loads a subagent by the agentId it got in session_views; the
    // daemon resolves the deterministic <main>/subagents/agent-<id>.jsonl path.
    const mainPath = path.join(projectsDir, '-Users-test-project', 'mainsess.jsonl');
    const agentId = 'a1b2c3d4e5f6';
    const reg = new SubagentViewRegistry();
    reg.recordStart(agentId, 'Explore', mainPath);
    const subPath = reg.resolvePath(agentId);
    expect(subPath).not.toBeNull();
    if (!subPath) return;
    fs.mkdirSync(path.dirname(subPath), { recursive: true });
    fs.writeFileSync(
      subPath,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: agentId,
        cwd: '/Users/test/project',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'subagent prompt' },
      }),
    );

    makeHandlers(() => null, reg).onTranscriptLoadRequest(CID, agentId, REQ);
    await waitForMessages(sendCalls, (calls) =>
      calls.some((c) => c.message.type === 'transcript_load_complete'),
    );
    expect(sendCalls.some((c) => (c.message as { code?: string }).code === 'NOT_FOUND')).toBe(
      false,
    );
  });

  test('subagent whose transcript is not written yet -> NOT_FOUND, not an empty load', async () => {
    // Tapped right after SubagentStart: registry has it, but the file does not
    // exist yet. Must send NOT_FOUND (so the client retries) rather than a
    // transcript_load_complete with 0 messages (which would cache an empty chat).
    const mainPath = path.join(projectsDir, '-Users-test-project', 'mainsess.jsonl');
    const agentId = 'b9c8d7e6f5a4';
    const reg = new SubagentViewRegistry();
    reg.recordStart(agentId, 'Explore', mainPath); // no file written

    makeHandlers(() => null, reg).onTranscriptLoadRequest(CID, agentId, REQ);

    // Synchronous early-return; no microtasks.
    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; code?: string };
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('NOT_FOUND');
    expect(sendCalls.some((c) => c.message.type === 'transcript_load_complete')).toBe(false);
  });

  test('reads a transcript by Claude session id and sends a completion envelope', async () => {
    const claudeSessionId = '11111111-1111-1111-1111-111111111111';
    writeTranscript(claudeSessionId, [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: claudeSessionId,
        cwd: '/Users/test/project',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        sessionId: claudeSessionId,
        cwd: '/Users/test/project',
        timestamp: new Date().toISOString(),
        message: {
          id: 'msg_1',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'hi there' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ]);

    makeHandlers().onTranscriptLoadRequest(CID, claudeSessionId, REQ);

    await waitForMessages(sendCalls, (calls) =>
      calls.some((c) => c.message.type === 'transcript_load_complete'),
    );

    const complete = sendCalls.find((c) => c.message.type === 'transcript_load_complete');
    expect(complete).toBeDefined();
    // Requesting connection matches the ack receiver.
    expect(complete?.connectionId).toBe(CID);
  });

  test('falls back to the store binding when a Remi UUID has no active watcher (#451)', async () => {
    // A wedged/rotated session: no live watcher, but the store knows the
    // current Claude session id. The handler must resolve via the binding
    // instead of returning NOT_FOUND.
    const claudeSessionId = '44444444-4444-4444-4444-444444444444';
    writeTranscript(claudeSessionId, [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: claudeSessionId,
        cwd: '/Users/test/project',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'history please' },
      },
    ]);

    const remiUuid = '55555555-5555-5555-5555-555555555555' as UUID;
    sessionStore.save({
      remiSessionId: remiUuid,
      claudeSessionId,
      projectPath: '/Users/test/project',
      port: 18767,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    // No watcher registered for remiUuid.
    makeHandlers().onTranscriptLoadRequest(CID, remiUuid, REQ);

    await waitForMessages(sendCalls, (calls) =>
      calls.some((c) => c.message.type === 'transcript_load_complete'),
    );

    expect(sendCalls.some((c) => (c.message as { code?: string }).code === 'NOT_FOUND')).toBe(
      false,
    );
  });

  test('falls back to the active watcher when the id is a Remi UUID', async () => {
    // Write a file whose filename is a Claude UUID, then register a live
    // watcher keyed by a DIFFERENT (Remi) UUID but pointing at the same file.
    const claudeSessionId = '22222222-2222-2222-2222-222222222222';
    const filePath = writeTranscript(claudeSessionId, [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: claudeSessionId,
        cwd: '/Users/test/project',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hi' },
      },
    ]);

    const remiUuid = '33333333-3333-3333-3333-333333333333' as UUID;
    const watcher = new TranscriptWatcher(
      { filePath, readExisting: false, pollIntervalMs: 0 },
      { onAssistantMessage: () => {}, onUserMessage: () => {} },
    );
    transcriptWatchers.set(remiUuid, watcher);

    try {
      makeHandlers().onTranscriptLoadRequest(CID, remiUuid, REQ);

      await waitForMessages(sendCalls, (calls) =>
        calls.some((c) => c.message.type === 'transcript_load_complete'),
      );

      // If fallback failed, we'd have received a NOT_FOUND instead.
      expect(sendCalls.some((c) => (c.message as { code?: string }).code === 'NOT_FOUND')).toBe(
        false,
      );
    } finally {
      watcher.stop();
    }
  });
});
