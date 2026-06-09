/**
 * Differential (shadow-mode) test for the TranscriptBinder — epic #453 phase 3,
 * commit 3.
 *
 * Drives `setupHookBridge` with `shadowBinder=true` through the same
 * RecordingHookServer harness the characterization suite uses, replaying the
 * four MANDATORY event streams from the design doc (§3.1 v4 #10):
 *
 *   (a) SessionEnd-then-restart  (SessionStart A, SessionEnd A, SessionStart B)
 *   (b) A -> B -> A re-resume
 *   (c) path-less restart        (SessionStart B without transcript_path)
 *   (d) foreign-subagent-after-rotation (agent_id event right after a rotation)
 *
 * Two assertions per stream:
 *   1. ZERO `[ShadowBinder] DISAGREE` lines: the shadow binder's load-bearing
 *      control-plane decision (bound id after, would-emit-rotation, watcher
 *      path) matches the old path's observed outcome on every event.
 *   2. ZERO shadow side effects: running the SAME stream with the shadow OFF
 *      (baseline) vs ON produces byte-identical observable output — same
 *      session_rotated messages on the wire, same final store binding, same
 *      final watcher path. The shadow cannot emit, write the store, or start a
 *      watcher, so the two runs must be indistinguishable.
 *
 * NO MOCKS: real SessionStore / SessionBindingStore / SessionRegistry /
 * TranscriptWatcher over a tmpdir; a fake PTY (the only seam, matching the
 * characterization suite).
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

/** One replay step: the hook event name + the raw input payload. */
interface Step {
  event: string;
  input: Record<string, unknown>;
}

/** Observable output of running a stream (for the side-effect-free diff). */
interface RunResult {
  /** Every session_rotated message that crossed the wire, in order. */
  rotations: Array<{ newClaudeSessionId: string; oldClaudeSessionId?: string | undefined }>;
  /** The durable binding after the whole stream ran. */
  finalBoundId: string | null;
  /** The final watcher's filePath (path-resolved), or null. */
  finalWatcherPath: string | null;
  /** Captured DISAGREE lines (only ever non-empty in the shadow-on run). */
  disagreements: string[];
}

describe('TranscriptBinder differential (shadow mode)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-binder-diff-'));
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build one isolated bridge + its backing state, replay `steps`, and return
   * the observable outcome. Each run gets a FRESH SessionStore/Registry/watcher
   * map under its own subdir so the shadow-on and shadow-off runs cannot share
   * state. The shadow binder writes nothing, so the two runs must match.
   */
  async function runStream(
    steps: Step[],
    shadowBinder: boolean,
    txBase: string,
  ): Promise<RunResult> {
    // Isolated per-run state dir (store + live-sessions) so the baseline and
    // shadow runs never share persisted state; transcript paths resolve against
    // the SHARED `txBase` so both runs produce identical absolute watcher paths.
    const stateDir = fs.mkdtempSync(path.join(tmpDir, 'state-'));
    const disagreements: string[] = [];
    configureLogger({
      writeLog: (msg: string) => {
        if (msg.includes('[ShadowBinder] DISAGREE')) disagreements.push(msg);
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

    sessionRegistry.registerSession(SID, txBase, fakePTY(), messageApi);

    // Mirror production cli.ts: the deterministic pre-spawn binding is written
    // to the store BEFORE the bridge sees any hook event. Without this record
    // SessionStore.updateClaudeSessionId is a no-op (it never creates a row),
    // so bindingStore.get() would always read null and the binding can never be
    // observed. Pre-assign the FIRST event's claude session id, exactly as
    // resolveClaudeBinding + bindingStore.preAssign do at spawn time.
    const firstClaudeId = steps[0]?.input['session_id'] as string | undefined;
    if (firstClaudeId) {
      bindingStore.preAssign({
        remiSessionId: SID,
        claudeSessionId: firstClaudeId,
        projectPath: txBase,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
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

    setupHookBridge(
      {
        sessionRegistry,
        bindingStore,
        liveSessionsRegistry,
        transcriptWatchers,
        transcriptFallbackTimers,
        autoApproveService: null,
        currentPort: () => 8765,
        shadowBinder,
        transcriptDiscovery,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: txBase,
        messageApi,
        sendAndRecord,
        tracker,
      },
    );

    // Resolve relative transcript paths against this run's dir so the two runs
    // produce identical absolute paths for the diff.
    for (const step of steps) {
      const input: Record<string, unknown> = { ...step.input };
      if (typeof input['transcript_path'] === 'string') {
        const abs = path.join(txBase, input['transcript_path'] as string);
        // Create the (empty) transcript file so the real TranscriptWatcher's
        // waitForFile resolves immediately instead of leaving a 1s poll alive
        // across runs (a harness flake under rapid back-to-back invocation). No
        // sibling in these streams, so the absent head marker never gates
        // ownsTranscript; both baseline and shadow runs share txBase so they see
        // identical files.
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
      disagreements,
    };

    // Cleanup: stop any real watchers this run started (fs.watch + 1s poll).
    for (const w of transcriptWatchers.values()) {
      try {
        w.stop();
      } catch {
        /* already stopped */
      }
    }
    await sessionRegistry.shutdown();
    return result;
  }

  /**
   * Replay a stream with the shadow OFF and ON, assert ZERO disagreements and
   * that the two runs are observationally identical (the shadow added no side
   * effect). Returns the shadow-on result for any stream-specific assertions.
   */
  async function assertNoDivergence(name: string, steps: Step[]): Promise<RunResult> {
    // Shared transcript base so both runs resolve identical absolute paths; each
    // run still gets its own isolated state dir inside runStream.
    const txBase = fs.mkdtempSync(path.join(tmpDir, 'tx-'));
    const baseline = await runStream(steps, /* shadowBinder */ false, txBase);
    const shadow = await runStream(steps, /* shadowBinder */ true, txBase);

    // 1) The shadow binder logged no control-plane disagreement.
    expect(shadow.disagreements, `${name}: shadow DISAGREE lines`).toEqual([]);
    // The baseline run never constructs a shadow, so it cannot disagree.
    expect(baseline.disagreements).toEqual([]);

    // 2) Side-effect-free: shadow-on output is identical to shadow-off output.
    expect(shadow.rotations, `${name}: rotations on wire`).toEqual(baseline.rotations);
    expect(shadow.finalBoundId, `${name}: final bound id`).toBe(baseline.finalBoundId);
    expect(shadow.finalWatcherPath, `${name}: final watcher path`).toBe(baseline.finalWatcherPath);

    return shadow;
  }

  test('(a) SessionEnd-then-restart: SessionStart A, SessionEnd A, SessionStart B', async () => {
    const result = await assertNoDivergence('end-then-restart', [
      { event: 'SessionStart', input: { session_id: 'claude-A', transcript_path: 'a.jsonl' } },
      { event: 'SessionEnd', input: { session_id: 'claude-A', reason: 'logout' } },
      { event: 'SessionStart', input: { session_id: 'claude-B', transcript_path: 'b.jsonl' } },
    ]);

    // Exactly one rotation (A -> B); final lock is B.
    expect(result.rotations.length).toBe(1);
    expect(result.rotations[0]?.newClaudeSessionId).toBe('claude-B');
    expect(result.rotations[0]?.oldClaudeSessionId).toBe('claude-A');
    expect(result.finalBoundId).toBe('claude-B');
    expect(result.finalWatcherPath?.endsWith(`${path.sep}b.jsonl`)).toBe(true);
  });

  test('(b) A -> B -> A re-resume', async () => {
    // /clear from A to B, then /resume back to A. The idempotent emit guard
    // must produce A->B, B->A and never a duplicate; the shadow must agree.
    const result = await assertNoDivergence('a-b-a', [
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

    expect(result.rotations.length).toBe(2);
    expect(result.rotations.map((r) => r.newClaudeSessionId)).toEqual(['claude-B', 'claude-A']);
    expect(result.finalBoundId).toBe('claude-A');
  });

  test('(c) path-less restart emits nothing for the path-less event', async () => {
    // SessionStart B with NO transcript_path. The old path nulls the lock but
    // does not emit (the :337 path guard); the shadow must match (zero emit,
    // lock null after the path-less event), then a follow-up event with a path
    // rebinds and emits the rotation.
    const result = await assertNoDivergence('path-less-restart', [
      { event: 'SessionStart', input: { session_id: 'claude-A', transcript_path: 'a.jsonl' } },
      { event: 'SessionEnd', input: { session_id: 'claude-A', reason: 'logout' } },
      // Path-less restart: nulls the lock, emits nothing.
      { event: 'SessionStart', input: { session_id: 'claude-B' } },
    ]);

    // No rotation crossed the wire (B carried no path on its SessionStart).
    expect(result.rotations.length).toBe(0);
  });

  test('(d) foreign subagent event (agent_id set) immediately after a rotation', async () => {
    // After A -> B rotates, a subagent event arrives with a DISTINCT session_id
    // (and agent_id) while the PTY is still running. It must classify FOREIGN
    // (different id, PTY running, mainSessionEnded reset to false by the rotate)
    // -> no new bind, no rotation, lock stays B. The distinct id is essential:
    // reusing B short-circuits the classifier to 'match' BEFORE mainSessionEnded
    // is read, so it would NOT exercise the v4 #5 reset (the reviewer proved
    // deleting the reset still passed the same-id form). With a distinct id this
    // stream genuinely depends on rotate() resetting mainSessionEnded.
    const result = await assertNoDivergence('foreign-after-rotation', [
      { event: 'SessionStart', input: { session_id: 'claude-A', transcript_path: 'a.jsonl' } },
      {
        event: 'SessionStart',
        input: { session_id: 'claude-B', transcript_path: 'b.jsonl', source: 'clear' },
      },
      // Foreign subagent event right after the rotation: agent_id set, DISTINCT
      // session_id so it reaches the mainPtyRunning && !mainSessionEnded branch.
      {
        event: 'PostToolUse',
        input: {
          session_id: 'claude-foreign-sub',
          agent_id: 'subagent-xyz',
          agent_type: 'task',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          transcript_path: 'b.jsonl',
        },
      },
    ]);

    // Exactly one rotation (A -> B); the foreign subagent event adds nothing.
    expect(result.rotations.length).toBe(1);
    expect(result.rotations[0]?.newClaudeSessionId).toBe('claude-B');
    expect(result.finalBoundId).toBe('claude-B');
  });
});
