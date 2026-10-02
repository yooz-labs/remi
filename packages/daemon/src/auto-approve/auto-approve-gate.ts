/**
 * AutoApproveGate — owns the PermissionRequest control plane for a session.
 *
 * Since #1125 (ADR 0030) remi no longer judges permissions: there is no LLM
 * evaluator and no rule layer behind this gate, and nothing is answered
 * without a human choice. The class keeps its historical name; it is the
 * permission relay.
 *
 * Since #1126 (ADR 0031) a BINARY main-context prompt is answered through
 * its held hook (ADR 0002): `resolvePermission` stashes the question,
 * pushes the card at once by id (`onHeldEscalate`), and returns a promise
 * that stays pending while Claude's own dialog is on screen (it renders
 * about 0.1 s after the hook POST, during the hold). The first answer wins:
 *   - a phone answer (`answerHeld`) resolves the hook with `allow`, `deny`
 *     (optionally with the user's message, which Claude receives as the
 *     tool result), or `allow` + `updatedPermissions` for a standing grant
 *     (`standingGrantFor`);
 *   - an answer in the terminal ends the hold through the external
 *     resolution signals below, and the hook gets an empty response that
 *     Claude ignores;
 *   - the hold deadline (`[prompts] hold_seconds`) releases the hook with an
 *     empty response, Claude's dialog simply stays, the card is dismissed
 *     and `onHoldDeadline` tells the phone to answer at the terminal (#733).
 * An empty response never decides anything: it is what every non-answer
 * path sends.
 *
 * Other shapes:
 *   - a multi-choice / design prompt (AskUserQuestion, ExitPlanMode, a
 *     multi-choice string-label permission) is answered 'passthrough' and
 *     pushed at once (`escalatePassthrough`); its answer is still typed
 *     into the PTY (Phase 4, #1127, replaces that);
 *   - a SUBAGENT-tagged prompt (`agent_id` present) is parked
 *     (`parkSubagentForPTY`): its card is pushed only if the prompt actually
 *     renders on the main PTY (ADR 0004). `onSubagentPassthrough` reports it
 *     for the informational subagent alert.
 *
 * The outward couplings the hook bridge used directly are injected as
 * callbacks so the gate has no back-reference to the bridge or the router:
 *   - `isInSubagentContext()` wraps `HookEventBridge.isInSubagentContext()`
 *   - `escalate(input)` wraps `HookEventBridge.handlePermissionRequest`
 *
 * #673: the gate also owns EXTERNAL-RESOLUTION cancellation. Every escalation
 * this gate creates (main or parked subagent) is tracked in
 * `openQuestionSignatures` by its (tool_name, tool_input, agent_id)
 * signature. Signals that prove an open escalation was resolved WITHOUT going
 * through remi's own answer path:
 *   - `cancelExternallyResolved`, called from PreToolUse / PostToolUse /
 *     PostToolUseFailure (subagent) / PermissionDenied in
 *     `hook-bridge-setup.ts` when the observed tool signature matches an open
 *     escalation: the tool is now running (or was refused), so the user must
 *     have answered it directly in the terminal or Claude's own permission
 *     mode resolved it;
 *   - a duplicate re-request: `escalateToUser` / `parkSubagentForPTY` resolve
 *     an already-open entry with the SAME signature before registering the
 *     new one, since Claude re-issuing the identical PermissionRequest proves
 *     the earlier card can never be answered through its own prompt again;
 *   - `cancelStale('Stop', {mainOnly:true})`: Claude cannot fire `Stop` while
 *     still blocked on its own native prompt, so a MAIN-tagged signature still
 *     open at Stop was resolved without a matching tool call (most often a
 *     "No" answered in the terminal, which fires no tool call at all);
 *   - `cancelStaleForAgent`, called from `SubagentStop`: the single-agent
 *     mirror of the Stop reasoning;
 *   - `cancelStale('SessionEnd')` and `forceRelease` (`remi unstick`): real
 *     teardown, every open escalation is resolved.
 * Each one routes through `resolveSupersededQuestion`, which ends the hold
 * (an empty response), removes the card from the registry and fires
 * `onResolved` (question_resolved + APNS dismissal), never a silent
 * bookkeeping-only delete. A phone answer (or a superseded render) retires
 * the signature through `retireQuestion` instead, because that path already
 * removes and dismisses the card itself.
 */

import type { QuestionOption, UUID } from '@remi/shared';

import { log, logError } from '../cli/logger.ts';
import { standingGrantFor } from '../hooks/hook-event-bridge.ts';
import type { PermissionDecision, PermissionRequestHookInput } from '../hooks/index.ts';
import type { SessionRegistry } from '../session/index.ts';
import { ALWAYS_ESCALATE_TOOLS, isDesignQuestion, isMultiChoicePermission } from './multichoice.ts';

/**
 * A phone answer to a held prompt (#1126), already resolved by the answer
 * path to one of the card's own options. `message` is the optional text a
 * "No" carries; Claude receives it as the denied tool's result. `cancel` is
 * the card's universal Cancel (Esc) action, which on a held card is a "No".
 */
export type HeldAnswer =
  | { readonly kind: 'option'; readonly option: QuestionOption; readonly message?: string }
  | { readonly kind: 'cancel' }
  /** Free text, or an answer matching none of the card's options: never an
   *  answer a held card offers, so a live hold refuses it. */
  | { readonly kind: 'text' };

/**
 * What `answerHeld` did with a phone answer (#1126):
 *   - `resolved`: the hook answered with the user's choice.
 *   - `refused`: the hold is live but the answer is not one its card offers
 *     (an unknown option, a standing grant whose suggestion is gone); nothing
 *     changed, the card and the hold stay.
 *   - `closed`: a binary prompt this gate held whose hold has ended (answered
 *     in the terminal, released at the deadline, aborted). Its answer belongs
 *     to the terminal now; nothing may be typed for it.
 *   - `unknown`: not a binary prompt this gate held (a hook-less prompt,
 *     AskUserQuestion, ExitPlanMode); the caller's own path applies.
 */
export type HeldAnswerOutcome = 'resolved' | 'refused' | 'closed' | 'unknown';

/** How many ended binary-prompt ids `answerHeld` remembers as `closed`.
 *  The registry keeps at most 8 pending cards, so a late answer for any card
 *  a client can still show is far inside this window. */
const CLOSED_HOLD_MEMORY = 256;

/** Longest deny message passed to Claude. A phone keyboard can paste a
 *  novel; Claude reads this as the tool result, so it is bounded. */
const DENY_MESSAGE_MAX = 2000;

/** A held PermissionRequest hook (#1126): the pending hook response, its
 *  deadline timer, and the suggestions a standing grant echoes from. */
interface Hold {
  readonly resolve: (decision: PermissionDecision) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly suggestions: readonly unknown[] | undefined;
}

/** The (tool_name, tool_input) signature of an OPEN escalation (#673),
 *  tracked so an external-resolution signal can find and cancel it. */
interface ToolSignature {
  readonly toolName: string;
  readonly toolInputKey: string;
  readonly toolUseId: string | undefined;
  /** #711: true when this signature's escalation was for a subagent/team-member
   *  event (`input.agent_id` present). A mainOnly `cancelStale` (Stop) resolves
   *  only main-tagged entries, so a teammate's still-open escalation is not
   *  wiped out just because the lead agent idled. */
  readonly isSubagent: boolean;
  /** #799: the escalating event's own `input.agent_id` (undefined for a MAIN
   *  event). Lets `findOpenQuestionMatching` and `cancelStaleForAgent` scope
   *  a match to the EXACT agent that opened it: without this, two different
   *  agents (or a subagent and main) issuing an identical (tool_name,
   *  tool_input) could cross-resolve each other's unrelated escalation. */
  readonly agentId: string | undefined;
}

/** An observed tool call to correlate against `openQuestionSignatures`. Same
 *  shape whether it came from a PreToolUse/PostToolUse hook or (for the
 *  duplicate-re-request path) a fresh PermissionRequest. */
export interface ObservedToolCall {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseId?: string | undefined;
  /** #799: the observing event's own `input.agent_id` (undefined for a MAIN
   *  PreToolUse/PostToolUse). Must match the tracked signature's `agentId`
   *  exactly; see `ToolSignature.agentId`. */
  readonly agentId?: string | undefined;
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

export interface AutoApproveGateDeps {
  sessionRegistry: SessionRegistry;
  /** Wraps `HookEventBridge.isInSubagentContext()`. Read live per call. */
  isInSubagentContext: () => boolean;
  /**
   * Reset the subagent-context tracker (#710). Called ONLY when a MAIN-tagged
   * PermissionRequest (`agent_id` absent) observes `isInSubagentContext()`
   * stuck true: proof of a tracker leak (a dropped PostToolUse(Task/Agent)
   * completion), never a real subagent prompt (those carry `agent_id` and
   * park instead, #751). Optional so tests that don't wire it degrade to a
   * no-op; the escalate-as-main recovery still happens without it, just
   * without clearing the leaked state.
   */
  resetSubagentContext?: () => void;
  /**
   * Park a subagent-tagged prompt for its PTY render (#751): stash its rich
   * question in the `QuestionPresenceTracker`
   * (`parkAwaitingPTY(hookBridge.buildPermissionQuestion(input))`) WITHOUT
   * pushing or registering it. The question only surfaces if Claude's native
   * prompt actually renders on the PTY. Optional so tests that don't wire it
   * degrade to a plain passthrough (the rendered prompt then pushes bare via
   * the #712 orphan path).
   *
   * Returns the parked `Question.id` (#799) so `parkSubagentForPTY` can
   * register it in `openQuestionSignatures`; without an id there is nothing
   * for a later matching subagent tool event or `SubagentStop` to resolve.
   * `undefined` when the dep is unwired or throws.
   */
  parkForPTY?: (input: PermissionRequestHookInput) => UUID | undefined;
  /**
   * Every subagent-tagged permission that passed through (#807), reported to
   * the sink for observation ONLY: the decision is already made by the time
   * this fires, so a sink cannot influence it. Drives the informational
   * `subagent_alert` push (`subagent-alert.ts`), the only visibility path for
   * a subagent permission Claude's own permission flow handles without ever
   * rendering it. Throw-safe: a sink that throws is logged and absorbed.
   */
  onSubagentPassthrough?: (input: PermissionRequestHookInput) => void;
  /** Escalate to the user (wraps `HookEventBridge.handlePermissionRequest`).
   *  Returns the id of the `Question` it stashed, so the gate can push it and
   *  track its signature; `undefined` means no question was created. The gate
   *  wraps every call in a try/catch, so an implementation that throws is
   *  logged and absorbed (treated as `undefined`) rather than propagated. */
  escalate: (input: PermissionRequestHookInput) => UUID | undefined;
  /** Push a stashed question IMMEDIATELY (-> `tracker.pushHeldHook` ->
   *  sessionRegistry.addQuestion + APNS), stamped `held`. Called for a held
   *  binary prompt (#1126) and for a multi-choice / design escalation (#625),
   *  neither of which waits for a render. PTY question-emission is suppressed
   *  for hooked sessions (#625), so this is the SOLE push trigger for both.
   *  Idempotent per id. */
  onHeldEscalate?: (questionId: UUID) => void;
  /**
   * How long a binary prompt's hook is held for a phone answer, in ms
   * (`[prompts] hold_seconds`, #1126). Required: a hold with no deadline
   * would outlast the 2:00 auto-deny of auto-mode fallback prompts. At the
   * deadline the hook is released with an empty response, so Claude's dialog
   * stays and the terminal answers it.
   */
  holdMs: number;
  /**
   * The hold deadline passed with no answer (#1126, the #733 handoff): tell
   * the phone the prompt is waiting in the terminal. Called while the card is
   * still registered, so the notice can carry its text; the gate then
   * dismisses the card. Throw-safe.
   */
  onHoldDeadline?: (questionId: UUID) => void;
  /**
   * A prompt whose "answer at the terminal" notice was pushed
   * (`onHoldDeadline`) is resolved now: dismiss that notice from the lock
   * screen (#1126). Throw-safe.
   */
  onTerminalNoticeResolved?: (questionId: UUID) => void;
  /** Push trigger for a BINARY main-context escalation: the hook is answered
   *  'passthrough', Claude renders its native prompt at once, and the stashed
   *  question pushes when that render pairs with it, carrying the parsed
   *  screen's options (#1121, #1134). Absent => the render is never pushed
   *  (tests). Throw-safe. */
  pushOnRender?: (questionId: UUID) => void;
  /**
   * Called when an open escalation resolved WITHOUT the user answering it
   * through remi's answer path (an external-resolution signal, a Stop /
   * SubagentStop / SessionEnd sweep, `remi unstick`), so the daemon broadcasts
   * `question_resolved` + the APNS dismissal and the card clears on every
   * client. NOT called for a user answer: that path (input-events
   * `handleAnswer`) broadcasts its own 'answered' resolution. Throw-safe.
   */
  onResolved?: (questionId: UUID, reason: 'cancelled') => void;
  /** Tools whose prompt is always a design question, never binary (#572):
   *  used to classify an escalation as binary (pushed on render) vs design
   *  (pushed immediately). Absent => `ALWAYS_ESCALATE_TOOLS`. */
  alwaysEscalateTools?: ReadonlySet<string>;
}

export class AutoApproveGate {
  private readonly sessionTag: string;

  /**
   * Every OPEN escalation this gate has created (MAIN or parked subagent),
   * keyed by `Question.id`, by its (tool_name, tool_input, agentId) signature
   * (#673, #799). Created in `escalateToUser` or `parkSubagentForPTY`; removed
   * by `retireQuestion` (a user answer, a superseded render) or `resolveSupersededQuestion` (every
   * other resolution signal, see the module doc). A stale entry is harmless
   * (a later signature match only triggers a redundant, idempotent cleanup),
   * but the sweeps above keep it from accumulating.
   */
  private readonly openQuestionSignatures = new Map<UUID, ToolSignature>();

  /** Live holds (#1126): binary PermissionRequest hooks waiting for a phone
   *  answer, keyed by the card's `Question.id`. Every entry also has an
   *  `openQuestionSignatures` entry; a hold ends (`endHold`) on an answer,
   *  the deadline, or any resolution signal, and the signature may outlive
   *  it (a prompt released at the deadline is still on screen). */
  private readonly holds = new Map<UUID, Hold>();

  /** Ids of binary prompts this gate held and no longer holds, oldest first,
   *  bounded by `CLOSED_HOLD_MEMORY` (#1126). Lets `answerHeld` tell a late
   *  answer for a hook-backed card (refuse: nothing is typed for it) from a
   *  card this gate never held (the caller's own path). */
  private readonly closedHoldIds = new Set<UUID>();

  /** Open prompts whose "answer at the terminal" notice was pushed (#1126),
   *  so their resolution also dismisses the notice. A subset of
   *  `openQuestionSignatures`' keys, deleted with them. */
  private readonly terminalNotices = new Set<UUID>();

  constructor(
    private readonly deps: AutoApproveGateDeps,
    private readonly sessionId: UUID,
  ) {
    this.sessionTag = sessionId.slice(0, 8);
  }

  /**
   * Resolve open escalations on a session-level signal. The bridge calls this
   * on `Stop` (`mainOnly: true`) and `SessionEnd`.
   *
   * `opts.mainOnly` (#711) scopes the sweep to MAIN-tagged escalations only.
   * `Stop` fires whenever the LEAD agent idles, even while teammates
   * (subagent/`agent_id`-tagged escalations) are still running; resolving
   * everything on a lead Stop turned every teammate's pushed card phantom.
   * A MAIN-tagged signature still open at Stop is a passthrough escalation
   * Claude no longer waits on (Claude cannot fire `Stop` while blocked on its
   * native prompt), so it is resolved through the same funnel a tool-signature
   * match uses. `SessionEnd` is real teardown and resolves everything.
   */
  cancelStale(reason: string, opts?: { mainOnly?: boolean }): void {
    if (opts?.mainOnly ?? false) {
      for (const [qid, sig] of [...this.openQuestionSignatures]) {
        if (sig.isSubagent) continue;
        this.resolveSupersededQuestion(qid, reason, sig.toolName);
      }
      return;
    }
    this.resolveAllOpenQuestions(reason);
  }

  /**
   * #948: resolve EVERY currently-open escalation (main or subagent) through
   * `resolveSupersededQuestion` instead of a silent bookkeeping-only delete.
   * Shared by the two real teardown paths (`cancelStale` without `mainOnly`,
   * and `forceRelease`). Returns how many were resolved.
   */
  private resolveAllOpenQuestions(reason: string): number {
    const open = [...this.openQuestionSignatures];
    for (const [qid, sig] of open) {
      this.resolveSupersededQuestion(qid, reason, sig.toolName);
    }
    return open.length;
  }

  /**
   * #799: resolve every OPEN escalation this gate still tracks for ONE exact
   * subagent/team-member `agent_id`. Called from `SubagentStop`: that agent's
   * own turn is over, so anything still open for it (pushed, or parked and
   * never rendered) can no longer be "about to run a tool". This is the one
   * unambiguous signal for a subagent permission REJECTED in the terminal: a
   * deny produces no tool call, so a signature match can never catch it.
   * Scoped strictly to `agentId`: another agent's (or main's) escalation is
   * left untouched.
   */
  cancelStaleForAgent(agentId: string, reason: string): void {
    for (const [qid, sig] of [...this.openQuestionSignatures]) {
      if (sig.agentId !== agentId) continue;
      this.resolveSupersededQuestion(qid, reason, sig.toolName);
    }
  }

  /**
   * Force-release escape (#617, `remi unstick`): resolve and dismiss EVERY
   * open escalation this gate tracks, main or subagent, so stale cards clear
   * everywhere. Returns how many were resolved, for the caller to log.
   */
  forceRelease(reason: string): { resolved: number } {
    const resolved = this.resolveAllOpenQuestions(reason);
    log(`[AutoApprove ${this.sessionTag}] Force-release (${reason}): resolved ${resolved} card(s)`);
    return { resolved };
  }

  /**
   * Another path already removed and dismissed `questionId`: the user
   * answered it through remi's answer path (`input-events.ts`), or its render
   * was superseded (`QuestionPresenceTracker.onHooklessQuestionGone`). Stop
   * tracking its signature, so a later matching tool event does not resolve
   * (and dismiss) it a second time. Idempotent; a no-op for an id this gate
   * never tracked.
   */
  retireQuestion(questionId: UUID): void {
    this.openQuestionSignatures.delete(questionId);
    if (this.terminalNotices.delete(questionId)) {
      this.safeCueWithArg(
        'onTerminalNoticeResolved',
        this.deps.onTerminalNoticeResolved,
        questionId,
      );
    }
    // A held prompt retired by another path must not leave its hook pending
    // until the deadline: release it with the empty response, which decides
    // nothing (Claude's dialog stays).
    this.endHold(questionId, 'passthrough');
  }

  /**
   * True while any hook-backed prompt this gate escalated is still open:
   * held, released to the terminal at its deadline, or relayed and not yet
   * resolved (#1126). The presence tracker asks this before treating a PTY
   * render as an orphan: a hook-backed dialog on screen is never a hook-less
   * prompt, and its card must not be rebuilt from the screen and answered by
   * typing. Read live per call.
   */
  hasOpenHookPrompt(): boolean {
    return this.openQuestionSignatures.size > 0;
  }

  /**
   * Apply a phone answer to a held prompt (#1126). Synchronous end to end:
   * the hook response is resolved before this returns, so no other answer
   * or resolution signal can interleave. See `HeldAnswerOutcome`.
   *
   * The mapping is by meaning, from the card's own option flags, never from
   * a position on Claude's screen:
   *   - Cancel, or a No option -> `deny` (a No may carry `message`);
   *   - a standing option (`suggestionIndex`) -> `allow` +
   *     `updatedPermissions: [standingGrantFor(suggestion).echo]`, only when
   *     the stashed suggestion is still one a card may offer;
   *   - the one-time Yes (labeled exactly "Yes", no suggestion) -> `allow`;
   *   - anything else is refused and the hold stays.
   */
  answerHeld(questionId: UUID, answer: HeldAnswer): HeldAnswerOutcome {
    const hold = this.holds.get(questionId);
    if (!hold) return this.closedHoldIds.has(questionId) ? 'closed' : 'unknown';
    const decision = this.decisionFor(hold, answer);
    if (decision === null) {
      log(
        `[AutoApprove ${this.sessionTag}] Held ${questionId.slice(0, 8)}: answer is not an option this card offers; hold kept`,
      );
      return 'refused';
    }
    this.openQuestionSignatures.delete(questionId);
    this.endHold(questionId, decision);
    log(
      `[AutoApprove ${this.sessionTag}] Held ${questionId.slice(0, 8)} answered from the phone: ${describeDecision(decision)}`,
    );
    return 'resolved';
  }

  /** The hook decision a phone answer maps to, or null when the held card
   *  does not offer it. See `answerHeld`. */
  private decisionFor(hold: Hold, answer: HeldAnswer): PermissionDecision | null {
    if (answer.kind === 'cancel') return 'deny';
    if (answer.kind === 'text') return null;
    const { option } = answer;
    if (option.isNo && !option.isYes) {
      const message = answer.message?.trim().slice(0, DENY_MESSAGE_MAX) ?? '';
      return message.length > 0 ? { behavior: 'deny', message } : 'deny';
    }
    if (!option.isYes || option.isNo) return null;
    if (option.suggestionIndex !== undefined) {
      const grant = standingGrantFor(hold.suggestions?.[option.suggestionIndex]);
      return grant === null ? null : { behavior: 'allow', updatedPermissions: [grant.echo] };
    }
    return option.label.trim() === 'Yes' ? 'allow' : null;
  }

  /**
   * Escalate a main-context permission to the user. A BINARY prompt holds its
   * hook for a phone answer (`holdForAnswer`, #1126); a multi-choice / design
   * prompt is answered 'passthrough' and pushed immediately
   * (`escalatePassthrough`).
   */
  private escalateMain(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    if (!this.isBinaryEscalation(input)) {
      return Promise.resolve(this.escalatePassthrough(input));
    }
    return this.holdForAnswer(input);
  }

  /**
   * Hold a binary prompt's hook for a phone answer (#1126, ADR 0031). The
   * card is stashed, the hold registered, and only then the card pushed, so
   * an answer can never arrive for a hold that does not exist yet. The
   * returned promise is what the hook server is blocked on; it settles
   * through `endHold`, exactly once. No question id means no card: answer
   * 'passthrough' at once, and the terminal dialog is the only way to answer.
   */
  private holdForAnswer(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    const qid = this.escalateToUser(input);
    if (!qid) {
      logError(
        `[AutoApprove ${this.sessionTag}] binary escalation produced no question id; not holding (terminal prompt still answerable locally)`,
      );
      return Promise.resolve('passthrough');
    }
    const decision = new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => this.releaseAtDeadline(qid), this.deps.holdMs);
      // A hold is human-paced; it must never keep the daemon alive.
      timer.unref?.();
      this.holds.set(qid, {
        resolve,
        timer,
        suggestions: input.permission_suggestions as readonly unknown[] | undefined,
      });
    });
    this.safeCueWithArg('onHeldEscalate', this.deps.onHeldEscalate, qid);
    log(
      `[AutoApprove ${this.sessionTag}] Holding ${qid.slice(0, 8)} for a phone answer (${input.tool_name}, up to ${Math.round(this.deps.holdMs / 1000)}s)`,
    );
    return decision;
  }

  /**
   * The hold deadline passed with no answer (#1126): release the hook with
   * the empty response (Claude's dialog stays on screen and the terminal
   * answers it), tell the phone (`onHoldDeadline`, while the card is still
   * registered so the notice can name it), then dismiss the card. The
   * signature stays open: the prompt is still on screen, and a later tool
   * run, Stop or new user prompt resolves it.
   */
  private releaseAtDeadline(questionId: UUID): void {
    if (!this.holds.has(questionId)) return;
    log(
      `[AutoApprove ${this.sessionTag}] Held ${questionId.slice(0, 8)} reached its deadline; released to the terminal`,
    );
    this.safeCueWithArg('onHoldDeadline', this.deps.onHoldDeadline, questionId);
    this.terminalNotices.add(questionId);
    this.endHold(questionId, 'passthrough');
    this.removeAndDismiss(questionId, 'hold_deadline');
  }

  /**
   * End a hold, exactly once: clear its timer, forget it, remember it as
   * closed, and settle the hook response with `decision`. A no-op for an id
   * that is not held. Every path that ends a hold goes through here.
   */
  private endHold(questionId: UUID, decision: PermissionDecision): void {
    const hold = this.holds.get(questionId);
    if (!hold) return;
    clearTimeout(hold.timer);
    this.holds.delete(questionId);
    this.rememberClosed(questionId);
    hold.resolve(decision);
  }

  /** Add to the bounded closed-hold memory, evicting the oldest. */
  private rememberClosed(questionId: UUID): void {
    this.closedHoldIds.delete(questionId);
    this.closedHoldIds.add(questionId);
    if (this.closedHoldIds.size > CLOSED_HOLD_MEMORY) {
      const oldest = this.closedHoldIds.values().next();
      if (!oldest.done) this.closedHoldIds.delete(oldest.value);
    }
  }

  /** Remove a card from the registry and broadcast its dismissal, each step
   *  guarded so one failure cannot skip the other. Broadcasts only for a card
   *  that was registered: a dismissal for a card no client holds is noise. */
  private removeAndDismiss(questionId: UUID, reason: string, toolName?: string): void {
    // Fails toward broadcasting: a dismissal for an unknown id is a no-op on
    // every client, a missed one strands a card.
    let wasRegistered = true;
    try {
      wasRegistered = this.deps.sessionRegistry.getQuestion(this.sessionId, questionId) !== null;
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] getQuestion during card cleanup threw:`, err);
    }
    try {
      this.deps.sessionRegistry.removeQuestion(
        this.sessionId,
        questionId,
        reason,
        toolName,
        'AutoApproveGate.removeAndDismiss',
      );
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] removeQuestion during card cleanup threw:`, err);
    }
    if (wasRegistered) this.notifyResolved(questionId);
  }

  /**
   * Escalate a BINARY main-context permission. The hook is answered
   * 'passthrough', so Claude renders its native prompt in the terminal
   * immediately, and the stashed question is marked to push when that render
   * pairs with it (`pushOnRender`). Pushing on the render rather than now
   * keeps two properties: the card only reaches the phone for a prompt that
   * actually rendered, and its options are the parsed screen's (#1134), so a
   * phone answer is typed with the screen's numbering; `handleAnswer` still
   * refuses one whose label does not match the screen.
   */
  private escalateForRender(input: PermissionRequestHookInput): PermissionDecision {
    const qid = this.escalateToUser(input);
    if (qid) {
      this.safeCueWithArg('pushOnRender', this.deps.pushOnRender, qid);
    } else {
      logError(
        `[AutoApprove ${this.sessionTag}] binary escalation produced no question id; no push will follow (terminal prompt still answerable locally)`,
      );
    }
    return 'passthrough';
  }

  /**
   * Escalate a multi-choice / design permission (AskUserQuestion,
   * ExitPlanMode) and push it from the gate at once (#625). Claude renders its
   * native prompt and waits there; the user answers the pushed card (digits
   * typed via the PTY, or the #627 AskUserQuestion runner) or the terminal
   * directly. With PTY question-emission gated off for hooked sessions (#625),
   * this push is the only one the escalation gets.
   */
  private escalatePassthrough(input: PermissionRequestHookInput): PermissionDecision {
    const qid = this.escalateToUser(input);
    if (qid) {
      this.safeCueWithArg('onHeldEscalate', this.deps.onHeldEscalate, qid);
    } else {
      logError(
        `[AutoApprove ${this.sessionTag}] passthrough escalation produced no question id; no push sent (terminal prompt still answerable locally)`,
      );
    }
    return 'passthrough';
  }

  /**
   * Whether an escalated permission is BINARY (a plain allow/deny prompt).
   * Multi-choice prompts and design / plan-mode / long-form questions are
   * not, so they push immediately instead of on their render.
   */
  private isBinaryEscalation(input: PermissionRequestHookInput): boolean {
    const suggestions = input.permission_suggestions as readonly unknown[] | undefined;
    const alwaysEscalate = this.deps.alwaysEscalateTools ?? ALWAYS_ESCALATE_TOOLS;
    return (
      !isMultiChoicePermission(input.tool_name, suggestions) &&
      !isDesignQuestion(input.tool_name, input.tool_input, suggestions, alwaysEscalate)
    );
  }

  /**
   * Resolve a PermissionRequest to its hook response (#496). A binary main
   * prompt is held for a phone answer (#1126); everything else is answered
   * 'passthrough':
   *   - a SUBAGENT-tagged event (`agent_id` present) is parked for its PTY
   *     render (ADR 0004), REGARDLESS of `isInSubagentContext()` (the tracker
   *     only brackets synchronous Task/Agent spawns, so team members and
   *     background subagents always observe it false; the tag on the event is
   *     the truth). Claude then runs its normal permission flow: its own
   *     rules may absorb the request silently, or the native prompt renders on
   *     the main PTY and the parked card is pushed then.
   *   - a MAIN-tagged event (no `agent_id`) is escalated (`escalateMain`). If
   *     `isInSubagentContext()` is true at that moment, that is the #710
   *     tracker-leak signature (a dropped PostToolUse(Task/Agent) completion),
   *     not a real subagent prompt: reset the tracker and escalate as main.
   */
  resolvePermission(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    if (this.isSubagentEvent(input)) {
      log(
        `[Hooks] Subagent PermissionRequest parked for its PTY render: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
      this.parkSubagentForPTY(input);
      // Observation only, AFTER the routing above is settled: one branch of
      // Claude's own permission flow allows a call without ever rendering it,
      // so the parked record never pairs and nothing else would ever mention
      // it. The sink decides what is worth a notification.
      this.safeCueWithArg('onSubagentPassthrough', this.deps.onSubagentPassthrough, input);
      return Promise.resolve('passthrough');
    }
    if (this.deps.isInSubagentContext()) {
      // #716 (blanket-reset tradeoff): resetSubagentContext() clears ALL
      // tracked use_ids, not just the leaked one; harmless for routing, which
      // keys on the event's own agent_id, never on the tracker.
      logError(
        `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}); resetting tracker. Possible subagent-context tracker leak.`,
      );
      this.deps.resetSubagentContext?.();
    }
    return this.escalateMain(input);
  }

  /**
   * #751 routing for a subagent-tagged permission: park the rich question in
   * the presence tracker. The caller answers the hook 'passthrough'.
   *
   * A parkForPTY throw is absorbed: the passthrough still stands, and the
   * rendered prompt degrades to a bare #712 orphan push instead of a merged
   * one.
   *
   * #799: also registers the parked question's signature in
   * `openQuestionSignatures`, tagged `isSubagent: true` + this event's own
   * `agent_id`, so a matching subagent tool event (`cancelExternallyResolved`)
   * or that agent's `SubagentStop` (`cancelStaleForAgent`) can resolve it.
   * A re-park for the identical signature (the SAME agent re-asking) proves
   * the earlier parked/pushed record is dead and resolves it first.
   */
  private parkSubagentForPTY(input: PermissionRequestHookInput): void {
    let questionId: UUID | undefined;
    try {
      questionId = this.deps.parkForPTY?.(input);
    } catch (err) {
      logError(
        `[AutoApprove ${this.sessionTag}] parkForPTY threw (prompt will fall to the orphan push path):`,
        err,
      );
    }
    if (!questionId) return;
    const observed: ObservedToolCall = {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id,
      agentId: input.agent_id,
    };
    this.cancelExternallyResolved(observed, 'duplicate-re-park-subagent');
    this.openQuestionSignatures.set(questionId, {
      toolName: observed.toolName,
      toolInputKey: stableToolInputKey(observed.toolInput),
      toolUseId: observed.toolUseId,
      isSubagent: true,
      agentId: observed.agentId,
    });
  }

  /**
   * Invoke a single-argument lifecycle callback. A throw is logged and
   * absorbed so a push failure can never propagate into the hook dispatch
   * loop. The push IS load-bearing for reaching the phone, but Claude's
   * native prompt is still on screen and answerable locally either way.
   */
  private safeCueWithArg<T>(label: string, fn: ((arg: T) => void) | undefined, arg: T): void {
    if (!fn) return;
    try {
      fn(arg);
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] ${label} cue threw (ignored):`, err);
    }
  }

  /**
   * Tell the daemon an open escalation resolved without a user answer (#585,
   * P7), so it broadcasts `question_resolved` + dismisses the pushed card on
   * every client. Throw-safe.
   */
  private notifyResolved(questionId: UUID): void {
    const fn = this.deps.onResolved;
    if (!fn) return;
    try {
      fn(questionId, 'cancelled');
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] onResolved threw (ignored):`, err);
    }
  }

  /** Subagent/team-member events carry a non-empty `agent_id`; main events do not. */
  private isSubagentEvent(input: PermissionRequestHookInput): boolean {
    return typeof input.agent_id === 'string' && input.agent_id.length > 0;
  }

  /**
   * Stash + track a main-context escalation. Returns the created
   * `Question.id`, or `undefined` when none was created (escalate() threw;
   * logged here).
   */
  private escalateToUser(input: PermissionRequestHookInput): UUID | undefined {
    let questionId: UUID | undefined;
    try {
      questionId = this.deps.escalate(input);
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] escalateToUser threw:`, err);
    }
    if (questionId) {
      const observed: ObservedToolCall = {
        toolName: input.tool_name,
        toolInput: input.tool_input,
        toolUseId: input.tool_use_id,
        agentId: input.agent_id,
      };
      // #673 duplicate re-request: Claude re-issuing the IDENTICAL
      // PermissionRequest (same tool signature) proves any earlier OPEN
      // escalation for it can never be answered through its own prompt
      // again. Clean it up BEFORE tracking the new one (the new questionId is
      // not registered yet, so this can never find/cancel itself).
      //
      // UNVERIFIED (#886): this assumes Claude Code processes a turn's
      // main-context tool-permission hooks SEQUENTIALLY, so two
      // identical-signature MAIN escalations can never be live at once. That
      // runtime ordering has not been observed against a live Claude Code
      // (the #885 epic's named experiment); if it ever parallelizes, this
      // check would need a stronger key (e.g. requiring tool_use_id).
      this.cancelExternallyResolved(observed, 'duplicate-re-request');
      this.openQuestionSignatures.set(questionId, {
        toolName: observed.toolName,
        toolInputKey: stableToolInputKey(observed.toolInput),
        toolUseId: observed.toolUseId,
        // #711: tags this OPEN escalation main vs subagent/team-member, so a
        // mainOnly Stop (cancelStale) resolves only main-tagged entries.
        isSubagent: this.isSubagentEvent(input),
        // #799: always undefined here (escalateToUser is main-context only);
        // kept for ToolSignature's shape symmetry with parkSubagentForPTY.
        agentId: observed.agentId,
      });
    }
    return questionId;
  }

  /**
   * #673: called when an external signal proves a currently-OPEN escalation
   * was already resolved without going through remi's own answer path (see
   * the module doc for every caller). Signature-scoped (exact tool_name +
   * tool_input + agent_id match, or exact tool_use_id match when both sides
   * carry one) so it can only ever touch the ONE question it matches. A no-op
   * when no open escalation matches.
   */
  cancelExternallyResolved(observed: ObservedToolCall, reason: string): void {
    const qid = this.findOpenQuestionMatching(observed);
    if (!qid) return;
    this.resolveSupersededQuestion(qid, reason, observed.toolName);
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
      // #799: never cross agents. A MAIN observation (agentId undefined) can
      // only match a MAIN-registered signature, and a subagent observation
      // only its OWN agent's signature.
      if (sig.agentId !== observed.agentId) continue;
      // Two DIFFERENT tool calls can legitimately share an identical
      // (tool_name, tool_input) (e.g. two `ls` calls in a row): if BOTH sides
      // carry a tool_use_id, it must ALSO agree. When at least one side has
      // no id, the signature alone is the best available proof.
      if (observed.toolUseId !== undefined && sig.toolUseId !== undefined) {
        if (observed.toolUseId === sig.toolUseId) return qid;
        continue;
      }
      return qid;
    }
    return undefined;
  }

  /**
   * Cleanup for a question proven stale by an external signal (#673): stop
   * tracking its signature, end its hold with the empty response (#1126:
   * Claude ignores it once the prompt is answered, and it decides nothing
   * while the prompt is still up), remove it from the registry, and
   * broadcast its resolution so the pushed card clears everywhere
   * (`removeAndDismiss`).
   *
   * The broadcast fires only when the question was actually registered: a
   * parked subagent prompt that never rendered was never pushed, and a card
   * released at its deadline was already dismissed then.
   *
   * `toolName` (#808), when the caller knows it, is carried onto the
   * question-lifecycle trace record for this removal.
   */
  private resolveSupersededQuestion(qid: UUID, reason: string, toolName?: string): void {
    log(
      `[AutoApprove ${this.sessionTag}] Externally resolved ${qid.slice(0, 8)} (${reason}); clearing stale escalation`,
    );
    this.openQuestionSignatures.delete(qid);
    this.endHold(qid, 'passthrough');
    this.removeAndDismiss(qid, reason, toolName);
    if (this.terminalNotices.delete(qid)) {
      this.safeCueWithArg('onTerminalNoticeResolved', this.deps.onTerminalNoticeResolved, qid);
    }
  }
}

/** A hook decision as one log fragment, without the deny message text. */
function describeDecision(decision: PermissionDecision): string {
  if (typeof decision === 'string') return decision;
  if (decision.behavior === 'deny') {
    return decision.message === undefined ? 'deny' : 'deny (with message)';
  }
  return 'allow (standing grant echoed)';
}
