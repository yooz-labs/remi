import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, Question, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { MessageAPI } from '../../../src/api/message-api.ts';
import {
  type PushQuestion,
  QuestionPresenceTracker,
} from '../../../src/api/question-presence-tracker.ts';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import { createInputHandlers, trackerScreenDeps } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { HookBridgeHandle } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import { setupHookBridge } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import { REMI_REGISTERED_HOOK_EVENTS } from '../../../src/hooks/hook-types.ts';
import type { HookServer } from '../../../src/hooks/index.ts';
import { selectPushCategory } from '../../../src/notifications/notification-dispatcher.ts';
import { parseQuestion } from '../../../src/parser/question-parser.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/index.ts';
import {
  WRAPPED_DIRECTORY,
  WRAPPED_DIRECTORY_DIALOG,
} from '../../parser/fixtures/claude-dialogs.ts';

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

/** PTYSession fake that records submitInput calls. Since #1125 nothing in
 *  the bridge types into the PTY on its own, so most tests assert it stays
 *  empty; the push-on-render tests assert the phone's answer reaches it. */
function fakePTY(submits: string[]): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async (content: string) => {
      submits.push(content);
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

/**
 * PassthroughTracker whose parked subagent prompts RENDER at once: the card is
 * pushed under the parked question's id, as the real render pairing does when
 * it adopts the hook record's identity. Lets an external-resolution test drive
 * a parked card that actually reached the registry (#1125: the gate only
 * broadcasts a dismissal for a card that was registered).
 */
class RenderedParkTracker extends PassthroughTracker {
  constructor(private readonly pushNow: PushQuestion) {
    super(pushNow);
  }

  override parkAwaitingPTY(question: Question): void {
    this.pushNow(question);
  }
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
      throwOnQuestionTimes?: number;
      /** Use a real QuestionPresenceTracker (no PTY-visible passthrough)
       *  so tests can exercise the actual record-pending / status-clear
       *  contract through the bridge wiring. Defaults to the passthrough
       *  tracker used by the legacy assertion-style tests. */
      realTracker?: boolean;
      /** Parked subagent prompts render (and push) at once; see
       *  `RenderedParkTracker`. Ignored with `realTracker`. */
      parkedRenders?: boolean;
      /** Shorten `QuestionPresenceTracker`'s orphan-PTY debounce (default
       *  1.5s) so a test can drive the real hooked-session orphan path without
       *  a long wait. Only meaningful with `realTracker`. */
      orphanDebounceMs?: number;
      /** Capture every broadcastQuestionResolved call (#585, P7). Each entry is
       *  the (questionId, reason) the bridge forwarded. Defaults to undefined
       *  (dep not wired). */
      broadcastResolvedLog?: Array<{ questionId: UUID; reason: string }>;
      /** Capture every foreignSessionEscalator.handleUnadmitted call (#672).
       *  Each entry is the (input, callerSessionId) the resolver forwarded.
       *  Defaults to undefined (dep not wired). */
      foreignEscalationLog?: Array<{ input: unknown; sessionId: UUID }>;
      /** Real SubagentViewRegistry instance (#891 tests need to inspect
       *  recordStart/recordStop's effect on the stored transcript path).
       *  Defaults to undefined (dep not wired, matches production callers
       *  that skip subagent-view tracking). */
      subagentViews?: SubagentViewRegistry;
      /**
       * Construct the REAL `MessageAPI` (real `QuestionDedup` inside it) -- per
       * ADR 0014, tests that assert a card actually reached the registry (not
       * just "the bridge called a stub N times") must construct the real push
       * path, not `fakeMessageAPI`.
       *
       * The `onQuestion` callback below reproduces only the ONE step these
       * tests assert on, `sessionRegistry.addQuestion`; it is deliberately not
       * a copy of `message-api-setup.ts`'s callback, which also does
       * `sendAndRecord`, the push/held decision and `claudeSessionId` stamping.
       * What is real here is `MessageAPI` itself and the dedup inside it --
       * the component whose behavior the elicitation tests turn on. Say which,
       * because "wired exactly as production" would be the kind of coverage
       * overclaim ADR 0014 exists to catch.
       *
       * Defaults to false (the existing fake, unchanged for every pre-#889
       * test in this file).
       */
      realMessageApi?: boolean;
      /** Override the session cwd when testing repository-bound behavior. */
      workingDirectory?: string;
      /** Give the real tracker the two registry-backed deps cli.ts wires
       *  (`hasLiveQuestions` and the `sessionRegistry.removeQuestion` half of
       *  `onHooklessQuestionGone`), so redraw-echo suppression and render-owned
       *  resolution run as they do in production. Only those two deps; it does
       *  not claim the rest of cli.ts's wiring. Only meaningful with
       *  `realTracker`. */
      liveQuestionDeps?: boolean;
      /** Record every push the REAL tracker makes, with its `held` flag.
       *  Only meaningful with `realTracker`. */
      pushLog?: Array<{ question: Question; held: boolean }>;
    } = {},
  ): { tracker: QuestionPresenceTracker; messageApi: MessageAPI } {
    const sessionWorkingDirectory = opts.workingDirectory ?? tmpDir;
    const localMessageApi: MessageAPI = opts.realMessageApi
      ? new MessageAPI(
          { sessionId: SID, initialBulletId: 1 },
          {
            onQuestion: (question) => {
              messageApiLog.questionCalls += 1;
              sessionRegistry.addQuestion(SID, question, question.source ?? 'unknown');
            },
            onStatusChange: (status) => {
              messageApiLog.statusCalls.push(status);
            },
          },
        )
      : fakeMessageAPI(
          messageApiLog,
          opts.throwOnQuestionTimes !== undefined
            ? { throwOnQuestionTimes: opts.throwOnQuestionTimes }
            : {},
        );
    const tracker: QuestionPresenceTracker = opts.realTracker
      ? new QuestionPresenceTracker(
          (q, pushOpts) => {
            opts.pushLog?.push({ question: q, held: pushOpts?.held === true });
            return localMessageApi.handleQuestion(q, pushOpts);
          },
          // Only pass deps when a test asked for them, so the pre-existing
          // realTracker tests keep their exact wiring (default 1.5s window, no
          // hasLiveQuestions dep).
          opts.orphanDebounceMs !== undefined || opts.liveQuestionDeps
            ? {
                ...(opts.orphanDebounceMs !== undefined
                  ? { orphanDebounceMs: opts.orphanDebounceMs }
                  : {}),
                ...(opts.liveQuestionDeps
                  ? {
                      hasLiveQuestions: () =>
                        (sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0) > 0,
                      onHooklessQuestionGone: (questionId: string, reason: string) => {
                        sessionRegistry.removeQuestion(
                          SID,
                          questionId as UUID,
                          reason,
                          undefined,
                          'test.onHooklessQuestionGone',
                        );
                      },
                    }
                  : {}),
              }
            : undefined,
        )
      : opts.parkedRenders
        ? new RenderedParkTracker((q) => localMessageApi.handleQuestion(q))
        : makePassthroughTracker(localMessageApi);
    sessionRegistry.registerSession(
      SID,
      sessionWorkingDirectory,
      fakePTY(ptySubmits),
      localMessageApi,
    );

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
        currentPort: () => 8765,
        transcriptDiscovery: new TranscriptDiscovery(),
        ...(opts.subagentViews ? { subagentViews: opts.subagentViews } : {}),
        ...(opts.broadcastResolvedLog
          ? {
              broadcastQuestionResolved: (_sid: UUID, questionId: UUID, reason: 'cancelled') =>
                opts.broadcastResolvedLog?.push({ questionId, reason }),
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
        workingDirectory: sessionWorkingDirectory,
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
    bridgeHandles.push(handle);
    return { tracker, messageApi: localMessageApi };
  }

  test('registers a .on() listener for every REMI_REGISTERED_HOOK_EVENTS entry except the resolver-installed PermissionRequest (#927)', () => {
    build();
    const events = new Set(hookServer.listeners.keys());
    // PermissionRequest is NOT a .on() listener — it is the synchronous
    // resolver (#496), installed via setPermissionResolver, so it is the one
    // known subtraction from the registry. Deriving the expected set from
    // REMI_REGISTERED_HOOK_EVENTS instead of a hand-copied literal is the
    // point of this test (#927): the registered-event count has moved twice
    // in one day (14 -> 15 -> 14, #937 then #930) with the listener count
    // following it (13 -> 14 -> 13). A hardcoded count here goes stale on
    // every such change; deriving it fails the moment the registry and the
    // listener block disagree, which is the actual guarantee this test
    // exists to provide.
    const expectedListenerEvents = new Set(
      REMI_REGISTERED_HOOK_EVENTS.filter((event) => event !== 'PermissionRequest'),
    );
    expect(events).toEqual(expectedListenerEvents);
    expect(hookServer.permissionResolver).not.toBeNull();
  });

  describe('UserPromptSubmit listener (#893)', () => {
    function lock(id: string): void {
      // #930: SessionStart is no longer a registered/dispatched hook
      // event (Claude Code discards http-type hooks for it). Notification
      // with a neutral type locks the binder via the same onHookEvent()
      // first-adopt path with zero downstream side effects (handleNotification
      // no-ops for anything outside permission_prompt/idle_prompt/
      // elicitation_dialog).
      hookServer.fire('Notification', {
        session_id: id,
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: '',
      });
    }

    test('does not throw when the listener fires with no downstream consumer wired', () => {
      build();
      lock('claude-q9-4');
      expect(() =>
        hookServer.fire('UserPromptSubmit', {
          session_id: 'claude-q9-4',
          transcript_path: path.join(tmpDir, 'claude-q9-4.jsonl'),
          hook_event_name: 'UserPromptSubmit',
          prompt: 'hello',
          session_title: 'test',
        }),
      ).not.toThrow();
    });
  });

  describe('phase 4 (#453): the 4 previously-dropped events', () => {
    /** Fire a neutral Notification so the bridge locks onto `id` (admit gate then passes; #930). */
    function lock(id: string): void {
      // #930: SessionStart is no longer a registered/dispatched hook
      // event (Claude Code discards http-type hooks for it). Notification
      // with a neutral type locks the binder via the same onHookEvent()
      // first-adopt path with zero downstream side effects (handleNotification
      // no-ops for anything outside permission_prompt/idle_prompt/
      // elicitation_dialog).
      hookServer.fire('Notification', {
        session_id: id,
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: '',
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

  test('builds without throwing', () => {
    expect(() => build()).not.toThrow();
  });

  test('#807: an agent_id-tagged PermissionRequest passes through unevaluated even with the PTY prompt visible', async () => {
    // History: pre-phase-4 these events were dropped at the listener boundary;
    // #419 demoted agent_id to metadata and let the LLM evaluate them, gating
    // only the PTY inject on presence.
    //
    // #807 removes the evaluation entirely. The hook is answered before Claude
    // renders anything, so PTY presence at THIS moment says nothing about
    // whether this particular prompt will render — the visible prompt here may
    // well belong to another agent. So the answer is 'passthrough' regardless,
    // and Claude's own permission flow decides. A card only appears if the
    // parked record later pairs with a real render.
    const { tracker } = build();

    hookServer.fire('Notification', {
      session_id: 'claude-sub-123',
      transcript_path: path.join(tmpDir, 'sub.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
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

    // #807: never evaluated. Passthrough, nothing typed into the PTY.
    expect(decision).toBe('passthrough');
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

    hookServer.fire('Notification', {
      session_id: 'claude-leak-1',
      transcript_path: path.join(tmpDir, 'leak.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
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
    // this window must also be filtered out (the headline #321 symptom: the
    // auto-approve log and status updates went missing; #1125 removed the
    // evaluator, the filter stays).
    hookServer.fire('Notification', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
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
    hookServer.fire('Notification', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
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
    hookServer.fire('Notification', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
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
    // and assert it is escalated as a question (proving filterBySession
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

    build();

    // Hot-switched PTY presence so the subagent gate doesn't shadow this
    // assertion (irrelevant to the lock-adoption check itself).
    // The first hook arrives WHILE hasSiblingInDir is still true. Pre-fix
    // this dropped silently. Post-fix, adoptLockFromStore pulls the lock
    // from sessionStore and filterBySession returns true.
    // If the lock was adopted, the event is admitted and the gate escalates
    // it, emitting a question. If not (regression), it is dropped as foreign:
    // also 'passthrough', but with no question. So the emitted question proves
    // adoption (#1125: before the evaluator was removed, the proof was an
    // 'allow' verdict).
    const decision = await hookServer.firePermission({
      session_id: 'claude-mine-via-fallback',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(decision).toBe('passthrough');
    expect(messageApiLog.questionCalls).toBe(1);
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

    build();

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
      build({ foreignEscalationLog });

      const decision = await hookServer.firePermission({
        session_id: 'claude-mine',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      // Admitted: the gate escalated it (a question was emitted).
      expect(decision).toBe('passthrough');
      expect(messageApiLog.questionCalls).toBe(1);
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

    build();

    // Initial adoption: hook for claude-A is admitted -> escalated, so the
    // gate emits a question (a dropped foreign hook emits none).
    expect(
      await hookServer.firePermission({
        session_id: 'claude-A-initial',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
    ).toBe('passthrough');
    expect(messageApiLog.questionCalls).toBe(1);

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
    // foreign with no question. A second question proves the rotation was
    // picked up.
    expect(
      await hookServer.firePermission({
        session_id: 'claude-B-rotated',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      }),
    ).toBe('passthrough');
    expect(messageApiLog.questionCalls).toBe(2);
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

    build();

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

  test('restart (/clear) broadcasts question_resolved for each pending question and clears them (#585 P7)', () => {
    const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
    build({ broadcastResolvedLog });

    // Lock onto claude-A.
    hookServer.fire('Notification', {
      session_id: 'claude-A',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
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
    // #930: SessionStart's own pre-empt is unreachable via hooks now (Claude
    // Code never sends it), so the rotation here is driven the way it
    // actually happens post-#930: a real SessionEnd for the OLD id flips
    // `mainSessionEnded` (`TranscriptBinder.onSessionEnd`), then any
    // registered event for the NEW id classifies as 'restart'. This is
    // real production behavior (SessionEnd genuinely fires on a clean exit),
    // not a synthetic-only substitute.
    hookServer.fire('SessionEnd', {
      session_id: 'claude-A',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });
    hookServer.fire('Notification', {
      session_id: 'claude-B',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
    });

    // The pending card is dismissed on every client (broadcast) AND dropped from
    // the registry, so nothing lingers across the rotation.
    expect(broadcastResolvedLog).toEqual([{ questionId: QID, reason: 'cancelled' }]);
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
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

    hookServer.fire('Notification', {
      session_id: 'claude-locked-wire-1',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'wire.jsonl'),
      notification_type: 'auth_success',
      message: '',
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

    hookServer.fire('Notification', {
      session_id: 'claude-restart-A',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'a.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });

    hookServer.fire('PermissionRequest', {
      session_id: 'claude-restart-A',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(tracker.hasPendingForTest()).toBe(true);

    // Restart fires (e.g. user typed /clear). #930: SessionStart's own
    // pre-empt is unreachable via hooks now, so the rotation is driven the
    // way it actually happens post-#930: a real SessionEnd for the OLD id
    // flips `mainSessionEnded`, then any registered event for the NEW id
    // classifies as 'restart' (see the (#585 P7) test above for the same
    // substitution and its rationale).
    hookServer.fire('SessionEnd', {
      session_id: 'claude-restart-A',
      hook_event_name: 'SessionEnd',
      reason: 'clear',
    });
    hookServer.fire('Notification', {
      session_id: 'claude-restart-B',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'b.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });

    expect(tracker.hasPendingForTest()).toBe(false);
  });

  test('Phase 3 wiring: late Notification after SessionEnd is dropped', () => {
    // silent-failure-hunter #3: SessionEnd already cleared status to
    // 'idle' (which drains tracker.pending). A late Notification
    // arriving from a dying Claude process must not re-populate the
    // pending slot, or a final PTY echo could fire a spurious push.
    const { tracker } = build({ realTracker: true });

    hookServer.fire('Notification', {
      session_id: 'claude-late-1',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'late.jsonl'),
      notification_type: 'auth_success',
      message: '',
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

  test("Phase 2 + Phase 3: mixed-shape suggestions pair through the hook->tracker->push merge, the screen's options win", async () => {
    // pr-test-analyzer Gap 3: phase 2 filters object entries out of
    // permission_suggestions; phase 3 merges the hook record onto the PTY
    // question. Both layers are tested in isolation; this covers the chain
    // end-to-end through the real bridge wiring. Since #1134 the merge takes
    // the hook's text and identity but keeps the screen's options: the card
    // is answered by typing an option value into that screen.
    const pushed: Question[] = [];
    const localApi = fakeMessageAPI(messageApiLog);
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits), localApi);
    const tracker = new QuestionPresenceTracker((q) => {
      pushed.push(q);
      return undefined;
    });

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

    hookServer.fire('Notification', {
      session_id: 'claude-mixed',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'mixed.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });

    // The gate escalates every main-agent request (#1125): escalateToUser
    // calls handlePermissionRequest -> onQuestion ->
    // tracker.recordPendingHook with the filtered options.
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-mixed',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
      permission_suggestions: [{ type: 'addDirectories', directories: ['/tmp'] }, 'Yes', 'No'],
    });

    expect(tracker.hasPendingForTest()).toBe(true);

    // PTY confirms the prompt is on screen with its own numbered options.
    const screen: Question = {
      id: generateId(),
      text: 'Allow Edit: /tmp/x.ts?',
      options: [
        { label: '1', value: '1', isRecommended: false, isYes: false, isNo: false },
        { label: '2', value: '2', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: false,
      isAnswered: false,
    };
    tracker.onPTYPromptVisible(screen);

    expect(pushed.length).toBe(1);
    // The hook record paired: its text and source, the screen's options.
    expect(pushed[0]?.source).toBe('permission_request');
    expect(pushed[0]?.text).toBe('Allow Edit: /tmp/x.ts');
    expect(pushed[0]?.options).toEqual(screen.options);
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
    const tracker = new QuestionPresenceTracker((q) => {
      pushed.push(q);
      return undefined;
    });

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

    hookServer.fire('Notification', {
      session_id: 'claude-sub-A',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'subA.jsonl'),
      notification_type: 'auth_success',
      message: '',
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
    const screen: Question = {
      id: generateId(),
      text: 'Allow Edit: /tmp/foo.ts?',
      options: [
        { label: '1', value: '1', isRecommended: false, isYes: false, isNo: false },
        { label: '2', value: '2', isRecommended: false, isYes: false, isNo: false },
        { label: '3', value: '3', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: false,
      isAnswered: false,
    };
    tracker.onPTYPromptVisible(screen);

    expect(pushed.length).toBe(1);
    // Merged metadata: the subagent's agent and named text, the screen's
    // options (#1134).
    expect(pushed[0]?.agentId).toBe('subagent-A');
    expect(pushed[0]?.text).toBe('general-purpose · Edit: /tmp/foo.ts');
    expect(pushed[0]?.options).toEqual(screen.options);
  });

  test('Phase 4 wiring: subagent PermissionRequest with no PTY confirmation drops cleanly', async () => {
    // Background subagent path: hook fires (agent_id set), no PTY emit
    // because the user is not hot-switched into this subagent's view.
    // The tracker holds the pending; a subsequent status transition
    // (PostToolUse -> 'thinking') clears it. No push reaches iOS.
    const pushed: Question[] = [];
    const localApi = fakeMessageAPI(messageApiLog);
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits), localApi);
    const tracker = new QuestionPresenceTracker((q) => {
      pushed.push(q);
      return undefined;
    });

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

    hookServer.fire('Notification', {
      session_id: 'claude-sub-B',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'subB.jsonl'),
      notification_type: 'auth_success',
      message: '',
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

    // #763: a MAIN-tagged PostToolUse (routine status churn from another
    // agent's work) must NOT wipe the still-live parked record — the prompt
    // may not have had a chance to render yet.
    hookServer.fire('PostToolUse', {
      session_id: 'claude-sub-B',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { exit_code: 0 },
    });
    expect(tracker.hasPendingForTest()).toBe(true);
    expect(pushed.length).toBe(0);

    // The subagent's OWN next tagged PreToolUse proves its permission
    // resolved without a render (allowlist absorbed / answered): the parked
    // record expires so it cannot stale-merge later. No push ever fired.
    hookServer.fire('PreToolUse', {
      session_id: 'claude-sub-B',
      agent_id: 'subagent-B',
      agent_type: 'task',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu_sub_b_next',
    });
    expect(tracker.hasPendingForTest()).toBe(false);
    expect(pushed.length).toBe(0);
  });

  test('Phase 4 wiring: subagent Notification(permission_prompt) no longer records in tracker (#890, Q5)', async () => {
    // Notification(permission_prompt) used to be dropped at the listener
    // when agent_id was present; phase 4 (#419) made it flow to the tracker
    // like its PermissionRequest sibling. #890/Q5 deleted the question
    // synthesis Notification(permission_prompt) fed into that tracker slot
    // entirely (a capture corpus found the stash it fed always superseded
    // by the richer paired PermissionRequest, 68/68 pairs, 0 unpaired) --
    // the bridge's onQuestion callback now only stashes `source ===
    // 'permission_request'`, so a Notification with no preceding
    // PermissionRequest leaves the tracker with nothing pending at all.
    const { tracker } = build({ realTracker: true });

    hookServer.fire('Notification', {
      session_id: 'claude-sub-N',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'subN.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });

    hookServer.fire('Notification', {
      session_id: 'claude-sub-N',
      agent_id: 'subagent-N',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });

    expect(tracker.hasPendingForTest()).toBe(false);
  });

  test('#890 residual path: an UNPAIRED permission_prompt whose prompt renders still surfaces a card', async () => {
    // Q5's safety argument has two halves. The test above proves the first
    // (nothing is stashed anymore). This proves the second, which the PR
    // asserted in a comment but never exercised: with the stash gone, a
    // permission_prompt that arrives with NO paired PermissionRequest and then
    // DOES render must still reach the user, via the same orphan-PTY fallback
    // every genuinely hook-less prompt uses. If that were wrong, deleting the
    // synthesis would have turned the rare unpaired case into silence -- the
    // exact outcome the capture gate was meant to rule out.
    //
    // Driven through `onOrphanPTYPrompt`, which is what cli.ts routes to when a
    // hookServer is active, not the non-hooked `onPTYPromptVisible` core.
    const { tracker } = build({
      realTracker: true,
      realMessageApi: true,
      orphanDebounceMs: 5,
    });

    hookServer.fire('Notification', {
      session_id: 'claude-890-unpaired',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'unpaired.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });

    // No PermissionRequest -- this is the unpaired case by construction.
    hookServer.fire('Notification', {
      session_id: 'claude-890-unpaired',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    expect(tracker.hasPendingForTest()).toBe(false);
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);

    // The prompt renders anyway.
    tracker.onOrphanPTYPrompt({
      id: 'pty-q-890' as UUID,
      text: 'Allow Bash: curl example.com?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      source: 'pty',
    });

    // Poll the debounce out rather than sleeping a guess.
    const deadline = Date.now() + 2000;
    while (
      (sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0) === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const questions = [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])];
    expect(questions).toHaveLength(1);
    // The PTY's own text and provenance survive -- nothing was merged over it,
    // because there is no hook record to merge.
    expect(questions[0]?.text).toBe('Allow Bash: curl example.com?');
    expect(questions[0]?.source).toBe('pty');
  });

  describe('unheld binary main-agent prompts push on render (#1121)', () => {
    // A Claude permission dialog as the terminal shows it, fed through the
    // real parser (`parseQuestion` is what OutputProcessor emits from).
    function claudeDialog(command: string): Question {
      const screen = [
        ' Bash command',
        '',
        `   ${command}`,
        '   Run the command',
        '',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        "   2. Yes, and don't ask again for this command",
        '   3. No, and tell Claude what to do differently (esc)',
      ].join('\n');
      const parsed = parseQuestion(screen);
      if (!parsed.question) throw new Error('fixture did not parse as a prompt');
      return parsed.question;
    }

    function lockSession(id: string): void {
      hookServer.fire('Notification', {
        session_id: id,
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        notification_type: 'auth_success',
        message: '',
      });
    }

    function bash(id: string, command: string) {
      return hookServer.firePermission({
        session_id: id,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command },
      });
    }

    function cards(): Question[] {
      return [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])];
    }

    async function waitFor(pred: () => boolean): Promise<void> {
      const deadline = Date.now() + 2000;
      while (!pred() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    test("a binary prompt with no usable hook suggestions reaches the phone when it renders, with the screen's three options", async () => {
      // Nothing holds the hook (#1125; before it, the default install with
      // auto_approve.enabled = false), so the gate answers 'passthrough' and
      // Claude renders its native prompt at once.
      // Before `pushOnRender`, the stashed hook record made `isGateOwnedCycle`
      // read that render as already pushed and suppress it: the card never
      // reached the phone. Driven through `onOrphanPTYPrompt`, the routing
      // cli.ts uses when a hook server is active.
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-unheld-1');

      expect(await bash('claude-unheld-1', 'curl example.com')).toBe('passthrough');
      // Nothing is registered until the prompt actually renders.
      expect(cards()).toHaveLength(0);

      tracker.onOrphanPTYPrompt(claudeDialog('curl example.com'));

      const registered = cards();
      expect(registered).toHaveLength(1);
      // No usable permission_suggestions, so the hook built the Yes/No fallback;
      // the merge takes the screen's three options (#1134: a merged card's
      // options always come from the screen), or a phone "No" would type 2
      // and select the persistent allow.
      expect(registered[0]?.options.map((o) => o.value)).toEqual(['1', '2', '3']);
      expect(registered[0]?.options[2]?.label.startsWith('No')).toBe(true);
    });

    test('a redraw of the same dialog does not push a second card', async () => {
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-unheld-2');
      await bash('claude-unheld-2', 'curl example.com');

      tracker.onOrphanPTYPrompt(claudeDialog('curl example.com'));
      tracker.onOrphanPTYPrompt(claudeDialog('curl example.com'));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(cards()).toHaveLength(1);
      expect(messageApiLog.questionCalls).toBe(1);
    });

    test('a terminal "No" leaves no stale card once the next prompt renders', async () => {
      // A denial fires no tool call, so `cancelExternallyResolved` never runs;
      // the next render taking the render-owned slot is what retires card A.
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-unheld-3');
      await bash('claude-unheld-3', 'echo A');
      tracker.onOrphanPTYPrompt(claudeDialog('echo A'));
      const cardA = cards()[0]?.id;

      await bash('claude-unheld-3', 'echo B');
      tracker.onOrphanPTYPrompt(claudeDialog('echo B'));

      const remaining = cards();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).not.toBe(cardA);
      expect(remaining[0]?.text).toContain('echo B');
    });

    test('two outstanding hooks before a render push the screen, never the other hook', async () => {
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        orphanDebounceMs: 5,
      });
      lockSession('claude-unheld-4');
      await bash('claude-unheld-4', 'echo A');
      await bash('claude-unheld-4', 'rm -rf B');

      // Dialog A renders first: pairing by agent key would dress it as B.
      const screenA = claudeDialog('echo A');
      tracker.onOrphanPTYPrompt(screenA);
      await waitFor(() => cards().length > 0);

      const registered = cards();
      expect(registered).toHaveLength(1);
      expect(registered[0]?.text).toBe(screenA.text);
      expect(registered[0]?.text).not.toContain('rm -rf B');
    });

    test('with no usable hook suggestions, a phone "No" types the screen\'s No (3), not the fallback\'s 2', async () => {
      // The answer side of the screen-numbered merge (#1134): an unheld card
      // has no hold, so `handleAnswer` resolves the label to the option VALUE
      // and types it. The tracker's screen reads are wired through
      // `trackerScreenDeps`, the same helper cli.ts uses.
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-unheld-7');
      await bash('claude-unheld-7', 'curl example.com');
      tracker.onOrphanPTYPrompt(claudeDialog('curl example.com'));
      const card = cards()[0];
      if (!card) throw new Error('no card registered');
      const no = card.options.find((o) => o.label.startsWith('No'));
      if (!no) throw new Error('no "No" option on the card');

      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send: () => true,
        ...trackerScreenDeps(() => tracker),
      });
      await handlers.onAnswer('conn-1' as UUID, SID, card.id, no.label);

      expect(ptySubmits).toEqual(['3']);
    });
  });

  describe('multi-choice / design escalations push at once (#625)', () => {
    test('an AskUserQuestion pushes exactly one held card, once, and it reaches the registry', async () => {
      // The immediate-push path end to end: gate -> escalatePassthrough ->
      // onHeldEscalate -> tracker.pushHeldHook -> MessageAPI -> registry,
      // with the real tracker and message API and the gate's default
      // ALWAYS_ESCALATE_TOOLS (no alwaysEscalateTools passed).
      const pushLog: Array<{ question: Question; held: boolean }> = [];
      const { tracker } = build({ realTracker: true, realMessageApi: true, pushLog });
      hookServer.fire('Notification', {
        session_id: 'claude-auq-push',
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, 'claude-auq-push.jsonl'),
        notification_type: 'auth_success',
        message: '',
      });

      const decision = await hookServer.firePermission({
        session_id: 'claude-auq-push',
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Which database?',
              header: 'Database',
              multiSelect: false,
              options: [
                { label: 'Postgres', description: 'relational' },
                { label: 'SQLite', description: 'embedded' },
              ],
            },
          ],
        },
      });

      expect(decision).toBe('passthrough');
      expect(pushLog).toHaveLength(1);
      expect(pushLog[0]?.held).toBe(true);
      const qid = pushLog[0]?.question.id;
      if (!qid) throw new Error('no card pushed');
      expect(sessionRegistry.getQuestion(SID, qid)).not.toBeNull();

      // A repeat push for the same id is a no-op (pushedHeldIds).
      expect(tracker.pushHeldHook(qid)).toBe(false);
      expect(pushLog).toHaveLength(1);
      expect(
        [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])].filter(
          (q) => q.id === qid,
        ),
      ).toHaveLength(1);
    });
  });

  /**
   * #1134, the live E5 reproduction: a Bash `PermissionRequest` whose
   * `permission_suggestions` were `addDirectories` + `setMode` built a
   * 4-option card (Yes / allow directory / switch to acceptEdits / No) over a
   * dialog Claude rendered with 3 (Yes / always allow access to <dir> / No).
   * The phone's "No" was value 4; Claude ignored the digit and the Enter that
   * followed confirmed "1. Yes", so the command ran. Driven through the real
   * bridge, gate, tracker, MessageAPI and answer handler, with the dialog
   * parsed from the live PTY bytes by the real parser.
   */
  describe("phone answers use the screen's numbering (#1134)", () => {
    const E5_SUGGESTIONS = [
      { type: 'addDirectories', directories: [WRAPPED_DIRECTORY], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ];

    function lockSession(id: string): void {
      hookServer.fire('Notification', {
        session_id: id,
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        notification_type: 'auth_success',
        message: '',
      });
    }

    function liveDialog(): Question {
      const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG);
      if (!parsed.question) throw new Error('the live dialog did not parse as a prompt');
      return parsed.question;
    }

    function cards(): Question[] {
      return [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])];
    }

    /** The answer handler with every dep cli.ts wires for it, pointed at this
     *  session's gate handle and tracker. */
    function answerHandlers(tracker: QuestionPresenceTracker, sent: ProtocolMessage[]) {
      const gate = bridgeHandles[bridgeHandles.length - 1]?.gate;
      if (!gate) throw new Error('no bridge handle');
      return createInputHandlers({
        sessionRegistry,
        bindingStore,
        send: (_c, m) => {
          sent.push(m);
          return true;
        },
        retireQuestion: (_s, q) => gate.retireQuestion(q),
        ...trackerScreenDeps(() => tracker),
      });
    }

    async function e5Card(sessionTag: string): Promise<{
      tracker: QuestionPresenceTracker;
      card: Question;
      screen: Question;
    }> {
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession(sessionTag);
      const decision = await hookServer.firePermission({
        session_id: sessionTag,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch e5-marker.txt' },
        permission_suggestions: E5_SUGGESTIONS,
      });
      // The gate answers passthrough and marks the card to push when the
      // dialog renders (#1121).
      expect(decision).toBe('passthrough');
      const screen = liveDialog();
      tracker.onOrphanPTYPrompt(screen);
      const registered = cards();
      expect(registered).toHaveLength(1);
      return { tracker, card: registered[0] as Question, screen };
    }

    test("the card carries the screen's options, not the hook's four", async () => {
      const { card, screen } = await e5Card('claude-e5-card');

      // The screen's labels and values, unchanged.
      expect(card.options.map((o) => [o.value, o.label])).toEqual(
        screen.options.map((o) => [o.value, o.label]),
      );
      expect(card.options.map((o) => o.value)).toEqual(['1', '2', '3']);
      expect(card.options[2]?.label).toBe('No');
      // Yes/no meaning restored from the screen labels (the parse has none),
      // so the lock screen's positional "Yes / Yes, always / No" buttons are
      // true of options 1-3.
      expect(card.options.map((o) => [o.isYes, o.isNo])).toEqual([
        [true, false],
        [true, false],
        [false, true],
      ]);
      expect(selectPushCategory(card.options)).toBe('REMI_YNA');
      // The hook still names the command.
      expect(card.text).toBe('Allow Bash: touch e5-marker.txt');
    });

    test('a phone "No" types the screen\'s 3, never 4', async () => {
      const { tracker, card } = await e5Card('claude-e5-no');
      const no = card.options.find((o) => o.label === 'No');
      if (!no) throw new Error('no "No" option on the card');

      const sent: ProtocolMessage[] = [];
      // The value, as the phone sent it in the live run.
      await answerHandlers(tracker, sent).onAnswer('conn-e5' as UUID, SID, card.id, no.value);

      expect(ptySubmits).toEqual(['3']);
      expect(sent.filter((m) => m.type === 'error')).toHaveLength(0);
    });

    test('free text on the card is refused, not typed into the menu', async () => {
      // Lead decision on the #1134 review. The merged card takes the hook's
      // allowsFreeText (false for a permission), not the parser's (true for
      // every selection box), so text sent against it never reaches the
      // dialog, where Claude would ignore it and Enter would confirm "1. Yes".
      const { tracker, card } = await e5Card('claude-e5-text');
      expect(card.allowsFreeText).toBe(false);

      const sent: ProtocolMessage[] = [];
      await answerHandlers(tracker, sent).onAnswer(
        'conn-e5' as UUID,
        SID,
        card.id,
        'no, do not create the file',
      );

      expect(ptySubmits).toEqual([]);
      const errors = sent.filter((m) => m.type === 'error');
      expect(errors).toHaveLength(1);
      expect((errors[0] as { code?: string }).code).toBe('STALE_ANSWER');
    });

    test('a value the screen does not show is refused and nothing is typed', async () => {
      // A card pushed by id before its render carries the hook's numbering:
      // here a passthrough multi-choice escalation (four plain-string
      // suggestions) whose "No" is 4, over the live 3-option dialog. Its
      // "No" is the exact digit that approved the command in the live run.
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-e5-stale');
      const decision = await hookServer.firePermission({
        session_id: 'claude-e5-stale',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch e5-marker.txt' },
        permission_suggestions: [
          'Yes',
          'Yes, allow directory',
          'Yes, switch to acceptEdits mode',
          'No',
        ],
      });
      expect(decision).toBe('passthrough');
      const card = cards()[0];
      if (!card) throw new Error('the passthrough escalation registered no card');
      expect(card.options.map((o) => o.value)).toEqual(['1', '2', '3', '4']);

      tracker.onOrphanPTYPrompt(liveDialog());
      expect(tracker.observedPromptOptions()?.map((o) => o.value)).toEqual(['1', '2', '3']);

      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      const sent: ProtocolMessage[] = [];
      await answerHandlers(tracker, sent).onAnswer('conn-e5' as UUID, SID, card.id, '4');

      expect(ptySubmits).toEqual([]);
      // Refused by the screen check, not by the presence guard before it.
      expect(logs.some((m) => m.includes('"4" is not an option on screen [1, 2, 3]'))).toBe(true);
      const errors = sent.filter((m) => m.type === 'error');
      expect(errors).toHaveLength(1);
      expect((errors[0] as { code?: string }).code).toBe('STALE_ANSWER');
      // Consumed like the other refusals: the card no longer matches the screen.
      expect(cards()).toHaveLength(0);
    });

    test('the same by-id multi-choice card: an identical "Yes" still types 1', async () => {
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-e5-multi-yes');
      await hookServer.firePermission({
        session_id: 'claude-e5-multi-yes',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch e5-marker.txt' },
        permission_suggestions: [
          'Yes',
          'Yes, allow directory',
          'Yes, switch to acceptEdits mode',
          'No',
        ],
      });
      const card = cards()[0];
      if (!card) throw new Error('the passthrough escalation registered no card');
      tracker.onOrphanPTYPrompt(liveDialog());

      await answerHandlers(tracker, []).onAnswer('conn-e5' as UUID, SID, card.id, 'Yes');
      expect(ptySubmits).toEqual(['1']);
    });

    /**
     * ExitPlanMode pushes by id at once with the hook's hardcoded list, so the
     * notification always arrives (some plan renders never parse). Claude
     * 2.1.287 builds its own list; the screen below is the e4-bare-classic
     * capture's layout, re-spaced and fed through the real parser. No card
     * label equals the screen's at its value, so every digit is refused and
     * the plan is answered at the terminal.
     */
    describe("ExitPlanMode answered over Claude's own list", () => {
      async function planCard(sessionTag: string) {
        const { tracker } = build({
          realTracker: true,
          realMessageApi: true,
          liveQuestionDeps: true,
        });
        lockSession(sessionTag);
        const decision = await hookServer.firePermission({
          session_id: sessionTag,
          hook_event_name: 'PermissionRequest',
          tool_name: 'ExitPlanMode',
          tool_input: { plan: '# Plan\n1. Do the thing' },
        });
        expect(decision).toBe('passthrough');
        const card = cards()[0];
        if (!card) throw new Error('ExitPlanMode pushed no card before its render');
        const parsed = parseQuestion(
          [
            ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
            ' ❯ 1. Yes, auto-accept edits',
            '   2. Yes, manually approve edits',
            '   3. Tell Claude what to change',
            '      shift+tab to approve with this feedback',
            ' ctrl+g to edit in Nvim · ~/.claude/plans/x.md',
          ].join('\n'),
        );
        if (!parsed.question) throw new Error('the plan dialog did not parse');
        tracker.onOrphanPTYPrompt(parsed.question);
        return { tracker, card };
      }

      test('"No, keep planning" (3) is refused: the screen\'s 3 is "Tell Claude what to change"', async () => {
        const { tracker, card } = await planCard('claude-plan-no');
        await answerHandlers(tracker, []).onAnswer(
          'conn-plan' as UUID,
          SID,
          card.id,
          'No, keep planning',
        );
        expect(ptySubmits).toEqual([]);
      });

      test('"Yes, and auto-accept edits" (1) is refused: worded differently on screen', async () => {
        const { tracker, card } = await planCard('claude-plan-yes');
        await answerHandlers(tracker, []).onAnswer(
          'conn-plan' as UUID,
          SID,
          card.id,
          'Yes, and auto-accept edits',
        );
        expect(ptySubmits).toEqual([]);
      });
    });

    test('AskUserQuestion pushes at once, and a plain pick types its screen digit', async () => {
      // Its runner answers from the structured questions; a plain pick, as
      // the extension's buttons send, goes through the guard: "SQLite"
      // equals the screen row once its description is appended, and types 2.
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-auq');
      const decision = await hookServer.firePermission({
        session_id: 'claude-auq',
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            {
              question: 'Which database?',
              header: 'DB',
              multiSelect: false,
              options: [
                { label: 'Postgres', description: 'Relational' },
                { label: 'SQLite', description: 'Embedded' },
              ],
            },
          ],
        },
      });
      expect(decision).toBe('passthrough');
      const card = cards()[0];
      if (!card) throw new Error('AskUserQuestion pushed no card before its render');
      expect(card.kind).toBe('multi_question');

      const parsed = parseQuestion(
        [
          ' Which database?',
          ' ❯ 1. Postgres',
          '      Relational',
          '   2. SQLite',
          '      Embedded',
          '   3. Type something.',
          ' Enter to select · ↑/↓ to navigate · Esc to cancel',
        ].join('\n'),
      );
      if (!parsed.question) throw new Error('the AskUserQuestion menu did not parse');
      tracker.onOrphanPTYPrompt(parsed.question);
      expect(cards()).toHaveLength(1);

      const outcome = await answerHandlers(tracker, []).relayAnswer(SID, card.id, 'SQLite');
      expect(outcome).toBe('delivered');
      expect(ptySubmits).toEqual(['2']);
    });
  });

  test('#710: active Task context but UNTAGGED PermissionRequest escalates, not denies', async () => {
    // An untagged request is the main agent's even while a Task is open.
    build();

    hookServer.fire('Notification', {
      session_id: 'claude-noaa-task',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'noaatask.jsonl'),
      notification_type: 'auth_success',
      message: '',
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

  test('#751: a genuinely subagent-TAGGED PermissionRequest (agent_id set) during an active Task context parks + passthrough', async () => {
    // agent_id present proves this really is a subagent prompt (not a leak).
    // #751 PTY-arbiter: instead of the old default-deny (silent teammate
    // breakage), the gate parks the rich question and answers 'passthrough' --
    // no PTY inject, no immediate push/registration; the question surfaces
    // only if Claude's native prompt renders on the PTY.
    build();

    hookServer.fire('Notification', {
      session_id: 'claude-esc-task-tagged',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'esctask-tagged.jsonl'),
      notification_type: 'auth_success',
      message: '',
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

    expect(decision).toBe('passthrough');
    expect(ptySubmits).toEqual([]);
    // The park routes through recordPendingHook, which this harness's
    // PassthroughTracker collapses into an immediate PTY-visible push — i.e.
    // the simulated terminal rendered the prompt, so the parked question
    // surfaced. True park-until-render semantics are covered in
    // tests/api/question-presence-tracker.test.ts ("awaiting-PTY parking").
    expect(messageApiLog.questionCalls).toBe(1);
  });
  // ---------------------------------------------------------------------------
  // #799: a subagent/teammate permission question answered IN THE TERMINAL had
  // no removal path from sessionRegistry.currentQuestions. Fix: the gate now
  // registers a signature for a parked subagent escalation too, and the
  // subagent branches of PreToolUse/PostToolUse (which used to early-return
  // before ever reaching the gate) now call cancelExternallyResolved; a
  // SubagentStop resolves anything still open for that agent (the
  // rejected-in-the-terminal case no tool call ever announces).
  // ---------------------------------------------------------------------------
  describe('#799: subagent question purge', () => {
    function lock(id: string): void {
      // #930: SessionStart is no longer a registered/dispatched hook
      // event (Claude Code discards http-type hooks for it). Notification
      // with a neutral type locks the binder via the same onHookEvent()
      // first-adopt path with zero downstream side effects (handleNotification
      // no-ops for anything outside permission_prompt/idle_prompt/
      // elicitation_dialog).
      hookServer.fire('Notification', {
        session_id: id,
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: '',
      });
    }

    test('a matching subagent PreToolUse resolves a parked permission (question_resolved fires)', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-799-pre');

      const decision = await hookServer.firePermission({
        session_id: 'claude-799-pre',
        agent_id: 'agent-799-1',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });
      expect(decision).toBe('passthrough');
      expect(broadcastResolvedLog).toHaveLength(0); // parked, not resolved yet

      // The user answered directly in the terminal: Claude now runs the tool.
      hookServer.fire('PreToolUse', {
        session_id: 'claude-799-pre',
        agent_id: 'agent-799-1',
        agent_type: 'general-purpose',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });

      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.reason).toBe('cancelled');
    });

    test('a matching subagent PostToolUse also resolves it', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-799-post');

      const decision = await hookServer.firePermission({
        session_id: 'claude-799-post',
        agent_id: 'agent-799-2',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      });
      expect(decision).toBe('passthrough');
      expect(broadcastResolvedLog).toHaveLength(0);

      hookServer.fire('PostToolUse', {
        session_id: 'claude-799-post',
        agent_id: 'agent-799-2',
        agent_type: 'general-purpose',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_response: 'ok',
      });

      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.reason).toBe('cancelled');
    });

    test('(b) a non-matching subagent PreToolUse leaves the parked permission open', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-799-nomatch');

      await hookServer.firePermission({
        session_id: 'claude-799-nomatch',
        agent_id: 'agent-799-3',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });

      hookServer.fire('PreToolUse', {
        session_id: 'claude-799-nomatch',
        agent_id: 'agent-799-3',
        agent_type: 'general-purpose',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/x' }, // different command -> no signature match
      });

      expect(broadcastResolvedLog).toHaveLength(0);
    });

    test("SubagentStop resolves that agent's still-open permission (denied in the terminal, no tool call ever followed)", async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      const { tracker } = build({
        broadcastResolvedLog,
      });
      lock('claude-799-stop');

      await hookServer.firePermission({
        session_id: 'claude-799-stop',
        agent_id: 'agent-799-4',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm important-file' },
      });
      expect(broadcastResolvedLog).toHaveLength(0); // still open: no tool call ever fired (denied)
      // The park left a parked-awaiting-PTY tracker record for this agent.
      expect(tracker.awaitingPTYCountForTest()).toBe(1);

      hookServer.fire('SubagentStop', {
        session_id: 'claude-799-stop',
        agent_id: 'agent-799-4',
        agent_type: 'general-purpose',
      });

      // Never rendered, so never pushed: nothing to dismiss (#1125), but the
      // gate no longer tracks it either.
      expect(broadcastResolvedLog).toHaveLength(0);
      expect(bridgeHandles.at(-1)?.gate.forceRelease('probe')).toEqual({ resolved: 0 });
      // #799 review fix: SubagentStop must ALSO expire the tracker's parked
      // record (mirrors the PreToolUse-subagent branch's noteAgentAdvanced
      // pairing) -- otherwise it survives up to PARKED_RECORD_TTL_MS and can
      // pair with a later, unrelated PTY render for this agent key and
      // re-push a phantom card for a question already gone from the registry.
      expect(tracker.awaitingPTYCountForTest()).toBe(0);
    });

    test("never fires ambiguously: SubagentStop for one agent does not resolve a DIFFERENT agent's still-open permission", async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-799-ambig');

      await hookServer.firePermission({
        session_id: 'claude-799-ambig',
        agent_id: 'agent-799-A',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo A' },
      });
      await hookServer.firePermission({
        session_id: 'claude-799-ambig',
        agent_id: 'agent-799-B',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo B' },
      });
      expect(broadcastResolvedLog).toHaveLength(0);

      // Only agent-A finished.
      hookServer.fire('SubagentStop', {
        session_id: 'claude-799-ambig',
        agent_id: 'agent-799-A',
        agent_type: 'general-purpose',
      });

      // Exactly ONE resolution -- agent-B's still-open permission is untouched.
      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.reason).toBe('cancelled');
    });

    test('a matching subagent PostToolUseFailure resolves it (a failed tool still proves the permission was granted)', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-799-failure');

      await hookServer.firePermission({
        session_id: 'claude-799-failure',
        agent_id: 'agent-799-5',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build/' },
      });
      expect(broadcastResolvedLog).toHaveLength(0);

      hookServer.fire('PostToolUseFailure', {
        session_id: 'claude-799-failure',
        agent_id: 'agent-799-5',
        agent_type: 'general-purpose',
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build/' },
        error: 'exit 1',
      });

      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.reason).toBe('cancelled');
    });

    test('a non-matching subagent PostToolUseFailure leaves the parked permission open', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-799-failure-nomatch');

      await hookServer.firePermission({
        session_id: 'claude-799-failure-nomatch',
        agent_id: 'agent-799-6',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build/' },
      });

      hookServer.fire('PostToolUseFailure', {
        session_id: 'claude-799-failure-nomatch',
        agent_id: 'agent-799-6',
        agent_type: 'general-purpose',
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf dist/' }, // different command -> no signature match
        error: 'exit 1',
      });

      expect(broadcastResolvedLog).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // #889 (Q4): a classifier-denied permission fires no tool call, so
  // PreToolUse/PostToolUse never observe it -- PermissionDenied is wired into
  // the SAME `cancelExternallyResolved` funnel. Matching is
  // tool_name+tool_input+agentId; `PermissionDenied` also carries a
  // `tool_use_id`, but it is forward-compatible only.
  //
  // Deliberately NO test for exact-`tool_use_id` disambiguation through this
  // path, and that absence is the honest outcome rather than a gap: the
  // registered signature is built from the `PermissionRequest` that opened the
  // escalation, and that event never sends a `tool_use_id`, so
  // `findOpenQuestionMatching`'s "both sides carry one" branch cannot be
  // reached from here. Writing such a test would mean fabricating a
  // `PermissionRequest` with an id Claude Code does not send -- a test that
  // passes about an input shape that never occurs, which is exactly the
  // coverage claim ADR 0014 says not to make. The branch itself IS covered,
  // generically, by `auto-approve-gate.test.ts`. Reconsider when a capture
  // shows `PermissionRequest` carrying an id.
  // ---------------------------------------------------------------------------
  describe('#889 (Q4): PermissionDenied external resolution', () => {
    function lock(id: string): void {
      // #930: SessionStart is no longer a registered/dispatched hook
      // event (Claude Code discards http-type hooks for it). Notification
      // with a neutral type locks the binder via the same onHookEvent()
      // first-adopt path with zero downstream side effects (handleNotification
      // no-ops for anything outside permission_prompt/idle_prompt/
      // elicitation_dialog).
      hookServer.fire('Notification', {
        session_id: id,
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: '',
      });
    }

    test('a matching MAIN PermissionDenied resolves the open (parked/passthrough) escalation', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-889-denied-main');

      const decision = await hookServer.firePermission({
        session_id: 'claude-889-denied-main',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'curl evil.example' },
      });
      expect(decision).toBe('passthrough');
      expect(broadcastResolvedLog).toHaveLength(0); // still open

      hookServer.fire('PermissionDenied', {
        session_id: 'claude-889-denied-main',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'curl evil.example' },
        tool_use_id: 'tu-1',
        reason: 'blocked by classifier',
      });

      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.reason).toBe('cancelled');
    });

    test('a matching SUBAGENT PermissionDenied resolves the parked escalation, scoped to that agent', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      const { tracker } = build({
        broadcastResolvedLog,
      });
      lock('claude-889-denied-sub');

      await hookServer.firePermission({
        session_id: 'claude-889-denied-sub',
        agent_id: 'agent-889-1',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/x' },
      });
      expect(tracker.awaitingPTYCountForTest()).toBe(1);

      hookServer.fire('PermissionDenied', {
        session_id: 'claude-889-denied-sub',
        agent_id: 'agent-889-1',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/x' },
        tool_use_id: 'tu-2',
      });

      // Never rendered, so never pushed: nothing to dismiss (#1125), but the
      // gate no longer tracks it either.
      expect(broadcastResolvedLog).toHaveLength(0);
      expect(bridgeHandles.at(-1)?.gate.forceRelease('probe')).toEqual({ resolved: 0 });
    });

    test('with two escalations open on the SAME signature, PermissionDenied resolves only its own agent', async () => {
      // Review gap: dropping the `sig.agentId !== observed.agentId` check in
      // `findOpenQuestionMatching` left all 160 tests in the two files this PR
      // touches green. The shared matcher is covered in
      // `auto-approve-gate.test.ts`, but nothing proved the `agentId:
      // input.agent_id` passthrough on THIS wiring path actually scopes -- and
      // a PermissionDenied closing another agent's still-open question is the
      // swallow class #925 was. Same tool + same tool_input on purpose, so
      // agent identity is the ONLY thing that can disambiguate.
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-889-denied-2agents');

      await hookServer.firePermission({
        session_id: 'claude-889-denied-2agents',
        agent_id: 'agent-A',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });
      await hookServer.firePermission({
        session_id: 'claude-889-denied-2agents',
        agent_id: 'agent-B',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });
      expect(broadcastResolvedLog).toHaveLength(0);

      hookServer.fire('PermissionDenied', {
        session_id: 'claude-889-denied-2agents',
        agent_id: 'agent-A',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });

      // Exactly one resolution: agent-B's question must survive, because it is
      // still open and only the PTY can answer it.
      expect(broadcastResolvedLog).toHaveLength(1);

      // And agent-B's own denial still resolves it afterward -- proving the
      // survivor was genuinely still tracked, not silently dropped.
      hookServer.fire('PermissionDenied', {
        session_id: 'claude-889-denied-2agents',
        agent_id: 'agent-B',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });
      expect(broadcastResolvedLog).toHaveLength(2);
    });

    test('a non-matching PermissionDenied (different tool_input) leaves the open escalation untouched', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-889-denied-nomatch');

      await hookServer.firePermission({
        session_id: 'claude-889-denied-nomatch',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      hookServer.fire('PermissionDenied', {
        session_id: 'claude-889-denied-nomatch',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' }, // different command -> no signature match
      });

      expect(broadcastResolvedLog).toHaveLength(0);
    });

    test('PermissionDenied for a FOREIGN session_id is dropped by the admit gate (no cross-session resolution)', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, parkedRenders: true });
      lock('claude-889-denied-foreign');

      await hookServer.firePermission({
        session_id: 'claude-889-denied-foreign',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      hookServer.fire('PermissionDenied', {
        session_id: 'claude-OTHER',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      expect(broadcastResolvedLog).toHaveLength(0);
    });

    test('with NO open escalation at all, PermissionDenied is a clean no-op (never throws)', () => {
      build();
      lock('claude-889-denied-empty');

      expect(() =>
        hookServer.fire('PermissionDenied', {
          session_id: 'claude-889-denied-empty',
          hook_event_name: 'PermissionDenied',
          tool_name: 'Bash',
          tool_input: { command: 'echo hi' },
        }),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // #889 (Q4): an MCP Elicitation dialog previously arrived only as a PTY
  // orphan. These tests construct the REAL MessageAPI (ADR 0014: the push
  // path is directly involved -- the claim under test is "the card actually
  // reached the registry via the real dedup", not just "a stub was called").
  // ---------------------------------------------------------------------------
  describe('#889 (Q4): Elicitation / ElicitationResult (real MessageAPI, ADR 0014)', () => {
    function lock(id: string): void {
      // #930: SessionStart is no longer a registered/dispatched hook
      // event (Claude Code discards http-type hooks for it). Notification
      // with a neutral type locks the binder via the same onHookEvent()
      // first-adopt path with zero downstream side effects (handleNotification
      // no-ops for anything outside permission_prompt/idle_prompt/
      // elicitation_dialog).
      hookServer.fire('Notification', {
        session_id: id,
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: '',
      });
    }

    test('Elicitation builds a free-text card that reaches sessionRegistry through the real dedup', () => {
      build({ realMessageApi: true });
      lock('claude-889-elicit-1');

      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-1',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        elicitation_id: 'elicit-abc',
      });

      const questions = [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])];
      expect(questions).toHaveLength(1);
      expect(questions[0]?.text).toBe('weather-mcp: Which city?');
      expect(questions[0]?.source).toBe('elicitation');
      expect(questions[0]?.allowsFreeText).toBe(true);
      expect(questions[0]?.options).toEqual([]);
    });

    test('ElicitationResult resolves the exact card by elicitation_id', () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ realMessageApi: true, broadcastResolvedLog });
      lock('claude-889-elicit-2');

      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-2',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        elicitation_id: 'elicit-xyz',
      });
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);

      hookServer.fire('ElicitationResult', {
        session_id: 'claude-889-elicit-2',
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'weather-mcp',
        elicitation_id: 'elicit-xyz',
        action: 'accept',
      });

      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.reason).toBe('cancelled');
    });

    test('a re-fired Elicitation for the same id keeps the live card resolvable (review finding)', () => {
      // The dedup drops the second emission (same text, same 0 options, same
      // allowsFreeText -> never "richer", and status never left 'waiting' to
      // reset the baseline), so its returned id names a card that was never
      // registered. Blindly overwriting the correlation pointed
      // ElicitationResult at that phantom and orphaned card A -- the card the
      // user is actually looking at -- with no automated way to clear it.
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ realMessageApi: true, broadcastResolvedLog });
      lock('claude-889-elicit-dup');

      const fire = (): void => {
        hookServer.fire('Elicitation', {
          session_id: 'claude-889-elicit-dup',
          hook_event_name: 'Elicitation',
          mcp_server_name: 'weather-mcp',
          message: 'Which city?',
          elicitation_id: 'elicit-dup',
        });
      };
      fire();
      const cardA = [...(sessionRegistry.getSession(SID)?.currentQuestions.keys() ?? [])][0];
      expect(cardA).toBeDefined();

      fire();
      // The repeat never became a second card, so there is still exactly one.
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);

      hookServer.fire('ElicitationResult', {
        session_id: 'claude-889-elicit-dup',
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'weather-mcp',
        elicitation_id: 'elicit-dup',
        action: 'accept',
      });

      // The still-live card A is the one that resolves, not a phantom.
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.questionId).toBe(cardA as UUID);
    });

    test('a re-fired Elicitation with a CHANGED message (genuinely richer, not deduped) still keeps the OLDER live card resolvable', () => {
      // Isolates the "still live" guard (:479, `previousIsLive`) from the
      // "was not registered" guard (:496) above -- mutation testing this
      // suite found the test above passes even with `previousIsLive`
      // neutered, because a byte-identical re-fire is ALSO caught by the
      // "was not registered" guard alone (QuestionDedup suppresses an
      // unchanged re-emission regardless). That means the test above never
      // actually exercised this guard's own reason to exist. A DIFFERENT
      // message for the same elicitation_id has a DIFFERENT dedup
      // fingerprint, so QuestionDedup lets it through (registers, does not
      // dedupe) -- the only way to isolate `previousIsLive` from the dedup
      // guard it sits beside.
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ realMessageApi: true, broadcastResolvedLog });
      lock('claude-889-elicit-changed');

      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-changed',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        elicitation_id: 'elicit-changed',
      });
      const cardA = [...(sessionRegistry.getSession(SID)?.currentQuestions.keys() ?? [])][0];
      expect(cardA).toBeDefined();

      // Different message -> different fingerprint -> QuestionDedup does NOT
      // suppress this one; it registers as its own, genuinely separate card.
      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-changed',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city, and for what date?',
        elicitation_id: 'elicit-changed',
      });
      // Both cards are real, live questions in the registry -- rememberElicitation
      // only controls the elicitation_id CORRELATION, not whether MessageAPI
      // registered the second card.
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(2);

      hookServer.fire('ElicitationResult', {
        session_id: 'claude-889-elicit-changed',
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'weather-mcp',
        elicitation_id: 'elicit-changed',
        action: 'accept',
      });

      // The guard kept tracking card A (still live when the second fired),
      // so THIS is the one that resolves -- card B (registered but never
      // adopted into the correlation map) stays.
      expect(broadcastResolvedLog).toHaveLength(1);
      expect(broadcastResolvedLog[0]?.questionId).toBe(cardA as UUID);
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);
      expect(sessionRegistry.getQuestion(SID, cardA as UUID)).toBeNull();
    });

    test('ElicitationResult with an UNKNOWN elicitation_id is a no-op (card, if any, stays)', () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ realMessageApi: true, broadcastResolvedLog });
      lock('claude-889-elicit-3');

      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-3',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        elicitation_id: 'elicit-real',
      });

      hookServer.fire('ElicitationResult', {
        session_id: 'claude-889-elicit-3',
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'weather-mcp',
        elicitation_id: 'elicit-DOES-NOT-EXIST',
      });

      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1); // untouched
      expect(broadcastResolvedLog).toHaveLength(0);
    });

    test('an Elicitation with NO elicitation_id still creates a card, but is not resolvable by ElicitationResult', () => {
      build({ realMessageApi: true });
      lock('claude-889-elicit-4');

      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-4',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        // no elicitation_id
      });

      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);

      // A later ElicitationResult (even with a real id from some OTHER
      // dialog) cannot possibly correlate -- graceful degradation, same as
      // PermissionRequest's own missing tool_use_id.
      hookServer.fire('ElicitationResult', {
        session_id: 'claude-889-elicit-4',
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'weather-mcp',
        elicitation_id: 'some-other-id',
      });
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1); // still there
    });

    test('a NEW elicitation_id whose own card is deduped is never tracked (#888 criterion iii, "was not registered" guard)', () => {
      // Distinct from the re-fired-same-id test above: that one exercises
      // rememberElicitation's OTHER guard (a PREVIOUSLY tracked, still-live
      // card must not be displaced -- necessarily a store re-query, since it
      // asks about history). This test isolates the guard #888 criterion iii
      // actually changed: a FIRST-time elicitation_id whose OWN push never
      // registered (deduped against an unrelated still-live baseline) must
      // not be tracked either -- decided directly from handleElicitation's
      // returned QuestionRegistrationOutcome, not a SessionRegistry re-query.
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ realMessageApi: true, broadcastResolvedLog });
      lock('claude-889-elicit-notreg');

      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-notreg',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        elicitation_id: 'elicit-first',
      });
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1);

      // Same mcp_server_name/message -> identical text/options/allowsFreeText
      // fingerprint, same agent ('main'), still inside QuestionDedup's
      // window: this second card is DEDUPED (QuestionDedup makes no
      // exception for a different elicitation_id -- it only sees the
      // Question). handleElicitation still mints and returns a fresh
      // questionId regardless; that id must never reach elicitationQuestions.
      hookServer.fire('Elicitation', {
        session_id: 'claude-889-elicit-notreg',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        elicitation_id: 'elicit-second',
      });
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1); // no second card

      // The deciding assertion: resolving the NEVER-REGISTERED id must be a
      // no-op -- no broadcast for a card no client ever saw. Neutering the
      // guard (`if (outcome?.status !== 'registered')`) makes this fire a
      // phantom broadcast while every assertion above still passes.
      hookServer.fire('ElicitationResult', {
        session_id: 'claude-889-elicit-notreg',
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'weather-mcp',
        elicitation_id: 'elicit-second',
        action: 'accept',
      });
      expect(broadcastResolvedLog).toHaveLength(0);
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(1); // still there

      // The FIRST id, which DID register, remains resolvable -- proving the
      // guard is scoped correctly and not just refusing everything.
      hookServer.fire('ElicitationResult', {
        session_id: 'claude-889-elicit-notreg',
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'weather-mcp',
        elicitation_id: 'elicit-first',
        action: 'accept',
      });
      expect(broadcastResolvedLog).toHaveLength(1);
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
    });

    test('Elicitation for a FOREIGN session_id is dropped by the admit gate', () => {
      build({ realMessageApi: true });
      lock('claude-889-elicit-5');

      hookServer.fire('Elicitation', {
        session_id: 'claude-OTHER',
        hook_event_name: 'Elicitation',
        mcp_server_name: 'weather-mcp',
        message: 'Which city?',
        elicitation_id: 'elicit-foreign',
      });

      expect(sessionRegistry.getSession(SID)?.currentQuestions.size).toBe(0);
    });
  });

  describe('child-liveness + port-ownership rotation (#451)', () => {
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

    // #930: the sibling/zombie/port-marker ROTATION scenarios that used to
    // live in this describe block (fired two SessionStarts to simulate a
    // live-PTY restart) relied on the SessionStart hookServer listener
    // calling `binder.preemptOnSessionStart` before `binder.onHookEvent` --
    // the ONLY way this integration layer could flip `mainSessionEnded` on a
    // live PTY without an intervening SessionEnd. That listener is deleted
    // (Claude Code hard-discards http-type hooks for SessionStart, so it
    // never fired in production either -- see hook-types.ts's
    // REMI_REGISTERED_HOOK_EVENTS doc comment).
    //
    // Deleted rather than "covered elsewhere": the scenarios these tests
    // exercised hinged on `preemptOnSessionStart`'s sibling/ownership guard
    // (`!this.hasSiblingInDir() || this.ownsTranscript(event.transcript_path)`,
    // `transcript-binder.ts:480`) taking its `!hasSiblingInDir()` branch --
    // i.e. a rotation event arriving with an UNMARKED or foreign-port
    // transcript (`ownsTranscript()` false) while a sibling is present. That
    // branch is now unreachable through `preemptOnSessionStart`'s only
    // production caller: `feedSyntheticRotation`'s candidate loop
    // (`transcript-binder.ts:~1117`) already drops any candidate whose
    // `ownerPort !== currentPort()` BEFORE it ever calls
    // `preemptOnSessionStart`, so `ownsTranscript()` is guaranteed true by
    // the time it runs -- the `!hasSiblingInDir()` side of the OR never
    // gets to matter. The deleted tests were not testing dead-but-parallel
    // coverage; they were testing a guard configuration that can no longer
    // occur.
    //
    // This is NOT a matched set against `transcript-binder.test.ts`: that
    // file has exactly ONE `#451`-labeled test (`#451: restart with a live
    // sibling + unmarked transcript defers`, line 496) and ONE zombie test
    // (`a zombie sibling (claude child exited) does not by itself block
    // reclaim, but staleness does`, line 1702) -- and the zombie test's
    // single `admitted === false` assertion cannot on its own distinguish
    // "zombie correctly ignored, staleness alone blocks" from "zombie
    // incorrectly blocks" (its setup combines a zombie sibling AND a stale
    // transcript, per its own title). Cited as the one surviving analog, not
    // as a parallel set proving the deleted scenarios stayed covered.
    //
    // Only the ONE test below survives here: it locks via the store-adoption
    // path (`seedLock` + a single PreToolUse), which never depended on
    // SessionStart at all.
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

      hookServer.fire('Notification', {
        session_id: 'claude-twostep',
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, 'twostep.jsonl'),
        notification_type: 'auth_success',
        message: '',
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

  describe('#891: free-win hook field consumption', () => {
    /** Fire a neutral Notification so the bridge locks onto `id` (admit gate then passes; #930). */
    function lock(id: string): void {
      // #930: SessionStart is no longer a registered/dispatched hook
      // event (Claude Code discards http-type hooks for it). Notification
      // with a neutral type locks the binder via the same onHookEvent()
      // first-adopt path with zero downstream side effects (handleNotification
      // no-ops for anything outside permission_prompt/idle_prompt/
      // elicitation_dialog).
      hookServer.fire('Notification', {
        session_id: id,
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: '',
      });
    }

    test('SubagentStop threads agent_transcript_path through to the SubagentViewRegistry', () => {
      const subagentViews = new SubagentViewRegistry();
      build({ subagentViews });
      lock('claude-891-a');
      const mainTranscriptPath = path.join(tmpDir, 'claude-891-a.jsonl');
      hookServer.fire('SubagentStart', {
        session_id: 'claude-891-a',
        agent_id: 'sub-1',
        agent_type: 'code-architect',
        transcript_path: mainTranscriptPath,
      });
      // The derived path (from SubagentStart) is the pre-#891 baseline.
      const derived = subagentViews.resolvePath('sub-1');
      expect(derived).not.toBeNull();

      // SubagentStop now hands over the real path directly; it wins over the
      // START-time derivation even when the two differ (a real Claude Code
      // session never disagrees -- see subagent-view-registry.ts's #891 doc
      // comment for the verified-against-captures claim -- but the plumbing
      // must prefer the carried value regardless).
      const carried = path.join(tmpDir, 'claude-891-a', 'subagents', 'agent-sub-1-carried.jsonl');
      hookServer.fire('SubagentStop', {
        session_id: 'claude-891-a',
        agent_id: 'sub-1',
        agent_transcript_path: carried,
      });
      expect(subagentViews.resolvePath('sub-1')).toBe(carried);
      expect(subagentViews.resolvePath('sub-1')).not.toBe(derived);
      expect(subagentViews.list()[0]?.active).toBe(false);
    });

    test('SubagentStop with no agent_transcript_path keeps the derived path (fallback)', () => {
      const subagentViews = new SubagentViewRegistry();
      build({ subagentViews });
      lock('claude-891-b');
      const mainTranscriptPath = path.join(tmpDir, 'claude-891-b.jsonl');
      hookServer.fire('SubagentStart', {
        session_id: 'claude-891-b',
        agent_id: 'sub-1',
        agent_type: 'Explore',
        transcript_path: mainTranscriptPath,
      });
      const derived = subagentViews.resolvePath('sub-1');
      hookServer.fire('SubagentStop', {
        session_id: 'claude-891-b',
        agent_id: 'sub-1',
        // No agent_transcript_path (older Claude Code, or the field genuinely absent).
      });
      expect(subagentViews.resolvePath('sub-1')).toBe(derived);
    });

    test('Stop logs the truncated last_assistant_message (turn genuinely complete)', () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      build();
      lock('claude-891-stop');
      const longMessage = `Line one.\n\nLine two with lots of detail. ${'x'.repeat(300)}`;
      hookServer.fire('Stop', {
        session_id: 'claude-891-stop',
        hook_event_name: 'Stop',
        stop_hook_active: false,
        last_assistant_message: longMessage,
      });
      const turnCompleteLines = logs.filter((l) => l.includes('Turn complete'));
      expect(turnCompleteLines.length).toBe(1);
      // The log line is keyed by remi's daemon-side session id (SID), not the
      // raw Claude session_id from the hook payload -- same convention every
      // other [Hooks] log line in this file uses.
      expect(turnCompleteLines[0]).toContain(SID);
      // Truncated: the 300+ char filler must not appear in full, and whitespace
      // (including the embedded newlines) is collapsed to single spaces.
      expect(turnCompleteLines[0]?.includes('x'.repeat(300))).toBe(false);
      expect(turnCompleteLines[0]).not.toContain('\n');
      expect(turnCompleteLines[0]).toContain('Line one. Line two with lots of detail.');
    });

    test('Stop does NOT log when stop_hook_active is true (turn is not actually done)', () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      build();
      lock('claude-891-stop-active');
      hookServer.fire('Stop', {
        session_id: 'claude-891-stop-active',
        hook_event_name: 'Stop',
        stop_hook_active: true,
        last_assistant_message: 'should not be logged',
      });
      expect(logs.some((l) => l.includes('Turn complete'))).toBe(false);
    });

    test('Stop does NOT log when last_assistant_message is absent', () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      build();
      lock('claude-891-stop-nomsg');
      hookServer.fire('Stop', {
        session_id: 'claude-891-stop-nomsg',
        hook_event_name: 'Stop',
        stop_hook_active: false,
      });
      expect(logs.some((l) => l.includes('Turn complete'))).toBe(false);
    });

    test('PostToolUse logs a slow tool call (duration_ms at/above threshold)', () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      build();
      lock('claude-891-slow');
      hookServer.fire('PostToolUse', {
        session_id: 'claude-891-slow',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 10' },
        tool_response: {},
        duration_ms: 5_000,
      });
      const slowLines = logs.filter((l) => l.includes('Slow tool'));
      expect(slowLines.length).toBe(1);
      expect(slowLines[0]).toContain('Bash');
      expect(slowLines[0]).toContain('5000ms');
      expect(slowLines[0]).toContain(SID);
    });

    test('PostToolUse does NOT log a fast tool call (duration_ms below threshold)', () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      build();
      lock('claude-891-fast');
      hookServer.fire('PostToolUse', {
        session_id: 'claude-891-fast',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/x' },
        tool_response: {},
        duration_ms: 42,
      });
      expect(logs.some((l) => l.includes('Slow tool'))).toBe(false);
    });

    test('PostToolUse does NOT log when duration_ms is absent', () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      build();
      lock('claude-891-nodur');
      hookServer.fire('PostToolUse', {
        session_id: 'claude-891-nodur',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/x' },
        tool_response: {},
      });
      expect(logs.some((l) => l.includes('Slow tool'))).toBe(false);
    });

    test('a subagent-tagged slow PostToolUse still logs (logged before the subagent early-return)', () => {
      const logs: string[] = [];
      configureLogger({ writeLog: (msg) => logs.push(msg) });
      build();
      lock('claude-891-slow-sub');
      hookServer.fire('PostToolUse', {
        session_id: 'claude-891-slow-sub',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 10' },
        tool_response: {},
        duration_ms: 9_000,
        agent_id: 'sub-1',
      });
      const slowLines = logs.filter((l) => l.includes('Slow tool'));
      expect(slowLines.length).toBe(1);
      expect(slowLines[0]).toContain('9000ms');
    });
  });
  /**
   * #1140: the chat guard reads the tracker's observation of the menu on
   * screen, and the status pipeline used to clear it on ANY non-waiting status,
   * including a background subagent's or teammate's. Driven end to end: the
   * real bridge listeners (`setupHookBridge`), the real tracker, and the real
   * `createInputHandlers`, with the menu parsed from the live dialog bytes.
   *
   * Which agent-tagged events reach the status pipeline matters. The
   * Pre/PostToolUse/PostToolUseFailure listeners drop a subagent-tagged event
   * BEFORE any status handler (the #419 split policy), so those can never clear
   * the observation; the first test pins that. SubagentStart/SubagentStop (always
   * agent-tagged) and a teammate's Notification are forwarded to the status
   * handlers, and those are what the `agentId` threading protects.
   */
  describe('the observed menu survives a subagent and clears for the main agent (#1140)', () => {
    const CONN = 'conn-1140' as UUID;

    function lockSession(id: string): void {
      hookServer.fire('Notification', {
        session_id: id,
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        notification_type: 'auth_success',
        message: '',
      });
    }

    function menuObserved(tag: string) {
      const { tracker } = build({ realTracker: true });
      lockSession(tag);
      const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG);
      if (!parsed.question) throw new Error('the live dialog did not parse as a prompt');
      tracker.onPTYPromptVisible(parsed.question);
      expect(tracker.observedPromptOptions()?.map((o) => o.value)).toEqual(['1', '2', '3']);
      sessionRegistry.attachConnection(SID, CONN);
      const sent: ProtocolMessage[] = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send: (_c, m) => {
          sent.push(m);
          return true;
        },
        ...trackerScreenDeps(() => tracker),
      });
      /** Chat text sent now: true when it was typed, false when refused. */
      const chat = async (text: string): Promise<boolean> => {
        const before = ptySubmits.length;
        const errorsBefore = sent.filter((m) => m.type === 'error').length;
        await handlers.onUserInput(CONN, SID, text, false);
        const typed = ptySubmits.length > before;
        const refused = sent.filter((m) => m.type === 'error').length > errorsBefore;
        expect(typed).not.toBe(refused);
        return typed;
      };
      return { tracker, chat, sent };
    }

    const tool = (tag: string, event: 'PreToolUse' | 'PostToolUse', extra: object) =>
      hookServer.fire(event, {
        session_id: tag,
        hook_event_name: event,
        tool_name: 'Bash',
        tool_use_id: `tu-${event}`,
        tool_input: { command: 'ls' },
        tool_response: {},
        ...extra,
      });

    test('a subagent PreToolUse or PostToolUse never reaches the status pipeline: chat stays refused', async () => {
      const { chat } = menuObserved('claude-1140-tools');

      tool('claude-1140-tools', 'PreToolUse', { agent_id: 'sub-1', agent_type: 'general-purpose' });
      tool('claude-1140-tools', 'PostToolUse', {
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      });

      // No status change was made at all.
      expect(messageApiLog.statusCalls).toEqual([]);
      expect(await chat('while the subagent works')).toBe(false);
      expect(ptySubmits).toEqual([]);
    });

    test('SubagentStart and SubagentStop reach the status pipeline and leave the menu observed: chat stays refused', async () => {
      const { tracker, chat } = menuObserved('claude-1140-lifecycle');

      hookServer.fire('SubagentStart', {
        session_id: 'claude-1140-lifecycle',
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      });
      // The status pipeline did see it (the message API is not filtered) ...
      expect(messageApiLog.statusCalls).toEqual(['executing']);
      // ... but the main dialog is still on screen.
      expect(tracker.observedPromptOptions()).not.toBeNull();
      expect(await chat('after the subagent started')).toBe(false);

      hookServer.fire('SubagentStop', { session_id: 'claude-1140-lifecycle', agent_id: 'sub-1' });
      expect(messageApiLog.statusCalls).toEqual(['executing', 'thinking']);
      expect(await chat('after the subagent stopped')).toBe(false);
      expect(ptySubmits).toEqual([]);
    });

    test("a teammate's idle_prompt Notification leaves the menu observed: chat stays refused", async () => {
      const { chat } = menuObserved('claude-1140-teammate');

      hookServer.fire('Notification', {
        session_id: 'claude-1140-teammate',
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: '',
        agent_id: 'team-1',
        agent_type: 'general-purpose',
      });

      expect(messageApiLog.statusCalls).toEqual(['idle']);
      expect(await chat('while the teammate idles')).toBe(false);
    });

    test('a main-agent PreToolUse (no agent_id) clears the observation: the next chat text is typed', async () => {
      const { tracker, chat } = menuObserved('claude-1140-main');
      hookServer.fire('SubagentStart', {
        session_id: 'claude-1140-main',
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      });
      expect(await chat('still refused')).toBe(false);

      tool('claude-1140-main', 'PreToolUse', {});

      expect(messageApiLog.statusCalls).toEqual(['executing', 'executing']);
      expect(tracker.observedPromptOptions()).toBeNull();
      expect(await chat('typed now')).toBe(true);
      expect(ptySubmits).toEqual(['typed now']);
    });

    test('a main-agent idle_prompt Notification clears it too', async () => {
      const { chat } = menuObserved('claude-1140-main-idle');

      hookServer.fire('Notification', {
        session_id: 'claude-1140-main-idle',
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: '',
      });

      expect(await chat('typed after idle')).toBe(true);
    });
  });
});
