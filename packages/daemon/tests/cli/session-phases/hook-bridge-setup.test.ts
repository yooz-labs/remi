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
      autoApproveDecision?: 'approve' | 'deny' | 'escalate' | 'cancelled' | 'pick';
      /** Index for the 'pick' branch (1-based, matches the auto-approve
       *  service contract). Only relevant when autoApproveDecision='pick'. */
      autoApprovePickIndex?: number;
      autoApproveDelayMs?: number;
      autoApproveThrows?: boolean;
      throwOnQuestionTimes?: number;
      submitInputThrows?: boolean;
      /** Test sink for cancel() invocations from the bridge. Each entry is
       *  the `reason` string the bridge passed. */
      cancelLog?: string[];
      /** Use a real QuestionPresenceTracker (no PTY-visible passthrough)
       *  so tests can exercise the actual record-pending / status-clear
       *  contract through the bridge wiring. Defaults to the passthrough
       *  tracker used by the legacy assertion-style tests. */
      realTracker?: boolean;
    } = {},
  ): { tracker: QuestionPresenceTracker } {
    const localMessageApi = fakeMessageAPI(
      messageApiLog,
      opts.throwOnQuestionTimes !== undefined
        ? { throwOnQuestionTimes: opts.throwOnQuestionTimes }
        : {},
    );
    const tracker: QuestionPresenceTracker = opts.realTracker
      ? new QuestionPresenceTracker((q) => localMessageApi.handleQuestion(q))
      : makePassthroughTracker(localMessageApi);
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
            if (decision === 'pick') {
              return {
                decision,
                pickIndex: opts.autoApprovePickIndex ?? 2,
                reasoning: 'test-autoapprove',
                durationMs,
                model: 'test-model',
              };
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
        // PassthroughTracker is the default: it collapses
        // recordPendingHook into an immediate push so the legacy
        // "bridge emitted a question to the consumer" assertions via
        // questionCalls still work. opts.realTracker uses the real
        // QuestionPresenceTracker for wiring tests (record/status-clear
        // through the bridge). Pure PTY-presence semantics are validated
        // in tests/api/question-presence-tracker.test.ts.
        tracker,
      },
    );
    return { tracker };
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

  test('Phase 4 (#419): PermissionRequest with agent_id is forwarded through auto-approve', async () => {
    // Pre-phase-4, agent_id-tagged events were dropped at the listener
    // boundary. Phase 4 demoted agent_id from kill-switch to metadata:
    // the auto-approve LLM evaluates and injects just like a main-agent
    // event. The push to iOS is still gated by PTY presence downstream,
    // so a background subagent's auto-approved permission silently
    // executes; a hot-switched subagent's prompt would surface via the
    // tracker's PTY confirmation path.
    build({ autoApprove: true, autoApproveDecision: 'approve' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-123',
      transcript_path: path.join(tmpDir, 'sub.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-sub-123',
      agent_id: 'subagent-abc',
      agent_type: 'task',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // Wait for evaluate() + inject() to resolve.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ptySubmits).toEqual(['1']);
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

  test('Phase 3 wiring: PreToolUse drives tracker.onStatusChange and clears pending', () => {
    // A PermissionRequest stashes the question in the tracker via
    // onQuestion → recordPendingHook. A subsequent PreToolUse must drive
    // tracker.onStatusChange('executing') through the bridge's
    // onStatusChange wiring and clear the pending slot. Without this,
    // a refactor that disconnects tracker.onStatusChange from the
    // bridge would leave stale pending records that merge wrong option
    // labels onto unrelated future PTY prompts.
    const { tracker } = build({ realTracker: true });

    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-wire-1',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'wire.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-wire-1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(tracker.hasPendingForTest()).toBe(true);

    hookServer.fire('PreToolUse', {
      session_id: 'claude-locked-wire-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
    });

    expect(tracker.hasPendingForTest()).toBe(false);
  });

  test('Phase 3 wiring: SessionStart restart clears tracker.pending', () => {
    // Cross-phase regression: phase 1's restart classifier tears down
    // the transcript watcher. Without explicit tracker.clearPending(),
    // a PermissionRequest stashed before /clear or /compact would
    // merge stale option labels onto the new session's first PTY
    // prompt. Two reviewers flagged this on PR #423.
    const { tracker } = build({ realTracker: true });

    hookServer.fire('SessionStart', {
      session_id: 'claude-restart-A',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-restart-A',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(tracker.hasPendingForTest()).toBe(true);

    // Restart fires (e.g. user typed /clear). Classifier returns
    // 'restart' because session_id mismatch + source is treated as
    // restart-evidence by phase 1.
    hookServer.fire('SessionStart', {
      session_id: 'claude-restart-B',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      source: 'clear',
      model: 'test',
    });

    expect(tracker.hasPendingForTest()).toBe(false);
  });

  test('Phase 3 wiring: cancelled auto-approve clears tracker.pending via real bridge', async () => {
    // pr-test-analyzer Gap 1: the existing 'cancelled decision: bridge
    // does not inject and does not escalate' test uses PassthroughTracker
    // and so cannot witness the clearPending() call. A refactor that
    // dropped it would still pass that test. This one uses the real
    // tracker and asserts the pending slot is drained.
    const { tracker } = build({
      autoApprove: true,
      autoApproveDecision: 'cancelled',
      realTracker: true,
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-cancel',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'c.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-cancel',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // Wait for the auto-approve .then() to drain.
    await new Promise((r) => setTimeout(r, 50));

    expect(ptySubmits).toEqual([]); // cancelled: no inject
    expect(tracker.hasPendingForTest()).toBe(false);
  });

  test('Phase 3 wiring: late Notification after SessionEnd is dropped', () => {
    // silent-failure-hunter #3: SessionEnd already cleared status to
    // 'idle' (which drains tracker.pending). A late Notification
    // arriving from a dying Claude process must not re-populate the
    // pending slot, or a final PTY echo could fire a spurious push.
    const { tracker } = build({ realTracker: true });

    hookServer.fire('SessionStart', {
      session_id: 'claude-late-1',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'late.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('SessionEnd', {
      session_id: 'claude-late-1',
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    });

    // Late Notification fires after teardown.
    hookServer.fire('Notification', {
      session_id: 'claude-late-1',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'phantom prompt from dying Claude',
    });

    expect(tracker.hasPendingForTest()).toBe(false);
  });

  test('Phase 2 + Phase 3: auto-approve pick decision injects the correct index', async () => {
    // pr-test-analyzer Gap 4: the bridge's 'pick' branch was uncovered
    // at the wiring layer. Service-level tests verify pick returns
    // {pickIndex}; this asserts the bridge translates that into the
    // right PTY submit value.
    build({
      autoApprove: true,
      autoApproveDecision: 'pick',
      autoApprovePickIndex: 2,
    });

    hookServer.fire('SessionStart', {
      session_id: 'claude-pick',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'pick.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-pick',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // Wait for the auto-approve .then() + inject to drain.
    await new Promise((r) => setTimeout(r, 50));

    expect(ptySubmits).toEqual(['2']);
  });

  test('Phase 2 + Phase 3: mixed-shape suggestions survive the hook->tracker->push merge', async () => {
    // pr-test-analyzer Gap 3: phase 2 filters object entries out of
    // permission_suggestions; phase 3 merges the filtered options onto
    // the PTY question. Both layers are tested in isolation; this
    // covers the chain end-to-end through the real bridge wiring.
    const pushed: Question[] = [];
    const localApi = fakeMessageAPI(messageApiLog);
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits), localApi);
    const tracker = new QuestionPresenceTracker((q) => pushed.push(q));

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
        autoApproveService: null,
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: localApi,
        sendAndRecord: () => {},
        tracker,
      },
    );

    hookServer.fire('SessionStart', {
      session_id: 'claude-mixed',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'mixed.jsonl'),
      source: 'startup',
      model: 'test',
    });

    // No auto-approve: the listener falls through to escalateToUser,
    // which calls handlePermissionRequest -> onQuestion ->
    // tracker.recordPendingHook with the filtered options.
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-mixed',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
      permission_suggestions: [{ type: 'addDirectories', directories: ['/tmp'] }, 'Yes', 'No'],
    });

    expect(tracker.hasPendingForTest()).toBe(true);

    // PTY confirms the prompt is on screen with the bland numbered
    // fallback options. The hook's filtered string options must win
    // the merge.
    tracker.onPTYPromptVisible({
      id: generateId(),
      text: 'Allow Edit: /tmp/x.ts?',
      options: [
        { label: '1', value: '1', isRecommended: false, isYes: false, isNo: false },
        { label: '2', value: '2', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: false,
      isAnswered: false,
    });

    expect(pushed.length).toBe(1);
    expect(pushed[0]?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  // -------------------------------------------------------------------------
  // Phase 4 (#419): agent_id demoted from kill-switch to metadata.
  // Subagent PermissionRequest + Notification events flow through to the
  // tracker; push is gated by PTY presence, not by the agent_id tag.
  // -------------------------------------------------------------------------

  test('Phase 4 wiring: subagent PermissionRequest + PTY-visible prompt fires a push', async () => {
    // The user hot-switches to a subagent's view; the subagent's prompt
    // is on the user's PTY screen. The hook fires with agent_id set.
    // Under the new contract, this is an answerable prompt: tracker
    // records the hook, PTY confirms, push fires with merged metadata.
    const pushed: Question[] = [];
    const localApi = fakeMessageAPI(messageApiLog);
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits), localApi);
    const tracker = new QuestionPresenceTracker((q) => pushed.push(q));

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
        autoApproveService: null, // no auto-approve -> escalate path
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: localApi,
        sendAndRecord: () => {},
        tracker,
      },
    );

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-A',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subA.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-sub-A',
      agent_id: 'subagent-A',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/foo.ts' },
      permission_suggestions: ['Yes', 'Always', 'No'],
    });

    // Hook recorded the question in the tracker (no push yet).
    expect(tracker.hasPendingForTest()).toBe(true);
    expect(pushed.length).toBe(0);

    // PTY parser confirms the prompt is on the user's terminal.
    tracker.onPTYPromptVisible({
      id: generateId(),
      text: 'Allow Edit: /tmp/foo.ts?',
      options: [
        { label: '1', value: '1', isRecommended: false, isYes: false, isNo: false },
        { label: '2', value: '2', isRecommended: false, isYes: false, isNo: false },
        { label: '3', value: '3', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: false,
      isAnswered: false,
    });

    expect(pushed.length).toBe(1);
    expect(pushed[0]?.options.map((o) => o.label)).toEqual(['Yes', 'Always', 'No']);
  });

  test('Phase 4 wiring: subagent PermissionRequest with no PTY confirmation drops cleanly', async () => {
    // Background subagent path: hook fires (agent_id set), no PTY emit
    // because the user is not hot-switched into this subagent's view.
    // The tracker holds the pending; a subsequent status transition
    // (PostToolUse -> 'thinking') clears it. No push reaches iOS.
    const pushed: Question[] = [];
    const localApi = fakeMessageAPI(messageApiLog);
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits), localApi);
    const tracker = new QuestionPresenceTracker((q) => pushed.push(q));

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
        autoApproveService: null,
        currentPort: () => 8765,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: localApi,
        sendAndRecord: () => {},
        tracker,
      },
    );

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-B',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subB.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-sub-B',
      agent_id: 'subagent-B',
      agent_type: 'task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(tracker.hasPendingForTest()).toBe(true);
    expect(pushed.length).toBe(0);

    // Subagent finished without the user seeing the prompt (background).
    hookServer.fire('PostToolUse', {
      session_id: 'claude-sub-B',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { exit_code: 0 },
    });

    expect(tracker.hasPendingForTest()).toBe(false);
    expect(pushed.length).toBe(0);
  });

  test('Phase 4 wiring: subagent Notification(permission_prompt) records in tracker', async () => {
    // Notification(permission_prompt) used to be dropped at the listener
    // when agent_id was present. Under phase 4 it flows to the tracker
    // just like its PermissionRequest sibling.
    const { tracker } = build({ realTracker: true });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-N',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subN.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('Notification', {
      session_id: 'claude-sub-N',
      agent_id: 'subagent-N',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    expect(tracker.hasPendingForTest()).toBe(true);
  });

  test('Phase 4 wiring: subagent PermissionRequest with auto-approve still injects normally', async () => {
    // Pre-phase-4 this path returned early (dropped). Now it goes through
    // auto-approve like a main-agent prompt. The push is suppressed
    // structurally: inject succeeds, status flips to executing, tracker
    // had no pending (handlePermissionRequest is only called via
    // escalateToUser, which auto-approve never enters on the approve
    // branch), so nothing pushes.
    build({ autoApprove: true, autoApproveDecision: 'approve' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-AA',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subAA.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-sub-AA',
      agent_id: 'subagent-AA',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ptySubmits).toEqual(['1']);
  });

  test('Phase 4 wiring: subagent PermissionRequest + auto-approve deny injects "3"', async () => {
    // Mirrors the approve case but on the deny branch. A refactor that
    // accidentally routed deny to escalateToUser would break the
    // non-hang guarantee for background subagents.
    build({ autoApprove: true, autoApproveDecision: 'deny' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-deny',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subdeny.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-sub-deny',
      agent_id: 'subagent-deny',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ptySubmits).toEqual(['3']);
  });

  test('Phase 4 wiring: escalate + active Task context default-denies (no hang)', async () => {
    // PR #424 review pr-test-analyzer Gap 2 (criticality 8): when
    // auto-approve cannot decide ('escalate') AND a Task tool call is
    // open on the main session, the bridge must inject '3' rather than
    // surface a question (the user can't answer a subagent's prompt
    // visible only to the subagent). With the TOCTOU fix from this
    // commit, the subagent context is read live in the .then(), so a
    // Task that opens mid-eval is correctly caught.
    build({ autoApprove: true, autoApproveDecision: 'escalate' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-esc-task',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'esctask.jsonl'),
      source: 'startup',
      model: 'test',
    });

    // Open a synchronous Task context.
    hookServer.fire('PreToolUse', {
      session_id: 'claude-esc-task',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { subagent_type: 'general-purpose', prompt: 'do stuff' },
      tool_use_id: 'tu_task_esc',
    });

    // Subagent-internal Bash PermissionRequest (no agent_id; the
    // Task-context safety net catches it).
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-esc-task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ptySubmits).toEqual(['3']);
    expect(messageApiLog.questionCalls).toBe(0);
  });

  test('Phase 4 wiring: autoApproveThrows + active Task context default-denies', async () => {
    // PR #424 review pr-test-analyzer Gap 3 (criticality 7): the
    // .catch() handler's `if (hookBridge.isInSubagentContext())` branch.
    // A dropped guard would route the catch through escalateToUser
    // instead of inject-deny, hanging the subagent.
    build({ autoApprove: true, autoApproveThrows: true });

    hookServer.fire('SessionStart', {
      session_id: 'claude-throws-task',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'throws-task.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PreToolUse', {
      session_id: 'claude-throws-task',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: {},
      tool_use_id: 'tu_task_throws',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-throws-task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ptySubmits).toEqual(['3']);
  });

  test('Phase 4 wiring: no auto-approve + active Task context default-denies', async () => {
    // PR #424 review pr-test-analyzer #4 (criticality 6): the
    // synchronous fallback `if (hookBridge.isInSubagentContext())` at
    // the bottom of the listener (no autoApproveService case). Uses a
    // Task context, not an agent_id-tagged event, so the
    // SubagentContextTracker bookkeeping is what carries the gate.
    build(); // no autoApprove

    hookServer.fire('SessionStart', {
      session_id: 'claude-noaa-task',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'noaatask.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PreToolUse', {
      session_id: 'claude-noaa-task',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: {},
      tool_use_id: 'tu_task_noaa',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-noaa-task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(ptySubmits).toEqual(['3']);
    expect(messageApiLog.questionCalls).toBe(0);
  });

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
