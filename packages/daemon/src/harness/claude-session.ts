/**
 * Claude Code's launch, behind the harness seam (epic #1161, phase 3 #1164).
 *
 * `createClaudeSession` is the middle of what `createNewSession` in `cli.ts`
 * used to do inline, moved here with its statements and their order intact:
 * the QuestionPresenceTracker, the OutputProcessor, the pre-spawn binding
 * (`resolveClaudeBinding` then `bindingStore.preAssign`), the hook bridge, and
 * the unstarted PTY. `cli.ts` keeps what is not Claude's: the message API, the
 * session registration, the `starting` status, `start()` with its
 * `markExited` on failure, and the child pid.
 *
 * Statement order is load-bearing and unchanged: `sessionNotifiers.set`
 * before the tracker, `sessionTrackers.set` before the hook bridge, and
 * `preAssign` before `setupHookBridge`.
 *
 * Three daemon-wide values change while the daemon runs, so they arrive as
 * getters and are read where the original read them, never captured:
 * `hookServer` (read at PTY-event time, and nulled by `cleanup`), `currentPort`
 * (`PORT` is reassigned by port probing) and `wsPort` (the `remi:<port>`
 * display name and the child's `REMI_PORT` are built at spawn time).
 */

import { errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';

import { hasLiveQuestionOnScreen } from '../api/live-questions.ts';
import { QuestionPresenceTracker } from '../api/question-presence-tracker.ts';
import type { SubagentViewRegistry } from '../api/subagent-view-registry.ts';
import { ALWAYS_ESCALATE_TOOLS } from '../auto-approve/index.ts';
import type { SubagentAlertSink } from '../auto-approve/index.ts';
import { resolveClaudeBinding } from '../cli/claude-binding.ts';
import { permissionHoldPolicy } from '../cli/hold-policy.ts';
import { log, logError } from '../cli/logger.ts';
import { setupHookBridge } from '../cli/session-phases/hook-bridge-setup.ts';
import type { SessionGateHandle } from '../cli/session-phases/hook-bridge-setup.ts';
import { createPtySessionForSession } from '../cli/session-phases/pty-session-setup.ts';
import type { PromptsConfig } from '../config/index.ts';
import type {
  ForeignSessionEscalator,
  HookInput,
  HookServer,
  PermissionDeniedHookInput,
  StopFailureHookInput,
} from '../hooks/index.ts';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher.ts';
import { OutputProcessor } from '../parser/output-processor.ts';
import type {
  SessionBindingStore,
  SessionRegistry,
  SessionRegistryFile,
  SessionStore,
} from '../session/index.ts';
import type { TranscriptDiscovery, TranscriptWatcher } from '../transcript/index.ts';
import type { HarnessLaunchContext, HarnessSession } from './types.ts';

/**
 * The daemon-wide services a Claude launch reads, passed once when `cli.ts`
 * builds the harness. The five `Map`s are the daemon's per-session registries
 * that the launch fills in (and `onSessionClosed` / `cleanup` drain); they are
 * passed whole because the statements that fill them moved here unchanged.
 */
export interface ClaudeLaunchDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  liveSessionsRegistry: SessionRegistryFile;
  transcriptDiscovery: TranscriptDiscovery;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  subagentViews: SubagentViewRegistry;
  foreignSessionEscalator: ForeignSessionEscalator;
  subagentAlerts: SubagentAlertSink;
  /** `question_resolved` to every client plus the APNS dismissal. */
  onQuestionResolved: (sessionId: UUID, questionId: UUID, reason: 'answered' | 'cancelled') => void;
  onHarnessDenied: (input: PermissionDeniedHookInput) => void;
  pushTurnFailed: (sessionId: UUID, input: StopFailureHookInput) => void;
  dismissTurnFailed: (sessionId: UUID) => void;
  /** `[prompts]` config, which picks the permission hold policy. */
  prompts: Pick<PromptsConfig, 'hold_seconds' | 'daemon_hold_seconds'>;
  /** The daemon's hook server, or null: read at launch and again at every PTY event. */
  hookServer: () => HookServer | null;
  /** The daemon's current listening port (`PORT`, reassigned by port probing). */
  currentPort: () => number;
  /** The WebSocket port, for the child's `remi:<port>` name and `REMI_PORT`. */
  wsPort: () => number;
  /** Process-level cleanup the PTY's exit handler runs. */
  cleanup: () => Promise<void>;
  /** Fed every chunk forwarded to the wrapper's local terminal (#932). */
  observeLocalPtyOutput: (data: Uint8Array) => void;
  sessionNotifiers: Map<UUID, NotificationDispatcher>;
  sessionGateHandles: Map<UUID, SessionGateHandle>;
  sessionTrackers: Map<UUID, QuestionPresenceTracker>;
  binderClosers: Map<UUID, () => void>;
  sessionAdmitsHandles: Map<UUID, (input: HookInput) => boolean>;
}

export function createClaudeSession(
  deps: ClaudeLaunchDeps,
  ctx: HarnessLaunchContext,
): HarnessSession {
  const {
    sessionRegistry,
    sessionStore,
    bindingStore,
    liveSessionsRegistry,
    transcriptDiscovery,
    transcriptWatchers,
    transcriptFallbackTimers,
    subagentViews,
    foreignSessionEscalator,
    subagentAlerts,
    onQuestionResolved,
    onHarnessDenied,
    pushTurnFailed,
    dismissTurnFailed,
    prompts,
    cleanup,
    observeLocalPtyOutput,
    sessionNotifiers,
    sessionGateHandles,
    sessionTrackers,
    binderClosers,
    sessionAdmitsHandles,
  } = deps;
  const {
    sessionId,
    workingDirectory,
    extraArgs,
    passThrough,
    reservedRows,
    messageApi,
    sendAndRecord,
    sendMessage,
    notifications,
  } = ctx;

  // Register this session's APNS dispatcher so the question-resolved path can
  // dismiss a pushed card through the same device-token fan-out (#585, P7).
  sessionNotifiers.set(sessionId, notifications);

  // PTY output parser: streamStatusOnly suppresses regular agent content (comes
  // from transcript). Tool-output errors (e.g. "OAuth token revoked") bypass the
  // guard so terminal-only failures still reach remote clients.

  // QuestionPresenceTracker pairs hook-derived metadata with PTY-derived
  // screen presence: hooks record (no push), PTY confirms (push). Status
  // transitions out of 'waiting' drop pending records so a prompt Claude
  // resolved on its own never pushes. `hasLiveQuestions` backs the #712 orphan-prompt
  // fallback: it is how the tracker tells a PTY echo of a gate-pushed
  // escalation (already registered here) apart from a genuine orphan.
  //
  // The push callback forwards `messageApi.handleQuestion`'s
  // `QuestionRegistrationOutcome` return straight through (#888 criterion
  // iii): the tracker's own confirmed-delivery gate (`pairAndPush`) now
  // consumes that value directly instead of a separate `isQuestionLive`
  // dep that re-queried `sessionRegistry.getQuestion` after the fact -- the
  // deleted dep used to live here.
  const tracker = new QuestionPresenceTracker((q, opts) => messageApi.handleQuestion(q, opts), {
    // #1126: a held subagent card does not count, its dialog is not on
    // screen (see live-questions.ts). The gate handle is registered after
    // the hook bridge is set up; read lazily, absent means nothing is held.
    hasLiveQuestions: () =>
      hasLiveQuestionOnScreen(
        sessionRegistry.getSession(sessionId)?.currentQuestions.values() ?? [],
        (questionId) => sessionGateHandles.get(sessionId)?.isHeld(questionId as UUID) ?? false,
      ),
    // #888/#920 hard requirement: a hook-less pending question (no
    // PermissionRequest/Notification ever fired for it) has no tool
    // signature for AutoApproveGate to resolve it by, so its PTY render
    // disappearing is its ONLY resolution evidence -- see the tracker's own
    // module doc. Remove it from the single pendingness owner (which
    // broadcasts question_snapshot via onQuestionsChanged, #798) and fire the
    // SAME question_resolved + APNS-dismiss path every other cancellation
    // route uses (`onQuestionResolved`, defined below in this file) so a
    // client sees the card clear immediately, not only on the next snapshot.
    onHooklessQuestionGone: (questionId, reason) => {
      sessionRegistry.removeQuestion(
        sessionId,
        questionId as UUID,
        reason,
        undefined,
        'QuestionPresenceTracker.onHooklessQuestionGone',
      );
      onQuestionResolved(sessionId, questionId as UUID, 'cancelled');
      // #1005 Change B: since this trigger now also fires for HOOK-BORN cards,
      // removing the card is no longer the whole job -- the gate still tracks
      // its signature (`openQuestionSignatures`). Retire it so a later matching
      // tool event does not resolve and dismiss the card a second time. A
      // no-op when the gate has nothing for this id.
      try {
        sessionGateHandles.get(sessionId)?.retireQuestion(questionId as UUID);
      } catch (err) {
        logError(
          `[QuestionPresenceTracker] gate cleanup for superseded ${questionId.slice(0, 8)} threw: ${errorToString(err)}`,
        );
      }
    },
  });
  // #920: register this session's tracker so the answer handler's
  // prompt-currency guard (input-events.ts) can reach it by sessionId.
  sessionTrackers.set(sessionId, tracker);

  const outputProcessor = new OutputProcessor(
    { sessionId, streamStatusOnly: true },
    {
      onMessage: (message) => {
        // Only fires for tool-output errors that bypass streamStatusOnly.
        messageApi.handleMessage(message);
      },
      onQuestion: (question) => {
        // #625 single gate: when a hook server is active the permission gate is
        // the primary authority for permission questions and drives their
        // pushes itself (held binary and multi-choice prompts at once via
        // onHeldEscalate, #1126). The PTY parser echoes EVERY on-screen prompt, so
        // routing those through unconditionally was the phantom-notification
        // source (>1,100 confirmed pushes, measured while auto-approve still
        // existed). But #624/#712 review found real prompts that reach ONLY
        // the PTY (Claude's native Agent-Teams permissions, a re-render after a
        // card was already dismissed; MCP
        // elicitation dialogs were a third until #889 registered the
        // `Elicitation` hook) — those were silently swallowed by the old
        // unconditional suppression. `onOrphanPTYPrompt` tells the two apart
        // structurally (pending hook record / live registered question means the
        // gate owns this cycle) and debounces the genuine orphans before pushing.
        if (deps.hookServer()) {
          tracker.onOrphanPTYPrompt(question);
          return;
        }
        tracker.onPTYPromptVisible(question);
      },
      onStatusChange: (status, context) => {
        if (!deps.hookServer()) {
          messageApi.handleStatusChange(status, context);
        }
        tracker.onStatusChange(status);
      },
    },
  );

  // Deterministic PTY -> transcript binding (#427). Resolve the
  // claudeSessionId Claude will write under BEFORE spawning, so sibling
  // daemons in the same cwd cannot race-claim each other's transcripts
  // through mtime-based discovery.
  const binding = resolveClaudeBinding(extraArgs, {
    displayName: `remi:${deps.wsPort()}`,
  });
  log(
    `[Binding] claude=${binding.claudeSessionId.slice(0, 8)} source=${binding.source} for remi=${sessionId.slice(0, 8)}`,
  );

  // Persist the binding before spawn so siblings observing the store
  // during the race window see our claim immediately.
  bindingStore.preAssign({
    remiSessionId: sessionId,
    claudeSessionId: binding.claudeSessionId,
    projectPath: workingDirectory,
    port: deps.currentPort(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });

  const launchHookServer = deps.hookServer();
  if (launchHookServer) {
    const holdPolicy = permissionHoldPolicy(passThrough, prompts);
    const hookBridgeHandle = setupHookBridge(
      {
        sessionRegistry,
        bindingStore,
        liveSessionsRegistry,
        transcriptWatchers,
        transcriptFallbackTimers,
        currentPort: deps.currentPort,
        transcriptDiscovery,
        subagentViews,
        foreignSessionEscalator,
        subagentAlerts,
        // Classify an escalation as binary vs design/plan-mode (#572/#573).
        alwaysEscalateTools: ALWAYS_ESCALATE_TOOLS,
        // #585: a held question the gate resolves without a user answer dismisses
        // its pushed card on every client.
        broadcastQuestionResolved: onQuestionResolved,
        // #1126: how long a binary prompt's hook waits for the phone, and
        // the registered hook timeout an abort is compared with; a wrapper
        // session hands an unanswered prompt to its terminal, a daemon or
        // hub session keeps it for the phone (see hold-policy.ts).
        holdMs: holdPolicy.holdMs,
        hookTimeoutMs: holdPolicy.hookTimeoutMs,
        pushTerminalNotice: (sid, question, reason) =>
          sessionNotifiers.get(sid)?.pushTerminalNotice(sid, question, reason),
        dismissTerminalNotice: (sid, questionId) =>
          sessionNotifiers.get(sid)?.dismissTerminalNotice(sid, questionId),
        onHarnessDenied,
        // #1153: a turn that ended on an API error is one `turn_failed` push
        // per session through the session's dispatcher, never a card; a later
        // main Stop or UserPromptSubmit clears it (`turn-failed.ts`).
        pushTurnFailed,
        dismissTurnFailed,
      },
      {
        hookServer: launchHookServer,
        sessionId,
        workingDirectory,
        messageApi,
        sendAndRecord,
        tracker,
        // #1126: a wrapper session has a local terminal, so a subagent's
        // prompt is passed to it; a daemon-mode session holds it instead.
        hasLocalTerminal: holdPolicy.hasLocalTerminal,
      },
    );
    // The binder owns the fallback poll + #452 dir-watch (armed by its start()
    // inside setupHookBridge); record its teardown so cleanup() reaches the
    // rotation dir-poll interval the shared maps below cannot.
    binderClosers.set(sessionId, hookBridgeHandle.closeBinder);
    // Register the per-session gate handle (#573) so the answer path and
    // `remi unstick` reach this exact session's gate.
    sessionGateHandles.set(sessionId, hookBridgeHandle.gate);
    // #914: lets the out-of-bridge turn-complete listener apply the same
    // session filter every in-bridge listener already uses.
    sessionAdmitsHandles.set(sessionId, hookBridgeHandle.admits);
  }

  const ptySession = createPtySessionForSession(
    {
      sessionRegistry,
      sessionStore,
      liveSessionsRegistry,
      outputProcessor,
      wsPort: deps.wsPort(),
      sendMessage,
      cleanup,
      // #932 durable fix: feed the wrapper's quiescence + clean-boundary
      // gate with every chunk actually forwarded to the local terminal, and
      // -- when the chunk completes a bare ESC[r (DECSTBM full-screen
      // reset) -- ask the bar to repaint immediately instead of leaving row
      // N unprotected until the next tick or the heartbeat.
      observeLocalPtyOutput,
    },
    { sessionId, workingDirectory, extraArgs: binding.args, passThrough, reservedRows },
  );

  return { pty: ptySession, start: () => ptySession.start() };
}
