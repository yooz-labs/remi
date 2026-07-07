/**
 * AutoApproveGate — owns the PermissionRequest control plane for a session.
 *
 * Epic #453 phase 1: extracted verbatim from `cli/session-phases/hook-bridge-setup.ts`
 * (concern 3 of that file's three braided concerns). It is the third member of the
 * QuestionPipeline boundary, alongside `NotificationDispatcher` and the already-
 * standalone `QuestionPresenceTracker`.
 *
 * Given a PermissionRequest hook event, `resolvePermission` returns a synchronous
 * decision (#496) that Claude honors in the hook response — it either:
 *   - returns 'allow'/'deny' from the auto-approve LLM verdict (NO PTY inject), or
 *   - escalates the prompt to the user and returns 'passthrough' (normal Question flow), or
 *   - default-denies a subagent prompt the user cannot answer via 'deny' (no hang, no PTY), or
 *   - on a primary 'escalate', consults an optional `escalate_model` second opinion
 *     (#522) before bothering the user.
 * The PTY inject path now survives only for multi-choice picks, which the response
 * cannot express.
 *
 * The two outward couplings the hook bridge used directly are injected as callbacks
 * so the gate has no back-reference to the bridge or the hook router:
 *   - `isInSubagentContext()` wraps `HookEventBridge.isInSubagentContext()`
 *   - `escalate(input)` wraps `handlers.onPermissionRequest?.(input)`
 * Both are read LIVE at each branch (never captured): the LLM eval is async, so the
 * subagent/Task context can open or close between the hook firing and the
 * `.then()`/`.catch()` running. Capturing would TOCTOU.
 *
 * #673: the gate also owns EXTERNAL-RESOLUTION cancellation. Every escalation
 * this gate creates (held OR passthrough) is tracked in `openQuestionSignatures`
 * by its (tool_name, tool_input) signature. Two triggers prove an open
 * escalation was resolved WITHOUT going through Remi's own answer path:
 *   - `cancelExternallyResolved`, called from PreToolUse/PostToolUse in
 *     `hook-bridge-setup.ts` when the observed tool signature matches an open
 *     escalation — the tool is now running, so the user must have answered it
 *     directly in the terminal (a passthrough escalation was never held, so
 *     Remi's own answer path never ran) or "the other process's own
 *     permission mode" resolved it independently.
 *   - a duplicate re-request: `escalateToUser` checks for an already-open
 *     entry with the SAME signature before registering a new one — Claude
 *     re-issuing the identical PermissionRequest proves the earlier one can
 *     never be answered through its own hook response again.
 * Both ALWAYS degrade to `releaseHeld(qid, 'passthrough')` — never a
 * fabricated allow/deny — mirroring the existing fail-open philosophy: we
 * cannot know what the user actually decided, so the safest response is "no
 * decision from us," identical to a hold timing out. Own-session scope only:
 * a foreign session's PermissionRequest never creates an entry here in the
 * first place (post-#672 that stays entirely with ForeignSessionEscalator's
 * informational-only push), so there is nothing for this gate to cancel for it.
 */

import type { UUID } from '@remi/shared';

import type { QuestionPresenceTracker } from '../api/question-presence-tracker.ts';
import { log, logError } from '../cli/logger.ts';
import type { PermissionDecision, PermissionRequestHookInput } from '../hooks/index.ts';
import { type DeliveryOutcome, isDelivered } from '../notifications/notification-dispatcher.ts';
import type { SessionRegistry } from '../session/index.ts';
import { isDesignQuestion, isMultiChoicePermission } from './multichoice.ts';
import type { AutoApproveResult } from './types.ts';

/** The (tool_name, tool_input) signature of an OPEN escalation (#673),
 *  tracked so an external-resolution signal can find and cancel it. */
interface ToolSignature {
  readonly toolName: string;
  readonly toolInputKey: string;
  readonly toolUseId: string | undefined;
  /** #711: true when this signature's escalation was for a subagent/team-member
   *  event (`input.agent_id` present). A mainOnly `cancelStale` (Stop) deletes
   *  only main-tagged entries here, so a teammate's still-open escalation is
   *  not wiped out just because the lead agent idled. */
  readonly isSubagent: boolean;
}

/** An observed tool call to correlate against `openQuestionSignatures`. Same
 *  shape whether it came from a PreToolUse/PostToolUse hook or (for the
 *  duplicate-re-request path) a fresh PermissionRequest. */
export interface ObservedToolCall {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseId?: string | undefined;
}

/**
 * A stable, key-order-independent JSON key for `tool_input` (#673). Two
 * logically identical tool_input objects with keys in a different order must
 * compare equal, so the signature match is not order-fragile.
 */
function stableToolInputKey(toolInput: Record<string, unknown>): string {
  try {
    return JSON.stringify(canonicalize(toolInput));
  } catch {
    // Non-serializable input should not happen (tool_input comes from a
    // parsed JSON hook payload); degrade to a key that can never match
    // anything rather than throwing into the escalation path.
    return `__unserializable__:${Math.random()}`;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sortedEntries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}

/**
 * Minimal seam the gate consumes. The real `AutoApproveService` satisfies it
 * structurally; tests inject a real object literal returning real
 * `AutoApproveResult` values, so the gate's branching is exercised without a
 * mocking framework or a live LLM.
 */
export interface AutoApproveEvaluator {
  /**
   * Evaluate a permission request. MUST NOT throw — return an `escalate` result
   * instead so the gate's decision path is deterministic. A rejected Promise is
   * tolerated (the gate's `.catch` treats it identically to `escalate`), but a
   * synchronous throw would escape into the hook dispatch loop.
   */
  evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    tag?: string,
    permissionSuggestions?: readonly unknown[],
    modelOverride?: string,
    evalId?: number,
    /** #730: this gate's own sessionId, so the shared daemon-wide service can
     *  isolate concurrent sessions' evals — a queued/running eval belonging
     *  to one session must never be cancelled or drained by another
     *  session's `cancelStale` / `cancelEvalForQuestion`. Omitted only by
     *  test doubles / direct-service unit tests that never mix scopes. */
    scope?: string,
    /** #730: tags a queued waiter so `drainScope(scope, {mainOnly: true})` can
     *  spare it the same way `cancelStale`'s running-eval cancel already
     *  spares a subagent eval via `evalIsSubagentById`. */
    isSubagent?: boolean,
  ): Promise<AutoApproveResult>;
  /**
   * Abort an in-flight `evaluate`. With `evalId`, aborts ONLY when that id is the
   * eval currently running (#617 per-eval scoping); without it, aborts whatever
   * is in flight. `scope` (#730) additionally requires the target belong to that
   * scope, so two sessions can never cancel each other's work by accident.
   * Omitting BOTH `evalId` and `scope` is a fully untargeted cancel — reserved
   * for `forceRelease` (the documented `remi unstick` global escape hatch);
   * every per-session caller here (`cancelStale`, `cancelEvalForQuestion`) passes
   * its own scope. Returns true if an abort was issued, false otherwise
   * (idempotent).
   */
  cancel(reason: string, evalId?: number, scope?: string): boolean;
  /** Drain queued evals so they escalate gracefully instead of seizing the freed
   *  GPU (#617 force-release). GLOBAL — every session's queue, not just this
   *  gate's own. Returns the number drained. Optional: a minimal evaluator
   *  under test may omit it. */
  drainQueue?(): number;
  /** #730: drain only THIS scope's queued evals (optionally main-tagged only),
   *  so `cancelStale` can drop a session's own moot queued work without
   *  touching a sibling session's queue or (mainOnly) a teammate's still-
   *  legitimate wait. Returns the number drained. Optional: a minimal
   *  evaluator under test may omit it. */
  drainScope?(scope: string, opts?: { mainOnly?: boolean }): number;
}

export interface AutoApproveGateDeps {
  /** null => no auto-approve configured; the no-AA escalate/default-deny path runs. */
  service: AutoApproveEvaluator | null;
  sessionRegistry: SessionRegistry;
  tracker: QuestionPresenceTracker;
  /** Wraps `HookEventBridge.isInSubagentContext()`. Read live per branch (async TOCTOU). */
  isInSubagentContext: () => boolean;
  /**
   * Reset the subagent-context tracker (#710). Called ONLY when a MAIN-tagged
   * PermissionRequest (`agent_id` absent) observes `isInSubagentContext()`
   * stuck true — proof of a tracker leak (a dropped PostToolUse(Task/Agent)
   * completion), never a real subagent prompt (those carry `agent_id` and
   * default-deny instead). Optional so tests that don't wire it degrade to a
   * no-op; the escalate-as-main recovery still happens without it, just
   * without clearing the leaked state.
   */
  resetSubagentContext?: () => void;
  /** Escalate to the user (wraps `handlers.onPermissionRequest`). Returns the id
   *  of the `Question` it created (#573), so a binary escalation can hold the
   *  hook keyed by that id and resolve it when the user answers; `undefined`
   *  means no question was created (e.g. the push failed) and the gate must
   *  fall open to passthrough rather than hold a hook nobody can answer. The
   *  gate wraps every call in a try/catch, so an implementation that throws is
   *  logged and absorbed (treated as `undefined`) rather than propagated. */
  escalate: (input: PermissionRequestHookInput, summary?: string) => UUID | undefined;
  /** Called right before the LLM eval starts, so the tracker can BUFFER the PTY
   *  prompt until the verdict (don't push an auto-approved permission). #484.
   *  `ctx.isSubagent` (#711) tells the setup layer whether this eval belongs to
   *  a subagent/team-member permission, so it can skip the client status-pill
   *  broadcast for it (the #484 buffering itself is unaffected). */
  onEvalStart?: (ctx: { isSubagent: boolean }) => void;
  /** Called when the verdict is escalate (the user must answer), so the tracker
   *  releases the buffered PTY prompt. #484. */
  onEscalate?: () => void;
  /** The gate's push trigger: called with a `Question.id` so the tracker pushes
   *  that question IMMEDIATELY (-> sessionRegistry.addQuestion + APNS), making it
   *  answerable. Called for BOTH escalation shapes (#625):
   *    - a BINARY escalation that HOLDS its hook (Model B, #573) — Claude blocks on
   *      the response and never renders the native prompt (via `createHold`);
   *    - a PASSTHROUGH escalation (multi-choice / design / AskUserQuestion) via
   *      `escalatePassthrough`.
   *  Since #625, PTY question-emission is suppressed for hooked sessions, so this
   *  callback is the SOLE push trigger in both cases — do NOT remove it from the
   *  passthrough path believing `onPTYPromptVisible` covers it (it does not; that
   *  would silently drop every passthrough notification). Idempotent per id
   *  (`pushedHeldIds`), so it can never double-push. Absent => no immediate push
   *  (tests / no-AA callers). #573 / #625 */
  onHeldEscalate?: (questionId: UUID) => void;
  /** Called when a HELD question's hold-timeout expires unanswered, JUST BEFORE
   *  it fails open to passthrough (#733). Fired only on the TIMEOUT path — never
   *  on the undeliverable fail-open (#603 delivery gate), where the push channel
   *  is already known broken and a handoff push would be pointless. The question
   *  is still registered in sessionRegistry when this fires, so the callback can
   *  read its text to build a "moved to the terminal" handoff notification.
   *  Without it, the timeout is SILENT on the phone: the card is dismissed and
   *  nothing says the prompt now waits in the terminal. Throw-safe (safeCue). */
  onHoldTimeout?: (questionId: UUID) => void;
  /** Called when the permission was auto-approved/denied silently (inject
   *  succeeded; the user never sees it). Drives the terminal "done" cue. #513.
   *  `ctx.isSubagent` (#711): same client-broadcast-only skip as `onEvalStart`
   *  -- the terminal cue above still fires either way. */
  onHandled?: (ctx: { isSubagent: boolean }) => void;
  /** Called when the eval ended without a verdict (cancelled — the user already
   *  advanced past the prompt). Drives the terminal cue back to idle. #513. */
  onCancelled?: () => void;
  /**
   * Called when a HELD question resolved WITHOUT the user answering it through
   * the WebSocket/relay answer path (#585, P7): a Part-B slow-eval verdict landed
   * after the early push (auto_approved/auto_denied), the hold timed out, or
   * cancelStale released it (cancelled). The daemon broadcasts a `question_resolved`
   * + fires the APNS dismissal so the pushed card clears on every client. NOT
   * called for a user answer — that path (input-events.handleAnswer) broadcasts
   * its own 'answered' resolution, so wiring it here too would double-fire.
   * Throw-safe at the call site (routed through `safeCueWithArg`), so a broadcast
   * failure can never break the decision/hold path. Absent => no resolution
   * broadcast (tests / no-AA callers). */
  onResolved?: (questionId: UUID, reason: 'auto_approved' | 'auto_denied' | 'cancelled') => void;
  /** Second-opinion model consulted on a primary 'escalate' in main context
   *  (#522). Empty/absent => no second opinion (escalate straight to the user). */
  escalateModel?: string;
  /** Tools that ALWAYS escalate to the user, never auto-decided (#572). Used by
   *  the gate to classify an escalation as binary (holdable) vs design (#573):
   *  a design/plan-mode tool's pick cannot be expressed by the hook response, so
   *  it passes through instead of holding. Absent => empty set (no extra tools). */
  alwaysEscalateTools?: ReadonlySet<string>;
  /** Milliseconds to HOLD a binary main-context PermissionRequest hook open
   *  after escalating, until the user answers (Model B, #573). On expiry the
   *  hold resolves 'passthrough' (fail open -> native prompt). <=0 (or absent)
   *  disables holding: escalations return 'passthrough' immediately as before. */
  holdMs?: number;
  /** Milliseconds before a SLOW binary main-context eval triggers an early
   *  push + hold (Part B, #573). If the eval has not produced a verdict within
   *  this window, the gate pushes + holds the hook so the user can step in; a
   *  late verdict then resolves the held hook. <=0 (or absent) disables Part B
   *  entirely — the eval/timer race never arms, so behavior reverts to A+C. */
  pushHoldMs?: number;
  /**
   * Probe a held escalation's notification delivery outcome (epic #603 Phase 1,
   * R1/R2). Returns the promise `NotificationDispatcher.maybePush` recorded for
   * `questionId`, or undefined when no push was attempted. The gate races it
   * against `deliveryConfirmMs`: a hold whose notification is never confirmed
   * delivered no longer blocks Claude for the full `holdMs` — it fails open fast
   * (or holds a short secondary window, `holdUnconfirmedMs`). Absent => delivery
   * gating disabled (legacy: hold to holdMs regardless of delivery). */
  awaitDelivery?: (questionId: UUID) => Promise<DeliveryOutcome> | undefined;
  /** Milliseconds to wait for a held escalation's delivery to be confirmed
   *  before treating it as undeliverable (epic #603 Phase 1). <=0 (or absent)
   *  disables delivery gating. From `auto_approve.delivery_confirm_timeout`. */
  deliveryConfirmMs?: number;
  /** Milliseconds to keep holding an UNDELIVERED escalation instead of failing
   *  open immediately (epic #603 Phase 1, D2 — hold-always-no-phone). <=0 (or
   *  absent) => fail open fast. From `auto_approve.hold_unconfirmed_timeout`. */
  holdUnconfirmedMs?: number;
}

/** A held PermissionRequest hook awaiting a user answer (#573). The `resolve`
 *  fulfills the promise the hook server is blocked on; the `timer` fails it open
 *  to passthrough on hold-timeout. Keyed by the escalated `Question.id`. */
interface PendingHold {
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  /** #711: true for a subagent/team-member escalation (`input.agent_id`
   *  present at hold-creation time). A lead's `Stop` fires while teammates
   *  keep working, so `cancelStale('Stop', { mainOnly: true })` releases only
   *  MAIN holds and leaves this one intact -- its pushed card stays
   *  answerable via `resolveHeld`. */
  isSubagent: boolean;
  /** The escalated input's own `permission_suggestions`, stashed so a later
   *  `resolveHeld(..., suggestionIndex)` can echo the EXACT original entry
   *  back as `updatedPermissions` (#718) -- Claude Code's hooks docs: echoing
   *  a received suggestion "is equivalent to the user selecting that 'always
   *  allow' option in the dialog." Undefined when the input carried none. */
  suggestions: readonly unknown[] | undefined;
}

export class AutoApproveGate {
  private readonly sessionTag: string;

  /**
   * Binary main-context escalations currently holding their PermissionRequest
   * hook open, keyed by the escalated `Question.id` (#573). Per-gate, so each
   * session's holds are isolated. An entry lives from `escalateAndHold` until it
   * is resolved by `resolveHeld` (the user answered), by the hold-timeout timer
   * (fail open -> passthrough), or by `cancelStale` (session ended). Every exit
   * path clears the timer and deletes the entry, so it never leaks.
   */
  private readonly pendingHolds = new Map<UUID, PendingHold>();

  /** Monotonic id stamped on each primary eval (#617), so a held question can be
   *  tied to the exact eval running for it and a manual answer cancels only that
   *  one. */
  private evalSeq = 0;

  /**
   * Maps a held question's id to the id of the eval still running for it (#617),
   * populated only by Part B (the early push + hold fires WHILE the eval keeps
   * running — the one case where the user can answer mid-eval). A manual answer
   * looks the question up here to cancel exactly its eval and free the GPU.
   * Entries are removed when the eval settles (reconcileLateVerdict) or on
   * force-release; a stale entry is harmless (cancel no-ops if that eval is no
   * longer the running one).
   */
  private readonly evalIdByQuestion = new Map<UUID, number>();

  /**
   * Subagent-ness of every primary eval currently in flight, keyed by its
   * `evalId` (#711). Populated in `resolvePermission` right after the eval is
   * stamped/started, deleted when that eval's own promise settles (evaluate()
   * is documented never to throw, so its `.finally` always runs exactly once).
   * Lets `cancelStale('Stop', { mainOnly: true })` cancel ONLY main-context
   * evals: under synchronous decisions a main eval cannot be in flight at Stop
   * (Claude blocks on the hook while the gate evaluates), so any eval still
   * tracked here at lead-Stop is a teammate's and must survive.
   */
  private readonly evalIsSubagentById = new Map<number, boolean>();

  /**
   * Every OPEN escalation this gate has created (held OR passthrough), keyed
   * by `Question.id`, by its (tool_name, tool_input) signature (#673). Entry
   * lifecycle: created in `escalateToUser` on a successful escalation; removed
   * by exactly TWO owners, unconditionally (regardless of whether a hold
   * existed), so no exit path can leak an entry:
   *   - the public `resolveHeld` (a separate, non-delegating path — it owns
   *     its own delete);
   *   - the private `releaseHeld`, which EVERY other resolution path funnels
   *     through: `releaseHeldAsPassthrough` (normal answer), `failOpenHeld`
   *     (hold-timeout / undelivered-notification fail-open),
   *     `reconcileLateVerdict`'s cancelled branch (Part B), and
   *     `resolveSupersededQuestion` (#673's own external-resolution / stale
   *     -duplicate cleanup).
   * `cancelStale` and `forceRelease` additionally wholesale-clear the whole
   * map (session end / force-release — nothing tracked is relevant after
   * either). A stale entry is harmless (a signature match just triggers a
   * redundant, idempotent cleanup), but MUST NOT be able to accumulate
   * indefinitely: an un-deleted entry from a timed-out/cancelled hold would
   * sit for the rest of the process lifetime and could fire a spurious
   * `notifyResolved` for a question dead for hours on a much-later,
   * unrelated duplicate of the same command.
   */
  private readonly openQuestionSignatures = new Map<UUID, ToolSignature>();

  constructor(
    private readonly deps: AutoApproveGateDeps,
    private readonly sessionId: UUID,
  ) {
    this.sessionTag = sessionId.slice(0, 8);
  }

  /**
   * Cancel any in-flight auto-approve LLM eval. The bridge calls this on hook events
   * that unambiguously confirm Claude advanced past a prompt (PreToolUse / PostToolUse /
   * Stop / SessionEnd): the user already answered, and a stale LLM result would inject
   * into the wrong PTY position or emit a phantom question.
   *
   * Deliberately NOT called on Notification events: idle_prompt can fire while a
   * permission eval is still legitimately in flight, and auth_success /
   * elicitation_dialog don't carry "user answered" semantics either. No-op when no
   * service is configured.
   *
   * `opts.mainOnly` (#711) scopes the release/cancel to MAIN-context state
   * only. `Stop` fires whenever the LEAD agent idles, even while teammates
   * (subagent/`agent_id`-tagged escalations) are still running -- releasing/
   * cancelling EVERYTHING on a lead Stop turned every teammate's already-
   * pushed card phantom (answering it resolved nothing) and killed their
   * in-flight evals. `SessionEnd` and `forceRelease` are real teardown and
   * always release/cancel everything (mainOnly absent/false) -- there is no
   * "the rest of the team is still going" case once the session has ended.
   *
   * Accepted tradeoff: if a teammate is killed WITHOUT Claude ever emitting
   * its own `SessionEnd` for that team member (e.g. the whole process is
   * torn down externally), its spared held card has no further release
   * trigger and sits until the pre-existing `hold_timeout` (default 1800s)
   * fails it open on its own timer -- bounded, not indefinite.
   */
  cancelStale(reason: string, opts?: { mainOnly?: boolean }): void {
    const mainOnly = opts?.mainOnly ?? false;
    // Release held hooks first (#573): a teardown means the session is going
    // away, so a hook blocked on a human answer must fail open to passthrough
    // rather than hang. mainOnly (#711) keeps subagent/team-member holds alive
    // -- their hooks are still blocked in a still-running teammate and remain
    // answerable via `resolveHeld`.
    this.releaseAllHolds('passthrough', reason, mainOnly);
    // #673 / #711: every OPEN escalation this gate has tracked (held above, or
    // a passthrough one with no hold) is moot on a full teardown -- wholesale
    // clear, as before. On a mainOnly Stop, only the MAIN-tagged entries are
    // moot; a teammate's is not (its hold, if any, was just spared above, and
    // its signature must stay trackable for external-resolution cancellation).
    if (mainOnly) {
      for (const [qid, sig] of this.openQuestionSignatures) {
        if (!sig.isSubagent) this.openQuestionSignatures.delete(qid);
      }
    } else {
      this.openQuestionSignatures.clear();
    }
    if (this.deps.service === null) return;
    // #730 (BUG 1 fix): drop THIS session's own QUEUED evals first -- work a
    // teardown or a mainOnly Stop has already decided is moot must never
    // survive in the shared FIFO to be promoted onto the GPU later just
    // because the eval ahead of it happens to release around the same time.
    // Scoped to this gate's own sessionId, so a sibling session's queue is
    // untouched; mainOnly additionally spares a queued subagent/team-member
    // eval, mirroring the running-eval loop below.
    const drainedCount = this.deps.service.drainScope?.(this.sessionId, { mainOnly }) ?? 0;
    if (drainedCount > 0) {
      log(`[AutoApprove ${this.sessionTag}] Drained ${drainedCount} queued eval(s) (${reason})`);
    }
    if (!mainOnly) {
      // #730 (BUG 3 fix): scoped to this session, so a SessionEnd here can
      // never abort a DIFFERENT session's running eval just because it
      // happens to be the one holding the shared (daemon-wide) slot.
      if (this.deps.service.cancel(reason, undefined, this.sessionId)) {
        log(`[AutoApprove] Cancelled stale LLM eval: ${reason}`);
      }
      return;
    }
    // #711: cancel ONLY the in-flight evals tagged main. Under synchronous
    // decisions a main eval cannot be in flight at Stop anyway (Claude blocks
    // on the hook while the gate evaluates it), so this is defensive; any eval
    // that IS running/queued at lead-Stop is a teammate's and must keep going.
    // #730 (BUG 2 fix): scoped, so an identically-numbered evalId belonging to
    // a DIFFERENT session (evalId is only unique per-gate) can never be hit
    // by mistake.
    let cancelledCount = 0;
    for (const [evalId, isSubagent] of this.evalIsSubagentById) {
      if (isSubagent) continue;
      if (this.deps.service.cancel(reason, evalId, this.sessionId)) cancelledCount += 1;
    }
    if (cancelledCount > 0) {
      log(`[AutoApprove] Cancelled ${cancelledCount} stale MAIN-context LLM eval(s): ${reason}`);
    }
  }

  /**
   * Cancel the in-flight eval (if any) for a question the user just answered, so
   * the GPU is freed immediately (#617, the user's critical "answer == GPU freed"
   * contract). Scoped by the per-question eval id, so it aborts ONLY that
   * question's eval and never another permission's that happens to be running.
   * Unlike `cancelStale` it does NOT release other holds — answering one question
   * must never fail the others open. No-op when no eval is tracked (it already
   * settled, or the question was not held mid-eval), so it is safe to call on
   * every answer unconditionally.
   */
  cancelEvalForQuestion(questionId: UUID, reason: string): void {
    const evalId = this.evalIdByQuestion.get(questionId);
    if (evalId === undefined) return;
    this.evalIdByQuestion.delete(questionId);
    // #730: scoped to this session's own sessionId, so this evalId can never
    // collide with an identically-numbered eval belonging to a different
    // session (evalId is only unique per-gate).
    if (this.deps.service?.cancel(reason, evalId, this.sessionId)) {
      log(
        `[AutoApprove ${this.sessionTag}] Answer freed the eval for ${questionId.slice(0, 8)} (${reason})`,
      );
    }
  }

  /**
   * Force-release escape (#617, `remi unstick`): the "just get me out" lever when
   * Ollama and a question are stuck and the phone has no device visibility.
   * Releases EVERY held hook to passthrough (the native terminal prompt), aborts
   * the in-flight eval, and drains queued evals so they escalate gracefully
   * instead of seizing the freed GPU. Safe with no service configured (only
   * releases holds). Returns a summary for the caller to log.
   */
  forceRelease(reason: string): { holds: number; cancelled: boolean; drained: number } {
    const holds = this.pendingHolds.size;
    this.releaseAllHolds('passthrough', reason);
    this.evalIdByQuestion.clear();
    // #673: mirrors cancelStale's wholesale clear -- a force-release is at
    // least as final as a session end for bookkeeping purposes.
    this.openQuestionSignatures.clear();
    const service = this.deps.service;
    if (service === null) return { holds, cancelled: false, drained: 0 };
    const cancelled = service.cancel(reason);
    const drained = service.drainQueue?.() ?? 0;
    log(
      `[AutoApprove ${this.sessionTag}] Force-release (${reason}): released ${holds} hold(s), ${cancelled ? 'cancelled the eval' : 'no eval in flight'}, drained ${drained} queued`,
    );
    return { holds, cancelled, drained };
  }

  /**
   * Resolve a held PermissionRequest hook (#573). Called when the user answers
   * from any channel (input-events.ts maps the picked option to allow/deny).
   * Returns true when a hold for `questionId` existed and was resolved (the
   * caller then skips the PTY inject — Claude is blocked on the hook, not
   * rendering a prompt); false when no such hold exists (a non-held answer, e.g.
   * a multi-choice pick or a non-auto-approve session, takes the PTY path).
   * Clears the hold's timer and marks the permission handled so the #484 buffer
   * + #513 cue close exactly as for a silent auto-decision.
   *
   * `suggestionIndex` (#718): present when the user picked a suggestion-derived
   * "Yes, always allow: ..." option. `decision` is still `'allow'` in that case
   * (the caller maps isNo -> deny, everything else it can express -> allow);
   * this resolves the hook with the RICHER `{behavior:'allow',
   * updatedPermissions:[suggestions[suggestionIndex]]}` instead, echoing the
   * exact original entry back to Claude Code so it actually persists the
   * choice — the real "Yes, always" the bare `allow` could never express. A
   * stale/out-of-range index (the hold's stashed suggestions no longer have
   * that entry) degrades to a plain `allow` with a loud warning rather than
   * silently dropping the escalation.
   */
  resolveHeld(questionId: UUID, decision: 'allow' | 'deny', suggestionIndex?: number): boolean {
    // #673: this is the NORMAL answer path (input-events.ts), so an open
    // escalation this question tracked is resolved now regardless of which
    // branch below runs -- clear it unconditionally, not just on the hit path.
    this.openQuestionSignatures.delete(questionId);
    const hold = this.pendingHolds.get(questionId);
    if (!hold) return false;
    clearTimeout(hold.timer);
    this.pendingHolds.delete(questionId);
    // Remove the registry entry too (#585, P7 FIX 2): the held question was
    // registered via pushHeldHook -> addQuestion, so resolving the hold without
    // this leaves a ghost card that replays on reconnect and lets a late
    // handleAnswer find it "live" and misroute. The user-answer path also
    // removes it in handleAnswer's finally; a double-remove is idempotent.
    this.deps.sessionRegistry.removeQuestion(this.sessionId, questionId);
    this.markHandled(hold.isSubagent);
    let resolvedDecision: PermissionDecision = decision;
    let logSuffix: string = decision;
    if (decision === 'allow' && suggestionIndex !== undefined) {
      const suggestion = hold.suggestions?.[suggestionIndex];
      if (suggestion !== undefined) {
        resolvedDecision = { behavior: 'allow', updatedPermissions: [suggestion] };
        logSuffix = 'allow (updatedPermissions echoed)';
      } else {
        logError(
          `[AutoApprove ${this.sessionTag}] Held hook ${questionId.slice(0, 8)}: suggestionIndex ${suggestionIndex} missing from stashed permission_suggestions; falling back to plain allow`,
        );
      }
    }
    hold.resolve(resolvedDecision);
    log(
      `[AutoApprove ${this.sessionTag}] Held hook ${questionId.slice(0, 8)} resolved: ${logSuffix}`,
    );
    return true;
  }

  /**
   * Release a held hook to 'passthrough' so Claude renders its native numbered
   * prompt (#573). Used when the user's answer cannot be expressed by the binary
   * hook response — a "Yes, always" or a multi-choice pick — so the daemon pops
   * the hold and the caller then injects the digit into the freshly-rendered
   * prompt. Returns true iff a hold for `questionId` existed. Public wrapper over
   * the private `releaseHeld(qid, 'passthrough')`; no markHandled (the user is
   * about to answer the native prompt, not a silent auto-decision).
   */
  releaseHeldAsPassthrough(questionId: UUID): boolean {
    // #673: openQuestionSignatures cleanup lives in the private releaseHeld
    // itself (the single owner every internal caller funnels through), so
    // there is nothing extra to do here.
    return this.releaseHeld(questionId, 'passthrough');
  }

  /** Resolve pending holds with one decision + reason, clearing timers and
   *  removing each released entry. Used by `cancelStale` (session teardown, or
   *  a mainOnly-scoped Stop, #711) -- `mainOnly` releases only holds NOT
   *  tagged subagent, leaving a teammate's hold (and its timer) intact so it
   *  stays answerable via `resolveHeld`. */
  private releaseAllHolds(decision: PermissionDecision, reason: string, mainOnly = false): void {
    const targets = mainOnly
      ? [...this.pendingHolds].filter(([, hold]) => !hold.isSubagent)
      : [...this.pendingHolds];
    if (targets.length === 0) return;
    log(
      `[AutoApprove ${this.sessionTag}] Releasing ${targets.length} held hook(s) as ${decision} (${reason}${mainOnly ? ', main-only' : ''})`,
    );
    for (const [qid, hold] of targets) {
      clearTimeout(hold.timer);
      // The session is going away (Stop/SessionEnd); dismiss the pushed card on
      // every client BEFORE resolving so it does not linger after the prompt is
      // gone (#585, P7), and drop the registry entry so no ghost card replays.
      this.notifyResolved(qid, 'cancelled');
      this.deps.sessionRegistry.removeQuestion(this.sessionId, qid);
      hold.resolve(decision);
      this.pendingHolds.delete(qid);
    }
  }

  /**
   * Escalate a binary main-context PermissionRequest to the user AND hold the
   * hook open until the user answers (Model B, #573). `escalate()` stashes the
   * hook record + pushes (returning the created `Question.id`); `onEscalate`
   * releases the #484 buffer. Then:
   *   - no question id (push failed) or holding disabled (holdMs <= 0) ->
   *     'passthrough' (today's behavior: Claude renders its native prompt).
   *   - else return a promise that stays PENDING until `resolveHeld` fulfills it
   *     with allow/deny, or the hold-timeout fires and fails it open to
   *     'passthrough' (so the terminal is never permanently stuck).
   * The returned promise is what the hook server is blocked on.
   */
  private escalateAndHold(
    input: PermissionRequestHookInput,
    summary?: string,
  ): Promise<PermissionDecision> {
    return this.createHold(input, summary).decision;
  }

  /**
   * Escalate (push) a binary main-context permission and register a hold,
   * returning BOTH the held promise the hook server blocks on AND the created
   * `Question.id` (so Part B can reconcile a late verdict into the same hold).
   * `questionId` is undefined when no question was created (push failed) or
   * holding is disabled — in which case `decision` is an immediate 'passthrough'
   * (today's behavior) and no hold is registered.
   */
  private createHold(
    input: PermissionRequestHookInput,
    summary?: string,
  ): {
    decision: Promise<PermissionDecision>;
    questionId: UUID | undefined;
  } {
    const qid = this.escalateToUser(input, summary);
    const holdMs = this.deps.holdMs ?? 0;
    if (!qid || holdMs <= 0) return { decision: Promise.resolve('passthrough'), questionId: qid };
    // A held binary escalation BLOCKS Claude's hook response, so Claude never
    // renders the native prompt and the tracker's PTY-render push trigger never
    // fires. Push the held question NOW so it is registered in sessionRegistry
    // (answerable) and pushed to the phone, keyed by the SAME id the hold uses
    // (#573). safeCue: cosmetic-shielded like the other lifecycle callbacks — a
    // push failure here must not break the decision path. ONLY here (a real
    // hold), never on the passthrough/multi-choice branches above (which push
    // via onPTYPromptVisible and would double-push).
    this.safeCueWithArg('onHeldEscalate', this.deps.onHeldEscalate, qid);
    const decision = new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        // #733: tell the phone the prompt is MOVING to the terminal before the
        // card is dismissed — while the question is still in sessionRegistry so
        // the handoff push can carry its text. Guarded on the hold still being
        // live so an already-answered/cancelled hold never fires a stale
        // handoff (failOpenHeld below no-ops the same way).
        if (this.pendingHolds.has(qid)) {
          this.safeCueWithArg('onHoldTimeout', this.deps.onHoldTimeout, qid);
        }
        this.failOpenHeld(qid, `Held hook ${qid.slice(0, 8)} timed out -> passthrough`);
      }, holdMs);
      // setTimeout keeps the event loop alive for the whole human-paced hold;
      // unref so a held hook never blocks daemon shutdown.
      timer.unref?.();
      this.pendingHolds.set(qid, {
        resolve,
        timer,
        isSubagent: this.isSubagentEvent(input),
        // #718: stashed so a later resolveHeld(..., suggestionIndex) can echo
        // back the exact original entry the user picked.
        suggestions: input.permission_suggestions,
      });
    });
    // Phase 1 (#603, R1/R2): gate the hold on CONFIRMED delivery. A held hook is
    // only worth blocking Claude for if the user can actually be notified; if
    // the notification is not confirmed delivered within delivery_confirm_timeout
    // (e.g. a dead device token), fail open fast instead of stalling for holdMs.
    this.armDeliveryGate(qid);
    return { decision, questionId: qid };
  }

  /**
   * Fail a held hook OPEN to passthrough (#573 hold-timeout / #603 undeliverable):
   * dismiss the now-stale pushed card on every client, drop the registry entry,
   * and resolve the hook so Claude renders its native prompt and the local
   * terminal can take over. No-op when the hold is already gone (answered, Part-B
   * verdict, cancelled) so it never double-resolves.
   */
  private failOpenHeld(qid: UUID, logMessage: string): void {
    if (!this.pendingHolds.has(qid)) return;
    log(`[AutoApprove ${this.sessionTag}] ${logMessage}`);
    // Dismiss the stale card everywhere BEFORE resolving (#585, P7); releaseHeld
    // then clears the timer, drops the registry entry, and resolves passthrough.
    this.notifyResolved(qid, 'cancelled');
    this.releaseHeld(qid, 'passthrough');
  }

  /**
   * Race a held escalation's notification delivery against `deliveryConfirmMs`
   * (epic #603 Phase 1). If delivery is confirmed (`isDelivered`: in_app / pushed
   * — `deduped` does NOT count, and never occurs for held pushes after Phase 3)
   * in time, the hold keeps blocking to `holdMs` as before. If it is NOT confirmed
   * — a dead token, no registered token, or the probe times out — the hold no
   * longer stalls Claude for the full window: `onDeliveryUnconfirmed` fails it
   * open fast (or re-arms a short secondary hold). Disabled (legacy hold) when
   * `deliveryConfirmMs <= 0` or no delivery signal was recorded for `qid`.
   */
  private armDeliveryGate(qid: UUID): void {
    const confirmMs = this.deps.deliveryConfirmMs ?? 0;
    if (confirmMs <= 0) return; // delivery gating disabled (legacy hold to holdMs)
    const probe = this.deps.awaitDelivery?.(qid);
    if (!probe) {
      // Gating is ON but no delivery signal was recorded for this question —
      // either awaitDelivery is unwired, or onHeldEscalate threw before maybePush
      // ran (its throw is swallowed as a cosmetic cue). Fall back to the legacy
      // hold, but log it: a silently-skipped gate could still stall to holdMs.
      log(
        `[AutoApprove ${this.sessionTag}] No delivery signal for ${qid.slice(0, 8)}; delivery gate skipped (holding to hold_timeout)`,
      );
      return;
    }
    const timeout = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), confirmMs);
      t.unref?.();
    });
    Promise.race([probe, timeout])
      .then((result) => {
        // The hold may already be resolved (user answered, Part-B verdict, or a
        // cancel) — then there is nothing to gate.
        if (!this.pendingHolds.has(qid)) return;
        if (result !== 'timeout' && isDelivered(result)) return; // confirmed: keep holding
        this.onDeliveryUnconfirmed(qid, result);
      })
      .catch((err) => {
        logError(
          `[AutoApprove ${this.sessionTag}] delivery probe threw (treating as unconfirmed):`,
          err,
        );
        if (this.pendingHolds.has(qid)) this.onDeliveryUnconfirmed(qid, 'failed');
      });
  }

  /**
   * A held escalation's notification was NOT confirmed delivered (epic #603
   * Phase 1). Default (hybrid): fail open NOW so the local terminal can answer,
   * instead of blocking Claude for the full `holdMs` on a notification nobody
   * received. When `holdUnconfirmedMs > 0` (D2 hold-always-no-phone): re-arm the
   * hold to a SHORT secondary window so a transient failure can recover before
   * fail-open. Either path is LOUD (logError) so an undelivered notification is
   * never a silent stall.
   */
  private onDeliveryUnconfirmed(qid: UUID, reason: DeliveryOutcome | 'timeout'): void {
    if (!this.pendingHolds.has(qid)) return;
    const holdUnconfirmedMs = this.deps.holdUnconfirmedMs ?? 0;
    if (holdUnconfirmedMs > 0) {
      const hold = this.pendingHolds.get(qid);
      if (!hold) return;
      clearTimeout(hold.timer);
      const timer = setTimeout(() => {
        this.failOpenHeld(
          qid,
          `Held hook ${qid.slice(0, 8)} still undelivered (${reason}); short hold expired -> passthrough`,
        );
      }, holdUnconfirmedMs);
      timer.unref?.();
      this.pendingHolds.set(qid, {
        resolve: hold.resolve,
        timer,
        isSubagent: hold.isSubagent,
        suggestions: hold.suggestions,
      });
      logError(
        `[AutoApprove ${this.sessionTag}] Held hook ${qid.slice(0, 8)} notification UNCONFIRMED (${reason}); holding ${Math.round(holdUnconfirmedMs / 1000)}s (hold_unconfirmed_timeout) with retry before fail-open`,
      );
      return;
    }
    logError(
      `[AutoApprove ${this.sessionTag}] Held hook ${qid.slice(0, 8)} notification UNDELIVERED (${reason}); failing open to passthrough so the terminal can answer (no notification reached your devices)`,
    );
    this.failOpenHeld(qid, `Held hook ${qid.slice(0, 8)} undelivered -> passthrough`);
  }

  /**
   * Escalate a main-context permission to the user (#573). A BINARY escalation
   * holds the hook open (`escalateAndHold`) so the user's answer resolves it via
   * the hook response with no PTY render; a multi-choice / design escalation
   * cannot be expressed by the binary response, so it escalates + returns
   * 'passthrough' immediately (Claude renders the native prompt and the pick is
   * delivered by the legacy PTY path / a later phase). Always main context — the
   * subagent escalate paths default-deny and never reach here.
   */
  private escalateMain(
    input: PermissionRequestHookInput,
    summary?: string,
  ): Promise<PermissionDecision> {
    if (this.isBinaryEscalation(input)) {
      return this.escalateAndHold(input, summary);
    }
    return Promise.resolve(this.escalatePassthrough(input, summary));
  }

  /**
   * Escalate a NON-holdable (passthrough) permission to the user AND push it from
   * the gate (#625). A binary escalation pushes via `createHold` -> `onHeldEscalate`;
   * a passthrough one (multi-choice / design / AskUserQuestion) historically relied
   * on the PTY render to trigger its push (`onPTYPromptVisible`). That coupling is the
   * phantom-notification source: the PTY echoes EVERY on-screen prompt, including ones
   * the gate already auto-approved. The gate is now the single push trigger, so a
   * passthrough escalation must push here too — otherwise, with PTY question-emission
   * gated off for hooked sessions (#625), the escalation would never reach the phone.
   *
   * Reuses the held-push primitive (`onHeldEscalate` -> `tracker.pushHeldHook`): it
   * registers the stashed question in `sessionRegistry` (answerable) and delivers it to
   * the lock screen idempotently. No hold is registered — Claude renders its native
   * prompt and waits there — so there is no delivery gate / hold timeout; the user
   * answers the pushed card (digit injected via the PTY) or the terminal directly.
   */
  private escalatePassthrough(
    input: PermissionRequestHookInput,
    summary?: string,
  ): PermissionDecision {
    const qid = this.escalateToUser(input, summary);
    if (qid) {
      this.safeCueWithArg('onHeldEscalate', this.deps.onHeldEscalate, qid);
    } else {
      // escalateToUser returned no id (escalate() threw — already logged there).
      // Unlike a binary hold there is no timer fallback here, so make the lost
      // push explicit: Claude still renders + waits at its native terminal prompt
      // (the user can answer locally), but no phone notification was sent.
      logError(
        `[AutoApprove ${this.sessionTag}] passthrough escalation produced no question id; no push sent (terminal prompt still answerable locally)`,
      );
    }
    return 'passthrough';
  }

  /**
   * Whether an escalated permission is BINARY (answerable allow/deny via the
   * hook response) and therefore holdable (#573). Multi-choice prompts and
   * design / plan-mode / long-form questions cannot be expressed by the binary
   * response, so they always passthrough (their pick delivery is a later phase).
   * Mirrors the service's own structural classifiers so the gate and the service
   * agree on what "binary" means.
   */
  private isBinaryEscalation(input: PermissionRequestHookInput): boolean {
    const suggestions = input.permission_suggestions as readonly unknown[] | undefined;
    const alwaysEscalate = this.deps.alwaysEscalateTools ?? new Set<string>();
    return (
      !isMultiChoicePermission(input.tool_name, suggestions) &&
      !isDesignQuestion(input.tool_name, input.tool_input, suggestions, alwaysEscalate)
    );
  }

  /**
   * Resolve a PermissionRequest to a synchronous decision (#496). Claude BLOCKS
   * on the hook response, so this returns the verdict INSTEAD of injecting it:
   *   - approve -> 'allow', deny -> 'deny' (Claude proceeds; NO PTY inject).
   *   - escalate (main) -> escalateToUser + 'passthrough' (Claude renders the
   *     prompt; the user answers).
   *   - escalate / no-service / eval-error in a SUBAGENT-TAGGED context
   *     (`agent_id` present) -> 'deny' via the hook response. This is the core
   *     fix: the old PTY-inject default-deny couldn't tell whose prompt was on
   *     the PTY for parallel subagents and leaked; the synchronous deny needs
   *     no PTY at all.
   *   - the SAME three branches with `isInSubagentContext()` true but NO
   *     `agent_id` on the input -> this is the #710 tracker-leak signature
   *     (a PostToolUse(Task/Agent) completion tagged with the spawned agent's
   *     own agent_id was dropped before popping the tracker), NOT a real
   *     subagent prompt. Reset the tracker and escalate as main instead of
   *     silently denying the main agent forever.
   *   - pick (multi-choice) -> inject the index + 'passthrough' (the hook
   *     response can't express "pick option N"; keep the PTY for this rare case).
   *   - cancelled -> 'passthrough' (the user already advanced).
   */
  async resolvePermission(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    const { service, isInSubagentContext } = this.deps;
    // #711: computed once and threaded through every markHandled/onEvalStart
    // call below, so a held hold, an openQuestionSignatures entry, and the
    // client status-pill cue all agree on whether THIS permission belongs to a
    // subagent/team-member (`agent_id` present) or the main agent.
    const isSubagent = this.isSubagentEvent(input);

    if (isSubagent) {
      log(
        `[Hooks] Subagent PermissionRequest forwarded: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
    }

    // No auto-approve: subagent default-denies via the response (no PTY, no
    // leak); main escalates to the user (holding the hook when binary, #573).
    if (!service) {
      if (isInSubagentContext()) {
        if (this.isSubagentEvent(input)) {
          log(`[${this.sessionTag}] Subagent context without auto-approve; default-deny`);
          return 'deny';
        }
        // #710: a MAIN-tagged event (no agent_id) reaching here means the
        // tracker leaked, not a real subagent prompt. Reset and fall through
        // to escalateMain below instead of denying the main agent.
        //
        // #716 (blanket-reset tradeoff): resetSubagentContext() clears ALL
        // tracked use_ids, not just the leaked one -- it cannot tell which
        // entry is stale. If a genuinely-running concurrent synchronous Task
        // is ALSO open right now, its own later agent_id-tagged permission
        // requests will see isInSubagentContext() false and escalate as main
        // instead of default-denying. Accepted: (a) that escalation is
        // held/answerable (Model B), the same way async/background subagents
        // and team members already behave; (b) the alternative -- silently
        // denying the MAIN agent -- is the #710 bug this reset exists to fix.
        logError(
          `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}, no-service path); resetting tracker and escalating. Possible subagent-context tracker leak.`,
        );
        this.deps.resetSubagentContext?.();
      }
      return this.escalateMain(input);
    }

    // Open the buffer/cue window (#484/#513). With synchronous decisions Claude
    // does not render the prompt during the eval, so the buffer rarely holds a
    // PTY prompt now; the cue lifecycle still rides these signals. #711: ctx
    // lets the setup layer skip the client status-pill broadcast for a
    // subagent/team-member eval the user never saw asked.
    this.safeCueWithArg('onEvalStart', this.deps.onEvalStart, { isSubagent });

    // Raw suggestions: the service does its own strict-string filtering; we
    // forward the raw shape so the multi-choice classifier can route a
    // non-string entry through escalate instead of crashing.
    // Stamp a unique id so a held question (Part B) can be tied to THIS eval and
    // a manual answer cancels exactly it (#617).
    const evalId = ++this.evalSeq;
    // #711: tag this eval's subagent-ness so a Stop can cancel ONLY main-context
    // evals (`cancelStale('Stop', { mainOnly: true })`); the .finally always
    // removes it once (evaluate() never rejects).
    this.evalIsSubagentById.set(evalId, isSubagent);
    const evalPromise = service
      .evaluate(
        input.tool_name,
        input.tool_input,
        this.sessionTag,
        input.permission_suggestions as readonly unknown[] | undefined,
        undefined,
        evalId,
        // #730: this gate's own sessionId, so the shared daemon-wide service
        // can isolate this eval from every other session's.
        this.sessionId,
        isSubagent,
      )
      .finally(() => {
        this.evalIsSubagentById.delete(evalId);
      });

    // Part B (#573, ISOLATED behind push_hold_timeout): if the eval is still
    // running after push_hold_timeout AND this is a binary main-context
    // permission, push + hold the hook early so the user can step in while the
    // model keeps thinking; the late verdict then reconciles into that hold.
    // When push_hold_timeout <= 0 this never arms and the eval is awaited as
    // usual (Parts A + C only). A non-null result means the early hold fired and
    // the returned decision is what the hook server is blocked on.
    const earlyHold = await this.maybePushOnSlowEval(input, evalPromise, evalId);
    if (earlyHold !== null) return earlyHold;

    let result: AutoApproveResult;
    try {
      result = await evalPromise;
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] Unexpected error:`, err);
      if (isInSubagentContext()) {
        if (isSubagent) {
          // #711: a genuine subagent deny must not flap the client pill.
          this.markHandled(true);
          return 'deny';
        }
        // #710: MAIN-tagged + stuck tracker == leak, not a real subagent
        // prompt. Reset and fall through to escalateMain below. Blanket-reset
        // tradeoff (clears ALL tracked use_ids, not just the leaked one):
        // see the no-service branch above (#716).
        logError(
          `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}, eval-error path); resetting tracker and escalating. Possible subagent-context tracker leak.`,
        );
        this.deps.resetSubagentContext?.();
      }
      return this.escalateMain(input);
    }

    if (result.decision === 'cancelled') {
      // The user already advanced past the prompt. Drop the pending hook record
      // so its stale option labels cannot merge onto the next PTY prompt.
      this.deps.tracker.clearPending();
      this.safeCue('onCancelled', this.deps.onCancelled);
      log(`[AutoApprove ${this.sessionTag}] Decision dropped: ${result.reasoning}`);
      return 'passthrough';
    }
    if (result.decision === 'approve') {
      this.markHandled(isSubagent);
      return 'allow';
    }
    if (result.decision === 'deny') {
      this.markHandled(isSubagent);
      return 'deny';
    }
    if (result.decision === 'pick') {
      // Multi-choice pick (#399): the response can't express it, so render the
      // prompt (passthrough) and inject the 1-based index into the PTY. The
      // index was validated against options length upstream. The discriminated
      // union guarantees pickIndex, but guard defensively: a malformed result
      // must escalate, not silently fall through to the subagent-deny below.
      if (result.pickIndex === undefined) {
        logError(`[AutoApprove ${this.sessionTag}] pick result missing pickIndex; escalating`);
        return this.escalatePassthrough(input);
      }
      if (
        await this.inject(input, String(result.pickIndex), `multichoice-pick-${result.pickIndex}`)
      ) {
        this.markHandled(isSubagent);
        return 'passthrough';
      }
      return this.escalatePassthrough(input);
    }
    // escalate: a subagent prompt the user cannot answer is default-denied via
    // the response (no hang, no PTY). A MAIN-tagged event (agent_id absent)
    // reaching here with isInSubagentContext() true is NOT a real subagent
    // prompt: it is the #710 tracker-leak signature (a PostToolUse(Task/Agent)
    // completion stamped with the SPAWNED agent's own agent_id never popped
    // the use_id an earlier untagged PreToolUse tracked). Denying it would
    // silently drop the main agent's own prompts (including AskUserQuestion)
    // forever, so reset the tracker and fall through to escalate as main
    // instead. Tradeoff (#710): on a legacy Claude Code version that predates
    // agent_id, a genuine synchronous subagent prompt would now escalate+hold
    // instead of deny — still answerable via the Model B hook response
    // (below), strictly better than a silent main-agent deny.
    if (isInSubagentContext()) {
      if (isSubagent) {
        log(`[AutoApprove ${this.sessionTag}] Subagent context; escalate->deny to prevent hang`);
        // #711: a genuine subagent deny must not flap the client pill.
        this.markHandled(true);
        return 'deny';
      }
      // Blanket-reset tradeoff (clears ALL tracked use_ids, not just the
      // leaked one): see the no-service branch above (#716).
      logError(
        `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}, escalate path); resetting tracker and escalating. Possible subagent-context tracker leak.`,
      );
      this.deps.resetSubagentContext?.();
    }
    // Second opinion (#522): the fast model would escalate, but a heavier
    // escalate_model may resolve it (honoring a broad approve policy) before we
    // bother the user. Its latency only hits would-escalate cases. Main context
    // only; never re-escalates into a third call.
    const escalateModel = this.deps.escalateModel;
    if (escalateModel) {
      let second: AutoApproveResult;
      try {
        // #711: deliberately NOT tagged in evalIsSubagentById (no evalId passed) --
        // the same "Claude blocks on the hook while the gate evaluates" invariant
        // that keeps a MAIN primary eval from ever being in flight at Stop applies
        // here too, since Claude is still blocked on this same hook response
        // while the second opinion runs. A mainOnly Stop therefore has nothing to
        // cancel for this call by construction; leaving it untracked is correct,
        // not a gap. #730: scope IS passed (unlike evalId) so a full teardown's
        // scoped, untargeted-by-evalId cancel can still abort this call if it is
        // somehow still running.
        second = await service.evaluate(
          input.tool_name,
          input.tool_input,
          this.sessionTag,
          input.permission_suggestions as readonly unknown[] | undefined,
          escalateModel,
          undefined,
          this.sessionId,
          isSubagent,
        );
      } catch (err) {
        logError(`[AutoApprove ${this.sessionTag}] escalate_model second opinion threw:`, err);
        second = {
          decision: 'escalate',
          reasoning: 'second-opinion error',
          durationMs: 0,
          model: escalateModel,
        };
      }
      if (second.decision === 'approve') {
        log(`[AutoApprove ${this.sessionTag}] escalate_model (${escalateModel}) approved`);
        this.markHandled(isSubagent);
        return 'allow';
      }
      if (second.decision === 'deny') {
        log(`[AutoApprove ${this.sessionTag}] escalate_model (${escalateModel}) denied`);
        this.markHandled(isSubagent);
        return 'deny';
      }
      if (second.decision === 'cancelled') {
        // Claude already advanced (cancelStale fired during the slower second
        // eval). Mirror the primary cancelled path — do NOT escalate a phantom.
        this.deps.tracker.clearPending();
        this.safeCue('onCancelled', this.deps.onCancelled);
        log(`[AutoApprove ${this.sessionTag}] Second-opinion cancelled: ${second.reasoning}`);
        return 'passthrough';
      }
      // second opinion still unsure (escalate/pick) -> ask the user.
    }
    // #628: result is the primary escalate verdict here (approve/deny/pick/cancelled
    // returned earlier), so carry its lock-screen summary onto the escalation.
    return this.escalateMain(input, result.decision === 'escalate' ? result.summary : undefined);
  }

  // -------------------------------------------------------------------------
  // Part B (#573): slow-eval early push + hold. ISOLATED behind push_hold_timeout.
  // Everything below is gated by `pushHoldMs > 0`; when it is <= 0 the method
  // returns null without arming any timer, so removing this block (delete the
  // method + its single call site, and the call site's `await ... ?? null`
  // collapses to the plain `await evalPromise`) reverts the gate to A + C only
  // with no other change.
  // -------------------------------------------------------------------------

  /**
   * If a binary main-context eval is slow, push + hold the hook EARLY so the
   * user can decide while the model keeps thinking (Part B). Returns:
   *   - null  -> Part B did not fire (disabled, non-binary, subagent context, or
   *              the eval settled before push_hold_timeout). The caller awaits
   *              the eval and handles the verdict normally.
   *   - a resolved PermissionDecision (from the held promise) -> the early hold
   *     fired; the returned promise is what the hook server is blocked on, and
   *     the late verdict has been reconciled into that same hold here. The caller
   *     returns it WITHOUT also awaiting the eval (avoids a double decision).
   *
   * The eval/timer race is entirely self-contained so it cannot disturb the A/C
   * paths: it only ever calls `escalateAndHold` (the shared hold primitive) and
   * `resolveHeld` / `releaseHeld` to reconcile, with a `pushed` guard so a late
   * escalate verdict never pushes a second time.
   */
  private async maybePushOnSlowEval(
    input: PermissionRequestHookInput,
    evalPromise: Promise<AutoApproveResult>,
    evalId: number,
  ): Promise<PermissionDecision | null> {
    const pushHoldMs = this.deps.pushHoldMs ?? 0;
    // Disabled, or this escalation could not be answered via the hook response
    // anyway (multi-choice/design), or a subagent prompt the user can't answer:
    // do not arm the race. Subagent context is read live (it may close before
    // the verdict), but arming an early USER push for a subagent prompt would be
    // wrong, so gate on the current value here.
    if (pushHoldMs <= 0 || !this.isBinaryEscalation(input) || this.deps.isInSubagentContext()) {
      return null;
    }

    // Suppress the eval promise's own unhandled-rejection while it races the
    // timer (we attach the real handler only on the timer-wins branch). The
    // eval-wins branch returns null and the caller awaits + handles it.
    const safeEval = evalPromise.then(
      (r) => ({ ok: true as const, result: r }),
      (err) => ({ ok: false as const, err }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), pushHoldMs);
      timer.unref?.();
    });

    const winner = await Promise.race([safeEval, timeout]);
    if (winner !== 'timeout') {
      // The eval settled first: no early push. Clear the timer and let the
      // caller take the normal path (it re-awaits evalPromise, already resolved).
      clearTimeout(timer);
      return null;
    }

    // The timer won: the eval is still running. Push + hold the hook now so the
    // user can step in. createHold returns the pending promise the hook server
    // will block on AND the question id (or passthrough if the push failed /
    // holding is off).
    log(`[AutoApprove ${this.sessionTag}] Slow eval (>${pushHoldMs}ms); pushing + holding early`);
    // createHold escalates AND (when a hold is registered) pushes the held
    // question via onHeldEscalate (#573), so the user can step in immediately.
    // NOTE (#628): no `summary` is passed here — this early push happens BEFORE the
    // verdict exists, so a Part B slow-eval escalation shows the raw tool text on
    // the lock screen. reconcileLateVerdict leaves the already-pushed card as-is on
    // a late escalate, so the summary is not back-filled. Re-pushing a collapsed
    // card with the late summary is a separate follow-up (kept on #628).
    const { decision: heldDecision, questionId } = this.createHold(input);
    // Tie the held question to THIS still-running eval so a manual answer cancels
    // exactly it and frees the GPU (#617). This is the only place an eval is live
    // while its question is answerable.
    if (questionId) this.evalIdByQuestion.set(questionId, evalId);
    // The reconciliation NEVER pushes again — a late escalate just leaves the
    // existing hold in place (guarded by the pendingHolds membership check
    // inside reconcileLateVerdict), and pushHeldHook is itself idempotent.
    void this.reconcileLateVerdict(safeEval, questionId);
    return heldDecision;
  }

  /**
   * Reconcile the late verdict of a slow eval into the already-pushed hold
   * (Part B). The hold was created with `escalateAndHold`; here we resolve it:
   * approve -> allow, deny -> deny, cancelled -> passthrough. An escalate/pick
   * verdict (or an eval error) leaves the hold in place — the user is already
   * looking at the pushed question, so no second push and no change. No-op when
   * the hold is already gone (the user answered, or it timed out) so there is no
   * double-resolve.
   */
  private async reconcileLateVerdict(
    safeEval: Promise<{ ok: true; result: AutoApproveResult } | { ok: false; err: unknown }>,
    qid: UUID | undefined,
  ): Promise<void> {
    const outcome = await safeEval;
    // The eval has settled; its question can no longer be cancelled (#617).
    if (qid) this.evalIdByQuestion.delete(qid);
    if (!qid || !this.pendingHolds.has(qid)) return; // already resolved/timed out
    if (!outcome.ok) {
      // Eval threw: the user is already looking at the pushed question; leave the
      // hold in place (it fails open on its own timeout if the user never answers).
      logError(`[AutoApprove ${this.sessionTag}] Slow-eval late error (hold kept):`, outcome.err);
      return;
    }
    const result = outcome.result;
    // Dismiss BEFORE resolving (#585, P7 FIX 5): the broadcast races ahead of
    // Claude proceeding on the verdict, shrinking the window where Claude has
    // executed but the card still shows. resolveHeld/releaseHeld then resolve the
    // hook + drop the registry entry (FIX 2).
    if (result.decision === 'approve') {
      // The slow verdict landed AFTER the early push, so the card is on screens
      // the user never needs to act on — dismiss it everywhere (#585, P7).
      this.notifyResolved(qid, 'auto_approved');
      this.resolveHeld(qid, 'allow');
    } else if (result.decision === 'deny') {
      this.notifyResolved(qid, 'auto_denied');
      this.resolveHeld(qid, 'deny');
    } else if (result.decision === 'cancelled') {
      // Claude advanced past the prompt during the slow eval; fail the hold open.
      this.deps.tracker.clearPending();
      this.notifyResolved(qid, 'cancelled');
      this.releaseHeld(qid, 'passthrough');
    }
    // escalate / pick: already pushed + holding; no double-push, leave as-is.
  }

  /**
   * Resolve a held hook with an arbitrary decision (incl. passthrough) WITHOUT
   * markHandled (used by Part B's cancelled reconciliation, where the verdict
   * was not a silent auto-decision). Returns true when a hold existed.
   *
   * #673: the SINGLE owner of `openQuestionSignatures` cleanup for every
   * internal caller of this method -- `releaseHeldAsPassthrough`,
   * `failOpenHeld` (hold-timeout / undelivered-notification fail-open),
   * `reconcileLateVerdict`'s cancelled branch, and `resolveSupersededQuestion`
   * (#673's own external-resolution cleanup) all funnel through here, so the
   * delete must be UNCONDITIONAL (not gated on `hold` existing) or every one
   * of those exit paths leaks an entry for the rest of the process lifetime.
   * (`resolveHeld` is a separate, non-delegating path and owns its own delete.)
   */
  private releaseHeld(questionId: UUID, decision: PermissionDecision): boolean {
    this.openQuestionSignatures.delete(questionId);
    const hold = this.pendingHolds.get(questionId);
    if (!hold) return false;
    clearTimeout(hold.timer);
    this.pendingHolds.delete(questionId);
    // Drop the registry entry so no ghost card replays (#585, P7 FIX 2). The
    // user-answer path (releaseHeldAsPassthrough -> handleAnswer finally) also
    // removes it; a double-remove is idempotent.
    this.deps.sessionRegistry.removeQuestion(this.sessionId, questionId);
    hold.resolve(decision);
    return true;
  }

  /**
   * Buffer-closing success path: the permission was auto-approved/denied
   * silently (inject succeeded), so the user never sees it. Notifies the
   * tracker (closes the #484 buffer window) AND the terminal cue (#513). Every
   * silent-handle site routes through here so neither signal can be missed.
   * `isSubagent` (#711) is forwarded to `onHandled` so the setup layer can skip
   * the client status-pill broadcast for a subagent/team-member permission the
   * user never saw asked -- the tracker + terminal cue still fire either way.
   */
  private markHandled(isSubagent: boolean): void {
    this.deps.tracker.onAutoApproveHandled();
    this.safeCueWithArg('onHandled', this.deps.onHandled, { isSubagent });
  }

  /**
   * Invoke a COSMETIC lifecycle callback (the #513 terminal cue). The cue must
   * never affect the decision path or the #484 buffer state, so a throw is
   * logged and absorbed here rather than propagating into the .then()/.catch()
   * chain (where the outer catch would re-run the decision and could re-open an
   * already-closed buffer). Mirrors how `escalateToUser` shields `onEscalate`.
   */
  private safeCue(label: string, fn: (() => void) | undefined): void {
    if (!fn) return;
    try {
      fn();
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] ${label} cue threw (cosmetic; ignored):`, err);
    }
  }

  /**
   * `safeCue` for a single-argument lifecycle callback (e.g. `onHeldEscalate`,
   * #573). Same contract: a throw is logged and absorbed so a held-push failure
   * cannot propagate into the decision/hold path. NOTE the held push IS
   * load-bearing for answerability, but absorbing a throw here only means the
   * push is lost — the hold still fails open on its own timeout, which is
   * strictly safer than letting the throw escape into the hook dispatch loop.
   */
  private safeCueWithArg<T>(label: string, fn: ((arg: T) => void) | undefined, arg: T): void {
    if (!fn) return;
    try {
      fn(arg);
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] ${label} cue threw (cosmetic; ignored):`, err);
    }
  }

  /**
   * Notify the daemon that a HELD question resolved without a user answer (#585,
   * P7), so it can broadcast `question_resolved` + dismiss the pushed card on
   * every client. Throw-safe like the cosmetic cues: a broadcast/push failure is
   * logged and absorbed so it can never propagate into the decision/hold path.
   * No-op when no `onResolved` is wired.
   */
  private notifyResolved(
    questionId: UUID,
    reason: 'auto_approved' | 'auto_denied' | 'cancelled',
  ): void {
    const fn = this.deps.onResolved;
    if (!fn) return;
    try {
      fn(questionId, reason);
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] onResolved threw (ignored):`, err);
    }
  }

  /** Subagent/team-member events carry a non-empty `agent_id`; main events do not. */
  private isSubagentEvent(input: PermissionRequestHookInput): boolean {
    return typeof input.agent_id === 'string' && input.agent_id.length > 0;
  }

  /**
   * Inject an answer into the PTY. Returns true on success. On failure (session
   * missing, PTY not running, submitInput throws, subagent off-screen gate trips)
   * it logs and returns false so callers can fall back to escalating.
   *
   * `value` is a 1-based numeric option index serialised as a string. Since #496
   * (synchronous decisions) approve/deny no longer inject — this is now reached
   * ONLY for a multi-choice pick, where `value` is the chosen index (#399).
   *
   * PTY-presence gate (subagent-only): a background subagent emits PermissionRequest
   * hooks for its own tool calls, but its prompts never render on the main PTY — only
   * a hot-switched subagent view does. Without this gate, auto-approve would type the
   * pick index into the MAIN AGENT's input every time a background subagent asked.
   */
  private async inject(
    input: PermissionRequestHookInput,
    value: string,
    reason: string,
  ): Promise<boolean> {
    const { sessionRegistry, tracker, isInSubagentContext } = this.deps;
    try {
      const session = sessionRegistry.getSession(this.sessionId);
      if (!session) {
        logError(`[AutoApprove ${this.sessionTag}] Session not found; cannot inject "${value}"`);
        return false;
      }
      const inSubagentContext = this.isSubagentEvent(input) || isInSubagentContext();
      if (inSubagentContext && !tracker.isPromptVisibleOnPTY()) {
        log(
          `[AutoApprove ${this.sessionTag}] Subagent ${input.tool_name}: skipping inject "${value}" (${reason}); no prompt visible on main PTY (agent=${input.agent_id?.slice(0, 8) ?? 'nested'} type=${input.agent_type ?? 'n/a'})`,
        );
        return false;
      }
      await session.pty.submitInput(value);
      log(`[AutoApprove ${this.sessionTag}] Injected "${value}" into PTY (${reason})`);
      // Optimistic: the picked option will run a tool. The authoritative status
      // follows from Claude's own PreToolUse hook.
      sessionRegistry.updateStatus(this.sessionId, 'executing');
      return true;
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] inject("${value}") threw:`, err);
      return false;
    }
  }

  /**
   * Safe escalation to the user. Used when inject fails or when auto-approve is off
   * and we're in main context. Wrapped so a bridge/push failure does not leave a
   * dangling unhandled rejection in the hook handler. Returns the created
   * `Question.id` so a binary escalation can hold the hook keyed by it (#573);
   * `undefined` when no question was created (the escalate threw / push failed),
   * in which case `escalateAndHold` falls open to passthrough.
   */
  private escalateToUser(input: PermissionRequestHookInput, summary?: string): UUID | undefined {
    let questionId: UUID | undefined;
    try {
      // escalate() stashes the hook record (onPermissionRequest -> recordPendingHook)
      // FIRST, then onEscalate releases the buffered PTY prompt so the pair+push
      // finds that record. Order matters; do not reorder. #484. `summary` (#628) is
      // the model's lock-screen one-liner, carried onto the Question for the push.
      questionId = this.deps.escalate(input, summary);
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] escalateToUser threw:`, err);
    } finally {
      // Release the buffer UNCONDITIONALLY: the verdict is "user must answer".
      // Even if escalate() threw (push will fail), the buffer must not stay
      // locked, or every later prompt in this session would buffer forever. #484.
      // safeCue: the wired callback releases the buffer (critical) then fires the
      // terminal cue (#513, cosmetic); a cue throw must not break the finally.
      this.safeCue('onEscalate', this.deps.onEscalate);
    }
    if (questionId) {
      const observed: ObservedToolCall = {
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolUseId: input.tool_use_id,
      };
      // #673 duplicate re-request: Claude re-issuing the IDENTICAL
      // PermissionRequest (same tool signature) proves any earlier OPEN
      // escalation for it can never be answered through its own hook response
      // again -- that response already went to a stale hook call. Clean it up
      // BEFORE tracking the new one (the new questionId is not registered yet,
      // so this can never find/cancel itself).
      //
      // Baked-in assumption: Claude Code processes a turn's tool-permission
      // hooks SEQUENTIALLY (verified against the cc-ref reference source,
      // conversation.rs:370's sequential for-loop), so two identical-signature
      // MAIN-context escalations can never be genuinely concurrent/live at
      // once -- an incoming duplicate always means the earlier one is dead. If
      // Claude Code ever parallelizes main-context tool-permission dispatch,
      // this invariant breaks and this check would need a stronger key (e.g.
      // requiring tool_use_id) before it could keep firing safely.
      this.cancelExternallyResolved(observed, 'duplicate-re-request');
      this.openQuestionSignatures.set(questionId, {
        toolName: observed.toolName,
        toolInputKey: stableToolInputKey(observed.toolInput),
        toolUseId: observed.toolUseId,
        // #711: tags this OPEN escalation main vs subagent/team-member, so a
        // mainOnly Stop (cancelStale) clears only main-tagged entries here.
        isSubagent: this.isSubagentEvent(input),
      });
    }
    return questionId;
  }

  /**
   * #673: called when an external signal proves a currently-OPEN escalation
   * (held or passthrough) was already resolved without going through Remi's
   * own answer path. Two callers:
   *   - `hook-bridge-setup.ts`'s PreToolUse/PostToolUse listeners, when the
   *     observed tool signature matches an open escalation — the tool is now
   *     running, so the permission was answered directly in the terminal (a
   *     passthrough escalation is never held, so Remi's own answer path never
   *     ran) or by the other process's own permission mode.
   *   - `escalateToUser`, for a duplicate re-request of the SAME signature.
   * Signature-scoped (exact tool_name + tool_input match, or exact
   * tool_use_id match when both sides carry one) so it can only ever touch
   * the ONE question it matches — never a DIFFERENT permission's still-running
   * eval (#537's concern for why PreToolUse/PostToolUse don't cancel broadly).
   * A no-op when no open escalation matches.
   */
  cancelExternallyResolved(observed: ObservedToolCall, reason: string): void {
    const qid = this.findOpenQuestionMatching(observed);
    if (!qid) return;
    this.resolveSupersededQuestion(qid, reason);
  }

  /** Find an open escalation matching `observed`, preferring an exact
   *  tool_use_id match (future-proofing: not sent by Claude Code today) over
   *  the tool_name + tool_input signature fallback. */
  private findOpenQuestionMatching(observed: ObservedToolCall): UUID | undefined {
    // Fast path: called on EVERY admitted PreToolUse/PostToolUse, so the
    // near-universal "no open escalation at all" case must not pay for a
    // stableToolInputKey stringify it can never use.
    if (this.openQuestionSignatures.size === 0) return undefined;
    const observedKey = stableToolInputKey(observed.toolInput);
    for (const [qid, sig] of this.openQuestionSignatures) {
      if (sig.toolName !== observed.toolName || sig.toolInputKey !== observedKey) continue;
      // Signature agrees. Two DIFFERENT tool calls can legitimately share an
      // identical (tool_name, tool_input) (e.g. two `ls` calls in a row) --
      // if BOTH sides carry a tool_use_id, it must ALSO agree, or this is a
      // known-different call and must NOT be treated as a match. When at
      // least one side has no id, the signature alone is the best available
      // proof.
      if (observed.toolUseId !== undefined && sig.toolUseId !== undefined) {
        if (observed.toolUseId === sig.toolUseId) return qid;
        continue;
      }
      return qid;
    }
    return undefined;
  }

  /**
   * Guarded cleanup for a question proven stale by an external signal (#673).
   * ALWAYS degrades to `releaseHeld(qid, 'passthrough')` — never a fabricated
   * allow/deny, matching the hold-timeout fail-open philosophy: we cannot know
   * what the user actually decided, so "no decision from us" is the only safe
   * response. Mirrors input-events.ts's own answer-cleanup sequence: each step
   * independently try/catch'd so one failure can never skip the rest —
   * `removeQuestion` in particular must always run even if the eval was
   * already gone or the hold release throws, or the pushed card lingers.
   */
  private resolveSupersededQuestion(qid: UUID, reason: string): void {
    log(
      `[AutoApprove ${this.sessionTag}] Externally resolved ${qid.slice(0, 8)} (${reason}); clearing stale escalation`,
    );
    try {
      this.releaseHeld(qid, 'passthrough');
    } catch (err) {
      logError(
        `[AutoApprove ${this.sessionTag}] releaseHeld during external-resolve cleanup threw:`,
        err,
      );
    }
    try {
      this.cancelEvalForQuestion(qid, reason);
    } catch (err) {
      logError(
        `[AutoApprove ${this.sessionTag}] cancelEvalForQuestion during external-resolve cleanup threw:`,
        err,
      );
    }
    try {
      this.deps.sessionRegistry.removeQuestion(this.sessionId, qid);
    } catch (err) {
      logError(
        `[AutoApprove ${this.sessionTag}] removeQuestion during external-resolve cleanup threw:`,
        err,
      );
    }
    // notifyResolved is already throw-safe internally; no extra wrap needed.
    // openQuestionSignatures cleanup already happened inside releaseHeld
    // above (the single owner, unconditional even if no hold existed) --
    // nothing further to delete here.
    this.notifyResolved(qid, 'cancelled');
  }
}
