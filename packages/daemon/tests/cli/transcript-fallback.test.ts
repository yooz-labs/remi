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

  const KNOWN_CLAUDE_ID = '11111111-2222-3333-4444-555555555555';
  const OTHER_CLAUDE_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';

  test('registers a timer in transcriptFallbackTimers', () => {
    const sid = registerSession();

    startTranscriptFallback(
      {
        sessionRegistry,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 10000, // Long enough that the timer is still alive when we assert.
        pollTimeoutMs: 10000,
      },
      sid,
      projectPath,
      KNOWN_CLAUDE_ID,
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
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 500,
      },
      sid,
      projectPath,
      KNOWN_CLAUDE_ID,
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
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 500,
      },
      sid,
      projectPath,
      KNOWN_CLAUDE_ID,
      fakeMessageAPI(),
      sendAndRecord,
    );

    await sleep(60);

    expect(transcriptFallbackTimers.has(sid)).toBe(false);
  });

  test('attaches a watcher when the bound transcript appears on disk', async () => {
    const sid = registerSession();
    const entry = {
      type: 'user',
      uuid: 'u1',
      sessionId: KNOWN_CLAUDE_ID,
      cwd: projectPath,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hi' },
    };
    writeTranscript(KNOWN_CLAUDE_ID, [entry]);

    startTranscriptFallback(
      {
        sessionRegistry,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 30,
        pollTimeoutMs: 1000,
      },
      sid,
      projectPath,
      KNOWN_CLAUDE_ID,
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

  test('ignores a sibling daemons transcript with a different UUID', async () => {
    // Race scenario: a sibling daemon's claude wrote its transcript first.
    // The new fallback waits for OUR pre-bound id, not "newest in the dir".
    const sid = registerSession();
    const entry = {
      type: 'user',
      uuid: 'u1',
      sessionId: OTHER_CLAUDE_ID,
      cwd: projectPath,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hi' },
    };
    writeTranscript(OTHER_CLAUDE_ID, [entry]);

    startTranscriptFallback(
      {
        sessionRegistry,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 150,
      },
      sid,
      projectPath,
      KNOWN_CLAUDE_ID,
      fakeMessageAPI(),
      sendAndRecord,
    );

    await sleep(200);

    expect(transcriptWatchers.has(sid)).toBe(false);
    expect(transcriptFallbackTimers.has(sid)).toBe(false);
  });

  test('times out when the bound transcript never appears', async () => {
    // No transcript on disk.
    const sid = registerSession();

    startTranscriptFallback(
      {
        sessionRegistry,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 100,
      },
      sid,
      projectPath,
      KNOWN_CLAUDE_ID,
      fakeMessageAPI(),
      sendAndRecord,
    );

    // Need at least (timeout + one poll interval) to let the timeout branch fire.
    await sleep(200);

    expect(transcriptFallbackTimers.has(sid)).toBe(false);
    expect(transcriptWatchers.has(sid)).toBe(false);
    expect(logs.some((m) => m.includes('[Fallback] Timed out waiting for transcript'))).toBe(true);
  });
});
