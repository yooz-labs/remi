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
 */

import type { UUID } from '@remi/shared';

import type { QuestionPresenceTracker } from '../api/question-presence-tracker.ts';
import { log, logError } from '../cli/logger.ts';
import type { PermissionDecision, PermissionRequestHookInput } from '../hooks/index.ts';
import { type DeliveryOutcome, isDelivered } from '../notifications/notification-dispatcher.ts';
import type { SessionRegistry } from '../session/index.ts';
import { isDesignQuestion, isMultiChoicePermission } from './multichoice.ts';
import type { AutoApproveResult } from './types.ts';

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
  ): Promise<AutoApproveResult>;
  /** Abort any in-flight `evaluate`. Returns true if an abort was issued, false
   *  if nothing was in flight (idempotent). */
  cancel(reason: string): boolean;
}

export interface AutoApproveGateDeps {
  /** null => no auto-approve configured; the no-AA escalate/default-deny path runs. */
  service: AutoApproveEvaluator | null;
  sessionRegistry: SessionRegistry;
  tracker: QuestionPresenceTracker;
  /** Wraps `HookEventBridge.isInSubagentContext()`. Read live per branch (async TOCTOU). */
  isInSubagentContext: () => boolean;
  /** Escalate to the user (wraps `handlers.onPermissionRequest`). Returns the id
   *  of the `Question` it created (#573), so a binary escalation can hold the
   *  hook keyed by that id and resolve it when the user answers; `undefined`
   *  means no question was created (e.g. the push failed) and the gate must
   *  fall open to passthrough rather than hold a hook nobody can answer. The
   *  gate wraps every call in a try/catch, so an implementation that throws is
   *  logged and absorbed (treated as `undefined`) rather than propagated. */
  escalate: (input: PermissionRequestHookInput) => UUID | undefined;
  /** Called right before the LLM eval starts, so the tracker can BUFFER the PTY
   *  prompt until the verdict (don't push an auto-approved permission). #484. */
  onEvalStart?: () => void;
  /** Called when the verdict is escalate (the user must answer), so the tracker
   *  releases the buffered PTY prompt. #484. */
  onEscalate?: () => void;
  /** Called when a BINARY escalation HOLDS its hook open (Model B, #573):
   *  Claude blocks on the hook response, so it never renders the native prompt
   *  and the tracker's PTY-render push trigger never fires. The gate calls this
   *  with the held `Question.id` so the tracker pushes that question IMMEDIATELY
   *  (-> sessionRegistry.addQuestion + APNS), making it answerable. Called ONLY
   *  in the held branch — passthrough / multi-choice escalations still render the
   *  PTY and push via `onPTYPromptVisible`, so calling it for them would
   *  double-push. Absent => no immediate held push (tests / no-AA callers). #573 */
  onHeldEscalate?: (questionId: UUID) => void;
  /** Called when the permission was auto-approved/denied silently (inject
   *  succeeded; the user never sees it). Drives the terminal "done" cue. #513. */
  onHandled?: () => void;
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
   */
  cancelStale(reason: string): void {
    // Release any held hooks first (#573): a Stop/SessionEnd means the session
    // is going away, so a hook blocked on a human answer must fail open to
    // passthrough rather than hang. A held hook cannot normally co-occur with
    // Stop (Claude is blocked on the permission), but this is defensive.
    this.releaseAllHolds('passthrough', reason);
    if (this.deps.service === null) return;
    if (this.deps.service.cancel(reason)) {
      log(`[AutoApprove] Cancelled stale LLM eval: ${reason}`);
    }
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
   */
  resolveHeld(questionId: UUID, decision: 'allow' | 'deny'): boolean {
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
    this.markHandled();
    hold.resolve(decision);
    log(
      `[AutoApprove ${this.sessionTag}] Held hook ${questionId.slice(0, 8)} resolved: ${decision}`,
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
    return this.releaseHeld(questionId, 'passthrough');
  }

  /** Resolve every pending hold with one decision + reason, clearing timers and
   *  emptying the map. Used by `cancelStale` (session teardown). */
  private releaseAllHolds(decision: PermissionDecision, reason: string): void {
    if (this.pendingHolds.size === 0) return;
    log(
      `[AutoApprove ${this.sessionTag}] Releasing ${this.pendingHolds.size} held hook(s) as ${decision} (${reason})`,
    );
    for (const [qid, hold] of this.pendingHolds) {
      clearTimeout(hold.timer);
      // The session is going away (Stop/SessionEnd); dismiss the pushed card on
      // every client BEFORE resolving so it does not linger after the prompt is
      // gone (#585, P7), and drop the registry entry so no ghost card replays.
      this.notifyResolved(qid, 'cancelled');
      this.deps.sessionRegistry.removeQuestion(this.sessionId, qid);
      hold.resolve(decision);
    }
    this.pendingHolds.clear();
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
  private escalateAndHold(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    return this.createHold(input).decision;
  }

  /**
   * Escalate (push) a binary main-context permission and register a hold,
   * returning BOTH the held promise the hook server blocks on AND the created
   * `Question.id` (so Part B can reconcile a late verdict into the same hold).
   * `questionId` is undefined when no question was created (push failed) or
   * holding is disabled — in which case `decision` is an immediate 'passthrough'
   * (today's behavior) and no hold is registered.
   */
  private createHold(input: PermissionRequestHookInput): {
    decision: Promise<PermissionDecision>;
    questionId: UUID | undefined;
  } {
    const qid = this.escalateToUser(input);
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
        this.failOpenHeld(qid, `Held hook ${qid.slice(0, 8)} timed out -> passthrough`);
      }, holdMs);
      // setTimeout keeps the event loop alive for the whole human-paced hold;
      // unref so a held hook never blocks daemon shutdown.
      timer.unref?.();
      this.pendingHolds.set(qid, { resolve, timer });
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
   * (epic #603 Phase 1). If delivery is confirmed (in_app / pushed / deduped) in
   * time, the hold keeps blocking to `holdMs` as before. If it is NOT confirmed
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
      this.pendingHolds.set(qid, { resolve: hold.resolve, timer });
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
  private escalateMain(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    if (this.isBinaryEscalation(input)) {
      return this.escalateAndHold(input);
    }
    this.escalateToUser(input);
    return Promise.resolve('passthrough');
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
   *   - escalate / no-service in a SUBAGENT context -> 'deny' via the hook
   *     response. This is the core fix: the old PTY-inject default-deny couldn't
   *     tell whose prompt was on the PTY for parallel subagents and leaked; the
   *     synchronous deny needs no PTY at all.
   *   - pick (multi-choice) -> inject the index + 'passthrough' (the hook
   *     response can't express "pick option N"; keep the PTY for this rare case).
   *   - cancelled -> 'passthrough' (the user already advanced).
   */
  async resolvePermission(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    const { service, isInSubagentContext } = this.deps;

    if (this.isSubagentEvent(input)) {
      log(
        `[Hooks] Subagent PermissionRequest forwarded: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
    }

    // No auto-approve: subagent default-denies via the response (no PTY, no
    // leak); main escalates to the user (holding the hook when binary, #573).
    if (!service) {
      if (isInSubagentContext()) {
        log(`[${this.sessionTag}] Subagent context without auto-approve; default-deny`);
        return 'deny';
      }
      return this.escalateMain(input);
    }

    // Open the buffer/cue window (#484/#513). With synchronous decisions Claude
    // does not render the prompt during the eval, so the buffer rarely holds a
    // PTY prompt now; the cue lifecycle still rides these signals.
    this.safeCue('onEvalStart', this.deps.onEvalStart);

    // Raw suggestions: the service does its own strict-string filtering; we
    // forward the raw shape so the multi-choice classifier can route a
    // non-string entry through escalate instead of crashing.
    const evalPromise = service.evaluate(
      input.tool_name,
      input.tool_input,
      this.sessionTag,
      input.permission_suggestions as readonly unknown[] | undefined,
    );

    // Part B (#573, ISOLATED behind push_hold_timeout): if the eval is still
    // running after push_hold_timeout AND this is a binary main-context
    // permission, push + hold the hook early so the user can step in while the
    // model keeps thinking; the late verdict then reconciles into that hold.
    // When push_hold_timeout <= 0 this never arms and the eval is awaited as
    // usual (Parts A + C only). A non-null result means the early hold fired and
    // the returned decision is what the hook server is blocked on.
    const earlyHold = await this.maybePushOnSlowEval(input, evalPromise);
    if (earlyHold !== null) return earlyHold;

    let result: AutoApproveResult;
    try {
      result = await evalPromise;
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] Unexpected error:`, err);
      if (isInSubagentContext()) {
        this.markHandled();
        return 'deny';
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
      this.markHandled();
      return 'allow';
    }
    if (result.decision === 'deny') {
      this.markHandled();
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
        this.escalateToUser(input);
        return 'passthrough';
      }
      if (
        await this.inject(input, String(result.pickIndex), `multichoice-pick-${result.pickIndex}`)
      ) {
        this.markHandled();
      } else {
        this.escalateToUser(input);
      }
      return 'passthrough';
    }
    // escalate: a subagent prompt the user cannot answer is default-denied via
    // the response (no hang, no PTY).
    if (isInSubagentContext()) {
      if (!this.isSubagentEvent(input)) {
        // A MAIN-agent event reaching here means the subagent-context tracker
        // leaked (a PostToolUse(Task) was dropped). Surface it loudly — otherwise
        // the main session silently denies every permission.
        logError(
          `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}); denying. Possible subagent-context tracker leak.`,
        );
      }
      log(`[AutoApprove ${this.sessionTag}] Subagent context; escalate->deny to prevent hang`);
      this.markHandled();
      return 'deny';
    }
    // Second opinion (#522): the fast model would escalate, but a heavier
    // escalate_model may resolve it (honoring a broad approve policy) before we
    // bother the user. Its latency only hits would-escalate cases. Main context
    // only; never re-escalates into a third call.
    const escalateModel = this.deps.escalateModel;
    if (escalateModel) {
      let second: AutoApproveResult;
      try {
        second = await service.evaluate(
          input.tool_name,
          input.tool_input,
          this.sessionTag,
          input.permission_suggestions as readonly unknown[] | undefined,
          escalateModel,
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
        this.markHandled();
        return 'allow';
      }
      if (second.decision === 'deny') {
        log(`[AutoApprove ${this.sessionTag}] escalate_model (${escalateModel}) denied`);
        this.markHandled();
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
    return this.escalateMain(input);
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
    const { decision: heldDecision, questionId } = this.createHold(input);
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

  /** Resolve a held hook with an arbitrary decision (incl. passthrough) WITHOUT
   *  markHandled (used by Part B's cancelled reconciliation, where the verdict
   *  was not a silent auto-decision). Returns true when a hold existed. */
  private releaseHeld(questionId: UUID, decision: PermissionDecision): boolean {
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
   */
  private markHandled(): void {
    this.deps.tracker.onAutoApproveHandled();
    this.safeCue('onHandled', this.deps.onHandled);
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
  private escalateToUser(input: PermissionRequestHookInput): UUID | undefined {
    let questionId: UUID | undefined;
    try {
      // escalate() stashes the hook record (onPermissionRequest -> recordPendingHook)
      // FIRST, then onEscalate releases the buffered PTY prompt so the pair+push
      // finds that record. Order matters; do not reorder. #484.
      questionId = this.deps.escalate(input);
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
    return questionId;
  }
}
