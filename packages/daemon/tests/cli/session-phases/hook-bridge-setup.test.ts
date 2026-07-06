import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, Question, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { HookBridgeHandle } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import { setupHookBridge } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import type { HookServer } from '../../../src/hooks/index.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/index.ts';

/**
 * Recording HookServer that captures `.on()` registrations AND lets tests
 * fire the registered listeners directly. Lets us exercise the 7 hook
 * callback bodies without starting a real Bun.serve HTTP listener.
 */
class RecordingHookServer {
  readonly listeners = new Map<string, (input: unknown) => void>();
  /** The synchronous PermissionRequest resolver (#496); set via setPermissionResolver. */
  permissionResolver: ((input: unknown) => Promise<string>) | null = null;
  on(event: string, listener: (input: unknown) => void): () => void {
    // Only the last listener per event survives; for setupHookBridge this is
    // fine because it installs exactly one per event name.
    this.listeners.set(event, listener);
    return () => this.listeners.delete(event);
  }
  setPermissionResolver(resolver: ((input: unknown) => Promise<string>) | null): void {
    this.permissionResolver = resolver;
  }
  fire(event: string, input: unknown): void {
    // PermissionRequest is no longer a `.on()` listener (#496) — it is the
    // synchronous resolver. Tests that fire it purely to drive the binder
    // (binding/foreign-drop/rotation) keep working: the binder bind + admit run
    // SYNCHRONOUSLY inside the resolver before the async decision, which we
    // fire-and-forget here. Decision-asserting tests use `await firePermission`.
    if (event === 'PermissionRequest' && !this.listeners.has(event) && this.permissionResolver) {
      void this.permissionResolver(input);
      return;
    }
    const fn = this.listeners.get(event);
    if (!fn) throw new Error(`No listener registered for ${event}`);
    fn(input);
  }
  /** Fire a PermissionRequest through the synchronous resolver (#496) and return
   *  the decision ('allow' | 'deny' | 'passthrough'). */
  async firePermission(input: unknown): Promise<string> {
    if (!this.permissionResolver) throw new Error('No permission resolver registered');
    return this.permissionResolver(input);
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
  let bindingStore: SessionBindingStore;
  let liveSessionsRegistry: SessionRegistryFile;
  // Stored loosely so tests can inject a minimal fake watcher without
  // dragging in a real TranscriptWatcher instance.
  let transcriptWatchers: Map<UUID, { filePath: string; stop: () => void }>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let hookServer: RecordingHookServer;
  let ptySubmits: string[];
  let messageApiLog: MessageApiCallLog;
  // Every setupHookBridge() call in this file registers its returned handle
  // here so afterEach can close its TranscriptBinder: the binder unconditionally
  // arms a fallback poll + #452 rotation dir-poll (setInterval) whenever the
  // session has a bound claudeSessionId, and only closeBinder() tears those
  // down. Without this every such test would leak a live timer.
  let bridgeHandles: HookBridgeHandle[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hook-bridge-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    // Live-sessions registry gets its OWN subdir so its listLive() scan does
    // not see (and delete as "invalid") the SessionStore's sessions.json that
    // shares the tmp root. Create it up front so tests that write sibling
    // entries directly into dirPath don't need their own mkdir.
    liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    hookServer = new RecordingHookServer();
    ptySubmits = [];
    messageApiLog = { resetCalls: { n: 0 }, statusCalls: [], questionCalls: 0 };
    bridgeHandles = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    for (const h of bridgeHandles) {
      try {
        h.closeBinder();
      } catch {
        /* already closed */
      }
    }
    // Stop any transcript watchers a test left running (tests that fire
    // SessionStart start a real TranscriptWatcher with an fs.watch + 1s poll;
    // without this they leak a timer + fd past the test). Covers the
    // pre-existing rotation tests too.
    for (const w of transcriptWatchers.values()) {
      try {
        w.stop();
      } catch {
        /* already stopped */
      }
    }
    // Backstop: closeBinder() above already cancels each binder's own fallback
    // timer, but clear the shared map directly too in case a test's handle was
    // not registered in bridgeHandles.
    for (const t of transcriptFallbackTimers.values()) {
      clearInterval(t);
    }
    transcriptFallbackTimers.clear();
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
      /** Capture every message the bridge sends via sendAndRecord (#576: the
       *  auto-approve status broadcasts). Defaults to a no-op send. */
      sendLog?: ProtocolMessage[];
      /** Capture every broadcastQuestionResolved call (#585, P7). Each entry is
       *  the (questionId, reason) the bridge forwarded. Defaults to undefined
       *  (dep not wired). */
      broadcastResolvedLog?: Array<{ questionId: UUID; reason: string }>;
      /** Capture every foreignSessionEscalator.handleUnadmitted call (#672).
       *  Each entry is the (input, callerSessionId) the resolver forwarded.
       *  Defaults to undefined (dep not wired). */
      foreignEscalationLog?: Array<{ input: unknown; sessionId: UUID }>;
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

    const handle = setupHookBridge(
      {
        sessionRegistry,
        bindingStore,
        liveSessionsRegistry,
        transcriptWatchers: transcriptWatchers as unknown as Map<
          UUID,
          import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
        >,
        transcriptFallbackTimers,
        autoApproveService,
        currentPort: () => 8765,
        transcriptDiscovery: new TranscriptDiscovery(),
        ...(opts.broadcastResolvedLog
          ? {
              broadcastQuestionResolved: (
                _sid: UUID,
                questionId: UUID,
                reason: 'auto_approved' | 'auto_denied' | 'cancelled',
              ) => opts.broadcastResolvedLog?.push({ questionId, reason }),
            }
          : {}),
        ...(opts.foreignEscalationLog
          ? {
              foreignSessionEscalator: {
                handleUnadmitted: (input: unknown, sid: UUID) =>
                  opts.foreignEscalationLog?.push({ input, sessionId: sid }),
              } as unknown as import('../../../src/hooks/index.ts').ForeignSessionEscalator,
            }
          : {}),
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: localMessageApi,
        sendAndRecord: opts.sendLog ? (m) => opts.sendLog?.push(m) : () => {},
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
    bridgeHandles.push(handle);
    return { tracker };
  }

  test('registers 10 .on() listeners + the synchronous PermissionRequest resolver (#496)', () => {
    build();
    const events = new Set(hookServer.listeners.keys());
    // PermissionRequest is NO LONGER a .on() listener — it is the synchronous
    // resolver (#496), installed via setPermissionResolver.
    expect(events).toEqual(
      new Set([
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'Notification',
        'Stop',
        'SessionEnd',
        // Wired in phase 4 (#453).
        'StopFailure',
        'PostToolUseFailure',
        'SubagentStart',
        'SubagentStop',
      ]),
    );
    expect(hookServer.permissionResolver).not.toBeNull();
  });

  describe('phase 4 (#453): the 4 previously-dropped events', () => {
    /** Fire a SessionStart so the bridge locks onto `id` (admit gate then passes). */
    function lock(id: string): void {
      hookServer.fire('SessionStart', {
        session_id: id,
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        hook_event_name: 'SessionStart',
      });
    }

    test('StopFailure emits a "Retry?" question + waiting status (no agent_id drop)', () => {
      build();
      lock('claude-A');
      hookServer.fire('StopFailure', { session_id: 'claude-A', error_type: 'timeout' });
      expect(messageApiLog.questionCalls).toBeGreaterThanOrEqual(1);
      expect(messageApiLog.statusCalls).toContain('waiting');
    });

    test('StopFailure for a FOREIGN session_id is dropped by the admit gate', () => {
      build();
      lock('claude-A');
      hookServer.fire('StopFailure', { session_id: 'claude-OTHER', error_type: 'timeout' });
      expect(messageApiLog.questionCalls).toBe(0);
    });

    test('#625 StopFailure emits DIRECTLY even with a real (non-passthrough) tracker', () => {
      // With a real QuestionPresenceTracker, recordPendingHook only STASHES (it does
      // not push without a PTY-visible signal). A source-less Stop-failure question has
      // no gate to push it, so the bridge must emit it directly to messageApi — proven
      // here by questionCalls incrementing despite the real tracker never pushing.
      build({ realTracker: true });
      lock('claude-A');
      hookServer.fire('StopFailure', { session_id: 'claude-A', error_type: 'timeout' });
      expect(messageApiLog.questionCalls).toBeGreaterThanOrEqual(1);
    });

    test('PostToolUseFailure sets executing status (main); a subagent failure is dropped', () => {
      build();
      lock('claude-A');
      hookServer.fire('PostToolUseFailure', {
        session_id: 'claude-A',
        tool_name: 'Bash',
        error: 'exit 1',
      });
      expect(messageApiLog.statusCalls).toEqual(['executing']);

      // A subagent's tool failure (agent_id set) must NOT flip main's status.
      messageApiLog.statusCalls.length = 0;
      hookServer.fire('PostToolUseFailure', {
        session_id: 'claude-A',
        agent_id: 'sub-1',
        tool_name: 'Bash',
        error: 'exit 1',
      });
      expect(messageApiLog.statusCalls).toEqual([]);
    });

    test('SubagentStart/Stop set the status breadcrumb (admit-gated, NOT agent_id-dropped)', () => {
      build();
      lock('claude-A');
      // SubagentStart/Stop ALWAYS carry agent_id; they must NOT be dropped.
      hookServer.fire('SubagentStart', {
        session_id: 'claude-A',
        agent_id: 'sub-1',
        agent_type: 'code-architect',
      });
      expect(messageApiLog.statusCalls).toEqual(['executing']);

      messageApiLog.statusCalls.length = 0;
      hookServer.fire('SubagentStop', { session_id: 'claude-A', agent_id: 'sub-1' });
      expect(messageApiLog.statusCalls).toEqual(['thinking']);
    });

    test('SubagentStart for a FOREIGN session_id is dropped by the admit gate', () => {
      build();
      lock('claude-A');
      hookServer.fire('SubagentStart', {
        session_id: 'claude-OTHER',
        agent_id: 'sub-1',
        agent_type: 'task',
      });
      expect(messageApiLog.statusCalls).toEqual([]);
    });
  });

  test('does not throw when autoApproveService is null (common case)', () => {
    expect(() => build()).not.toThrow();
  });

  test('Phase 4 (#419): PermissionRequest with agent_id is forwarded through auto-approve, gated by PTY presence', async () => {
    // Pre-phase-4, agent_id-tagged events were dropped at the listener
    // boundary. Phase 4 demoted agent_id from kill-switch to metadata:
    // the auto-approve LLM evaluates and forwards to the inject path.
    // Inject is then gated by tracker.isPromptVisibleOnPTY() — true for
    // a hot-switched subagent view, false for a background subagent.
    // This test simulates the hot-switched case (PTY confirms presence)
    // so inject proceeds end to end.
    const { tracker } = build({ autoApprove: true, autoApproveDecision: 'approve' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-123',
      transcript_path: path.join(tmpDir, 'sub.jsonl'),
      hook_event_name: 'SessionStart',
    });

    // PTY rendered the subagent's prompt on the user's screen.
    tracker.onPTYPromptVisible({
      id: 'pty-pr1',
      text: 'Allow Bash?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });

    const decision = await hookServer.firePermission({
      session_id: 'claude-sub-123',
      agent_id: 'subagent-abc',
      agent_type: 'task',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // #496: approve returns 'allow' via the hook response — no PTY inject
    // (the old inject was what the PTY-presence gate guarded; approve no
    // longer needs the PTY at all).
    expect(decision).toBe('allow');
    expect(ptySubmits).toEqual([]);
  });

  test('PTY gate covers legacy subagents: nested-Task PermissionRequest WITHOUT agent_id is dropped when no PTY presence', async () => {
    // The agent_id-based detector misses legacy Claude Code versions and any
    // future flows where the subagent hook fires without agent_id. The
    // secondary safety net is `hookBridge.isInSubagentContext()` (PreToolUse
    // Task with tool_use_id increments the tracker; PostToolUse decrements).
    // Inject must consult BOTH detectors; otherwise a nested Bash hook with
    // no agent_id would inject into the parent agent's PTY input.
    build({ autoApprove: true, autoApproveDecision: 'approve' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-nested-1',
      transcript_path: path.join(tmpDir, 'nested.jsonl'),
      hook_event_name: 'SessionStart',
    });

    // Engage nested-Task subagent context (no agent_id, just Task spawn).
    hookServer.fire('PreToolUse', {
      session_id: 'claude-nested-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'task-use-1',
      tool_input: { prompt: 'nested work' },
    });

    // PermissionRequest fires from inside the Task: NO agent_id (legacy
    // path), but isInSubagentContext() is true and PTY has not confirmed
    // any prompt is on screen.
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-nested-1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Pre-fix the inject would have typed '1' into the parent PTY because
    // isSubagentEvent was false. Post-fix the OR gate trips on
    // isInSubagentContext() and the inject is skipped.
    expect(ptySubmits).toEqual([]);
  });

  test('#710 regression: PostToolUse(Task) tagged with the spawned agent_id still pops the tracker', () => {
    // The leak: PreToolUse(Task) fires untagged (main context) and tracks
    // tool_use_id X. Claude Code may stamp the Task's OWN completion
    // PostToolUse with the spawned agent's agent_id. Pre-fix, the PostToolUse
    // listener's `if (isSubagentEvent(input)) return;` dropped that event
    // BEFORE it reached handlers.onPostToolUse -> handlePostToolUse -> the
    // tracker pop, so X was never popped and isInSubagentContext() stuck true
    // forever. Post-fix, the subagent-tagged drop path pops via
    // hookBridge.noteSubagentToolEnd() before returning.
    build();
    const bridge = bridgeHandles[bridgeHandles.length - 1]?.bridge;
    if (!bridge) throw new Error('test setup: no bridge handle');

    hookServer.fire('SessionStart', {
      session_id: 'claude-leak-1',
      transcript_path: path.join(tmpDir, 'leak.jsonl'),
      hook_event_name: 'SessionStart',
    });

    hookServer.fire('PreToolUse', {
      session_id: 'claude-leak-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'tu_leak_1',
      tool_input: { prompt: 'spawn subagent' },
    });
    expect(bridge.isInSubagentContext()).toBe(true);

    // The Task's own completion event arrives tagged with the spawned agent's
    // agent_id (the observed 0.6.18-dev.24 soak shape) — NOT untagged as the
    // matching PreToolUse was.
    hookServer.fire('PostToolUse', {
      session_id: 'claude-leak-1',
      hook_event_name: 'PostToolUse',
      agent_id: 'spawned-agent-1',
      tool_name: 'Task',
      tool_use_id: 'tu_leak_1',
      tool_input: {},
      tool_response: { result: 'done' },
    });

    expect(bridge.isInSubagentContext()).toBe(false);
  });

  test('PermissionRequest with auto-approve APPROVE returns "allow" (no inject) (#496)', async () => {
    build({ autoApprove: true });

    // Fire SessionStart first so claudeSessionId locks; subsequent events
    // pass filterBySession.
    hookServer.fire('SessionStart', {
      session_id: 'claude-locked-123',
      transcript_path: path.join(tmpDir, 'does-not-matter.jsonl'),
      hook_event_name: 'SessionStart',
    });

    const decision = await hookServer.firePermission({
      session_id: 'claude-locked-123',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // #496: synchronous APPROVE returns 'allow'; Claude proceeds without a
    // prompt and remi never injects. (Status is no longer set here — the tool's
    // own PreToolUse hook sets 'executing' when Claude runs it.)
    expect(decision).toBe('allow');
    expect(ptySubmits).toEqual([]);
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

  test('sibling-in-dir + fallback-discovered claudeSessionId: lock adopted from sessionStore on next hook', async () => {
    // The dev.3 inconsistency the user hit: when 2+ Remi wrappers share a
    // project directory, hasSiblingInDir() defers hook-event-based locking
    // to the transcript-fallback poll. The fallback discovers our own
    // Claude session ID by inspecting `~/.claude/projects/<dir>/` and writes
    // it to sessionStore. Pre-fix, the hook-bridge's `claudeSessionId`
    // closure never read from sessionStore, so filterBySession kept
    // returning false (no lock + siblings) and dropped EVERY hook for the
    // entire session lifetime. The fix: adoptLockFromStore() reads
    // sessionStore.findByRemiSessionId(...)?.claudeSessionId lazily on the
    // next hook event after fallback completes.
    //
    // Test setup: seed a sibling and pre-populate sessionStore as the
    // fallback would have done. Fire a PermissionRequest for our session
    // and assert the auto-approve inject fires (proving filterBySession
    // adopted the lock).
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(liveSessionsRegistry.dirPath, 'sibling-in-dir.json'),
      JSON.stringify({
        sessionId: 'sibling-session-id',
        pid: process.pid,
        wsPort: 18999,
        hookPort: 18001,
        projectPath: tmpDir,
        name: 'sibling',
        startedAt: new Date().toISOString(),
      }),
    );

    // Pre-populate the store as transcript-fallback would have done after
    // discovering our Claude transcript via filesystem polling.
    sessionStore.save({
      remiSessionId: SID,
      claudeSessionId: 'claude-mine-via-fallback',
      projectPath: tmpDir,
      port: 8765,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    build({ autoApprove: true, autoApproveDecision: 'approve' });

    // Hot-switched PTY presence so the subagent gate doesn't shadow this
    // assertion (irrelevant to the lock-adoption check itself).
    // The first hook arrives WHILE hasSiblingInDir is still true. Pre-fix
    // this dropped silently. Post-fix, adoptLockFromStore pulls the lock
    // from sessionStore and filterBySession returns true.
    // If the lock was adopted, the event is admitted and auto-approve evaluates
    // -> 'allow' (#496). If not (regression), it is dropped as foreign ->
    // 'passthrough'. So the decision proves adoption (the old proof was an inject).
    const decision = await hookServer.firePermission({
      session_id: 'claude-mine-via-fallback',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(decision).toBe('allow');
    expect(ptySubmits).toEqual([]);
  });

  test("sibling-in-dir + fallback-discovered lock: foreign session's hooks still drop", () => {
    // Mirror of the test above, but with a hook event from a DIFFERENT
    // session_id (i.e. the sibling's Claude). Lock-adoption must not turn
    // into "accept anything"; the adopted lock should be enforced like
    // the normal locked path.
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(liveSessionsRegistry.dirPath, 'sibling-in-dir-2.json'),
      JSON.stringify({
        sessionId: 'sibling-session-id-2',
        pid: process.pid,
        wsPort: 18998,
        hookPort: 18002,
        projectPath: tmpDir,
        name: 'sibling-2',
        startedAt: new Date().toISOString(),
      }),
    );

    sessionStore.save({
      remiSessionId: SID,
      claudeSessionId: 'claude-mine-v2',
      projectPath: tmpDir,
      port: 8765,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    build({ autoApprove: true, autoApproveDecision: 'approve' });

    // Foreign session_id — sibling's Claude firing through our hook URL.
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-sibling-not-ours',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // No inject — filterBySession matched on the adopted lock and
        // dropped the foreign event.
        expect(ptySubmits).toEqual([]);
        resolve();
      }, 50);
    });
  });

  describe('#672 foreignSessionEscalator wiring', () => {
    function bindOurSession(): void {
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-mine',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
    }

    test('calls handleUnadmitted with the raw input + our sessionId when a PermissionRequest is NOT admitted', async () => {
      bindOurSession();
      const foreignEscalationLog: Array<{ input: unknown; sessionId: UUID }> = [];
      build({ foreignEscalationLog });

      const input = {
        session_id: 'claude-someone-else',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      };
      const decision = await hookServer.firePermission(input);

      expect(decision).toBe('passthrough');
      expect(foreignEscalationLog).toHaveLength(1);
      expect(foreignEscalationLog[0]?.sessionId).toBe(SID);
      expect(foreignEscalationLog[0]?.input).toMatchObject({ session_id: 'claude-someone-else' });
    });

    test('does NOT call handleUnadmitted when the PermissionRequest IS admitted (our own session)', async () => {
      bindOurSession();
      const foreignEscalationLog: Array<{ input: unknown; sessionId: UUID }> = [];
      build({ foreignEscalationLog, autoApprove: true, autoApproveDecision: 'approve' });

      const decision = await hookServer.firePermission({
        session_id: 'claude-mine',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      expect(decision).toBe('allow');
      expect(foreignEscalationLog).toHaveLength(0);
    });

    test('with no foreignSessionEscalator wired, a foreign PermissionRequest still passes through cleanly (no throw)', async () => {
      bindOurSession();
      build(); // no foreignEscalationLog -> dep left unwired

      const decision = await hookServer.firePermission({
        session_id: 'claude-someone-else',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });

      expect(decision).toBe('passthrough');
    });
  });

  test('sibling-in-dir + sessionStore rotation: adoptLockFromStore re-adopts the new claudeSessionId', async () => {
    // After initial adoption from sessionStore (claude-A), the user runs
    // /clear in the sibling-wrapper scenario. The transcript-fallback
    // rediscovers and writes claude-B to the store. The hook-bridge MUST
    // pick up the rotation; pre-fix, the `if (claudeSessionId !== null)
    // return` short-circuit blocked the re-read and every hook for
    // claude-B was silently dropped.
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(liveSessionsRegistry.dirPath, 'sibling-rotate.json'),
      JSON.stringify({
        sessionId: 'sibling-session-id-rotate',
        pid: process.pid,
        wsPort: 18997,
        hookPort: 18003,
        projectPath: tmpDir,
        name: 'sibling-rotate',
        startedAt: new Date().toISOString(),
      }),
    );

    sessionStore.save({
      remiSessionId: SID,
      claudeSessionId: 'claude-A-initial',
      projectPath: tmpDir,
      port: 8765,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    build({ autoApprove: true, autoApproveDecision: 'approve' });

    // Initial adoption: hook for claude-A is admitted -> approve -> 'allow' (#496).
    expect(
      await hookServer.firePermission({
        session_id: 'claude-A-initial',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
    ).toBe('allow');

    // Fallback rediscovers after /clear and writes the new id.
    sessionStore.save({
      remiSessionId: SID,
      claudeSessionId: 'claude-B-rotated',
      projectPath: tmpDir,
      port: 8765,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });

    // Hook for claude-B: the lock must re-adopt; otherwise it is dropped as
    // foreign -> 'passthrough'. 'allow' proves the rotation was picked up.
    expect(
      await hookServer.firePermission({
        session_id: 'claude-B-rotated',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      }),
    ).toBe('allow');
    expect(ptySubmits).toEqual([]);
  });

  test('adoptLockFromStore catches sessionStore throws and keeps the daemon running', () => {
    // EMFILE / permissions / mid-write JSON.parse failures inside
    // sessionStore.read can throw out of findByRemiSessionId. Pre-fix
    // those propagated into the hook dispatch loop. The try/catch wrapper
    // must contain them: log via logError and fall through to the
    // existing sibling-guard path (claudeSessionId stays null, hooks
    // drop until siblings clear).
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    fs.writeFileSync(
      path.join(liveSessionsRegistry.dirPath, 'sibling-throw.json'),
      JSON.stringify({
        sessionId: 'sibling-session-id-throw',
        pid: process.pid,
        wsPort: 18996,
        hookPort: 18004,
        projectPath: tmpDir,
        name: 'sibling-throw',
        startedAt: new Date().toISOString(),
      }),
    );

    // Replace findByRemiSessionId with one that throws to simulate
    // EMFILE-class failures from fs.readFileSync inside SessionStore.read.
    sessionStore.findByRemiSessionId = () => {
      throw Object.assign(new Error('test: EMFILE'), { code: 'EMFILE' });
    };

    build({ autoApprove: true, autoApproveDecision: 'approve' });

    // Fire a hook — this triggers adoptLockFromStore which would throw.
    // We expect the hook dispatch to survive (no thrown exception, hook
    // is filtered out because the closure remains null + sibling present).
    expect(() =>
      hookServer.fire('PermissionRequest', {
        session_id: 'claude-throw-test',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
    ).not.toThrow();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // No inject — sibling is present and adoptLockFromStore could not
        // resolve a lock, so filterBySession's `!hasSiblingInDir()` arm
        // returns false. The daemon stays alive instead of crashing.
        expect(ptySubmits).toEqual([]);
        resolve();
      }, 50);
    });
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

  test('restart (/clear) broadcasts question_resolved for each pending question and clears them (#585 P7)', () => {
    const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
    build({ broadcastResolvedLog });

    // Lock onto claude-A.
    hookServer.fire('SessionStart', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'SessionStart',
    });

    // A question was pushed before the restart (held-hook or hook+PTY path).
    const QID = 'q1111111-1111-1111-1111-111111111111' as UUID;
    sessionRegistry.addQuestion(SID, {
      id: QID,
      text: 'proceed?',
      options: [
        { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
        { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
      ],
      allowsFreeText: false,
      isAnswered: false,
    });
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);

    // /clear: a new session_id rotates the binding (restart classification).
    hookServer.fire('SessionStart', {
      session_id: 'claude-B',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      hook_event_name: 'SessionStart',
      source: 'clear',
    });

    // The pending card is dismissed on every client (broadcast) AND dropped from
    // the registry, so nothing lingers across the rotation.
    expect(broadcastResolvedLog).toEqual([{ questionId: QID, reason: 'cancelled' }]);
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
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

    bridgeHandles.push(
      setupHookBridge(
        {
          sessionRegistry,
          bindingStore,
          liveSessionsRegistry,
          transcriptWatchers: transcriptWatchers as unknown as Map<
            UUID,
            import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
          >,
          transcriptFallbackTimers,
          autoApproveService: null,
          currentPort: () => 8765,
          transcriptDiscovery: new TranscriptDiscovery(),
        },
        {
          hookServer: hookServer as unknown as HookServer,
          sessionId: SID,
          workingDirectory: tmpDir,
          messageApi: localApi,
          sendAndRecord: () => {},
          tracker,
        },
      ),
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

    bridgeHandles.push(
      setupHookBridge(
        {
          sessionRegistry,
          bindingStore,
          liveSessionsRegistry,
          transcriptWatchers: transcriptWatchers as unknown as Map<
            UUID,
            import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
          >,
          transcriptFallbackTimers,
          autoApproveService: null, // no auto-approve -> escalate path
          currentPort: () => 8765,
          transcriptDiscovery: new TranscriptDiscovery(),
        },
        {
          hookServer: hookServer as unknown as HookServer,
          sessionId: SID,
          workingDirectory: tmpDir,
          messageApi: localApi,
          sendAndRecord: () => {},
          tracker,
        },
      ),
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

    bridgeHandles.push(
      setupHookBridge(
        {
          sessionRegistry,
          bindingStore,
          liveSessionsRegistry,
          transcriptWatchers: transcriptWatchers as unknown as Map<
            UUID,
            import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
          >,
          transcriptFallbackTimers,
          autoApproveService: null,
          currentPort: () => 8765,
          transcriptDiscovery: new TranscriptDiscovery(),
        },
        {
          hookServer: hookServer as unknown as HookServer,
          sessionId: SID,
          workingDirectory: tmpDir,
          messageApi: localApi,
          sendAndRecord: () => {},
          tracker,
        },
      ),
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

  test('subagent approve returns "allow" via the response — no inject, no escalate (#496)', async () => {
    // Regression guard for the dev.3 misfiring: a background subagent's
    // PermissionRequest cannot answer by injecting into the MAIN PTY
    // because the subagent's prompt isn't there — "1" would land in the
    // main agent's input. inject() must gate on
    // tracker.isPromptVisibleOnPTY(); when false (no PTY confirmation),
    // it returns false so the approve branch falls through to
    // escalateToUser, which records into the tracker. The PassthroughTracker
    // collapses that into a push (one question call). In production the
    // real tracker would wait for PTY confirmation that never arrives →
    // pending dropped on next status change → no spurious push.
    build({ autoApprove: true, autoApproveDecision: 'approve' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-AA',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subAA.jsonl'),
      source: 'startup',
      model: 'test',
    });

    const decision = await hookServer.firePermission({
      session_id: 'claude-sub-AA',
      agent_id: 'subagent-AA',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // approve -> 'allow' via the response; no PTY inject and no escalation,
    // regardless of subagent PTY presence.
    expect(decision).toBe('allow');
    expect(ptySubmits).toEqual([]);
    expect(messageApiLog.questionCalls).toBe(0);
  });

  test('subagent approve with PTY-visible prompt returns "allow" (no inject) (#496)', async () => {
    // Preserves PR #419's hot-switched-subagent case: when the user
    // has switched to the subagent's view, its permission prompt IS
    // rendered on the main PTY. Simulate that by firing
    // onPTYPromptVisible BEFORE the PermissionRequest so the tracker's
    // ptyShowingQuestion flag is true when inject's gate checks it.
    const { tracker } = build({ autoApprove: true, autoApproveDecision: 'approve' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-hot',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subhot.jsonl'),
      source: 'startup',
      model: 'test',
    });

    // PTY rendered the subagent's prompt on the user's screen.
    tracker.onPTYPromptVisible({
      id: 'pty-q-1',
      text: 'Allow Bash?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });

    const decision = await hookServer.firePermission({
      session_id: 'claude-sub-hot',
      agent_id: 'subagent-hot',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    // #496: approve allows via the response even with a hot-switched subagent
    // view; no inject.
    expect(decision).toBe('allow');
    expect(ptySubmits).toEqual([]);
  });

  test('subagent deny returns "deny" via the response — no inject, no escalate (#496)', async () => {
    // Mirrors the approve case for the deny branch — same gate, same
    // fallthrough. The non-hang guarantee for background subagents is
    // now structural: with no PTY presence the subagent has no answerable
    // prompt to hang on (the inject never could have reached it), so
    // dropping is correct.
    build({ autoApprove: true, autoApproveDecision: 'deny' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-deny',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subdeny.jsonl'),
      source: 'startup',
      model: 'test',
    });

    const decision = await hookServer.firePermission({
      session_id: 'claude-sub-deny',
      agent_id: 'subagent-deny',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    // deny -> 'deny' via the response; no inject, no escalation.
    expect(decision).toBe('deny');
    expect(ptySubmits).toEqual([]);
    expect(messageApiLog.questionCalls).toBe(0);
  });

  test('subagent deny with PTY-visible prompt returns "deny" (no inject) (#496)', async () => {
    const { tracker } = build({ autoApprove: true, autoApproveDecision: 'deny' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-sub-deny-hot',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'subdenyhot.jsonl'),
      source: 'startup',
      model: 'test',
    });

    tracker.onPTYPromptVisible({
      id: 'pty-q-2',
      text: 'Allow Bash: rm -rf /?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });

    const decision = await hookServer.firePermission({
      session_id: 'claude-sub-deny-hot',
      agent_id: 'subagent-deny-hot',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    // #496: deny returns 'deny' via the response; no PTY inject even with a
    // visible prompt.
    expect(decision).toBe('deny');
    expect(ptySubmits).toEqual([]);
  });

  test('#710: escalate + active Task context but UNTAGGED PermissionRequest now escalates, not denies', async () => {
    // PR #424 originally asserted this default-denied (pr-test-analyzer Gap 2):
    // auto-approve escalates AND a Task tool call is open on the main session,
    // with no agent_id on the PermissionRequest itself (the SubagentContextTracker
    // legacy-support safety net). #710 changed the policy: an UNTAGGED event
    // (agent_id absent) reaching the default-deny branch with
    // isInSubagentContext() true is now treated as tracker-leak evidence, not a
    // genuine legacy subagent — current Claude Code tags the Task's own
    // PostToolUse completion with agent_id (the actual leak mechanism fixed by
    // this issue), so escalating (holdable via Model B) is strictly safer than a
    // silent main-agent deny. The bridge resets the tracker and escalates as main.
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

    // Untagged PermissionRequest while the tracker is (still) open.
    const decision = await hookServer.firePermission({
      session_id: 'claude-esc-task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(decision).toBe('passthrough');
    expect(ptySubmits).toEqual([]);
    expect(messageApiLog.questionCalls).toBe(1); // escalated to the user, not silently denied
  });

  test('#710: autoApproveThrows + active Task context but UNTAGGED PermissionRequest now escalates, not denies', async () => {
    // Mirrors the escalate case above for the eval-error (.catch) branch.
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

    const decision = await hookServer.firePermission({
      session_id: 'claude-throws-task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(decision).toBe('passthrough');
    expect(ptySubmits).toEqual([]);
  });

  test('#710: no auto-approve + active Task context but UNTAGGED PermissionRequest now escalates, not denies', async () => {
    // Mirrors the escalate case above for the no-service branch.
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

    const decision = await hookServer.firePermission({
      session_id: 'claude-noaa-task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(decision).toBe('passthrough');
    expect(ptySubmits).toEqual([]);
    expect(messageApiLog.questionCalls).toBe(1); // escalated to the user, not silently denied
  });

  test('#710: a genuinely subagent-TAGGED PermissionRequest (agent_id set) during an active Task context still default-denies', async () => {
    // The still-valid case: agent_id present proves this really is a subagent
    // prompt (not a leak), so it must keep default-denying via the response.
    build({ autoApprove: true, autoApproveDecision: 'escalate' });

    hookServer.fire('SessionStart', {
      session_id: 'claude-esc-task-tagged',
      hook_event_name: 'SessionStart',
      transcript_path: path.join(tmpDir, 'esctask-tagged.jsonl'),
      source: 'startup',
      model: 'test',
    });

    hookServer.fire('PreToolUse', {
      session_id: 'claude-esc-task-tagged',
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { subagent_type: 'general-purpose', prompt: 'do stuff' },
      tool_use_id: 'tu_task_esc_tagged',
    });

    const decision = await hookServer.firePermission({
      session_id: 'claude-esc-task-tagged',
      agent_id: 'subagent-tagged-1',
      agent_type: 'general-purpose',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(decision).toBe('deny');
    expect(ptySubmits).toEqual([]);
    expect(messageApiLog.questionCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Issue #387: cancel stale auto-approve LLM eval on advance signals
  // -------------------------------------------------------------------------

  test('#537: PreToolUse does NOT cancel the in-flight auto-approve eval', () => {
    // Under synchronous decisions Claude blocks on the PermissionRequest, so a
    // running eval is the verdict it is waiting for — a previous tool's
    // PreToolUse must not abort it (that dropped decisions about to approve).
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
    expect(cancelLog).not.toContain('PreToolUse');
  });

  test('#537: PostToolUse does NOT cancel the in-flight auto-approve eval', () => {
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
    expect(cancelLog).not.toContain('PostToolUse');
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

  describe('session_rotated emission on rotation (#430 #438)', () => {
    /**
     * Set up a hook bridge that captures every protocol message it tries
     * to send. We can't use the shared `build` helper because that swallows
     * sendAndRecord; rotation emission is the whole point we need to assert
     * on.
     */
    function buildWithCapture(): { sent: import('@remi/shared').ProtocolMessage[] } {
      const sent: import('@remi/shared').ProtocolMessage[] = [];
      const tracker = new PassthroughTracker((q) => {
        messageApiLog.questionCalls += 1;
        const _ = q;
      });
      const handle = setupHookBridge(
        {
          sessionRegistry,
          bindingStore,
          liveSessionsRegistry,
          transcriptWatchers: transcriptWatchers as unknown as Map<
            UUID,
            import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
          >,
          transcriptFallbackTimers,
          autoApproveService: null,
          currentPort: () => 8765,
          transcriptDiscovery: new TranscriptDiscovery(),
        },
        {
          hookServer: hookServer as unknown as HookServer,
          sessionId: SID,
          workingDirectory: tmpDir,
          messageApi: {
            handleMessage: () => {},
            handleQuestion: () => {},
            handleStatusChange: () => {},
            reset: () => {
              messageApiLog.resetCalls.n += 1;
            },
          } as unknown as import('../../../src/api/message-api.ts').MessageAPI,
          sendAndRecord: (msg) => sent.push(msg),
          tracker: tracker as unknown as QuestionPresenceTracker,
        },
      );
      bridgeHandles.push(handle);
      return { sent };
    }

    test('first-init does NOT emit (no rotation, only hello_ack covers initial)', () => {
      const { sent } = buildWithCapture();

      // Register the session so the bridge proceeds past hasSession() checks.
      sessionRegistry.registerSession(SID, tmpDir, fakePTY([]), {
        handleMessage: () => {},
        handleQuestion: () => {},
        handleStatusChange: () => {},
        reset: () => {},
      } as unknown as import('../../../src/api/message-api.ts').MessageAPI);

      hookServer.fire('SessionStart', {
        session_id: 'claude-first-id',
        transcript_path: path.join(tmpDir, 'first.jsonl'),
        hook_event_name: 'SessionStart',
      });

      expect(sent.filter((m) => m.type === 'session_rotated')).toHaveLength(0);
    });

    test('second SessionStart with a different id emits one session_rotated', () => {
      const { sent } = buildWithCapture();
      sessionRegistry.registerSession(SID, tmpDir, fakePTY([]), {
        handleMessage: () => {},
        handleQuestion: () => {},
        handleStatusChange: () => {},
        reset: () => {},
      } as unknown as import('../../../src/api/message-api.ts').MessageAPI);

      hookServer.fire('SessionStart', {
        session_id: 'claude-first-id',
        transcript_path: path.join(tmpDir, 'first.jsonl'),
        hook_event_name: 'SessionStart',
      });
      hookServer.fire('SessionStart', {
        session_id: 'claude-second-id',
        transcript_path: path.join(tmpDir, 'second.jsonl'),
        hook_event_name: 'SessionStart',
      });

      const events = sent.filter((m) => m.type === 'session_rotated') as Array<{
        sessionId: string;
        oldClaudeSessionId?: string;
        newClaudeSessionId: string;
        newTranscriptPath: string;
        reason: string;
      }>;
      expect(events).toHaveLength(1);
      expect(events[0]?.sessionId).toBe(SID);
      expect(events[0]?.oldClaudeSessionId).toBe('claude-first-id');
      expect(events[0]?.newClaudeSessionId).toBe('claude-second-id');
      expect(events[0]?.newTranscriptPath).toBe(path.join(tmpDir, 'second.jsonl'));
      expect(events[0]?.reason).toBe('restart');
    });

    // Epic #453 phase 0 characterization. The #430/#433 hazard: the
    // transcript-fallback writes the NEW claudeSessionId to sessionStore
    // BEFORE the hook event for it arrives, so adoptLockFromStore pulls the
    // new id and classifySessionEvent sees currentLock === incoming = 'match'.
    // The bug-regression + Codex critics flagged that this exact race is
    // untested. This pins TODAY's behavior so the TranscriptBinder refactor
    // (phase 3) cannot change it unnoticed: when the store has already raced
    // to the new id, the early-return at hook-bridge-setup.ts:370 is hit and
    // NO session_rotated is emitted (the snapshot's isRotation is computed but
    // never reaches the restart/adopt announce). Reconnect reconcile then
    // relies on the store-binding + hello_ack decoration, not a replayed
    // session_rotated. The binder must consciously preserve OR fix this.
    test('store raced to the new id before SessionStart: characterize session_rotated', () => {
      const { sent } = buildWithCapture();
      sessionRegistry.registerSession(SID, tmpDir, fakePTY([]), {
        handleMessage: () => {},
        handleQuestion: () => {},
        handleStatusChange: () => {},
        reset: () => {},
      } as unknown as import('../../../src/api/message-api.ts').MessageAPI);

      // Establish the lock on claude-A.
      hookServer.fire('SessionStart', {
        session_id: 'claude-A',
        transcript_path: path.join(tmpDir, 'a.jsonl'),
        hook_event_name: 'SessionStart',
      });

      // Fallback races the store to claude-B BEFORE the SessionStart for B.
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-B',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });

      // SessionStart for B arrives; adoptLockFromStore pulls B -> 'match'.
      hookServer.fire('SessionStart', {
        session_id: 'claude-B',
        transcript_path: path.join(tmpDir, 'b.jsonl'),
        hook_event_name: 'SessionStart',
      });

      // Baseline: the store-raced case does NOT re-emit session_rotated.
      expect(sent.filter((m) => m.type === 'session_rotated')).toHaveLength(0);
      // But the binding DID advance to B (store + lock), so a reconnect still
      // reconciles via the store, not via a replayed rotation event.
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-B');
    });

    // Epic #453 phase 0: golden-master / differential baseline. A
    // representative multi-rotation session lifecycle (fresh -> /clear ->
    // /clear) replayed through the CURRENT path, capturing the control-plane
    // contract: the ordered session_rotated sequence + the final durable
    // binding. Phase 3's TranscriptBinder must reproduce this exactly
    // (shadow-mode diffs against it). Deterministic (synchronous control
    // plane only; async transcript content is out of scope here).
    test('golden master: multi-rotation control-plane sequence + final binding', () => {
      const { sent } = buildWithCapture();
      sessionRegistry.registerSession(SID, tmpDir, fakePTY([]), {
        handleMessage: () => {},
        handleQuestion: () => {},
        handleStatusChange: () => {},
        reset: () => {},
      } as unknown as import('../../../src/api/message-api.ts').MessageAPI);

      // Pre-spawn binding (createNewSession writes this before spawn).
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: 'claude-1',
        projectPath: tmpDir,
        port: 8765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });

      const t1 = path.join(tmpDir, 'm1.jsonl');
      const t2 = path.join(tmpDir, 'm2.jsonl');
      const t3 = path.join(tmpDir, 'm3.jsonl');

      hookServer.fire('SessionStart', {
        session_id: 'claude-1',
        transcript_path: t1,
        hook_event_name: 'SessionStart',
        source: 'startup',
      });
      hookServer.fire('SessionStart', {
        session_id: 'claude-2',
        transcript_path: t2,
        hook_event_name: 'SessionStart',
        source: 'clear',
      });
      hookServer.fire('SessionStart', {
        session_id: 'claude-3',
        transcript_path: t3,
        hook_event_name: 'SessionStart',
        source: 'clear',
      });

      const rotations = sent
        .filter((m) => m.type === 'session_rotated')
        .map((m) => {
          const r = m as unknown as {
            oldClaudeSessionId?: string;
            newClaudeSessionId: string;
            newTranscriptPath: string;
            reason: string;
          };
          return {
            old: r.oldClaudeSessionId,
            new: r.newClaudeSessionId,
            path: r.newTranscriptPath,
            reason: r.reason,
          };
        });

      // THE GOLDEN MASTER — phase 3 must reproduce this byte-for-byte.
      expect(rotations).toEqual([
        { old: 'claude-1', new: 'claude-2', path: t2, reason: 'restart' },
        { old: 'claude-2', new: 'claude-3', path: t3, reason: 'restart' },
      ]);
      expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe('claude-3');
    });
  });

  describe('child-liveness + port-ownership rotation (#451)', () => {
    /** Write a co-located sibling registry entry. `child` controls how its
     *  Claude liveness is recorded: alive pid, a dead pid, or none (legacy). */
    function writeSibling(
      name: string,
      child: { claudeChildPid?: number; claudeChildExited?: boolean } = {},
    ): void {
      fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
      fs.writeFileSync(
        path.join(liveSessionsRegistry.dirPath, name),
        JSON.stringify({
          sessionId: `sib-${name}`,
          pid: process.pid, // sibling DAEMON is alive
          wsPort: 18999,
          hookPort: 18001,
          projectPath: tmpDir,
          name: 'sibling',
          startedAt: new Date().toISOString(),
          ...child,
        }),
      );
    }

    /** Write a transcript whose head optionally carries the remi:<port> marker. */
    function writeTranscript(claudeId: string, ownerPort: number | null): string {
      const p = path.join(tmpDir, `${claudeId}.jsonl`);
      const head =
        ownerPort !== null
          ? `${JSON.stringify({ type: 'custom-title', customTitle: `remi:${ownerPort}` })}\n`
          : '';
      fs.writeFileSync(
        p,
        `${head}${JSON.stringify({
          type: 'user',
          uuid: 'u1',
          sessionId: claudeId,
          message: { role: 'user', content: 'hi' },
        })}\n`,
      );
      return p;
    }

    /** Pre-seed the store binding so the first event adopts the lock. */
    function seedLock(claudeId: string): void {
      sessionStore.save({
        remiSessionId: SID,
        claudeSessionId: claudeId,
        projectPath: tmpDir,
        port: 8765, // matches the harness currentPort()
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
    }

    function stopWatchers(): void {
      for (const w of transcriptWatchers.values()) {
        try {
          w.stop();
        } catch {
          /* best effort */
        }
      }
    }

    const CLAUDE_A = 'aaaaaaaa-1111-1111-1111-111111111111';
    const CLAUDE_B = 'bbbbbbbb-2222-2222-2222-222222222222';

    test('zombie sibling (dead Claude child) no longer wedges our rotation', async () => {
      // The exact bug: a leftover daemon (process alive, Claude dead) shares
      // the dir. Pre-fix it permanently deferred rotation handling. The
      // rotated transcript here carries NO port marker, proving the zombie is
      // fully ignored rather than relying on the ownership signal.
      const deadProc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
      await deadProc.exited;
      writeSibling('zombie.json', { claudeChildPid: deadProc.pid });
      seedLock(CLAUDE_A);
      writeTranscript(CLAUDE_A, null);
      const pathB = writeTranscript(CLAUDE_B, null);

      build();
      // Event 1: establish lock=CLAUDE_A from the store.
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_A,
        transcript_path: path.join(tmpDir, `${CLAUDE_A}.jsonl`),
        hook_event_name: 'SessionStart',
      });
      // Event 2: in-process rotation to CLAUDE_B.
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_B,
        transcript_path: pathB,
        hook_event_name: 'SessionStart',
      });

      try {
        expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe(CLAUDE_B);
        expect(transcriptWatchers.has(SID)).toBe(true);
      } finally {
        stopWatchers();
      }
    });

    test('genuine live sibling: our own rotation adopts via the remi:<port> marker', async () => {
      // A real second daemon (live Claude child) shares the dir. Our rotation
      // must still rebind because the new transcript carries OUR port marker.
      writeSibling('live.json', { claudeChildPid: process.pid }); // alive
      seedLock(CLAUDE_A);
      writeTranscript(CLAUDE_A, 8765);
      const pathB = writeTranscript(CLAUDE_B, 8765); // ours

      build();
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_A,
        transcript_path: path.join(tmpDir, `${CLAUDE_A}.jsonl`),
        hook_event_name: 'SessionStart',
      });
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_B,
        transcript_path: pathB,
        hook_event_name: 'SessionStart',
      });

      try {
        expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe(CLAUDE_B);
        expect(transcriptWatchers.has(SID)).toBe(true);
      } finally {
        stopWatchers();
      }
    });

    test("genuine live sibling: the SIBLING's rotation is NOT adopted (no latching)", () => {
      // Mirror of the above, but the rotating transcript carries the SIBLING's
      // port. We must not overwrite our binding or start a watcher on it.
      writeSibling('live2.json', { claudeChildPid: process.pid });
      seedLock(CLAUDE_A);
      writeTranscript(CLAUDE_A, 8765);
      const siblingId = 'cccccccc-3333-3333-3333-333333333333';
      const pathSib = writeTranscript(siblingId, 18999); // sibling's port

      build();
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_A,
        transcript_path: path.join(tmpDir, `${CLAUDE_A}.jsonl`),
        hook_event_name: 'SessionStart',
      });
      hookServer.fire('SessionStart', {
        session_id: siblingId,
        transcript_path: pathSib,
        hook_event_name: 'SessionStart',
      });

      try {
        // Binding unchanged: the sibling's rotation never overwrote ours.
        expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe(CLAUDE_A);
        // Our watcher (started for CLAUDE_A on event 1) is still intact and was
        // never torn down or re-pointed at the sibling's transcript.
        expect(transcriptWatchers.get(SID)?.filePath).toBe(path.join(tmpDir, `${CLAUDE_A}.jsonl`));
        expect(transcriptWatchers.get(SID)?.filePath).not.toBe(pathSib);
      } finally {
        stopWatchers();
      }
    });

    test('live sibling + rotation with NO port marker is not adopted', () => {
      // Guards the &&-not-|| shape of the ownership check: with a live sibling
      // present and a rotated transcript carrying no remi:<port> marker, we
      // cannot prove ownership, so we must defer rather than latch.
      writeSibling('live-nomarker.json', { claudeChildPid: process.pid });
      seedLock(CLAUDE_A);
      writeTranscript(CLAUDE_A, 8765); // ours, lets event 1 lock cleanly
      const pathB = writeTranscript(CLAUDE_B, null); // rotation, unmarked

      build();
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_A,
        transcript_path: path.join(tmpDir, `${CLAUDE_A}.jsonl`),
        hook_event_name: 'SessionStart',
      });
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_B,
        transcript_path: pathB,
        hook_event_name: 'SessionStart',
      });

      try {
        // Unproven rotation deferred: binding stays, watcher stays on CLAUDE_A.
        expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe(CLAUDE_A);
        expect(transcriptWatchers.get(SID)?.filePath).toBe(path.join(tmpDir, `${CLAUDE_A}.jsonl`));
      } finally {
        stopWatchers();
      }
    });

    test('sibling explicitly flagged claudeChildExited is ignored (recycle-proof)', () => {
      // The recycle-proof tombstone path: an entry that went alive -> exited via
      // markClaudeChildExited must not count as a sibling even though its pid is
      // alive. Rotation proceeds with no port marker, as in the zombie case.
      writeSibling('flagged-exited.json', {
        claudeChildPid: process.pid, // alive pid...
        claudeChildExited: true, // ...but explicitly tombstoned
      });
      seedLock(CLAUDE_A);
      writeTranscript(CLAUDE_A, null);
      const pathB = writeTranscript(CLAUDE_B, null);

      build();
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_A,
        transcript_path: path.join(tmpDir, `${CLAUDE_A}.jsonl`),
        hook_event_name: 'SessionStart',
      });
      hookServer.fire('SessionStart', {
        session_id: CLAUDE_B,
        transcript_path: pathB,
        hook_event_name: 'SessionStart',
      });

      try {
        expect(sessionStore.findByRemiSessionId(SID)?.claudeSessionId).toBe(CLAUDE_B);
        expect(transcriptWatchers.has(SID)).toBe(true);
      } finally {
        stopWatchers();
      }
    });

    test('self-heals the watcher when locked-from-store but the fallback gave up', () => {
      // The osa case: single daemon, no sibling. The lock is adopted from the
      // store (deterministic pre-spawn binding), but no watcher exists because
      // the 30s fallback poll timed out before Claude wrote its first transcript
      // line. The next hook event from our own Claude must start the watcher
      // (no port marker needed: the session_id match is proof of ownership).
      seedLock(CLAUDE_A);
      writeTranscript(CLAUDE_A, null);

      build();
      // No fallback ran in this harness, so we start with no watcher.
      expect(transcriptWatchers.has(SID)).toBe(false);

      hookServer.fire('PreToolUse', {
        session_id: CLAUDE_A,
        transcript_path: path.join(tmpDir, `${CLAUDE_A}.jsonl`),
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        hook_event_name: 'PreToolUse',
      });

      try {
        expect(transcriptWatchers.get(SID)?.filePath).toBe(path.join(tmpDir, `${CLAUDE_A}.jsonl`));
      } finally {
        stopWatchers();
      }
    });
  });

  // Epic #453 phase 0: pin TODAY's behavior so the QuestionPipeline / binder
  // refactor is verified against a baseline. These tests change no production
  // code; they characterize. The migration-safety + Codex critics flagged
  // that the existing realTracker tests assert hasPendingForTest() but never
  // that the push itself is gated on PTY presence, so a refactor could
  // collapse the two-step recordPendingHook -> onPTYPromptVisible contract
  // into a direct handleQuestion and still pass.
  describe('phase 0 characterization (#453 baseline)', () => {
    test('two-step push: a hook stashes pending WITHOUT pushing; only PTY presence fires the push', () => {
      const { tracker } = build({ realTracker: true });

      hookServer.fire('SessionStart', {
        session_id: 'claude-twostep',
        hook_event_name: 'SessionStart',
        transcript_path: path.join(tmpDir, 'twostep.jsonl'),
        source: 'startup',
        model: 'test',
      });

      hookServer.fire('PermissionRequest', {
        session_id: 'claude-twostep',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      // The hook recorded a pending question but did NOT push (no handleQuestion).
      expect(tracker.hasPendingForTest()).toBe(true);
      expect(messageApiLog.questionCalls).toBe(0);

      // The PTY confirms the prompt is on screen -> the push fires exactly once.
      tracker.onPTYPromptVisible({
        id: 'pty-twostep',
        text: 'Allow Bash?',
        options: [],
        allowsFreeText: false,
        isAnswered: false,
      } as unknown as Question);

      expect(messageApiLog.questionCalls).toBe(1);
    });
  });

  describe('#576 auto-approve status broadcasts', () => {
    /** Pull the AgentStatus values out of the session_update messages a run sent. */
    function sessionUpdateStatuses(log: ProtocolMessage[]): string[] {
      return log
        .filter(
          (m): m is Extract<ProtocolMessage, { type: 'session_update' }> =>
            m.type === 'session_update',
        )
        .map((m) => m.session.status);
    }

    test('an APPROVE eval broadcasts "evaluating" then "approved" session_updates', async () => {
      const sendLog: ProtocolMessage[] = [];
      // A small eval delay guarantees onEvalStart fires before onHandled.
      build({ autoApprove: true, autoApproveDecision: 'approve', autoApproveDelayMs: 10, sendLog });

      hookServer.fire('SessionStart', {
        session_id: 'claude-aa-status',
        hook_event_name: 'SessionStart',
        transcript_path: path.join(tmpDir, 'aa-status.jsonl'),
        source: 'startup',
        model: 'test',
      });

      const decision = await hookServer.firePermission({
        session_id: 'claude-aa-status',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(decision).toBe('allow');

      const statuses = sessionUpdateStatuses(sendLog);
      // evaluating (onEvalStart) must precede approved (onHandled).
      expect(statuses).toContain('evaluating');
      expect(statuses).toContain('approved');
      expect(statuses.indexOf('evaluating')).toBeLessThan(statuses.indexOf('approved'));
    });

    test('an ESCALATE eval broadcasts "evaluating" but NOT "approved" (no double-emit)', async () => {
      const sendLog: ProtocolMessage[] = [];
      build({
        autoApprove: true,
        autoApproveDecision: 'escalate',
        autoApproveDelayMs: 10,
        sendLog,
      });

      hookServer.fire('SessionStart', {
        session_id: 'claude-aa-esc',
        hook_event_name: 'SessionStart',
        transcript_path: path.join(tmpDir, 'aa-esc.jsonl'),
        source: 'startup',
        model: 'test',
      });

      await hookServer.firePermission({
        session_id: 'claude-aa-esc',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      const statuses = sessionUpdateStatuses(sendLog);
      expect(statuses).toContain('evaluating');
      // onEscalate deliberately does NOT broadcast (the bridge's
      // handlePermissionRequest -> onStatusChange('waiting') already does);
      // and onHandled is not reached on an escalate verdict.
      expect(statuses).not.toContain('approved');
    });

    test('a status-broadcast send error never propagates into the gate decision', async () => {
      // The broadcast helper wraps its own send in try/catch so a throwing
      // sendAndRecord cannot break the allow/deny decision or the buffer path.
      // A fresh setup wires a sender that records then throws on every send.
      const throwingLog: ProtocolMessage[] = [];
      const localApi = fakeMessageAPI({ resetCalls: { n: 0 }, statusCalls: [], questionCalls: 0 });
      const freshSid = generateId();
      sessionRegistry.registerSession(freshSid, tmpDir, fakePTY([]), localApi);
      const autoApproveService = {
        evaluate: async () => ({
          decision: 'approve' as const,
          reasoning: 'test',
          durationMs: 0,
          model: 'test-model',
        }),
        cancel: () => false,
      } as unknown as import('../../../src/auto-approve/index.ts').AutoApproveService;
      const freshHook = new RecordingHookServer();
      bridgeHandles.push(
        setupHookBridge(
          {
            sessionRegistry,
            bindingStore,
            liveSessionsRegistry,
            transcriptWatchers: transcriptWatchers as unknown as Map<
              UUID,
              import('../../../src/transcript/transcript-watcher.ts').TranscriptWatcher
            >,
            transcriptFallbackTimers,
            autoApproveService,
            currentPort: () => 8765,
            transcriptDiscovery: new TranscriptDiscovery(),
          },
          {
            hookServer: freshHook as unknown as HookServer,
            sessionId: freshSid,
            workingDirectory: tmpDir,
            messageApi: localApi,
            sendAndRecord: (m) => {
              throwingLog.push(m);
              throw new Error('test: send blew up');
            },
            tracker: makePassthroughTracker(localApi),
          },
        ),
      );

      freshHook.fire('SessionStart', {
        session_id: 'claude-throw-broadcast',
        hook_event_name: 'SessionStart',
        transcript_path: path.join(tmpDir, 'throw-bc.jsonl'),
        source: 'startup',
        model: 'test',
      });

      // The decision must still resolve to 'allow' despite the throwing sender.
      const decision = await freshHook.firePermission({
        session_id: 'claude-throw-broadcast',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(decision).toBe('allow');
      // And the broadcast was at least attempted (proving the throw path ran).
      expect(throwingLog.length).toBeGreaterThan(0);
    });
  });
});
