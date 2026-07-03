/**
 * Integration test for the TranscriptBinder wired through `setupHookBridge` —
 * epic #453 phase 3, commit 5.
 *
 * Until #470, this file replayed each stream through the OLD inline
 * session-binding path AND the binder, asserting they were observationally
 * identical (proving the binder was safe to drive). That parity was
 * established and the old path was deleted in #470 — the binder is now the
 * ONLY path — so this file replays the same streams ONCE through
 * `setupHookBridge` and asserts the (previously old-path-derived) expected
 * outcomes directly.
 *
 * Streams:
 *   (a) normal first-bind + a /clear rotation (A -> B),
 *   (b) A -> B -> A re-resume (idempotent emit guard),
 *   (c) sibling-defer: a live co-located sibling owns the dir and the incoming
 *       event's transcript carries the sibling's port marker -> defers (no
 *       bind, no watcher, no rotation).
 *
 * NO MOCKS: real SessionStore / SessionBindingStore / SessionRegistry /
 * SessionRegistryFile / TranscriptWatcher over a tmpdir; a fake PTY (the only
 * seam, matching the characterization suite in hook-bridge-setup.test.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { setupHookBridge } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import type { HookServer } from '../../../src/hooks/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/index.ts';
import type { TranscriptWatcher } from '../../../src/transcript/transcript-watcher.ts';

/** Recording HookServer: capture `.on()` registrations, fire them directly. */
class RecordingHookServer {
  readonly listeners = new Map<string, (input: unknown) => void>();
  permissionResolver: ((input: unknown) => Promise<string>) | null = null;
  on(event: string, listener: (input: unknown) => void): () => void {
    this.listeners.set(event, listener);
    return () => this.listeners.delete(event);
  }
  setPermissionResolver(resolver: ((input: unknown) => Promise<string>) | null): void {
    this.permissionResolver = resolver;
  }
  fire(event: string, input: unknown): void {
    // PermissionRequest is the synchronous resolver (#496), not a .on() listener;
    // fire it through the resolver (the binder bind runs synchronously inside).
    if (event === 'PermissionRequest' && !this.listeners.has(event) && this.permissionResolver) {
      void this.permissionResolver(input);
      return;
    }
    const fn = this.listeners.get(event);
    if (!fn) throw new Error(`No listener registered for ${event}`);
    fn(input);
  }
}

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

/** Minimal no-op MessageAPI — the bridge calls reset() on rotation. */
function noopMessageAPI(): MessageAPI {
  return {
    handleMessage: () => {},
    handleStatusChange: () => {},
    handleQuestion: () => {},
    reset: () => {},
  } as unknown as MessageAPI;
}

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;
const PORT = 8765;

/** One replay step: the hook event name + the raw input payload. */
interface Step {
  event: string;
  input: Record<string, unknown>;
}

/** Optional per-run injection of a live sibling into the live-sessions dir. */
interface SiblingSpec {
  /** Sibling's wsPort (must differ from PORT so it counts as a sibling). */
  wsPort: number;
  /** A live pid so claudeChildLooksAlive() treats it as a live sibling. */
  claudeChildPid: number;
}

interface RunOptions {
  sibling?: SiblingSpec;
  /**
   * Skip the pre-spawn binding write. The sibling-defer case needs the lock
   * UNBOUND (no stored binding to adopt) so the first-adopt sibling/ownership
   * gate — not the already-bound tripwire — is what defers.
   */
  skipPreAssign?: boolean;
}

/** Observable output of running a stream. */
interface RunResult {
  /** Every session_rotated message that crossed the wire, in order. */
  rotations: Array<{ newClaudeSessionId: string; oldClaudeSessionId?: string | undefined }>;
  /** The durable binding after the whole stream ran. */
  finalBoundId: string | null;
  /** The final watcher's filePath (path-resolved), or null. */
  finalWatcherPath: string | null;
  /** Any unexpected error lines (should always be empty). */
  errors: string[];
}

describe('TranscriptBinder drive mode (#453 phase 3, commit 5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-binder-drive-'));
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build one isolated bridge + its backing state, replay `steps`, and return
   * the observable outcome. Each run gets a FRESH SessionStore/Registry/watcher
   * map under its own subdir. The returned handle's closeBinder() is called in
   * cleanup so the binder's fallback poll + #452 rotation dir-poll never
   * outlive the run.
   */
  async function runStream(steps: Step[], options: RunOptions = {}): Promise<RunResult> {
    const { sibling, skipPreAssign } = options;
    const stateDir = fs.mkdtempSync(path.join(tmpDir, 'state-'));
    const errors: string[] = [];
    configureLogger({
      writeLog: (msg: string) => {
        // Surface only genuine failure lines; the binder logs routine
        // [Hooks]/[Binder] info lines that are not errors.
        if (msg.includes('failed') || msg.includes('Failed')) errors.push(msg);
      },
    });

    const sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    const sessionStore = new SessionStore(path.join(stateDir, 'sessions.json'));
    const bindingStore = new SessionBindingStore(sessionStore);
    const liveSessionsRegistry = new SessionRegistryFile(path.join(stateDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    const transcriptWatchers = new Map<UUID, TranscriptWatcher>();
    const transcriptFallbackTimers = new Map<UUID, ReturnType<typeof setInterval>>();
    const transcriptDiscovery = new TranscriptDiscovery();
    const hookServer = new RecordingHookServer();
    const messageApi = noopMessageAPI();
    const tracker = new QuestionPresenceTracker(() => {});

    sessionRegistry.registerSession(SID, tmpDir, fakePTY(), messageApi);

    // Mirror production cli.ts: the deterministic pre-spawn binding is written to
    // the store BEFORE the bridge sees any hook event (and BEFORE binder.start(),
    // which reads it for the fallback/dir-watch arm).
    const firstClaudeId = steps[0]?.input['session_id'] as string | undefined;
    if (firstClaudeId && !skipPreAssign) {
      bindingStore.preAssign({
        remiSessionId: SID,
        claudeSessionId: firstClaudeId,
        projectPath: tmpDir,
        port: PORT,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
    }

    // Optional: register a LIVE co-located sibling so hasSiblingInDir() returns
    // true (the sibling-defer case). Written as a raw registry file: projectPath
    // equals our workingDirectory, wsPort differs from PORT, and a live
    // claudeChildPid keeps it from being treated as a zombie.
    if (sibling) {
      fs.writeFileSync(
        path.join(liveSessionsRegistry.dirPath, 'sibling.json'),
        JSON.stringify({
          sessionId: 'sib-drive-test',
          pid: process.pid, // sibling DAEMON is alive
          wsPort: sibling.wsPort,
          hookPort: sibling.wsPort + 1,
          projectPath: tmpDir,
          name: 'sibling',
          startedAt: new Date().toISOString(),
          claudeChildPid: sibling.claudeChildPid,
        }),
      );
    }

    const rotations: RunResult['rotations'] = [];
    const sendAndRecord = (message: ProtocolMessage): void => {
      if (message.type === 'session_rotated') {
        rotations.push({
          newClaudeSessionId: message.newClaudeSessionId as string,
          oldClaudeSessionId: message.oldClaudeSessionId as string | undefined,
        });
      }
    };

    const handle = setupHookBridge(
      {
        sessionRegistry,
        bindingStore,
        liveSessionsRegistry,
        transcriptWatchers,
        transcriptFallbackTimers,
        autoApproveService: null,
        currentPort: () => PORT,
        transcriptDiscovery,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi,
        sendAndRecord,
        tracker,
      },
    );

    for (const step of steps) {
      const input: Record<string, unknown> = { ...step.input };
      if (typeof input['transcript_path'] === 'string') {
        const abs = path.join(tmpDir, input['transcript_path'] as string);
        // Create the (empty) transcript file so the real TranscriptWatcher's
        // waitForFile resolves immediately instead of leaving a 1s poll alive.
        if (!fs.existsSync(abs)) fs.writeFileSync(abs, '');
        input['transcript_path'] = abs;
      }
      hookServer.fire(step.event, input);
    }

    const finalWatcher = transcriptWatchers.get(SID);
    const result: RunResult = {
      rotations,
      finalBoundId: bindingStore.get(SID)?.claudeSessionId ?? null,
      finalWatcherPath: finalWatcher ? path.resolve(finalWatcher.filePath) : null,
      errors,
    };

    // Cleanup: close the binder so its fallback poll + #452 rotation dir-poll
    // intervals are cleared, then stop any watchers + remaining fallback timers
    // this run started.
    handle.closeBinder();
    for (const w of transcriptWatchers.values()) {
      try {
        w.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const t of transcriptFallbackTimers.values()) clearInterval(t);
    await sessionRegistry.shutdown();
    return result;
  }

  test('(a) normal first-bind + /clear rotation A -> B', async () => {
    const result = await runStream([
      { event: 'SessionStart', input: { session_id: 'claude-A', transcript_path: 'a.jsonl' } },
      {
        event: 'SessionStart',
        input: { session_id: 'claude-B', transcript_path: 'b.jsonl', source: 'clear' },
      },
    ]);

    expect(result.errors).toEqual([]);
    // Exactly one rotation A -> B reached the wire, the store is bound to B, and
    // the watcher started on b.jsonl.
    expect(result.rotations.length).toBe(1);
    expect(result.rotations[0]?.newClaudeSessionId).toBe('claude-B');
    expect(result.rotations[0]?.oldClaudeSessionId).toBe('claude-A');
    expect(result.finalBoundId).toBe('claude-B');
    expect(result.finalWatcherPath?.endsWith(`${path.sep}b.jsonl`)).toBe(true);
  });

  test('(b) A -> B -> A re-resume (idempotent emit)', async () => {
    const result = await runStream([
      { event: 'SessionStart', input: { session_id: 'claude-A', transcript_path: 'a.jsonl' } },
      {
        event: 'SessionStart',
        input: { session_id: 'claude-B', transcript_path: 'b.jsonl', source: 'clear' },
      },
      {
        event: 'SessionStart',
        input: { session_id: 'claude-A', transcript_path: 'a.jsonl', source: 'resume' },
      },
    ]);

    expect(result.errors).toEqual([]);
    // A->B then B->A, never a duplicate; final lock is A.
    expect(result.rotations.map((r) => r.newClaudeSessionId)).toEqual(['claude-B', 'claude-A']);
    expect(result.finalBoundId).toBe('claude-A');
  });

  test('(c) sibling-defer: live sibling owns the dir, incoming marker is not ours', async () => {
    // A live co-located sibling shares the directory. The pre-assigned binding is
    // never written by a hook here (we start at the UNBOUND state and the first
    // event's transcript carries no remi:<port> head marker proving ownership),
    // so admits() defers: no bind, no watcher, no rotation. The empty transcript
    // file the harness writes carries no marker, so ownsTranscript() is false.
    const result = await runStream(
      [
        // Use PreToolUse (not SessionStart) so the SessionStart pre-empt does not
        // fire; this exercises the first-adopt sibling/ownership gate directly.
        {
          event: 'PreToolUse',
          input: {
            session_id: 'claude-X',
            transcript_path: 'x.jsonl',
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
          },
        },
      ],
      {
        // Lock must stay UNBOUND so the first-adopt sibling/ownership gate (not
        // the already-bound tripwire) is what defers; the empty x.jsonl carries
        // no remi:<port> marker so ownsTranscript() is false.
        skipPreAssign: true,
        sibling: { wsPort: 9999, claudeChildPid: process.pid },
      },
    );

    expect(result.errors).toEqual([]);
    // Deferred: nothing bound, nothing emitted, no watcher.
    expect(result.rotations.length).toBe(0);
    expect(result.finalWatcherPath).toBe(null);
  });
});
