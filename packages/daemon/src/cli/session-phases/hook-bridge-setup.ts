/**
 * Wire the Claude Code hook event stream into our PTY's MessageAPI during
 * createNewSession.
 *
 * Two concerns live here, both depending on the same `TranscriptBinder`
 * (session binding/watcher/rotation control plane, `src/transcript/transcript-binder.ts`):
 *
 *   1. **Session filtering.** Claude Code fires hook events that may belong
 *      to our PTY, a subagent inside it, or a sibling daemon's PTY in the
 *      same project directory. Without filtering, subagent/sibling events
 *      would hijack status/questions/transcript watching. `binder.admits()`
 *      is the single filter every listener consults.
 *   2. **Transcript discovery via hooks.** Most events carry
 *      `transcript_path`; the binder starts the watcher on it, self-heals a
 *      timed-out fallback poll, and announces a rotation (/clear or /resume
 *      — NOT /compact, which keeps the same session id) as a single atomic
 *      `session_rotated` event.
 *
 * A third concern, the **auto-approve gate**, used to be inlined here; it is now
 * delegated to `AutoApproveGate` (#453 phase 1). The bridge does the session
 * filtering, then routes PermissionRequest to the gate, which runs the
 * auto-approve eval and injects "1"/"3"/pick into the PTY, escalates to the user,
 * or default-denies a subagent prompt no one can answer. The gate is wired with
 * the bridge's `isInSubagentContext` + the router's `onPermissionRequest` as
 * callbacks; Stop/SessionEnd call `gate.cancelStale()` to abort an in-flight eval
 * when the Claude session actually ends. (Pre/PostToolUse deliberately do NOT
 * cancel — under synchronous decisions the eval is never stale; see #537.) Stop
 * passes `{ mainOnly: true }` (#711): it fires whenever the LEAD idles even
 * while agent-team teammates keep working, so it releases/cancels only
 * MAIN-context holds and evals, sparing a teammate's still-open escalation.
 * SessionEnd is real teardown and stays unscoped (releases/cancels everything).
 *
 * This listener block IS the per-session hook router (admit-then-fan-out); a
 * formal HookRouter class is deferred to a later refactor (#470). The function
 * registers 11 hookServer listeners — the original 7 (SessionStart, PreToolUse,
 * PostToolUse, Notification, PermissionRequest, Stop, SessionEnd) plus the 4
 * wired in phase 4 (StopFailure, PostToolUseFailure, SubagentStart, SubagentStop)
 * — and returns void. It runs once per session at createNewSession time, only
 * when a hookServer is configured.
 *
 * The inline session-binding path this file used to also carry (pre-#453) and
 * the shadow-mode differential wiring (#453 phase 3, commit 3) were deleted in
 * #470 once the TranscriptBinder soaked as the unconditional driver (#503).
 */

import { createSessionUpdate, createSessionViews, errorToString } from '@remi/shared';
import type { AgentStatus, ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../../api/message-api.ts';
import type { QuestionPresenceTracker } from '../../api/question-presence-tracker.ts';
import type { SubagentViewRegistry } from '../../api/subagent-view-registry.ts';
import { AutoApproveGate } from '../../auto-approve/index.ts';
import type { AutoApproveService } from '../../auto-approve/index.ts';
import { HookEventBridge } from '../../hooks/index.ts';
import type { ForeignSessionEscalator, HookServer } from '../../hooks/index.ts';
import type { DeliveryOutcome } from '../../notifications/notification-dispatcher.ts';
import type {
  SessionBindingStore,
  SessionRegistry,
  SessionRegistryFile,
} from '../../session/index.ts';
import { TranscriptBinder } from '../../transcript/index.ts';
import type { TranscriptWatcher } from '../../transcript/index.ts';
import type { TranscriptDiscovery } from '../../transcript/transcript-discovery.ts';
import { log, logError } from '../logger.ts';
import type { StatusWriter } from '../status-writer.ts';

export interface HookBridgeDeps {
  sessionRegistry: SessionRegistry;
  bindingStore: SessionBindingStore;
  liveSessionsRegistry: SessionRegistryFile;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  autoApproveService: AutoApproveService | null;
  /** PORT is reassigned during daemon-mode port probing; read lazily. */
  currentPort: () => number;
  /**
   * The `TranscriptBinder` OWNS the binding/watcher/rotation control plane
   * unconditionally (#453 phase 3, #503, #470): each hook listener routes to
   * `binder.onHookEvent` / `binder.admits` / `binder.preemptOnSessionStart` /
   * `binder.onSessionEnd`, and `binder.start()` arms the fallback poll + #452
   * dir-watch. Required so `start()` has a `TranscriptDiscovery` to read.
   */
  transcriptDiscovery: TranscriptDiscovery;
  /**
   * Tracks the subagent conversations this session spawns (epic #499 phase 3).
   * Populated from SubagentStart/Stop; a `session_views` push tells the client
   * which subagent chats it can switch to. Optional so tests/old callers are
   * unaffected.
   */
  subagentViews?: SubagentViewRegistry;
  /**
   * Process-wide terminal cue (#513): animates the wrapper terminal title and
   * fires a desktop notification across the auto-approve lifecycle. Shared by
   * all sessions (one terminal). Optional; inert when absent or headless.
   */
  statusWriter?: StatusWriter | undefined;
  /**
   * Tools that always escalate to the user (#572). Passed to the gate so it
   * classifies an escalation as binary (holdable, #573) vs design/plan-mode
   * (passthrough). From `config.auto_approve.always_escalate_tools`. Absent =>
   * empty set (tests / no-AA callers).
   */
  alwaysEscalateTools?: ReadonlySet<string>;
  /**
   * Seconds to HOLD a binary main-context PermissionRequest hook open until the
   * user answers (Model B, #573). From `config.auto_approve.hold_timeout`. 0 /
   * absent => no holding (escalate -> passthrough as before).
   */
  holdTimeoutSec?: number;
  /**
   * Seconds before a slow binary main-context eval triggers an early push + hold
   * (Part B, #573). From `config.auto_approve.push_hold_timeout`. 0 / absent =>
   * Part B disabled (the eval/timer race never arms).
   */
  pushHoldTimeoutSec?: number;
  /**
   * Probe a held escalation's notification delivery outcome (epic #603 Phase 1).
   * Wired from this session's `NotificationDispatcher.awaitDelivery`. Lets the
   * gate fail a hold open fast when no notification reached the user instead of
   * blocking for the full hold_timeout. Absent => delivery gating disabled.
   */
  awaitDelivery?: (questionId: UUID) => Promise<DeliveryOutcome> | undefined;
  /**
   * Hold-timeout handoff notice (#733). Wired from this session's
   * `NotificationDispatcher.pushHoldTimeoutHandoff`: when a held escalation
   * expires unanswered and moves to the native terminal prompt, tell the phone
   * so the timeout is not silent. Absent => no handoff push (tests).
   */
  onHoldTimeout?: (questionId: UUID) => void;
  /**
   * Seconds to wait for a held escalation's delivery to be confirmed before
   * treating it as undeliverable (epic #603 Phase 1). From
   * `config.auto_approve.delivery_confirm_timeout`. 0 / absent => no gating.
   */
  deliveryConfirmSec?: number;
  /**
   * Seconds to keep holding an UNDELIVERED escalation instead of failing open
   * immediately (epic #603 Phase 1, D2 hold-always-no-phone). From
   * `config.auto_approve.hold_unconfirmed_timeout`. 0 / absent => fail open fast.
   */
  holdUnconfirmedSec?: number;
  /**
   * Cross-client question dismissal (#585, P7). Called by the gate when a HELD
   * question resolves WITHOUT a user answer (Part-B late verdict, hold timeout,
   * or cancelStale): the daemon broadcasts `question_resolved` to every client and
   * fires the APNS dismissal so the pushed card clears everywhere. Must be
   * throw-safe (the gate also guards the call). Absent => no dismissal broadcast.
   */
  broadcastQuestionResolved?: (
    sessionId: UUID,
    questionId: UUID,
    reason: 'auto_approved' | 'auto_denied' | 'cancelled',
  ) => void;
  /**
   * Fail-safe fallback for a PermissionRequest that `binder.admits()` rejects
   * (#672): decides whether a live sibling daemon owns the foreign session
   * (stay silent) or it is genuinely unclaimed (fire a rate-limited,
   * informational-only push — never an answerable Question, since an answer
   * cannot be injected into a PTY we do not own). Shared across every session
   * on this daemon so its rate-limit state is daemon-wide, not per-session.
   * Absent => legacy debug-log-only passthrough (tests / callers that build
   * their own bridge without daemon-wide escalation wiring).
   */
  foreignSessionEscalator?: ForeignSessionEscalator;
}

export interface HookBridgeArgs {
  /** Required; caller must verify non-null before invoking. */
  hookServer: HookServer;
  sessionId: UUID;
  workingDirectory: string;
  messageApi: MessageAPI;
  sendAndRecord: (message: ProtocolMessage) => void;
  /** Pairs hook metadata with PTY screen presence: hook events stash the
   *  question via recordPendingHook (no push), the PTY parser fires the
   *  push on confirmation, and status transitions out of 'waiting' drop
   *  stale pending records. Required when wired into the createNewSession
   *  flow; tests construct their own per-bridge tracker. */
  tracker: QuestionPresenceTracker;
}

/**
 * Per-session control surface for the auto-approve gate (#573). Registered by
 * cli.ts keyed by `sessionId` so the WebSocket answer handler reaches the RIGHT
 * session's gate when the user answers a held permission.
 */
export interface SessionGateHandle {
  /**
   * Resolve a held binary PermissionRequest hook with the user's answer (Model
   * B). Returns true when a hold for `questionId` existed and was resolved (the
   * caller then SKIPS the PTY inject — Claude is blocked on the hook, not
   * rendering); false when no hold exists (the answer takes the PTY path, e.g. a
   * multi-choice pick or a non-AA session).
   *
   * `suggestionIndex` (#718): present when the answered option was derived
   * from a structured `permission_suggestions` entry ("Yes, always allow:
   * ..."); forwarded to `AutoApproveGate.resolveHeld` so the hook resolves
   * with the real `updatedPermissions` echo instead of a bare `allow`.
   */
  resolveHeld: (questionId: UUID, decision: 'allow' | 'deny', suggestionIndex?: number) => boolean;
  /**
   * Release a held hook to 'passthrough' so Claude renders its native numbered
   * prompt (#573), for answers the binary hook response cannot express ("Yes,
   * always", a multi-choice pick). Returns true iff a hold existed; the caller
   * then injects the digit into the rendered prompt.
   */
  releaseHeldAsPassthrough: (questionId: UUID) => boolean;
  /** Cancel any in-flight eval AND release pending holds for this session (the
   *  user answered / advanced). Forwards to the gate's `cancelStale`. */
  cancelStale: (reason: string) => void;
  /** Cancel ONLY the eval for the question the user just answered, freeing the
   *  GPU without touching other holds (#617). Forwards to `cancelEvalForQuestion`. */
  cancelEvalForQuestion: (questionId: UUID, reason: string) => void;
  /** Force-release escape (#617 `remi unstick`): release all holds to passthrough,
   *  abort the in-flight eval, drain the queue. Forwards to `forceRelease`. */
  forceRelease: (reason: string) => { holds: number; cancelled: boolean; drained: number };
}

export interface HookBridgeHandle {
  /** Live bridge instance. Callers can read `isInSubagentContext()` to gate
   *  alternate question sources (e.g. PTY parser) so subagent prompts are
   *  not surfaced to the user. */
  bridge: HookEventBridge;
  /**
   * Tear down the `TranscriptBinder` for this session (its watcher, fallback
   * timer, and the #452 rotation dir-poll). The caller must invoke this on
   * session teardown so the binder's rotation dir-poll interval — which the
   * shared `transcriptWatchers` / `transcriptFallbackTimers` cleanup in cli.ts
   * does NOT reach — never outlives the session.
   */
  closeBinder: () => void;
  /**
   * Per-session auto-approve gate handle (#573): `resolveHeld` + `cancelStale`,
   * so the WebSocket answer path can resolve a held hook / cancel the eval for
   * this exact session. Always present (the gate is constructed unconditionally).
   */
  gate: SessionGateHandle;
}

export function setupHookBridge(
  deps: Readonly<HookBridgeDeps>,
  args: Readonly<HookBridgeArgs>,
): HookBridgeHandle {
  const {
    sessionRegistry,
    bindingStore,
    liveSessionsRegistry,
    transcriptWatchers,
    transcriptFallbackTimers,
    autoApproveService,
    currentPort,
    transcriptDiscovery,
    subagentViews,
  } = deps;
  const { hookServer, sessionId, workingDirectory, messageApi, sendAndRecord, tracker } = args;

  // Push the session's subagent views to clients (epic #499 phase 3). Declared
  // here (before the binder/handlers reference it) so there is no fragile
  // forward-reference. The SessionViewMeta omits the on-disk path: the client
  // echoes agentId back and the daemon resolves the path via the registry.
  const pushSubagentViews = (): void => {
    if (!subagentViews) return;
    sendAndRecord(
      createSessionViews(
        sessionId,
        subagentViews.list().map((v) => ({
          agentId: v.agentId,
          agentType: v.agentType,
          active: v.active,
        })),
      ),
    );
  };

  /**
   * Dismiss every pending question for this session on a Claude restart
   * (/clear, /compact, /resume), THEN clear the registry collection (#585, P7).
   * A card pushed before the restart would otherwise linger on every device
   * forever — the most common dismissal case. Broadcasts
   * `question_resolved(..., 'cancelled')` for each pending id so all clients drop
   * the card and the lock-screen push is dismissed, mirroring the gate's own
   * held-resolution dismissal. Throw-safe: a broadcast failure for one question
   * must never block clearing the rest, and the clear always runs.
   */
  const resolveAndClearQuestions = (): void => {
    const broadcast = deps.broadcastQuestionResolved;
    if (broadcast) {
      const pendingIds = [
        ...(sessionRegistry.getSession(sessionId)?.currentQuestions.keys() ?? []),
      ];
      for (const questionId of pendingIds) {
        try {
          broadcast(sessionId, questionId, 'cancelled');
        } catch (err) {
          logError(
            `[Hooks] question_resolved broadcast (restart) failed for ${questionId}: ${errorToString(err)}`,
          );
        }
      }
    }
    sessionRegistry.clearQuestions(sessionId);
  };

  // ---- Bridge + hook handler registration ---------------------------------

  const hookBridge = new HookEventBridge(sessionId, {
    onStatusChange: (status: AgentStatus, context?: string) => {
      messageApi.handleStatusChange(status, context);
      tracker.onStatusChange(status);
    },
    onQuestion: (question) => {
      // #625 single gate: a PERMISSION question is coordinated by the auto-approve
      // gate — it is stashed here and the gate drives its push on escalate (binary
      // via onHeldEscalate, passthrough via escalatePassthrough). recordPendingHook
      // only stashes; it never emits on its own.
      //   - 'permission_request' (rich: tool + command + options) is the one the gate
      //     escalates and pushes by id.
      //   - 'notification' is Claude's redundant generic "needs your permission"
      //     prompt; it is INTENTIONALLY stashed-and-suppressed (NOT routed to the
      //     direct-emit path), because direct-emitting it would push for EVERY
      //     permission — including auto-approved ones — which is exactly the phantom
      //     #625 removes. It is bounded (one per agent) and cleared on status-leaves-
      //     waiting. (Assumes Claude pairs it with a PermissionRequest, true today.)
      // A STANDALONE hook question that no gate pushes (e.g. a Stop-failure "Retry?",
      // source-less) is emitted directly to the client + lock screen, since the
      // PTY-render push that used to deliver it is suppressed for hooked sessions.
      if (question.source === 'permission_request' || question.source === 'notification') {
        tracker.recordPendingHook(question);
      } else {
        messageApi.handleQuestion(question);
      }
    },
    // The binder's onHookEvent (fired from the SessionStart listener) already
    // subsumes the bind/rotation this callback used to perform inline (#470).
    // The bridge still fires it (status/subagent tracking lives on
    // handlers.onSessionStart), but the binding control plane is the binder's
    // alone, so there is nothing left to do here.
    onSessionInfo: () => {},
  });

  const handlers = hookBridge.hookHandlers();

  // #576: push an auto-approve lifecycle status to clients so the pill reflects
  // `evaluating` -> `approved` promptly, instead of waiting for the next hook.
  //
  // CRITICAL: the gate invokes the cue callbacks below through its `safeCue`
  // wrapper (cosmetic; a throw there is logged and absorbed so it can never
  // re-enter the decision/buffer path). This helper adds its OWN try/catch so a
  // broadcast send error can never propagate into the gate even if the call site
  // changes. It emits a client-only `session_update` and deliberately does NOT
  // touch the StatusWriter `sessionStatus` (the wrapper bar + native statusline
  // already cue the AA state from the `autoApprove` sub-field) nor the existing
  // hook-driven onStatusChange path, so it neither double-emits nor fights the
  // real PreToolUse/PermissionRequest status that follows.
  const broadcastAutoApproveStatus = (status: AgentStatus): void => {
    try {
      sendAndRecord(createSessionUpdate(sessionId, status));
    } catch (err) {
      logError(
        `[Hooks] auto-approve status broadcast failed for ${sessionId}: ${errorToString(err)}`,
      );
    }
  };

  // Auto-approve control plane (#453 phase 1): owns the PermissionRequest eval +
  // inject + escalate + cancelStale. Constructed after the bridge + handlers so it
  // can wrap the two outward couplings (isInSubagentContext, onPermissionRequest) as
  // injected callbacks, read live at inject time (async TOCTOU).
  const autoApproveGate = new AutoApproveGate(
    {
      service: autoApproveService,
      sessionRegistry,
      tracker,
      isInSubagentContext: () => hookBridge.isInSubagentContext(),
      // #710: lets the gate recover from a tracker leak (a MAIN-tagged
      // PermissionRequest observing isInSubagentContext() stuck true) instead
      // of denying the main agent forever.
      resetSubagentContext: () => hookBridge.resetSubagentContext(),
      // Call the bridge DIRECTLY (not via the void-typed handlers map) so the
      // created Question.id flows back to the gate; a binary escalation holds
      // the hook keyed by it (#573). The bridge still does the onQuestion +
      // status side effects exactly as before.
      escalate: (i, summary) => hookBridge.handlePermissionRequest(i, summary),
      // #751 PTY-arbiter: a subagent-tagged escalation the gate cannot decide
      // parks its rich question (same builder as a real escalation, minus the
      // push/registration side effects) and answers 'passthrough'; the tracker
      // pushes it only if Claude's native prompt actually renders on the PTY.
      parkForPTY: (i, summary) =>
        tracker.parkAwaitingPTY(hookBridge.buildPermissionQuestion(i, summary)),
      // #484: buffer the PTY prompt while the eval runs; release it only on an
      // escalate verdict, so silently auto-approved permissions never push APNS.
      // #560: the same lifecycle drives the auto-approve cue in Claude's native
      // status line via the StatusWriter. A COUNT (start/end) replaces the old
      // shared title spinner, which raced under concurrent evals.
      onEvalStart: (ctx) => {
        tracker.onAutoApproveStart();
        deps.statusWriter?.autoApproveStart(Date.now());
        // #576: surface the in-flight eval on the client pill ('working').
        // #711: skip the CLIENT broadcast for a subagent/team-member eval --
        // the user never saw it asked, so flashing the pill to 'evaluating'
        // for it reads as a phantom auto-approval. The tracker buffer + the
        // StatusWriter terminal cue above still fire unconditionally.
        if (!ctx.isSubagent) broadcastAutoApproveStatus('evaluating');
      },
      onEscalate: () => {
        tracker.onAutoApproveEscalate();
        deps.statusWriter?.autoApproveEnd('escalated', Date.now());
        // No status broadcast here: a MAIN escalate routes through
        // handlePermissionRequest -> onStatusChange('waiting'), which broadcasts
        // the 'waiting' session_update; re-emitting would double-emit. A PARKED
        // subagent escalation (#751) bypasses handlePermissionRequest, so no
        // 'waiting' fires here either — deliberately: the prompt may never
        // render (allowlist absorption). When it does render, the PTY parser
        // flips the status, and the web pill prioritizes the pushed question
        // over raw status anyway (#763 finding 3).
      },
      // #573: a binary escalation that HOLDS its hook blocks Claude's response,
      // so Claude never renders the native prompt and the tracker's PTY-render
      // push trigger (onPTYPromptVisible) never fires. Without this, the held
      // question is stashed via recordPendingHook but never registered in
      // sessionRegistry nor pushed -> the user cannot answer it and the hold sits
      // until hold_timeout. The gate calls this ONLY in the held branch with the
      // held Question.id, so the tracker pushes that exact question immediately
      // (-> addQuestion + maybePush) under the id the hold is keyed by.
      onHeldEscalate: (questionId) => tracker.pushHeldHook(questionId),
      onHandled: (ctx) => {
        deps.statusWriter?.autoApproveEnd('approved', Date.now());
        // #576: the permission was silently allowed; tell clients so the pill
        // doesn't sit stale on 'evaluating' until the next hook fires.
        // #711: same subagent skip as onEvalStart above -- see that comment.
        if (!ctx.isSubagent) broadcastAutoApproveStatus('approved');
      },
      onCancelled: () => deps.statusWriter?.autoApproveEnd('cancelled', Date.now()),
      // #585: a held question that resolves without a user answer (Part-B late
      // verdict / hold timeout / cancelStale) tells the daemon to dismiss the
      // pushed card on every client. Forwarded with this session's id.
      onResolved: (questionId, reason) =>
        deps.broadcastQuestionResolved?.(sessionId, questionId, reason),
      // #522: second-opinion model on a primary escalate (read from the service's
      // config). Empty when unset -> escalate straight to the user.
      escalateModel: autoApproveService?.escalateModel ?? '',
      // #573: classify an escalation as binary (holdable) vs design/multi-choice
      // (passthrough) the same way the service does; hold binary main-context
      // hooks open until the user answers (holdMs) and optionally push early on a
      // slow eval (pushHoldMs). Seconds -> ms; 0 disables (gate treats <=0 as off).
      alwaysEscalateTools: deps.alwaysEscalateTools ?? new Set<string>(),
      holdMs: (deps.holdTimeoutSec ?? 0) * 1000,
      pushHoldMs: (deps.pushHoldTimeoutSec ?? 0) * 1000,
      // #603 Phase 1: gate a held hook on confirmed notification delivery, so a
      // dead push channel fails open fast instead of stalling for holdMs.
      ...(deps.awaitDelivery ? { awaitDelivery: deps.awaitDelivery } : {}),
      // #733: hold-timeout handoff notice — the phone learns the prompt moved
      // to the terminal instead of the card just silently vanishing.
      ...(deps.onHoldTimeout ? { onHoldTimeout: deps.onHoldTimeout } : {}),
      deliveryConfirmMs: (deps.deliveryConfirmSec ?? 0) * 1000,
      holdUnconfirmedMs: (deps.holdUnconfirmedSec ?? 0) * 1000,
    },
    sessionId,
  );

  // Subagent/team-member events carry `agent_id` (confirmed via
  // REMI_HOOK_DEBUG capture 2026-04-16). They share main's session_id and
  // transcript, so session-id filtering cannot distinguish them.
  //
  // Split policy:
  //   - `PreToolUse` / `PostToolUse` / `SessionStart`: dropped here so
  //     status updates and Task-tool tracking stay scoped to the main
  //     interactive session.
  //   - `PermissionRequest` / `Notification(permission_prompt)`: forwarded
  //     (phase 4, #419). Push is gated by PTY presence in the tracker,
  //     not by agent_id. A hot-switched subagent view that renders a
  //     permission prompt IS user-answerable; dropping the hook loses
  //     the rich tool/option metadata for that case.
  const isSubagentEvent = (input: { agent_id?: string }): boolean =>
    typeof input.agent_id === 'string' && input.agent_id.length > 0;

  // ---- TranscriptBinder (#453 phase 3, commit 5; unconditional since #503) --
  //
  // ONE binder per session. It OWNS the binding/watcher/rotation control plane:
  // every hook listener below routes to its `onHookEvent` / `admits` /
  // `preemptOnSessionStart` / `onSessionEnd`. Wired with the real effect deps
  // (this session's `sendAndRecord`, `bindingStore`, `messageApi`) and the real
  // rotation side effect (clear the presence tracker's pending record +
  // sessionRegistry questions, mirroring the pre-#453 restart branch's
  // `tracker.clearPending(); sessionRegistry.clearQuestions(sessionId)`).
  //
  // `start()` arms BOTH the fallback poll (Case A: our pre-assigned file
  // appears) AND the #452 re-arming dir-watch (Case B: a no-hooks rotation), so
  // cli.ts does NOT also call `startTranscriptFallback` (that would double-arm
  // the same fallback timer). The pre-assigned claudeSessionId is the binding
  // cli.ts wrote to the store before spawn (#427); read it here.
  const binder = new TranscriptBinder(
    {
      sessionRegistry,
      bindingStore,
      liveSessionsRegistry,
      transcriptWatchers,
      transcriptFallbackTimers,
      transcriptDiscovery,
      messageApi,
      sendAndRecord,
      currentPort,
      onRotation: () => {
        // The pre-#453 restart branch's injected side effects: drop any hook
        // record stashed before the rotation so the new session's first PTY
        // prompt cannot merge stale option labels, and dismiss + drop the
        // pending-question collection (cards clear on every device, #585) so
        // stale answers are refused.
        tracker.clearPending();
        resolveAndClearQuestions();
        // The new session starts with no subagents (#499 phase 3).
        if (subagentViews) {
          subagentViews.clear();
          pushSubagentViews();
        }
      },
    },
    { sessionId, workingDirectory },
    'drive',
  );

  // Arm the fallback poll + #452 dir-watch on the pre-assigned id (the binding
  // cli.ts wrote to the store before Bun.spawn). On a fresh store read this is
  // the deterministic claude id Claude will write under. Wrapped so an EMFILE /
  // permissions flake on the store's backing file (SessionStore.read) cannot
  // escape setup and crash createNewSession — the binder's own per-event reads
  // guard the same way (TranscriptBinder.adoptLockFromStore).
  const preAssignedClaudeId = (() => {
    try {
      return bindingStore.get(sessionId)?.claudeSessionId ?? null;
    } catch (err) {
      logError(
        `[Binder] Failed to read pre-assigned claudeSessionId for ${sessionId.slice(0, 8)}: ${errorToString(err)}`,
      );
      return null;
    }
  })();
  if (preAssignedClaudeId) {
    binder.start(preAssignedClaudeId);
  } else {
    logError(
      `[Binder] No pre-assigned claudeSessionId for ${sessionId.slice(0, 8)}; fallback poll + dir-watch not armed`,
    );
  }

  hookServer.on('SessionStart', (input) => {
    // The binder owns the pre-empt + bind. Pre-empt (flip its own
    // mainSessionEnded) BEFORE onHookEvent, mirroring the pre-#453 order.
    binder.preemptOnSessionStart(input);
    binder.onHookEvent(input);
    handlers.onSessionStart?.(input);
  });

  hookServer.on('PreToolUse', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    if (isSubagentEvent(input)) {
      // #763: an agent-tagged PreToolUse means that agent's pending
      // permission resolved without a PTY render we could pair (the
      // allowlist absorbed it post-passthrough, or it was answered
      // out-of-band) — expire its parked record so it cannot stale-merge
      // onto a later unrelated prompt.
      tracker.noteAgentAdvanced(input.agent_id);
      return;
    }
    // NB: do NOT cancel the in-flight auto-approve eval here (#537). Under
    // synchronous decisions (#496) Claude BLOCKS on the PermissionRequest until
    // the daemon answers, so a running eval is never stale — it is the verdict
    // Claude is waiting for. A PreToolUse/PostToolUse for a PREVIOUS tool would
    // otherwise abort the NEXT permission's eval mid-flight ("Decision dropped"),
    // dropping a decision that was about to approve. Only Stop/SessionEnd (a real
    // session-end) cancel an eval now.
    //
    // #673: distinct from the above -- this does NOT broadly cancel evals. A
    // PreToolUse whose (tool_name, tool_input) signature matches a currently
    // OPEN escalation/hold proves that EXACT permission was already resolved
    // externally (answered directly in the terminal, bypassing Remi's own
    // answer path, or the other process's own permission mode), so the tool
    // is now running and the pushed card would otherwise linger as an
    // unanswerable "needs you" notification. Signature-scoped: it can only
    // ever match the ONE question with that exact signature, never a
    // different permission's still-running eval, so it cannot regress #537.
    autoApproveGate.cancelExternallyResolved(
      { toolName: input.tool_name, toolInput: input.tool_input, toolUseId: input.tool_use_id },
      'PreToolUse',
    );
    handlers.onPreToolUse?.(input);
  });
  hookServer.on('PostToolUse', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    if (isSubagentEvent(input)) {
      // #710: the subagent-context tracker pop must see EVERY admitted
      // PostToolUse, even one Claude Code stamps with the SPAWNED agent's own
      // agent_id (its Task/Agent completion event) — that is exactly the
      // event that closes the tool_use_id an earlier, untagged PreToolUse(Task)
      // started tracking. Dropping it here without popping first leaked the
      // tracked use_id forever, sticking isInSubagentContext() true and
      // default-denying every later MAIN-agent PermissionRequest. Popping by
      // tool_use_id is safe for a genuine subagent-internal PostToolUse too:
      // its use_ids were never tracked in the first place (subagent PreToolUse
      // events are dropped without tracking, same as this listener's PreToolUse
      // sibling above).
      //
      // Residual gap (#716): this pop only runs when `binder.admits(input)`
      // above is true. A Task-closing PostToolUse that `admits()` rejects (a
      // rotation/sibling race) never reaches here and can still leak the
      // tracked use_id -- bounded by the Stop/SessionEnd/StopFailure resets
      // in hook-event-bridge.ts and by the gate's #710 leak-recovery
      // escalate (reset + escalate as main instead of denying).
      hookBridge.noteSubagentToolEnd(input.tool_name, input.tool_use_id);
      return;
    }
    // See the PreToolUse note above: no cancelStale here (#537). The previous
    // tool's PostToolUse must not abort the next permission's in-flight eval.
    // #673: same signature-scoped external-resolution cancel as PreToolUse
    // above (a tool that has already FINISHED is at least as strong a signal
    // that its permission was resolved elsewhere as one that just started).
    autoApproveGate.cancelExternallyResolved(
      { toolName: input.tool_name, toolInput: input.tool_input, toolUseId: input.tool_use_id },
      'PostToolUse',
    );
    handlers.onPostToolUse?.(input);
  });
  hookServer.on('Notification', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // SessionEnd already cleared status to 'idle'; a late
    // Notification(permission_prompt) for the dying session would
    // re-populate tracker.pending and a final PTY echo could fire a
    // spurious push the user cannot answer. Gate at the listener boundary;
    // restart resets mainSessionEnded so legitimate post-restart
    // notifications still pass. The binder owns mainSessionEnded (and resets
    // it on restart via rotate()), so read it there as the single source of
    // truth.
    if (binder.isMainEnded()) {
      log(`[Hooks] Dropped post-SessionEnd Notification: type=${input.notification_type}`);
      return;
    }
    // Phase 4 (#419): subagent notifications previously dropped here
    // based on agent_id presence. Now we forward; QuestionPresenceTracker
    // gates the push by PTY presence. A hot-switched subagent view that
    // renders a permission prompt on the user's PTY produces a push;
    // a background subagent does not (PTY never confirms presence).
    handlers.onNotification?.(input);
  });
  // Synchronous PermissionRequest decision (#496). Claude BLOCKS on this
  // response; the gate returns allow/deny (Claude proceeds without rendering the
  // prompt) or passthrough (escalated to the user / multi-choice inject). The
  // binder binding runs first (as for any event); a foreign event we do not own
  // returns 'passthrough' ({}) so we ABSTAIN and the owning daemon decides.
  hookServer.setPermissionResolver(async (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) {
      // #593: a PermissionRequest we don't own returns passthrough so the owning
      // daemon decides. Log it so the drop is diagnosable: e.g. a SUBAGENT
      // permission rejected here (a different/empty session_id, or arriving
      // during a startup/binding window) never reaches the auto-approve gate,
      // and the user sees the native prompt with no AA and no "evaluating"
      // status. A `subagent` tag on these lines is the smell for #593.
      log(
        `[Hooks] PermissionRequest NOT admitted -> passthrough (no AA eval): tool=${input.tool_name} ` +
          `incoming=${input.session_id?.slice(0, 8) ?? '-'} ` +
          `agent=${isSubagentEvent(input) ? (input.agent_id?.slice(0, 8) ?? 'subagent') : 'main'}`,
      );
      // #672: fail-safe ladder for a foreign PermissionRequest — silent when a
      // live sibling daemon owns it, an informational (non-answerable) push
      // when it is genuinely unclaimed, error-only when ownership cannot be
      // determined. Never affects the synchronous 'passthrough' below.
      deps.foreignSessionEscalator?.handleUnadmitted(input, sessionId);
      return 'passthrough';
    }
    return autoApproveGate.resolvePermission(input);
  });
  hookServer.on('Stop', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // #711: mainOnly -- Stop fires whenever the LEAD agent idles, even while
    // teammates (subagent/agent_id-tagged permission escalations) are still
    // running. A wholesale cancelStale here released every teammate's
    // already-pushed held card as passthrough (phantom: answering it resolved
    // nothing) and killed their in-flight evals. SessionEnd below is real
    // teardown and keeps the wholesale release/cancel.
    autoApproveGate.cancelStale('Stop', { mainOnly: true });
    handlers.onStop?.(input);
  });
  hookServer.on('SessionEnd', (input) => {
    // The binder owns mainSessionEnded on id-match (and resets it on restart
    // via rotate()). The post-SessionEnd Notification drop reads
    // binder.isMainEnded() directly, so there is no other flag to keep in
    // sync here — the binder is the single source of truth.
    binder.onSessionEnd(input);
    if (!binder.admits(input)) return;
    autoApproveGate.cancelStale('SessionEnd');
    handlers.onSessionEnd?.(input);
  });

  // ---- The 4 previously-dropped events (#453 phase 4) -----------------------
  // These were registered with Claude Code (REMI_REGISTERED_HOOK_EVENTS) but had
  // NO listener here, so they reached only (absent) dynamic listeners — a silent
  // no-op. Wired now, each following the same admit-then-fan-out template as the
  // tool listeners (drive the binder first so admits() sees an up-to-date lock,
  // then the per-event policy). The bridge handlers already exist + are tested.

  hookServer.on('StopFailure', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // Question event: a failed Stop hook leaves the agent in an unknown state, so
    // the bridge emits a "Retry?" card via onQuestion. Like PermissionRequest it
    // is NOT agent_id-dropped — PTY-presence gating happens downstream in the
    // tracker (#419).
    handlers.onStopFailure?.(input);
  });

  hookServer.on('PostToolUseFailure', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // Status event: a subagent's tool failure must not flip MAIN's status, so
    // drop on agent_id — the same split policy as Pre/PostToolUse (#419).
    if (isSubagentEvent(input)) return;
    handlers.onPostToolUseFailure?.(input);
  });

  // SubagentStart/SubagentStop are subagent-LIFECYCLE events: they ALWAYS carry
  // agent_id by definition, so the isSubagentEvent drop would discard them
  // entirely. The whole point is to surface subagent activity as a status
  // breadcrumb, so gate them with admits() ONLY (the sibling defer + session
  // scoping still apply via session_id) — a deliberate divergence from the
  // Pre/PostToolUse agent_id drop (#453 phase 4).
  hookServer.on('SubagentStart', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // input.transcript_path is the MAIN transcript; the subagent file is the
    // deterministic <main>/subagents/agent-<id>.jsonl (registry derives it).
    // Wrapped so a send/registry throw can't escape into the hook dispatch loop
    // (#499 phase 3).
    try {
      subagentViews?.recordStart(input.agent_id, input.agent_type, input.transcript_path);
      pushSubagentViews();
      handlers.onSubagentStart?.(input);
    } catch (err) {
      logError(
        `[Hooks] SubagentStart view-tracking failed for ${sessionId}: ${errorToString(err)}`,
      );
    }
  });

  hookServer.on('SubagentStop', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    try {
      subagentViews?.recordStop(input.agent_id);
      pushSubagentViews();
      handlers.onSubagentStop?.(input);
    } catch (err) {
      logError(`[Hooks] SubagentStop view-tracking failed for ${sessionId}: ${errorToString(err)}`);
    }
  });

  log(`[Hooks] Event bridge active for session ${sessionId}`);

  return {
    bridge: hookBridge,
    closeBinder: () => {
      binder.close();
      // Drop the per-session PermissionRequest resolver (#496) so a stale
      // closure (over this session's gate/tracker) can't fire after teardown.
      hookServer.setPermissionResolver(null);
    },
    gate: {
      resolveHeld: (questionId, decision, suggestionIndex) =>
        autoApproveGate.resolveHeld(questionId, decision, suggestionIndex),
      releaseHeldAsPassthrough: (questionId) =>
        autoApproveGate.releaseHeldAsPassthrough(questionId),
      cancelStale: (reason) => autoApproveGate.cancelStale(reason),
      cancelEvalForQuestion: (questionId, reason) =>
        autoApproveGate.cancelEvalForQuestion(questionId, reason),
      forceRelease: (reason) => autoApproveGate.forceRelease(reason),
    },
  };
}
