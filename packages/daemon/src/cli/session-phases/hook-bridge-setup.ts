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
 * A third concern, the **permission gate** (`AutoApproveGate`, a historical
 * name), used to be inlined here (#453 phase 1). The bridge does the session
 * filtering, then routes PermissionRequest to the gate, which since #1125
 * (ADR 0030) decides nothing on its own: since #1126 (ADR 0031) it holds a
 * binary prompt's hook for the phone's answer while Claude's dialog is on
 * screen, pushes a multi-choice / design prompt at once and answers it
 * 'passthrough', and passes a subagent prompt to the local terminal (wrapper
 * mode) or holds it like a main one (daemon mode). Stop / SessionEnd call
 * `gate.cancelStale()` to resolve escalations Claude no longer waits on. Stop passes
 * `{ mainOnly: true }` (#711): it fires whenever the LEAD idles even while
 * agent-team teammates keep working, so it resolves only MAIN-context
 * escalations, sparing a teammate's still-open one. SessionEnd is real
 * teardown and stays unscoped. #799: `SubagentStop` calls
 * `gate.cancelStaleForAgent(agent_id)`, the single-agent mirror of Stop's
 * mainOnly sweep: it resolves any permission still open for THAT agent (the
 * terminal-rejection case a matching tool call can never signal, since a deny
 * produces no tool call at all).
 *
 * #889 (Q4) adds two more observe-only resolution/surfacing paths, both
 * registered in `REMI_REGISTERED_HOOK_EVENTS` for the first time here:
 *   - `PermissionDenied` routes into the SAME external-resolution funnel as
 *     PreToolUse/PostToolUse (`gate.cancelExternallyResolved`) — a classifier
 *     denial fires no tool call, so without this a still-open escalation for
 *     it would linger with no other resolution signal.
 *   - `Elicitation` builds an answerable card (`hookBridge.handleElicitation`,
 *     source `'elicitation'`, direct-emitted like a source-less StopFailure
 *     card) instead of leaving an MCP dialog as a PTY orphan; `elicitationQuestions`
 *     (below) remembers its `elicitation_id` so a later `ElicitationResult`
 *     can resolve the SAME card by exact id, mirroring PermissionDenied's
 *     "close the lingering-card gap" shape.
 *
 * #893 (Q9) registered a 4th event, `UserPromptSubmit`, to feed the
 * auto-approve authority summary. That consumer was deleted in #1125; the
 * listener stays (it drives `binder.onHookEvent` like every other listener),
 * and the registration stays because the turn-complete timer anchors each
 * turn on it (`notifications/turn-timer.ts`).
 *
 * This listener block IS the per-session hook router (admit-then-fan-out); a
 * formal HookRouter class is deferred to a later refactor (#470). The function
 * registers 13 hookServer `.on()` listeners — the original 5 still standing
 * (PreToolUse, PostToolUse, Notification, Stop, SessionEnd; PermissionRequest
 * is installed separately via `setPermissionResolver`, not `.on()`) plus the 4
 * wired in phase 4 (StopFailure, PostToolUseFailure, SubagentStart, SubagentStop)
 * plus the 3 wired for Q4 (#889: PermissionDenied, Elicitation,
 * ElicitationResult) plus the 1 wired for Q9 (#893: UserPromptSubmit) — and
 * returns void. It runs once per session at createNewSession time, only when
 * a hookServer is configured.
 *
 * #930 REMOVES the `SessionStart` listener that used to make this 14 (the
 * "original 6"): Claude Code hard-discards `http`-type hook registrations for
 * `SessionStart`/`Setup` before dispatch, confirmed by binary extraction
 * against 2.1.220 and independently by 5,000+ captured events containing zero
 * `SessionStart` records, so the listener never ran. Its three legs were each
 * already covered elsewhere: the restart pre-empt has a designed no-hooks
 * mirror (`TranscriptBinder.feedSyntheticRotation`, #452/#453), every other
 * listener below already calls `binder.onHookEvent` as its first line, and
 * the subagent-context reset + `onSessionInfo` leg (`HookEventBridge.
 * handleSessionStart`) was deleted outright -- `onSessionInfo` was wired to a
 * literal no-op regardless. `TranscriptBinder.preemptOnSessionStart` itself
 * is KEPT; `feedSyntheticRotation` is its only remaining caller.
 *
 * The inline session-binding path this file used to also carry (pre-#453) and
 * the shadow-mode differential wiring (#453 phase 3, commit 3) were deleted in
 * #470 once the TranscriptBinder soaked as the unconditional driver (#503).
 */

import { createSessionViews, errorToString } from '@remi/shared';
import type { AgentStatus, ProtocolMessage, Question, UUID } from '@remi/shared';

import type { MessageAPI, QuestionRegistrationOutcome } from '../../api/message-api.ts';
import type { QuestionPresenceTracker } from '../../api/question-presence-tracker.ts';
import type { SubagentViewRegistry } from '../../api/subagent-view-registry.ts';
import { AutoApproveGate } from '../../auto-approve/index.ts';
import type { HeldAnswer, HeldAnswerOutcome } from '../../auto-approve/index.ts';
import { HookEventBridge } from '../../hooks/index.ts';
import type {
  ForeignSessionEscalator,
  HookInput,
  HookServer,
  PermissionDeniedHookInput,
  PermissionRequestHookInput,
} from '../../hooks/index.ts';
import type { TerminalNoticeReason } from '../../notifications/notification-dispatcher.ts';
import type {
  SessionBindingStore,
  SessionRegistry,
  SessionRegistryFile,
} from '../../session/index.ts';
import { TranscriptBinder } from '../../transcript/index.ts';
import type { TranscriptWatcher } from '../../transcript/index.ts';
import type { TranscriptDiscovery } from '../../transcript/transcript-discovery.ts';
import { log, logError } from '../logger.ts';

/**
 * Cap for the Stop-turn log line (#891). `last_assistant_message` can run
 * several paragraphs (real captures in `~/.remi/hook-diag.jsonl` include
 * multi-paragraph reviewer summaries); this is a LOG line, not a client
 * surface, so it is bounded so one verbose turn cannot dominate the daemon
 * log. Whitespace (including embedded newlines) is collapsed for the same
 * reason `notification-dispatcher.ts` normalizes push text.
 */
const STOP_LOG_MESSAGE_MAX = 200;

/** Truncate + collapse whitespace in a hook-carried message for a single log line. */
function summarizeForLog(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Threshold above which a PostToolUse `duration_ms` is logged (#891). Tool
 * calls are frequent (1220 in one real `~/.remi/hook-diag.jsonl` capture, 100%
 * carrying `duration_ms`) so logging every one would be pure noise; only a
 * genuinely slow call is operationally interesting.
 */
const SLOW_TOOL_MS = 5_000;

export interface HookBridgeDeps {
  sessionRegistry: SessionRegistry;
  bindingStore: SessionBindingStore;
  liveSessionsRegistry: SessionRegistryFile;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
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
   * Tools whose prompt is always a design question (#572). Passed to the gate
   * so it classifies an escalation as binary (held, #1126) vs design/plan-mode
   * (passthrough, pushed immediately). Absent => `ALWAYS_ESCALATE_TOOLS`.
   */
  alwaysEscalateTools?: ReadonlySet<string>;
  /**
   * Cross-client question dismissal (#585, P7). Called when an open question
   * resolves WITHOUT a user answer (an external-resolution signal, a Stop /
   * SubagentStop / SessionEnd sweep, a restart, `remi unstick`): the daemon
   * broadcasts `question_resolved` to every client and fires the APNS
   * dismissal so the pushed card clears everywhere. Must be throw-safe (the
   * gate also guards the call). Absent => no dismissal broadcast.
   */
  broadcastQuestionResolved?: (sessionId: UUID, questionId: UUID, reason: 'cancelled') => void;
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
  /**
   * Observer for every subagent-tagged permission that passed through (#807). Forwarded verbatim to the gate's
   * `onSubagentPassthrough`; see that dep's doc for why it cannot influence
   * the decision. Supplied by `cli.ts`, which owns the `SubagentAlerter` and
   * the push transport (daemon-wide, so alert rate-limiting is shared across
   * sessions rather than reset per session — same reasoning as
   * `foreignSessionEscalator` above). Absent => no alert, no audit line.
   */
  onSubagentPassthrough?: (input: PermissionRequestHookInput) => void;
  /**
   * How long a binary prompt's hook is held for a phone answer, in ms
   * (`[prompts] hold_seconds`, #1126). Required: see `AutoApproveGateDeps.holdMs`.
   */
  holdMs: number;
  /**
   * Push an informational "answer at the terminal" notice for `question`
   * (#1126), wired to the session's `NotificationDispatcher.pushTerminalNotice`.
   * Fired when a held prompt reaches its deadline (the #733 handoff) and
   * when a subagent prompt passed to the local terminal renders. Absent =>
   * no notice (tests). Must be throw-safe; the gate also guards it.
   */
  pushTerminalNotice?: (sessionId: UUID, question: Question, reason: TerminalNoticeReason) => void;
  /** Dismiss a notice `pushTerminalNotice` sent, once its prompt is
   *  answered. Absent => the notice stays until the user clears it. */
  dismissTerminalNotice?: (sessionId: UUID, questionId: UUID) => void;
  /**
   * Claude Code's auto-mode classifier blocked a tool call in this session
   * (`PermissionDenied`, #1126): wired by cli.ts to the `harness_denied`
   * push (`notifications/harness-denied.ts`). Informational, never a card;
   * called only for an admitted event. Absent => no push. Throw-safe here.
   */
  onHarnessDenied?: (input: PermissionDeniedHookInput) => void;
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
  /** Whether this session has a local terminal (wrapper mode, #1126): it
   *  decides whether a subagent prompt is passed to that terminal or held
   *  for the phone. See `AutoApproveGateDeps.hasLocalTerminal`. */
  hasLocalTerminal: boolean;
}

/**
 * Per-session control surface for the permission gate (#573). Registered by
 * cli.ts keyed by `sessionId` so the answer handler and `remi unstick` reach
 * the RIGHT session's gate.
 */
export interface SessionGateHandle {
  /** Another path already removed and dismissed `questionId` (a user answer,
   *  a superseded render): stop tracking its signature so a later matching
   *  tool event does not resolve (and dismiss) it again. Forwards to
   *  `retireQuestion`. */
  retireQuestion: (questionId: UUID) => void;
  /** Apply a phone answer to a held prompt (#1126). Forwards to
   *  `AutoApproveGate.answerHeld`; see `HeldAnswerOutcome`. */
  answerHeld: (questionId: UUID, answer: HeldAnswer) => HeldAnswerOutcome;
  /** Is a main-agent prompt's hook held, with its dialog on screen (#1126)?
   *  Forwards to `AutoApproveGate.hasMainHold`. */
  hasMainHold: () => boolean;
  /** Force-release escape (#617 `remi unstick`): resolve and dismiss every
   *  open escalation. Forwards to `forceRelease`. */
  forceRelease: (reason: string) => { resolved: number };
}

export interface HookBridgeHandle {
  /** Live bridge instance. Callers can read `isInSubagentContext()` to gate
   *  alternate question sources (e.g. PTY parser) so subagent prompts are
   *  not surfaced to the user. */
  bridge: HookEventBridge;
  /**
   * Does this session's binder claim the event? (#914)
   *
   * Every listener inside `setupHookBridge` already consults `binder.admits()`;
   * this exposes the same filter to listeners registered OUTSIDE it. Needed
   * because two daemons in the SAME project directory each append their own
   * matcher to the shared `.claude/settings.local.json` hooks array
   * (`HookConfigManager.install` matches on `h.url`, so a second daemon adds
   * rather than replaces), and Claude Code POSTs every event to both. A
   * listener without this filter cannot tell whose turn it is looking at.
   */
  admits: (input: HookInput) => boolean;
  /**
   * Tear down the `TranscriptBinder` for this session (its watcher, fallback
   * timer, and the #452 rotation dir-poll). The caller must invoke this on
   * session teardown so the binder's rotation dir-poll interval — which the
   * shared `transcriptWatchers` / `transcriptFallbackTimers` cleanup in cli.ts
   * does NOT reach — never outlives the session.
   */
  closeBinder: () => void;
  /**
   * Per-session gate handle (#573), so the answer path and `remi unstick`
   * reach this exact session's gate. Always present (the gate is constructed
   * unconditionally).
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
    currentPort,
    transcriptDiscovery,
    subagentViews,
  } = deps;
  const {
    hookServer,
    sessionId,
    workingDirectory,
    messageApi,
    sendAndRecord,
    tracker,
    hasLocalTerminal,
  } = args;

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
    sessionRegistry.clearQuestions(sessionId, 'session_restart');
  };

  // ---- Elicitation correlation (#889, Q4) ----------------------------------
  //
  // `Elicitation` builds a card via `hookBridge.handleElicitation`, direct-
  // emitted (source 'elicitation', not stashed by the tracker -- see the
  // module doc above). `ElicitationResult` is the resolution signal: both
  // events carry `elicitation_id` (optional -- absent on either side means no
  // correlation is possible, same graceful-degradation as PermissionRequest's
  // missing tool_use_id), an EXACT key, so this map is a simple id->id lookup
  // rather than the tool-signature matching `openQuestionSignatures` needs.
  // Scoped to this session's closure (dropped with the bridge on teardown, so
  // it cannot outlive the session); capped defensively so a pathological
  // stream of never-resolved elicitations cannot grow it unbounded within one
  // session's lifetime: an MCP dialog per session is rare, so 32 is far above
  // any real count.
  const MAX_PENDING_ELICITATIONS = 32;
  const elicitationQuestions = new Map<string, UUID>();
  /**
   * Record `elicitation_id -> questionId`, but NEVER let an id that is not a
   * live registered card displace one that is (review finding on #889).
   *
   * `handleElicitation` mints an id and returns it unconditionally, but the
   * emission behind it is fire-and-forget and can be dropped: `MessageAPI.
   * handleQuestion` skips `addQuestion` when `QuestionDedup.shouldEmit` is
   * false (`message-api.ts`) -- reported honestly today via its
   * `QuestionRegistrationOutcome` return (#888 criterion iii; before that
   * fix, `handleQuestion` returned `void` and the caller had to re-query
   * `SessionRegistry` to find out). A re-fired `Elicitation` for the SAME
   * `elicitation_id` is exactly that dedup case — same `mcp_server_name`/
   * `message` text, same `options: []` + `allowsFreeText: true`, so never
   * "richer" — and the dedup baseline is still live because `handleElicitation`
   * emits the question BEFORE its `onStatusChange('waiting')`, so status
   * never leaves 'waiting' to reset it. Overwriting blindly therefore
   * pointed the map at a card that was never registered, leaving the FIRST
   * card (the one the user can actually see) unreachable: `ElicitationResult`
   * resolved the phantom, and the live card could only clear by the user
   * answering it or LRU eviction. Same defect class as #925 — a resolution
   * path that cannot reach the question it is for — so the same guard:
   * confirm the target is really registered.
   *
   * Note the rule is the OPPOSITE of `cancelExternallyResolved`-before-
   * register (`auto-approve-gate.ts`), which resolves the earlier entry so the
   * newer one wins. There, a re-requested permission genuinely re-renders, so
   * newest is the live prompt. Here a re-fired `Elicitation` is the SAME MCP
   * dialog, and the newer card is the one that does not exist; keeping the
   * older, still-live card is what makes `ElicitationResult` able to close it.
   */
  const rememberElicitation = (
    elicitationId: string,
    questionId: UUID,
    outcome: QuestionRegistrationOutcome | undefined,
  ): void => {
    const previous = elicitationQuestions.get(elicitationId);
    if (previous !== undefined && previous !== questionId) {
      // Distinct question, about the PREVIOUSLY tracked entry: whether THAT
      // card is still live right now cannot come from this call's own return
      // value (it is about a different id, possibly minutes old), so this
      // half genuinely has to ask the store.
      const previousIsLive = sessionRegistry.getQuestion(sessionId, previous) !== null;
      if (previousIsLive) {
        logError(
          `[Hooks] Elicitation re-fired for ${elicitationId} while its card ${previous} is still live; keeping it (not tracking ${questionId}) so ElicitationResult resolves the card the user can see`,
        );
        return;
      }
    }
    // Confirmed delivery, the #925 gate (#888 criterion iii): consumes the
    // `QuestionRegistrationOutcome` `handleElicitation` already returned for
    // THIS exact call, instead of re-querying `SessionRegistry` after the
    // fact -- the information flows from the call itself, which is
    // synchronous end to end (`handleElicitation` -> `onQuestion` ->
    // `MessageAPI.handleQuestion` -> `QuestionDedup` -> `addQuestion`), so the
    // returned outcome is exactly as current as a post-hoc query would have
    // been. Tracking an id that never registered would make
    // `ElicitationResult` broadcast a dismiss for a card no client ever saw
    // and consume a slot under `MAX_PENDING_ELICITATIONS` for nothing.
    if (outcome?.status !== 'registered') {
      logError(
        `[Hooks] Elicitation card ${questionId} for ${elicitationId} was not registered (deduped as a repeat of a still-open prompt); not tracking it`,
      );
      return;
    }
    if (elicitationQuestions.size >= MAX_PENDING_ELICITATIONS) {
      const oldest = elicitationQuestions.keys().next();
      if (!oldest.done) {
        elicitationQuestions.delete(oldest.value);
        logError(
          `[Hooks] elicitationQuestions at cap (${MAX_PENDING_ELICITATIONS}) for ${sessionId}; evicted the oldest tracked elicitation -- its ElicitationResult (if any) will no longer resolve its card`,
        );
      }
    }
    elicitationQuestions.set(elicitationId, questionId);
  };
  /** Resolve + clear a previously-pushed elicitation card by its exact
   *  `elicitation_id`. A no-op when nothing is tracked under that id (no
   *  correlation was possible, already resolved, or evicted at the cap) --
   *  mirrors `cancelExternallyResolved`'s own no-op-on-no-match safety. */
  const resolveElicitation = (elicitationId: string): void => {
    const questionId = elicitationQuestions.get(elicitationId);
    if (!questionId) return;
    elicitationQuestions.delete(elicitationId);
    try {
      deps.broadcastQuestionResolved?.(sessionId, questionId, 'cancelled');
    } catch (err) {
      logError(
        `[Hooks] question_resolved broadcast (ElicitationResult) failed for ${questionId}: ${errorToString(err)}`,
      );
    }
    try {
      sessionRegistry.removeQuestion(
        sessionId,
        questionId,
        'ElicitationResult',
        undefined,
        'setupHookBridge.resolveElicitation',
      );
    } catch (err) {
      logError(
        `[Hooks] removeQuestion (ElicitationResult) failed for ${questionId}: ${errorToString(err)}`,
      );
    }
  };

  // ---- Bridge + hook handler registration ---------------------------------

  const hookBridge = new HookEventBridge(sessionId, {
    onStatusChange: (status: AgentStatus, context?: string, agentId?: string) => {
      messageApi.handleStatusChange(status, context);
      // #1140: the event's agent_id rides along, so a subagent's or
      // teammate's tool call does not clear the menu the main dialog shows.
      tracker.onStatusChange(status, { agentId });
    },
    onQuestion: (question) => {
      // #625 single gate: a PERMISSION question is coordinated by the permission
      // gate — it is stashed here and the gate drives its push on escalate (a
      // held binary prompt and a multi-choice / design one at once via
      // onHeldEscalate, #1126). recordPendingHook only stashes; it never emits
      // on its own.
      //   - 'permission_request' (rich: tool + command + options) is the one the gate
      //     escalates and pushes by id. This is the ONLY source stashed here now:
      //     `HookEventBridge` used to also synthesize a redundant generic
      //     'notification' question from Claude's Notification(permission_prompt)
      //     (Claude still fires it — it just pairs with the PermissionRequest above
      //     rather than producing a second Question); #890/Q5 deleted that
      //     synthesis after a capture corpus found 0 unpaired occurrences across
      //     4244 events / 5 sessions / one day (see `handleNotification`'s own
      //     comment for the full argument + residual failure mode).
      // A STANDALONE hook question that no gate pushes (e.g. a Stop-failure "Retry?",
      // source-less, or an 'elicitation' card, #889) is emitted directly to the
      // client + lock screen, since the PTY-render push that used to deliver it
      // is suppressed for hooked sessions.
      if (question.source === 'permission_request') {
        // recordPendingHook only stashes -- no `handleQuestion` call happens
        // here, so there is no registration outcome to report (#888 criterion
        // iii). This question is not registered until a later PTY render
        // pairs with it (`QuestionPresenceTracker.pairAndPush`).
        tracker.recordPendingHook(question);
        return undefined;
      }
      return messageApi.handleQuestion(question);
    },
  });

  const handlers = hookBridge.hookHandlers();

  // Permission gate (#453 phase 1): owns the PermissionRequest response,
  // escalation and external-resolution cleanup. Constructed after the bridge +
  // handlers so it can wrap the two outward couplings (isInSubagentContext,
  // handlePermissionRequest) as injected callbacks.
  const autoApproveGate = new AutoApproveGate(
    {
      sessionRegistry,
      isInSubagentContext: () => hookBridge.isInSubagentContext(),
      // #710: lets the gate recover from a tracker leak (a MAIN-tagged
      // PermissionRequest observing isInSubagentContext() stuck true) instead
      // of treating the main agent's prompt as a subagent's.
      resetSubagentContext: () => hookBridge.resetSubagentContext(),
      // Call the bridge DIRECTLY (not via the void-typed handlers map) so the
      // created Question.id flows back to the gate, which pushes and tracks it
      // by that id. The bridge still does the onQuestion + status side effects.
      escalate: (i) => hookBridge.handlePermissionRequest(i),
      // #751: a subagent-tagged prompt parks its rich question (same builder
      // as a real escalation, minus the push/registration side effects); the
      // tracker pushes it only if Claude's native prompt actually renders on
      // the PTY. #799: return the parked question's id so the gate can
      // register its signature in `openQuestionSignatures` -- without it, a
      // subagent permission answered in the terminal has no removal path at
      // all (see the PreToolUse/PostToolUse/SubagentStop wiring below).
      // #1126: when the parked prompt renders (wrapper mode), the phone gets
      // an "answer at the terminal" notice, never an answerable card: the
      // hook was answered passthrough, so only the terminal can answer it.
      parkForPTY: (i) => {
        const question = hookBridge.buildPermissionQuestion(i);
        tracker.parkAwaitingPTY(question, {
          onRender: (merged) => {
            // Keep the parked id: the gate dismisses the notice by it.
            deps.pushTerminalNotice?.(sessionId, { ...merged, id: question.id }, 'subagent');
            autoApproveGate.noteTerminalNotice(question.id);
          },
        });
        return question.id;
      },
      pushTerminalNoticeNow: (i) => {
        if (!deps.pushTerminalNotice) return undefined;
        const question = hookBridge.buildPermissionQuestion(i);
        deps.pushTerminalNotice(sessionId, question, 'subagent');
        return question.id;
      },
      hasLocalTerminal,
      ...(deps.onSubagentPassthrough ? { onSubagentPassthrough: deps.onSubagentPassthrough } : {}),
      // A held binary prompt (#1126) and a multi-choice / design escalation
      // (#625) push immediately under their own id (-> addQuestion +
      // maybePush); PTY question-emission is suppressed for hooked sessions.
      onHeldEscalate: (questionId) => tracker.pushHeldHook(questionId),
      holdMs: deps.holdMs,
      // #1126: a held prompt reached its deadline. Read the card while it is
      // still registered (the gate dismisses it right after) so the notice
      // names the actual ask.
      onHoldDeadline: (questionId) => {
        const question = sessionRegistry.getQuestion(sessionId, questionId);
        if (question === null) return;
        deps.pushTerminalNotice?.(
          sessionId,
          question,
          hasLocalTerminal ? 'hold_deadline' : 'hold_deadline_no_terminal',
        );
      },
      onTerminalNoticeResolved: (questionId) => deps.dismissTerminalNotice?.(sessionId, questionId),
      // #585: an open escalation that resolves without a user answer tells
      // the daemon to dismiss the pushed card on every client.
      onResolved: (questionId, reason) =>
        deps.broadcastQuestionResolved?.(sessionId, questionId, reason),
      // #573: classify an escalation as binary (held, #1126) vs
      // design/multi-choice (pushed immediately). Absent => the gate's
      // `ALWAYS_ESCALATE_TOOLS` default.
      ...(deps.alwaysEscalateTools ? { alwaysEscalateTools: deps.alwaysEscalateTools } : {}),
    },
    sessionId,
  );

  // #1126: a render while a hook-backed prompt is open is that prompt (or a
  // redraw of it), never a hook-less orphan, so it is not rebuilt into a
  // card the phone would answer by typing. The one wiring point, here where
  // both the gate and the tracker exist.
  tracker.setHookPromptProbe(() => autoApproveGate.hasOpenHookPrompt());

  // Subagent/team-member events carry `agent_id` (confirmed via
  // REMI_HOOK_DEBUG capture 2026-04-16). They share main's session_id and
  // transcript, so session-id filtering cannot distinguish them.
  //
  // Split policy:
  //   - `PreToolUse` / `PostToolUse`: STATUS updates and
  //     Task-tool tracking are dropped here so they stay scoped to the main
  //     interactive session. #799: Pre/PostToolUse additionally call
  //     `autoApproveGate.cancelExternallyResolved` (agent-scoped) before
  //     returning — a tool call now running for this exact agent proves any
  //     permission the gate parked/pushed for it was answered outside Remi's
  //     own path, so its card must still be resolved even though the rest of
  //     the event is dropped.
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
        // stale answers are refused. The gate goes first (#1126): a hold
        // must never outlive the Claude session that asked, so every open
        // escalation is resolved and its hook released with the empty
        // response before the registry is cleared.
        autoApproveGate.cancelStale('session_restart');
        tracker.clearPending();
        resolveAndClearQuestions();
        // #889: drop any elicitation_id correlations too -- their target
        // questions were just cleared above, and a stale entry surviving into
        // the new session could (in principle, if Claude Code ever reused an
        // elicitation_id) resolve an unrelated future card.
        elicitationQuestions.clear();
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
      // #799: mirrors the main-context external-resolution cancel below —
      // this agent's tool is now running, so any parked/pushed permission
      // question the gate is still tracking FOR THIS AGENT with a matching
      // (tool_name, tool_input) signature was answered outside Remi's own
      // path (most commonly directly in the terminal). Funnel it through the
      // same removeQuestion + question_resolved cleanup a main match uses.
      autoApproveGate.cancelExternallyResolved(
        {
          toolName: input.tool_name,
          toolInput: input.tool_input,
          toolUseId: input.tool_use_id,
          agentId: input.agent_id,
        },
        'PreToolUse-subagent',
      );
      // #1126: remember the call so its PermissionRequest pairs with its id.
      autoApproveGate.notePreToolUse({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolUseId: input.tool_use_id,
        agentId: input.agent_id,
      });
      return;
    }
    // #673: a PreToolUse whose (tool_name, tool_input) signature matches a
    // currently OPEN escalation proves that EXACT permission was already
    // resolved externally (answered directly in the terminal, bypassing remi's
    // own answer path, or Claude's own permission mode), so the tool is now
    // running and the pushed card would otherwise linger as an unanswerable
    // "needs you" notification. Signature-scoped: it can only ever match the
    // ONE question with that exact signature (#537).
    autoApproveGate.cancelExternallyResolved(
      { toolName: input.tool_name, toolInput: input.tool_input, toolUseId: input.tool_use_id },
      'PreToolUse',
    );
    // #1126: the PermissionRequest for this call (if any) fires about 10 ms
    // later and carries no tool_use_id; remembering the call lets it pair,
    // so the PostToolUse of a Yes answered in the terminal closes exactly
    // that held prompt.
    autoApproveGate.notePreToolUse({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id,
    });
    handlers.onPreToolUse?.(input);
  });
  hookServer.on('PostToolUse', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // #891: PostToolUse now carries duration_ms. No dedicated tool-activity
    // tracker/UI exists to put it in yet (the epic notes a live view needs
    // Q6's bus) -- this only stops discarding the signal that is actually
    // operationally interesting: a genuinely slow tool call, for BOTH main
    // and subagent activity (logged before the subagent-branch early return
    // below).
    if (typeof input.duration_ms === 'number' && input.duration_ms >= SLOW_TOOL_MS) {
      log(`[Hooks] Slow tool: ${input.tool_name} took ${input.duration_ms}ms (${sessionId})`);
    }
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
      // #799: same external-resolution cancel as the PreToolUse branch above
      // — a tool that has already FINISHED is at least as strong a signal
      // that its permission was resolved elsewhere as one that just started.
      autoApproveGate.cancelExternallyResolved(
        {
          toolName: input.tool_name,
          toolInput: input.tool_input,
          toolUseId: input.tool_use_id,
          agentId: input.agent_id,
        },
        'PostToolUse-subagent',
      );
      autoApproveGate.noteToolUseEnded(input.tool_use_id);
      return;
    }
    // #673: same signature-scoped external-resolution cancel as PreToolUse
    // above (a tool that has already FINISHED is at least as strong a signal
    // that its permission was resolved elsewhere as one that just started).
    // #1126: this is how a Yes answered in the terminal reaches a held
    // prompt: Claude runs the tool and never closes the held request, and
    // this PostToolUse carries the tool_use_id the prompt was paired with.
    // The hold ends with the empty response Claude ignores.
    autoApproveGate.cancelExternallyResolved(
      { toolName: input.tool_name, toolInput: input.tool_input, toolUseId: input.tool_use_id },
      'PostToolUse',
    );
    autoApproveGate.noteToolUseEnded(input.tool_use_id);
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
  // Synchronous PermissionRequest response (#496). Since #1125 the gate always
  // answers 'passthrough' (Claude renders its native prompt) after escalating
  // or parking the request. The binder binding runs first (as for any event);
  // a foreign event we do not own returns 'passthrough' ({}) so we ABSTAIN.
  hookServer.setPermissionResolver(async (input, signal) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) {
      // #593: a PermissionRequest we don't own returns passthrough so the owning
      // daemon decides. Log it so the drop is diagnosable: e.g. a SUBAGENT
      // permission rejected here (a different/empty session_id, or arriving
      // during a startup/binding window) never reaches the gate, so no card
      // is pushed for it. A `subagent` tag on these lines is the smell for #593.
      log(
        `[Hooks] PermissionRequest NOT admitted -> passthrough (no card): tool=${input.tool_name} ` +
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
    return autoApproveGate.resolvePermission(input, signal);
  });
  hookServer.on('Stop', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // #711: mainOnly -- Stop fires whenever the LEAD agent idles, even while
    // teammates (subagent/agent_id-tagged permission escalations) are still
    // running. A wholesale cancelStale here resolved every teammate's
    // already-pushed card (phantom: answering it resolved nothing). SessionEnd
    // below is real teardown and keeps the wholesale sweep.
    autoApproveGate.cancelStale('Stop', { mainOnly: true });
    // #891: Stop now carries the turn's real content (last_assistant_message),
    // previously dropped entirely. There is no client-facing surface to carry
    // it to a phone/lock-screen yet -- `Session`/`SessionUpdateMessage` have no
    // text field, and adding one is a protocol change out of scope here (see
    // PR body). Until that lands, at least stop discarding it at the point it
    // enters the daemon: log it (truncated) so the real turn-complete content
    // is observable operationally instead of a bare "Status: idle".
    if (!input.stop_hook_active && input.last_assistant_message) {
      log(
        `[Hooks] Turn complete (${sessionId}): ${summarizeForLog(input.last_assistant_message, STOP_LOG_MESSAGE_MAX)}`,
      );
    }
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
    //
    // #799 deliberately does NOT clear open escalations here: an unknown-state
    // agent is exactly the ambiguous signal #799 avoids clearing on (unlike a
    // clean Stop/SubagentStop). Known residual leak, tracked as #802.
    handlers.onStopFailure?.(input);
  });

  hookServer.on('PostToolUseFailure', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // Status event: a subagent's tool failure must not flip MAIN's status, so
    // drop on agent_id — the same split policy as Pre/PostToolUse (#419).
    if (isSubagentEvent(input)) {
      // #799: a tool call that FAILED still proves the gating permission was
      // granted (the tool actually ran) — at least as strong a signal as a
      // successful PostToolUse. Same agent-scoped external-resolution cancel
      // as the PreToolUse/PostToolUse subagent branches above.
      autoApproveGate.cancelExternallyResolved(
        {
          toolName: input.tool_name,
          toolInput: input.tool_input,
          toolUseId: input.tool_use_id,
          agentId: input.agent_id,
        },
        'PostToolUseFailure-subagent',
      );
      autoApproveGate.noteToolUseEnded(input.tool_use_id);
      return;
    }
    // #1126: a Yes answered in the terminal whose tool then failed still
    // proves the held prompt was answered; same cancel as PostToolUse.
    autoApproveGate.cancelExternallyResolved(
      { toolName: input.tool_name, toolInput: input.tool_input, toolUseId: input.tool_use_id },
      'PostToolUseFailure',
    );
    autoApproveGate.noteToolUseEnded(input.tool_use_id);
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
      // #891: SubagentStop now carries agent_transcript_path directly;
      // recordStop prefers it over the SubagentStart-time derivation (see
      // subagent-view-registry.ts for the fallback + validation rules).
      subagentViews?.recordStop(input.agent_id, input.agent_transcript_path);
      pushSubagentViews();
      handlers.onSubagentStop?.(input);
    } catch (err) {
      logError(`[Hooks] SubagentStop view-tracking failed for ${sessionId}: ${errorToString(err)}`);
    }
    // #799: this agent's turn is fully over, so any permission escalation the
    // gate still tracks for it (parked-then-pushed, or parked-and-never-
    // rendered) can no longer be "about to run a tool" — resolve it through
    // the same funnel a matching tool call uses. Covers the one case a tool
    // signature match never can: the subagent's permission was REJECTED in
    // the terminal (or an unrelated allowlist absorption left no render), so
    // no PreToolUse/PostToolUse ever fires for it. Scoped to this exact
    // agent_id, so a sibling teammate's still-open escalation is untouched.
    //
    // Also expire this agent's PARKED tracker record (#763), pairing with
    // cancelStaleForAgent the same way the PreToolUse-subagent branch pairs
    // noteAgentAdvanced with cancelExternallyResolved above. Without this, a
    // resolved-but-still-parked record can survive up to PARKED_RECORD_TTL_MS
    // (120s) and pair with a delayed PTY render for this agent key, re-pushing
    // a phantom card for a question that is already gone from sessionRegistry.
    if (input.agent_id) {
      tracker.noteAgentAdvanced(input.agent_id);
      autoApproveGate.cancelStaleForAgent(input.agent_id, 'SubagentStop');
    }
  });

  // ---- Q4 (#889): PermissionDenied + Elicitation/ElicitationResult --------
  // Newly registered in REMI_REGISTERED_HOOK_EVENTS by this change (see
  // hook-types.ts for why). Both stay observe-only: neither hook response
  // encodes a decision -- `handleRequest` (hook-server.ts) never installs a
  // resolver for these event names, so they always fall through to the plain
  // `{}` 200 response, exactly like Stop/SessionEnd/StopFailure today.

  hookServer.on('PermissionDenied', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    // A classifier denial fires no tool call, so PreToolUse/PostToolUse never
    // observe it -- this is the ONLY external-resolution signal for it. Same
    // funnel, same signature-then-tool_use_id matching as PreToolUse/
    // PostToolUse above; a no-op when nothing open matches (the codebase-wide
    // rule "every ambiguous path resolves toward showing the user" -- NOT
    // something #889 introduced -- this never guesses,
    // it only clears an escalation THIS gate is still tracking under the
    // exact same tool_name+tool_input+agentId, and tool_use_id when both
    // sides carry one).
    autoApproveGate.cancelExternallyResolved(
      {
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolUseId: input.tool_use_id,
        agentId: input.agent_id,
      },
      'PermissionDenied',
    );
    autoApproveGate.noteToolUseEnded(input.tool_use_id);
    // #1126: tell the phone why the agent changed course. Never a card:
    // a classifier block fires no PermissionRequest, so nothing waits.
    try {
      deps.onHarnessDenied?.(input);
    } catch (err) {
      logError(`[Hooks] harness_denied push failed for ${sessionId}: ${errorToString(err)}`);
    }
  });

  hookServer.on('Elicitation', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    try {
      const { questionId, outcome } = hookBridge.handleElicitation(input);
      if (input.elicitation_id) {
        rememberElicitation(input.elicitation_id, questionId, outcome);
      }
    } catch (err) {
      logError(`[Hooks] Elicitation handling failed for ${sessionId}: ${errorToString(err)}`);
    }
  });

  hookServer.on('ElicitationResult', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input)) return;
    if (!input.elicitation_id) return;
    resolveElicitation(input.elicitation_id);
  });

  // ---- UserPromptSubmit (#893) --------------------------------------------
  // Registered so the turn-complete timer anchors each turn on the moment the
  // human submits it (`notifications/turn-timer.ts`, via HookServer's
  // `onAnyEvent`). Its other consumer, the auto-approve authority summary, was
  // deleted in #1125. The listener drives the binder like every other
  // listener and, since #1126, closes stale main prompts (below):
  // `HookServer.dispatch` runs it SYNCHRONOUSLY before Claude Code's blocked
  // hook response, so it must stay this cheap.
  hookServer.on('UserPromptSubmit', (input) => {
    binder.onHookEvent(input);
    if (!binder.admits(input) || isSubagentEvent(input)) return;
    // #1126: the user typed a new prompt, so the main agent is not waiting
    // on a permission dialog any more. Closes a main prompt that was
    // answered No in the terminal after its hold was released (that fires
    // no hook at all), so its open entry cannot outlive the turn.
    autoApproveGate.cancelStale('UserPromptSubmit', { mainOnly: true });
  });

  log(`[Hooks] Event bridge active for session ${sessionId}`);

  return {
    bridge: hookBridge,
    /**
     * Does this session's binder claim the event? (#914)
     *
     * Every listener inside this module already consults `binder.admits()`;
     * this exposes the same filter to listeners registered OUTSIDE it. The
     * turn-complete notification in `cli.ts` needs it because two daemons in
     * the SAME project directory both append their own matcher to the shared
     * `.claude/settings.local.json` hooks array (`hook-config-manager.ts`
     * matches on `h.url`, so a second daemon adds rather than replaces), and
     * Claude Code then POSTs every event to both. Without this filter that
     * notification would report a sibling daemon's turn as this session's.
     */
    admits: (input: HookInput) => binder.admits(input),
    closeBinder: () => {
      binder.close();
      // Drop the per-session PermissionRequest resolver (#496) so a stale
      // closure (over this session's gate/tracker) can't fire after teardown.
      hookServer.setPermissionResolver(null);
      // #1126: release any hook still held for this session (the empty
      // response decides nothing) and clear its cards.
      autoApproveGate.cancelStale('session_closed');
    },
    gate: {
      retireQuestion: (questionId) => autoApproveGate.retireQuestion(questionId),
      answerHeld: (questionId, answer) => autoApproveGate.answerHeld(questionId, answer),
      hasMainHold: () => autoApproveGate.hasMainHold(),
      forceRelease: (reason) => autoApproveGate.forceRelease(reason),
    },
  };
}
