/**
 * Integration test for #427/#428: two daemons in the SAME cwd must never
 * cross-bind each other's Claude transcripts.
 *
 * Exercises the actual binding chain — resolveClaudeBinding, SessionStore,
 * and startTranscriptFallback wired together the same way createNewSession
 * wires them in cli.ts. Does not mock Bun.spawn: instead we simulate two
 * "claude" processes by writing the .jsonl files each binding expects.
 *
 * Pre-fix this scenario was the silent killer behind cross-daemon answer
 * routing: both daemons' fallbacks called findLatestTranscript and grabbed
 * whichever .jsonl had the freshest mtime, regardless of which Claude wrote
 * it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';

import type { MessageAPI } from '../../src/api/message-api.ts';
import { resolveClaudeBinding } from '../../src/cli/claude-binding.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  expectedTranscriptPath,
  startTranscriptFallback,
} from '../../src/cli/transcript-fallback.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import type { TranscriptWatcher } from '../../src/transcript/transcript-watcher.ts';

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
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
    reset: () => {},
  } as unknown as MessageAPI;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Model one daemon's state — its own sessionStore, its own watchers map,
 * its own transcript-fallback timer map. In production each daemon is a
 * separate process; here we keep them isolated within one test process by
 * giving each its own state bundle.
 */
interface DaemonFixture {
  readonly label: string;
  readonly remiSessionId: UUID;
  readonly sessionStore: SessionStore;
  readonly sessionRegistry: SessionRegistry;
  readonly transcriptWatchers: Map<UUID, TranscriptWatcher>;
  readonly transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  claudeSessionId?: string;
}

describe('two daemons in the same cwd never cross-bind (#427)', () => {
  let tmpDir: string;
  let projectsDir: string;
  let projectPath: string;
  let transcriptDiscovery: TranscriptDiscovery;
  let logs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cross-bind-'));
    projectsDir = path.join(tmpDir, 'claude-projects');
    projectPath = path.join(tmpDir, 'shared-project');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });
    transcriptDiscovery = new TranscriptDiscovery({ projectsDir });
    logs = [];
    configureLogger({ writeLog: (m) => logs.push(m) });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDaemon(label: string): DaemonFixture {
    const sessionStore = new SessionStore(path.join(tmpDir, `sessions-${label}.json`));
    const sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    const remiSessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(remiSessionId, projectPath, fakePTY(), fakeMessageAPI());
    return {
      label,
      remiSessionId,
      sessionStore,
      sessionRegistry,
      transcriptWatchers: new Map(),
      transcriptFallbackTimers: new Map(),
    };
  }

  /**
   * Simulate the create-session flow up to (but not including) Bun.spawn:
   * resolve a binding, persist to store, and start the fallback poll.
   * Mirrors the order in cli.ts:createNewSession.
   */
  function startDaemonBinding(d: DaemonFixture): void {
    const binding = resolveClaudeBinding([], { displayName: `remi:${d.label}` });
    d.claudeSessionId = binding.claudeSessionId;
    d.sessionStore.save({
      remiSessionId: d.remiSessionId,
      claudeSessionId: binding.claudeSessionId,
      projectPath,
      port: 0,
      pid: 0,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
    startTranscriptFallback(
      {
        sessionRegistry: d.sessionRegistry,
        sessionStore: d.sessionStore,
        transcriptDiscovery,
        transcriptWatchers: d.transcriptWatchers,
        transcriptFallbackTimers: d.transcriptFallbackTimers,
        pollIntervalMs: 20,
        pollTimeoutMs: 2000,
      },
      d.remiSessionId,
      projectPath,
      binding.claudeSessionId,
      fakeMessageAPI(),
      (_: ProtocolMessage) => {},
    );
  }

  /** Write a fake transcript .jsonl to disk as if Claude had just started. */
  function writeClaudeTranscript(claudeId: string): string {
    const encodedDir = path.join(projectsDir, projectPath.replace(/\//g, '-'));
    fs.mkdirSync(encodedDir, { recursive: true });
    const filePath = path.join(encodedDir, `${claudeId}.jsonl`);
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({
        type: 'user',
        uuid: generateId(),
        sessionId: claudeId,
        cwd: projectPath,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'boot' },
      })}\n`,
    );
    return filePath;
  }

  async function shutdownAll(daemons: DaemonFixture[]): Promise<void> {
    for (const d of daemons) {
      for (const t of d.transcriptFallbackTimers.values()) clearInterval(t);
      d.transcriptFallbackTimers.clear();
      for (const w of d.transcriptWatchers.values()) w.stop();
      d.transcriptWatchers.clear();
      await d.sessionRegistry.shutdown();
    }
  }

  test('two daemons race-binding produce distinct claudeSessionIds', () => {
    const a = makeDaemon('A');
    const b = makeDaemon('B');

    // Race: bindings resolved + saved synchronously back-to-back, like two
    // daemons booting at the same instant.
    startDaemonBinding(a);
    startDaemonBinding(b);

    expect(a.claudeSessionId).toBeDefined();
    expect(b.claudeSessionId).toBeDefined();
    expect(a.claudeSessionId).not.toBe(b.claudeSessionId);

    // Each store has its OWN entry; no leakage across daemon stores.
    const storedA = a.sessionStore.findByRemiSessionId(a.remiSessionId);
    const storedB = b.sessionStore.findByRemiSessionId(b.remiSessionId);
    expect(storedA?.claudeSessionId).toBe(a.claudeSessionId!);
    expect(storedB?.claudeSessionId).toBe(b.claudeSessionId!);

    return shutdownAll([a, b]);
  });

  test('each daemon binds its OWN transcript even when both files exist', async () => {
    const a = makeDaemon('A');
    const b = makeDaemon('B');

    startDaemonBinding(a);
    startDaemonBinding(b);

    // Both "claudes" write their transcripts concurrently. Daemon B's
    // file lands FIRST so pre-fix code (newest-mtime sort) would have
    // pointed daemon A at B's file.
    const bPath = writeClaudeTranscript(b.claudeSessionId!);
    await sleep(15);
    const aPath = writeClaudeTranscript(a.claudeSessionId!);

    // Wait for both fallbacks to bind.
    for (let i = 0; i < 50; i++) {
      if (a.transcriptWatchers.has(a.remiSessionId) && b.transcriptWatchers.has(b.remiSessionId)) {
        break;
      }
      await sleep(30);
    }

    const watcherA = a.transcriptWatchers.get(a.remiSessionId);
    const watcherB = b.transcriptWatchers.get(b.remiSessionId);

    expect(watcherA).toBeDefined();
    expect(watcherB).toBeDefined();
    expect(watcherA!.filePath).toBe(aPath);
    expect(watcherB!.filePath).toBe(bPath);
    expect(watcherA!.filePath).not.toBe(watcherB!.filePath);

    return shutdownAll([a, b]);
  });

  test('daemon ignores sibling-only transcripts even if its own never appears', async () => {
    // Mirror the cruel case: daemon A is alive but its claude crashed
    // before writing any transcript; daemon B's transcript is present.
    // Pre-fix, A would have adopted B's file. Now, A times out cleanly.
    const a = makeDaemon('A');
    const b = makeDaemon('B');

    startDaemonBinding(a);
    startDaemonBinding(b);

    writeClaudeTranscript(b.claudeSessionId!);
    // Deliberately DO NOT write A's transcript.

    // Wait past A's fallback timeout (configured 2000ms in startDaemonBinding).
    await sleep(2200);

    expect(a.transcriptWatchers.has(a.remiSessionId)).toBe(false);
    // A timed out cleanly with a typed error log, not by adopting B's file.
    expect(logs.some((m) => m.includes('[Fallback] Timed out waiting for transcript'))).toBe(true);

    // B should be bound correctly to its own file.
    await sleep(50);
    const watcherB = b.transcriptWatchers.get(b.remiSessionId);
    expect(watcherB?.filePath).toBe(
      expectedTranscriptPath(transcriptDiscovery, projectPath, b.claudeSessionId!),
    );

    return shutdownAll([a, b]);
  });

  test('expected paths derived from binding match what fallback waits for', () => {
    // Defense-in-depth: the path the fallback polls for must equal the
    // path the .jsonl filename derives from the bound UUID. If these
    // ever drift (e.g. someone changes the encoding rule on one side
    // only), this test fires immediately.
    const a = makeDaemon('A');
    startDaemonBinding(a);
    const derived = expectedTranscriptPath(transcriptDiscovery, projectPath, a.claudeSessionId!);
    const expectedDir = transcriptDiscovery.getProjectTranscriptDir(projectPath);
    expect(derived.startsWith(expectedDir)).toBe(true);
    expect(derived.endsWith(`${a.claudeSessionId!}.jsonl`)).toBe(true);
    return shutdownAll([a]);
  });
});
