import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { startTranscriptFallback } from '../../src/cli/transcript-fallback.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import type { TranscriptWatcher } from '../../src/transcript/transcript-watcher.ts';

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
    handleMessage: () => {},
    handleStatusChange: () => {},
    handleQuestion: () => {},
  } as unknown as MessageAPI;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startTranscriptFallback', () => {
  let tmpDir: string;
  let projectsDir: string;
  let projectPath: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let transcriptDiscovery: TranscriptDiscovery;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let logs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tfallback-'));
    projectsDir = path.join(tmpDir, 'claude-projects');
    projectPath = path.join(tmpDir, 'my-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    transcriptDiscovery = new TranscriptDiscovery({ projectsDir });
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    logs = [];
    configureLogger({ writeLog: (m) => logs.push(m) });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    for (const timer of transcriptFallbackTimers.values()) {
      clearInterval(timer);
    }
    transcriptFallbackTimers.clear();
    for (const w of transcriptWatchers.values()) w.stop();
    transcriptWatchers.clear();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a transcript file inside the encoded project directory. */
  function writeTranscript(claudeId: string, entries: object[]): string {
    const encodedDir = path.join(projectsDir, projectPath.replace(/\//g, '-'));
    fs.mkdirSync(encodedDir, { recursive: true });
    const filePath = path.join(encodedDir, `${claudeId}.jsonl`);
    fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n'));
    return filePath;
  }

  function registerSession(): UUID {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, projectPath, fakePTY(), fakeMessageAPI());
    return sessionId;
  }

  const sendAndRecord = (_: ProtocolMessage) => {};

  test('registers a timer in transcriptFallbackTimers', () => {
    const sid = registerSession();

    startTranscriptFallback(
      {
        sessionRegistry,
        sessionStore,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 10000, // Long enough that the timer is still alive when we assert.
        pollTimeoutMs: 10000,
      },
      sid,
      projectPath,
      fakeMessageAPI(),
      sendAndRecord,
    );

    expect(transcriptFallbackTimers.has(sid)).toBe(true);
  });

  test('self-clears when a watcher already exists for the session', async () => {
    const sid = registerSession();
    // Pre-populate watchers so the first tick bails out.
    transcriptWatchers.set(sid, { stop: () => {} } as unknown as TranscriptWatcher);

    startTranscriptFallback(
      {
        sessionRegistry,
        sessionStore,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 500,
      },
      sid,
      projectPath,
      fakeMessageAPI(),
      sendAndRecord,
    );

    await sleep(60);

    expect(transcriptFallbackTimers.has(sid)).toBe(false);
  });

  test('self-clears when the session is no longer registered', async () => {
    const sid = registerSession();
    sessionRegistry.closeSession(sid, 'forced');

    startTranscriptFallback(
      {
        sessionRegistry,
        sessionStore,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 500,
      },
      sid,
      projectPath,
      fakeMessageAPI(),
      sendAndRecord,
    );

    await sleep(60);

    expect(transcriptFallbackTimers.has(sid)).toBe(false);
  });

  test('attaches a watcher when a fresh transcript appears on disk', async () => {
    const sid = registerSession();
    const claudeId = '11111111-2222-3333-4444-555555555555';
    const entry = {
      type: 'user',
      uuid: 'u1',
      sessionId: claudeId,
      cwd: projectPath,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hi' },
    };
    writeTranscript(claudeId, [entry]);

    startTranscriptFallback(
      {
        sessionRegistry,
        sessionStore,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 30,
        pollTimeoutMs: 1000,
      },
      sid,
      projectPath,
      fakeMessageAPI(),
      sendAndRecord,
    );

    // Wait for at least one poll tick + async watcher start.
    for (let i = 0; i < 20; i++) {
      if (transcriptWatchers.has(sid)) break;
      await sleep(30);
    }

    expect(transcriptWatchers.has(sid)).toBe(true);
    expect(transcriptFallbackTimers.has(sid)).toBe(false);
  });

  test('times out when no transcript ever appears', async () => {
    // No transcript on disk.
    const sid = registerSession();

    startTranscriptFallback(
      {
        sessionRegistry,
        sessionStore,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 100,
      },
      sid,
      projectPath,
      fakeMessageAPI(),
      sendAndRecord,
    );

    // Need at least (timeout + one poll interval) to let the timeout branch fire.
    await sleep(200);

    expect(transcriptFallbackTimers.has(sid)).toBe(false);
    expect(transcriptWatchers.has(sid)).toBe(false);
    expect(
      logs.some((m) =>
        m.includes('[error] [Hooks] Transcript fallback timed out without any transcript file'),
      ),
    ).toBe(true);
  });
});
