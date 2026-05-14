import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Question, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { setupHookBridge } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import type { HookServer } from '../../../src/hooks/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

/**
 * Recording HookServer that captures `.on()` registrations AND lets tests
 * fire the registered listeners directly. Lets us exercise the 7 hook
 * callback bodies without starting a real Bun.serve HTTP listener.
 */
class RecordingHookServer {
  readonly listeners = new Map<string, (input: unknown) => void>();
  on(event: string, listener: (input: unknown) => void): () => void {
    // Only the last listener per event survives; for setupHookBridge this is
    // fine because it installs exactly one per event name.
    this.listeners.set(event, listener);
    return () => this.listeners.delete(event);
  }
  fire(event: string, input: unknown): void {
    const fn = this.listeners.get(event);
    if (!fn) throw new Error(`No listener registered for ${event}`);
    fn(input);
  }
}

/** PTYSession fake that tracks submitInput calls (drives the auto-approve inject assertions).
 *  When throws=true, submitInput rejects to exercise the inject() cancellation path. */
function fakePTY(submits: string[], opts: { throws?: boolean } = {}): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async (content: string) => {
      submits.push(content);
      if (opts.throws) {
        throw new Error('test: submitInput synthetic failure');
      }
    },
    close: async () => {},
  } as unknown as PTYSession;
}

interface MessageApiCallLog {
  resetCalls: { n: number };
  statusCalls: string[];
  questionCalls: number;
}

function fakeMessageAPI(
  log: MessageApiCallLog,
  opts: { throwOnQuestionTimes?: number } = {},
): MessageAPI {
  let throwsLeft = opts.throwOnQuestionTimes ?? 0;
  return {
    handleMessage: () => {},
    handleStatusChange: (status: string) => {
      log.statusCalls.push(status);
    },
    handleQuestion: () => {
      log.questionCalls += 1;
      if (throwsLeft > 0) {
        throwsLeft -= 1;
        throw new Error('test: handleQuestion synthetic failure');
      }
    },
    reset: () => {
      log.resetCalls.n += 1;
    },
  } as unknown as MessageAPI;
}

/**
 * Tracker used by setupHookBridge tests. Bridge calls onQuestion →
 * recordPendingHook, which on real wiring stores and waits for PTY. In
 * these tests we have no PTY, so the passthrough collapses recordPendingHook
 * into onPTYPromptVisible — i.e. simulate a terminal whose prompt is always
 * visible. Lets the existing `questionCalls` assertions keep their meaning
 * ("the bridge emitted a question to the consumer"). True PTY-presence
 * semantics are validated in tests/api/question-presence-tracker.test.ts.
 */
class PassthroughTracker extends QuestionPresenceTracker {
  override recordPendingHook(question: Question): void {
    this.onPTYPromptVisible(question);
  }
}

function makePassthroughTracker(api: MessageAPI): PassthroughTracker {
  return new PassthroughTracker((q) => api.handleQuestion(q));
}

const SID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;

describe('setupHookBridge', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let liveSessionsRegistry: SessionRegistryFile;
  // Stored loosely so tests can inject a minimal fake watcher without
  // dragging in a real TranscriptWatcher instance.
  let transcriptWatchers: Map<UUID, { filePath: string; stop: () => void }>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let hookServer: RecordingHookServer;
  let ptySubmits: string[];
  let messageApiLog: MessageApiCallLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hook-bridge-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    liveSessionsRegistry = new SessionRegistryFile(tmpDir);
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    hookServer = new RecordingHookServer();
    ptySubmits = [];
    messageApiLog = { resetCalls: { n: 0 }, statusCalls: [], questionCalls: 0 };
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function build(
    opts: {
      autoApprove?: boolean;
      autoApproveDecision?: 'approve' | 'deny' | 'escalate' | 'cancelled';
      autoApproveDelayMs?: number;
      autoApproveThrows?: boolean;
      throwOnQuestionTimes?: number;
      submitInputThrows?: boolean;
      /** Test sink for cancel() invocations from the bridge. Each entry is
       *  the `reason` string the bridge passed. */
      cancelLog?: string[];
    } = {},
  ) {
    const localMessageApi = fakeMessageAPI(
      messageApiLog,
      opts.throwOnQuestionTimes !== undefined
        ? { throwOnQuestionTimes: opts.throwOnQuestionTimes }
        : {},
    );
    sessionRegistry.registerSession(
      SID,
      tmpDir,
      fakePTY(ptySubmits, opts.submitInputThrows ? { throws: true } : {}),
      localMessageApi,
    );

    // Minimal AutoApproveService stub. Only invoked when opts.autoApprove is
    // true; default decision is 'approve' (existing tests rely on this).
    // `autoApproveDelayMs` simulates LLM eval latency; `autoApproveThrows`
    // exercises the outer .catch() handler.
    const autoApproveService = opts.autoApprove
      ? ({
          evaluate: async () => {
            if (opts.autoApproveDelayMs && opts.autoApproveDelayMs > 0) {
              await new Promise((r) => setTimeout(r, opts.autoApproveDelayMs));
            }
            if (opts.autoApproveThrows) {
              throw new Error('test: ollama down');
            }
            const decision = opts.autoApproveDecision ?? 'approve';
            const durationMs = opts.autoApproveDelayMs ?? 0;
            if (decision === 'cancelled') {
              return { decision, reasoning: 'test-autoapprove', durationMs };
            }
            return {
              decision,
              reasoning: 'test-autoapprove',
              durationMs,
              model: 'test-model',
            };
          },
          cancel: (reason: string) => {
            opts.cancelLog?.push(reason);
            return false;
          },
        } as unknown as import('../../../src/auto-approve/index.ts').AutoApproveService)
      : null;

    setupHookBridge(
      {
        sessionRegistry,
        sessionStore,
        liveSessionsRegistry,
        transcriptWatchers: transcriptWatchers as unknown as Map<
          UUID,
          import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
        >,
        transcriptFallbackTimers,
        autoApproveService,
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: localMessageApi,
        sendAndRecord: () => {},
        // The bridge wires onQuestion → tracker.recordPendingHook (no
        // push). Tests assert the legacy "bridge emitted a question to
        // the consumer" semantics via questionCalls, so the test tracker
        // simulates a permanently-PTY-visible terminal by pushing on
        // every recordPendingHook. Real PTY-presence semantics are
        // validated in tests/api/question-presence-tracker.test.ts.
        tracker: makePassthroughTracker(localMessageApi),
      },
    );
  }

  test('registers listeners for all 7 hook events', () => {
    build();
    const events = new Set(hookServer.listeners.keys());
    expect(events).toEqual(
      new Set([
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'Notification',
        'PermissionRequest',
        'Stop',
        'SessionEnd',
      ]),
    );
  });

  test('does not throw when autoApproveService is null (common case)', () => {
    expect(() => build()).not.toThrow();
  });

  test('PermissionRequest with agent_id is dropped before reaching inject', async () => {
    build({ autoApprove: true });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-123',
      agent_id: 'subagent-abc',
      agent_type: 'task',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    // Let any queued microtasks run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Subagent PermissionRequests must NOT inject into the main PTY.
    expect(ptySubmits).toEqual([]);
  });

  test('PermissionRequest with auto-approve APPROVE injects "1" (status: executing)', async () => {
    build({ autoApprove: true });

    // Fire SessionStart first so claudeSessionId locks; subsequent events
    // pass filterBySession.
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-123',
      transcript_path: path.join(tmpDir, 'does-not-matter.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-123',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // Auto-approve .evaluate() is async; wait for the inject promise chain.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ptySubmits).toEqual(['1']);
    expect(sessionRegistry.getSession(SID)?.currentStatus).toBe('executing');
  });

  test('regression #321: sibling daemon dying re-enables hook lock acquisition AND filterBySession recovers', () => {
    // Pre-seed a sibling entry so the first hook event sees siblings present.
    const siblingFile = path.join(liveSessionsRegistry.dirPath, 'sibling-1.json');
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    fs.writeFileSync(
      siblingFile,
      JSON.stringify({
        sessionId: 'sibling-session-id',
        pid: process.pid, // alive (must be a live pid so listLive doesn't drop it)
        wsPort: 18999, // different from currentPort()=8765
        hookPort: 18000,
        projectPath: tmpDir, // SAME directory as our session under test
        name: 'sibling',
        startedAt: new Date().toISOString(),
      }),
    );

    build();

    // First hook event arrives while sibling exists -> must NOT lock onto
    // claude-A; events are deferred to the mtime fallback. PreToolUse during
    // this window must also be filtered out (the headline #321 symptom: no
    // [AutoApprove], no status updates).
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });
    expect(transcriptWatchers.has(SID)).toBe(false);

    hookServer.fire('PreToolUse', {
      session_id: 'claude-A',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    // filterBySession with no lock + sibling => drops everything; status
    // never advances. This was the user-visible failure in #321.
    expect(messageApiLog.statusCalls).toEqual([]);

    // Sibling daemon dies (file removed).
    fs.unlinkSync(siblingFile);

    // Next hook event must now lock onto claude-A and start the watcher.
    // Pre-#321-fix: the cached `hasSiblingInDir=true` from the first call
    // permanently blocked init even after the sibling was gone.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });
    expect(transcriptWatchers.has(SID)).toBe(true);

    // And filterBySession must now accept further events. PreToolUse maps to
    // 'executing' via HookEventBridge.handleStatusChange.
    hookServer.fire('PreToolUse', {
      session_id: 'claude-A',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messageApiLog.statusCalls).toContain('executing');
  });

  test('regression #321: sibling appearing after lock acquisition does not re-engage the guard', () => {
    // Once we hold a session lock, a sibling daemon spinning up later must
    // not flip filterBySession into the pre-lock branch and start dropping
    // events. claudeSessionId-based filtering takes precedence.
    build();

    // Acquire the lock cleanly with no siblings present.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });
    expect(transcriptWatchers.has(SID)).toBe(true);

    // A sibling appears now (e.g. user opens another remi in the same dir).
    fs.writeFileSync(
      path.join(liveSessionsRegistry.dirPath, 'late-sibling.json'),
      JSON.stringify({
        sessionId: 'late-sibling-id',
        pid: process.pid,
        wsPort: 18999,
        hookPort: 18000,
        projectPath: tmpDir,
        name: 'late-sibling',
        startedAt: new Date().toISOString(),
      }),
    );

    // Our own Claude's events must still flow through filterBySession because
    // session_id matches claudeSessionId; the sibling guard never reads.
    hookServer.fire('PreToolUse', {
      session_id: 'claude-A',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messageApiLog.statusCalls).toContain('executing');
  });

  test('SessionStart with source=clear pre-empts classifier and tears down watcher', () => {
    build();

    // First lock onto claude-A via a normal SessionStart.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    // Simulate a live transcript watcher so teardown has something to act on.
    const stopCalls: number[] = [];
    transcriptWatchers.set(SID, {
      filePath: path.join(tmpDir, 'a.jsonl'),
      stop: () => {
        stopCalls.push(1);
      },
    } as never);

    // Fire SessionStart with source=clear and a DIFFERENT session id.
    // This pre-empts the classifier into 'restart', tearing down the watcher
    // and resetting claudeSessionId so the new claude-B can lock.
    hookServer.fire('SessionStart', {
      session_id: 'claude-B',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      hook_event_name: 'SessionStart',
      source: 'clear',
    });

    // teardown side effects: old watcher stopped, messageApi reset. A new
    // watcher MAY be registered immediately after (for claude-B), so we
    // assert only the tear-down signals, not the final map state.
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(messageApiLog.resetCalls.n).toBeGreaterThanOrEqual(1);
  });

  // SessionStart restart pre-empt is source-agnostic: any rotation of
  // session_id while PTY is running fires it. These tests cover the new-
  // source, undefined-source, same-session_id (must NOT fire), missing
  // session_id (defensive), and subagent (agent_id set, must NOT fire) axes.

  test('SessionStart with unknown source AND new session_id pre-empts classifier (issue #416)', () => {
    build();

    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    const stopCalls: number[] = [];
    transcriptWatchers.set(SID, {
      filePath: path.join(tmpDir, 'a.jsonl'),
      stop: () => {
        stopCalls.push(1);
      },
    } as never);

    hookServer.fire('SessionStart', {
      session_id: 'claude-B',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      hook_event_name: 'SessionStart',
      source: 'switch_chat_future_value',
    });

    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(messageApiLog.resetCalls.n).toBeGreaterThanOrEqual(1);

    hookServer.fire('PreToolUse', {
      session_id: 'claude-B',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messageApiLog.statusCalls).toContain('executing');
  });

  test('SessionStart with undefined source AND new session_id pre-empts classifier (issue #416)', () => {
    // Some Claude Code versions omit `source` entirely on session transitions.
    build();

    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    const stopCalls: number[] = [];
    transcriptWatchers.set(SID, {
      filePath: path.join(tmpDir, 'a.jsonl'),
      stop: () => {
        stopCalls.push(1);
      },
    } as never);

    hookServer.fire('SessionStart', {
      session_id: 'claude-B',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      hook_event_name: 'SessionStart',
    });

    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(messageApiLog.resetCalls.n).toBeGreaterThanOrEqual(1);

    hookServer.fire('PreToolUse', {
      session_id: 'claude-B',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messageApiLog.statusCalls).toContain('executing');
  });

  test('SessionStart with same session_id does NOT pre-empt (issue #416)', () => {
    // Locks the `input.session_id !== claudeSessionId` guard against silent
    // refactor regression: a duplicate SessionStart for the same session
    // (e.g. SDK reconnect, source=startup repeat) must be a no-op.
    build();

    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    const stopCalls: number[] = [];
    transcriptWatchers.set(SID, {
      filePath: path.join(tmpDir, 'a.jsonl'),
      stop: () => {
        stopCalls.push(1);
      },
    } as never);
    const resetsBefore = messageApiLog.resetCalls.n;

    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
      source: 'startup',
    });

    expect(stopCalls.length).toBe(0);
    expect(messageApiLog.resetCalls.n).toBe(resetsBefore);
  });

  test('SessionStart with missing session_id does NOT pre-empt (issue #416)', () => {
    // Defensive: malformed/incomplete event must be inert, not tear down.
    build();

    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    const stopCalls: number[] = [];
    transcriptWatchers.set(SID, {
      filePath: path.join(tmpDir, 'a.jsonl'),
      stop: () => {
        stopCalls.push(1);
      },
    } as never);
    const resetsBefore = messageApiLog.resetCalls.n;

    hookServer.fire('SessionStart', {
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
    });

    expect(stopCalls.length).toBe(0);
    expect(messageApiLog.resetCalls.n).toBe(resetsBefore);
  });

  test('SessionStart with agent_id set does NOT pre-empt even on session_id mismatch (issue #416)', () => {
    // isSubagentEvent guard: a subagent firing SessionStart with its own
    // session_id (hypothetical future Claude Code shape) must not tear down
    // main's watcher. Closes the gap the pre-PR narrow `source` gate covered
    // by accident.
    build();

    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    const stopCalls: number[] = [];
    transcriptWatchers.set(SID, {
      filePath: path.join(tmpDir, 'a.jsonl'),
      stop: () => {
        stopCalls.push(1);
      },
    } as never);
    const resetsBefore = messageApiLog.resetCalls.n;

    hookServer.fire('SessionStart', {
      session_id: 'subagent-B',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      hook_event_name: 'SessionStart',
      agent_id: 'subagent-id-xyz',
    });

    expect(stopCalls.length).toBe(0);
    expect(messageApiLog.resetCalls.n).toBe(resetsBefore);
  });

  // -------------------------------------------------------------------------
  // Phase 3 (#418) replaced the pre-emptive `lastPermissionEmitAt` dedup
  // window (#377/#379/#381) and the `PendingAck` inject timer (#382) with
  // QuestionPresenceTracker — see
  // packages/daemon/src/api/question-presence-tracker.ts and its tests.
  // Those windows/timers no longer exist, so the associated regression
  // tests were removed in this cleanup. Tracker semantics are validated
  // structurally in question-presence-tracker.test.ts.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Issue #387: cancel stale auto-approve LLM eval on advance signals
  // -------------------------------------------------------------------------

  test('PreToolUse cancels stale auto-approve LLM eval', () => {
    const cancelLog: string[] = [];
    build({ autoApprove: true, cancelLog });
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-pre',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'cancel-test.jsonl'),
      source: 'startup',
      model: 'test',
    });
    hookServer.fire('PreToolUse', {
      session_id: 'claude-locked-pre',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(cancelLog).toContain('PreToolUse');
  });

  test('PostToolUse cancels stale auto-approve LLM eval', () => {
    const cancelLog: string[] = [];
    build({ autoApprove: true, cancelLog });
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-post',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'cancel-test.jsonl'),
      source: 'startup',
      model: 'test',
    });
    hookServer.fire('PostToolUse', {
      session_id: 'claude-locked-post',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'ok',
    });
    expect(cancelLog).toContain('PostToolUse');
  });

  test('Stop cancels stale auto-approve LLM eval', () => {
    const cancelLog: string[] = [];
    build({ autoApprove: true, cancelLog });
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-stop',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'cancel-test.jsonl'),
      source: 'startup',
      model: 'test',
    });
    hookServer.fire('Stop', {
      session_id: 'claude-locked-stop',
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    expect(cancelLog).toContain('Stop');
  });

  test('SessionEnd cancels stale auto-approve LLM eval', () => {
    const cancelLog: string[] = [];
    build({ autoApprove: true, cancelLog });
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-end',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'cancel-test.jsonl'),
      source: 'startup',
      model: 'test',
    });
    hookServer.fire('SessionEnd', {
      session_id: 'claude-locked-end',
      hook_event_name: 'SessionEnd',
      reason: 'user',
    });
    expect(cancelLog).toContain('SessionEnd');
  });

  test('Notification(idle_prompt) does NOT cancel auto-approve eval', () => {
    // idle_prompt can fire concurrently with a still-valid permission eval;
    // cancelling here would defeat auto-approve for slow LLMs.
    const cancelLog: string[] = [];
    build({ autoApprove: true, cancelLog });
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-idle',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'cancel-test.jsonl'),
      source: 'startup',
      model: 'test',
    });
    hookServer.fire('Notification', {
      session_id: 'claude-locked-idle',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: '',
    });
    expect(cancelLog).toHaveLength(0);
  });

  test('cancelled decision: bridge does not inject and does not escalate', async () => {
    // The bridge fixture's `evaluate` returns `decision: 'cancelled'`
    // immediately; the bridge's .then() must take the no-op branch.
    build({
      autoApprove: true,
      autoApproveDecision: 'cancelled',
    });
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-cancel',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'cancel-test.jsonl'),
      source: 'startup',
      model: 'test',
    });
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-cancel',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    // Drain microtasks so the .then() runs.
    await new Promise((r) => setTimeout(r, 50));

    expect(ptySubmits).toHaveLength(0); // no inject
    expect(messageApiLog.questionCalls).toBe(0); // no escalate
  });
});
