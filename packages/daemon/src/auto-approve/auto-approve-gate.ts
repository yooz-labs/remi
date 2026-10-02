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
 *   - an answer in the terminal ends the hold: a Yes runs the tool, and its
 *     `PostToolUse` (or `PostToolUseFailure`) carries the `tool_use_id` this
 *     prompt was paired with from the `PreToolUse` that preceded it
 *     (`notePreToolUse` / `pairToolUse`; the request itself carries no id),
 *     so the hook gets an empty response Claude ignores; a No or Esc makes
 *     Claude close the held request, which the hook server's abort signal
 *     reports (`onHoldAborted`), and the card is dismissed;
 *   - the hold deadline (`[prompts] hold_seconds`) releases the hook with an
 *     empty response, Claude's dialog simply stays, the card is dismissed
 *     and `onReleasedToTerminal` tells the phone to answer at the terminal
 *     (#733). Every other release of a live hold to the terminal (an
 *     ambiguous signal, `remi unstick`, Claude's hook timeout) tells it too.
 * An empty response never decides anything: it is what every non-answer
 * path sends.
 *
 * Since #1127 AskUserQuestion and ExitPlanMode are held the same way (their
 * dialogs render during the hold too), and a phone answer resolves the hook
 * with a structured `updatedInput` (`structured-answers.ts`): the tool input
 * echoed with the user's `answers`, or a plan approval echoed with a
 * session `setMode`. An answer that is not complete is refused and the hold
 * stays; nothing is completed with a guess.
 *
 * Other shapes:
 *   - a multi-choice string-label permission, or a question-shaped tool that
 *     is not AskUserQuestion, is answered 'passthrough' and pushed at once
 *     (`escalatePassthrough`; no structured hook answer was verified for
 *     either): a multi-choice card's answer is typed into the PTY behind the
 *     #1134 screen guard, and a question-shaped tool's card is
 *     `terminalOnly` (its dialog is Claude's permission prompt), so nothing
 *     from the phone is applied to it but Cancel;
 *   - a SUBAGENT-tagged prompt (`agent_id` present) depends on
 *     `hasLocalTerminal` (#1126): a background subagent's dialog does not
 *     render while its hook is held. With a local terminal it is answered
 *     'passthrough' and parked (`passSubagentToTerminal`, ADR 0004); when
 *     its dialog renders the phone gets an informational "answer at the
 *     terminal" notice, never an answerable card. Without a local terminal
 *     (daemon or hub mode) it is escalated exactly like a main prompt: held,
 *     with an answerable card. Either way the subagent alert
 *     (`subagent-alert.ts`) stays silent for it: the alert is fed from the
 *     hook bridge, not from here, and only for calls that never prompted
 *     (#1155).
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
 *     PostToolUseFailure / PermissionDenied in `hook-bridge-setup.ts` when
 *     the observed call matches an open escalation (its paired tool_use_id
 *     when both sides carry one, else the tool name + input): the tool is
 *     now running (or was refused), so the user must have answered it
 *     directly in the terminal or Claude's own permission mode resolved it;
 *   - a duplicate re-request: `escalateToUser` / `passSubagentToTerminal` resolve
 *     an already-open entry with the SAME signature before registering the
 *     new one, since Claude re-issuing the identical PermissionRequest proves
 *     the earlier card can never be answered through its own prompt again;
 *   - `cancelStale('Stop', {mainOnly:true})`: Claude cannot fire `Stop` while
 *     still blocked on its own native prompt, so a MAIN-tagged signature still
 *     open at Stop was resolved without a matching tool call (most often a
 *     "No" answered in the terminal, which fires no tool call at all);
 *     `UserPromptSubmit` sweeps the same way (#1126): a terminal "No"
 *     interrupts the turn without a `Stop`, and a new prompt proves the
 *     dialog is gone; so does a main-agent `StopFailure` (#1153), a turn that
 *     ended on an API error, which Claude cannot report while blocked on its
 *     own prompt either;
 *   - `cancelStaleForAgent`, called from `SubagentStop`: the single-agent
 *     mirror of the Stop reasoning;
 *   - `cancelStale('SessionEnd')`: real teardown, every open escalation is
 *     resolved;
 *   - `forceRelease` (`remi unstick`): every open escalation is resolved
 *     except a LIVE hold, which is handed to the terminal with a notice
 *     (`releaseWithNotice`, #1126) because its dialog is on screen.
 * Each resolution routes through `resolveSupersededQuestion`, which ends the hold
 * (an empty response), removes the card from the registry and fires
 * `onResolved` (question_resolved + APNS dismissal), never a silent
 * bookkeeping-only delete. A phone answer (or a superseded render) retires
 * the signature through `retireQuestion` instead, because that path already
 * removes and dismisses the card itself.
 */

import type { AnswerSelection, QuestionOption, UUID } from '@remi/shared';

import { log, logError } from '../cli/logger.ts';
import { standingGrantFor } from '../hooks/hook-event-bridge.ts';
import type { PermissionDecision, PermissionRequestHookInput } from '../hooks/index.ts';
import {
  ASK_DISMISSED_MESSAGE,
  askOptionIndex,
  askUserQuestionDecision,
  exitPlanModeDecision,
  keepPlanningDecision,
  parseAskUserQuestion,
} from '../hooks/structured-answers.ts';
import type { SessionRegistry } from '../session/index.ts';
import { ALWAYS_ESCALATE_TOOLS, isDesignQuestion, isMultiChoicePermission } from './multichoice.ts';
import { stableToolInputKey } from './tool-input-key.ts';

/**
 * A phone answer to a held prompt (#1126), as the answer path received it.
 * `option` is one of the card's own options; `message` is the optional text
 * a "No" (or "Keep planning") carries, which Claude receives as the denied
 * tool's result. `cancel` is the card's universal Cancel (Esc) action, which
 * on a held card is a "No". `selections` is a structured AskUserQuestion
 * answer (#1127), not yet validated.
 */
export type HeldAnswer =
  | { readonly kind: 'option'; readonly option: QuestionOption; readonly message?: string }
  | { readonly kind: 'cancel' }
  /** Free text, or an answer matching none of the card's options. Only a
   *  one-question, single-select AskUserQuestion takes it (as that
   *  question's answer, #1127); any other live hold refuses it. */
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'selections'; readonly selections: readonly AnswerSelection[] }
  /** A plain answer that is one option's value and a different option's
   *  label (#1127 review S1): never resolved to either, so a live hold
   *  refuses it. */
  | { readonly kind: 'ambiguous' };

/**
 * What `answerHeld` did with a phone answer (#1126):
 *   - `resolved`: the hook answered with the user's choice.
 *   - `refused`: the hold is live but the answer is not one its card offers
 *     (an unknown option, a standing grant whose suggestion is gone); nothing
 *     changed, the card and the hold stay.
 *   - `closed`: a binary prompt this gate held whose hold has ended (answered
 *     in the terminal, released at the deadline, aborted). Its answer belongs
 *     to the terminal now; nothing may be typed for it.
 *   - `unknown`: not a prompt this gate held (a hook-less prompt, a
 *     multi-choice permission); the caller's own path applies.
 */
export type HeldAnswerOutcome = 'resolved' | 'refused' | 'closed' | 'unknown';

/** How many ended binary-prompt ids `answerHeld` remembers as `closed`.
 *  The registry keeps at most 8 pending cards beyond the held ones (a held
 *  card is never evicted), so a late answer for any card a client can still
 *  show is far inside this window. */
const CLOSED_HOLD_MEMORY = 256;

/** Longest deny message passed to Claude. A phone keyboard can paste a
 *  novel; Claude reads this as the tool result, so it is bounded. */
const DENY_MESSAGE_MAX = 2000;

/**
 * What a held prompt asks, which decides how a phone answer maps to its hook
 * response (`decisionFor`): a binary permission (#1126), an AskUserQuestion
 * or an ExitPlanMode (#1127).
 */
type HoldKind = 'binary' | 'ask' | 'plan';

/** A held PermissionRequest hook (#1126): the pending hook response, its
 *  deadline timer, the suggestions a standing grant echoes from, the tool
 *  input a structured answer echoes (#1127), how to stop listening for the
 *  request's abort, and when the hold began. */
interface Hold {
  readonly kind: HoldKind;
  /** The request came from a subagent (`agent_id`, daemon or hub mode): its
   *  plan approval sets no session mode (#1127 review S5). */
  readonly subagent: boolean;
  readonly resolve: (decision: PermissionDecision) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly suggestions: readonly unknown[] | undefined;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly detachAbort: () => void;
  readonly startedAt: number;
}

/** Why a live hold was released to the terminal with no answer (#1126):
 *  nobody answered in time (`deadline`, also Claude's hook timeout), or remi
 *  let go early (`released`: an ambiguous signal, `remi unstick`). */
export type TerminalReleaseCause = 'deadline' | 'released';

/** An abort this close to the registered hook timeout is Claude's timeout,
 *  not an answer in the terminal (#1126 lead decision). */
const HOOK_TIMEOUT_MARGIN_MS = 5_000;

/**
 * A tool call Claude announced with `PreToolUse` and has not finished
 * (#1126). `PermissionRequest` carries no `tool_use_id`, but it fires about
 * 10 ms after the `PreToolUse` of the same call (same tool name and input),
 * so pairing the two gives the held prompt the id its `PostToolUse` will
 * carry when the terminal answers Yes.
 */
interface InFlightToolUse {
  readonly toolName: string;
  readonly toolInputKey: string;
  readonly agentId: string | undefined;
  readonly at: number;
}

/** How many unfinished tool calls are remembered for pairing, oldest dropped
 *  first. A main agent and its subagents run a handful at once. */
const IN_FLIGHT_TOOL_USE_MAX = 64;

/** How long an unfinished tool call stays pairable. An auto-mode fallback
 *  prompt fires after the classifier decided, seconds after `PreToolUse`;
 *  a call that never finishes (interrupted) must not pair forever. */
const IN_FLIGHT_TOOL_USE_TTL_MS = 10 * 60_000;

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
   * Required (#1126, ADR 0031): does this session have a local terminal
   * (wrapper mode)? Decides a SUBAGENT prompt's route. A background
   * subagent's dialog does not render while its hook is held, so:
   *   - with a local terminal, the hook is answered 'passthrough' so the
   *     dialog renders there, and the phone gets an informational "answer at
   *     the terminal" notice when it does (`parkForPTY`);
   *   - without one (daemon or hub mode), nobody could answer a rendered
   *     dialog, so the prompt is held and pushed as an answerable card,
   *     exactly like a main-agent prompt.
   * Known at session setup; no default, so a caller cannot forget it.
   */
  hasLocalTerminal: boolean;
  /**
   * Park a subagent-tagged prompt for its PTY render (#751): stash its rich
   * question in the `QuestionPresenceTracker` WITHOUT pushing or registering
   * it. When Claude's native dialog renders, the tracker pushes an
   * informational "answer at the terminal" notice for it (#1126; the wiring
   * reports that through `noteTerminalNotice`), never an answerable card:
   * the hook was answered 'passthrough', so only the terminal can answer.
   *
   * Returns the parked `Question.id` (#799) so `passSubagentToTerminal` can
   * register it in `openQuestionSignatures`; without an id there is nothing
   * for a later matching subagent tool event or `SubagentStop` to resolve.
   * `undefined` when the dep is unwired or throws; the gate then pushes the
   * notice at once instead (`pushTerminalNoticeNow`).
   */
  parkForPTY?: (input: PermissionRequestHookInput) => UUID | undefined;
  /**
   * Push the "answer at the terminal" notice for a subagent prompt NOW, when
   * there is no render path to push it from (`parkForPTY` unwired, threw or
   * returned no id, #1126). Returns the notice's question id so its later
   * resolution can dismiss it; `undefined` when nothing was pushed.
   * Throw-safe.
   */
  pushTerminalNoticeNow?: (input: PermissionRequestHookInput) => UUID | undefined;
  /** Escalate to the user (wraps `HookEventBridge.handlePermissionRequest`).
   *  Returns the id of the `Question` it stashed, so the gate can push it and
   *  track its signature; `undefined` means no question was created. The gate
   *  wraps every call in a try/catch, so an implementation that throws is
   *  logged and absorbed (treated as `undefined`) rather than propagated. */
  escalate: (input: PermissionRequestHookInput) => UUID | undefined;
  /** Push a stashed question IMMEDIATELY (-> `tracker.pushHeldHook` ->
   *  sessionRegistry.addQuestion + APNS), stamped `held`. Called for a held
   *  prompt (binary #1126; AskUserQuestion, ExitPlanMode #1127) and for a
   *  passthrough multi-choice escalation (#625), none of which waits for a
   *  render. PTY question-emission is suppressed
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
   * The PermissionRequest hook timeout registered with Claude, in ms (600 s
   * in wrapper mode, 3600 s in daemon or hub mode, #1126). Claude closes a
   * held request at that timeout and decides nothing; the dialog stays. An
   * abort within `HOOK_TIMEOUT_MARGIN_MS` of it is therefore handled like
   * the deadline (released to the terminal, notice pushed), never as a No
   * answered in the terminal. Absent: every abort is a terminal answer.
   */
  hookTimeoutMs?: number;
  /**
   * A live hold was released to the terminal with no answer (#1126, the
   * #733 handoff): tell the phone the prompt may be waiting there. `cause`
   * is `deadline` for the hold deadline or Claude's hook timeout (nobody
   * answered in time), and `released` when remi let go early (an ambiguous
   * signal that the hold may be stale, or `remi unstick`). Called while the
   * card is still registered, so the notice can carry its text; the gate
   * then dismisses the card. Throw-safe.
   */
  onReleasedToTerminal?: (questionId: UUID, cause: TerminalReleaseCause) => void;
  /**
   * A prompt whose "answer at the terminal" notice was pushed
   * (`onReleasedToTerminal`) is resolved now: dismiss that notice from the
   * lock screen (#1126). Throw-safe.
   */
  onTerminalNoticeResolved?: (questionId: UUID) => void;
  /**
   * Called when an open escalation resolved WITHOUT the user answering it
   * through remi's answer path (an external-resolution signal, a Stop /
   * SubagentStop / SessionEnd sweep, `remi unstick`), so the daemon broadcasts
   * `question_resolved` + the APNS dismissal and the card clears on every
   * remi client (Telegram does not dismiss, #1148). NOT called for a user answer: that path (input-events
   * `handleAnswer`) broadcasts its own 'answered' resolution. Throw-safe.
   */
  onResolved?: (questionId: UUID, reason: 'cancelled') => void;
  /** Tools whose prompt is always a design question, never binary (#572):
   *  used to classify an escalation as binary (held, #1126) vs design
   *  (passthrough, pushed immediately). AskUserQuestion and ExitPlanMode are
   *  held by name before this applies (#1127). Absent =>
   *  `ALWAYS_ESCALATE_TOOLS`. */
  alwaysEscalateTools?: ReadonlySet<string>;
}

export class AutoApproveGate {
  private readonly sessionTag: string;

  /**
   * Every OPEN escalation this gate has created (MAIN or parked subagent),
   * keyed by `Question.id`, by its (tool_name, tool_input, agentId) signature
   * (#673, #799). Created in `escalateToUser` or `passSubagentToTerminal`; removed
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
   *  `terminalPrompts`, deleted with it. */
  private readonly terminalNotices = new Set<UUID>();

  /**
   * Open prompts whose dialog is (or may still be) on screen and whose
   * answer belongs to the terminal (#1126), each with the time it got there:
   * a hold released at its deadline, a hold released early by an ambiguous
   * signal (`releaseToTerminal`), and a wrapper-mode subagent prompt once
   * its dialog rendered. A subset of `openQuestionSignatures`' keys, closed
   * only by a hook signal (its tool run, Stop, a new prompt, the agent's
   * next tool call or SubagentStop, teardown), never by a late phone answer
   * (`retireQuestion`). An entry younger than the session's hold length is
   * what `hasOpenHookPrompt` reports besides a live main hold.
   */
  private readonly terminalPrompts = new Map<UUID, number>();

  /** Unfinished tool calls by `tool_use_id`, oldest first (#1126), for
   *  pairing a PermissionRequest with its call. See `InFlightToolUse`. */
  private readonly inFlightToolUses = new Map<string, InFlightToolUse>();

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
    // #948: real teardown resolves EVERY open escalation (main or subagent)
    // through `resolveSupersededQuestion`, never a silent bookkeeping-only
    // delete.
    for (const [qid, sig] of [...this.openQuestionSignatures]) {
      this.resolveSupersededQuestion(qid, reason, sig.toolName);
    }
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
   * Force-release escape (#617, `remi unstick`): clear every open escalation
   * this gate tracks, main or subagent, so stale cards clear on every remi
   * client and from APNS (Telegram does not dismiss, #1148).
   * A LIVE hold is not closed but released to the terminal (#1126 lead
   * decision): its dialog is on screen, so the prompt stays open there
   * (orphan suppression kept) and the phone is told it was handed back.
   * Everything else is resolved and dismissed. Returns how many cards were
   * cleared, for the caller to log.
   */
  forceRelease(reason: string): { resolved: number } {
    const live = [...this.holds.keys()];
    for (const qid of live) this.releaseWithNotice(qid, 'released', reason);
    const released = new Set(live);
    let resolved = 0;
    for (const [qid, sig] of [...this.openQuestionSignatures]) {
      if (released.has(qid)) continue;
      this.resolveSupersededQuestion(qid, reason, sig.toolName);
      resolved++;
    }
    log(
      `[AutoApprove ${this.sessionTag}] Force-release (${reason}): released ${live.length} live hold(s) to the terminal, resolved ${resolved} other card(s)`,
    );
    return { resolved: live.length + resolved };
  }

  /**
   * Another path already removed and dismissed `questionId`: the user
   * answered it through remi's answer path (`input-events.ts`), or its render
   * was superseded (`QuestionPresenceTracker.onHooklessQuestionGone`). Stop
   * tracking its signature, so a later matching tool event does not resolve
   * (and dismiss) it a second time. Idempotent; a no-op for an id this gate
   * never tracked.
   *
   * Except a prompt whose answer now belongs to the terminal
   * (`terminalPrompts`, #1126), for example one released at its hold
   * deadline (its card already dismissed by this gate, its "answer at the
   * terminal" notice out): it is still on screen, and only a hook signal
   * (its tool run, Stop, a new prompt, SubagentStop) proves it answered. A late phone answer for the dismissed card reaches here
   * through the stale-answer path; retiring then would clear the notice and
   * let the dialog's redraws be read as hook-less orphans. Live-observed on
   * the #1126 verification run before this guard.
   */
  retireQuestion(questionId: UUID): void {
    if (this.terminalPrompts.has(questionId)) {
      log(
        `[AutoApprove ${this.sessionTag}] Not retiring ${questionId.slice(0, 8)}: its prompt is waiting in the terminal`,
      );
      return;
    }
    this.openQuestionSignatures.delete(questionId);
    // A held prompt retired by another path must not leave its hook pending
    // until the deadline: release it with the empty response, which decides
    // nothing (Claude's dialog stays).
    this.endHold(questionId, 'passthrough');
  }

  /**
   * True while a hook-backed dialog this gate knows about is (or may be) on
   * screen (#1126): a live main hold (its dialog renders during the hold),
   * or any prompt in `terminalPrompts` (main or subagent) younger than the
   * session's hold length (`holdMs`). The presence tracker asks this before
   * treating a PTY render as an orphan: such a render is that dialog or a
   * redraw of it, and must not be rebuilt into a card the phone would answer
   * by typing; for a wrapper-mode subagent prompt the phone keeps exactly one
   * artifact, its notice. Read live per call.
   *
   * Bounded on purpose (#1126 lead decision), because every entry this
   * counts suppresses a genuinely hook-less prompt's card (sandbox network,
   * trust, an agent-team dialog) while it lasts. Only what does not render
   * is excluded:
   *   - subagent HOLDS never count: their dialog does not render while held;
   *   - a `terminalPrompts` entry stops counting once it is older than
   *     `holdMs` (a No answered in the terminal fires no hook), and a
   *     subagent's entry is also cleared by that agent's next tool call
   *     (`noteAgentToolCall`), `SubagentStop` or `SessionEnd`. A redraw past
   *     that takes the guarded hook-less path (#1134: typed only on an exact
   *     label match, fail closed).
   * A held AskUserQuestion or ExitPlanMode (#1127) counts as a main hold;
   * a passthrough multi-choice card is registered, which the tracker's
   * live-question check already covers.
   */
  hasOpenHookPrompt(): boolean {
    if (this.hasMainHold()) return true;
    const cutoff = Date.now() - this.deps.holdMs;
    for (const at of this.terminalPrompts.values()) {
      if (at > cutoff) return true;
    }
    return false;
  }

  /**
   * A subagent started a tool call (its `PreToolUse`, #1126): any of its own
   * prompts waiting in the terminal was answered, since an agent does not
   * move on while its dialog is up. A No answered there fires no hook, so
   * without this the entry (and its "answer at the terminal" notice) would
   * last until `SubagentStop`. Resolved like any external signal; the call's
   * own prompt, if any, is not affected (it is asked after this). A no-op
   * for the main agent, whose prompts are swept by `Stop` and a new prompt.
   */
  noteAgentToolCall(agentId: string | undefined, toolUseId: string | undefined): void {
    if (agentId === undefined || this.terminalPrompts.size === 0) return;
    for (const qid of [...this.terminalPrompts.keys()]) {
      const sig = this.openQuestionSignatures.get(qid);
      if (sig?.agentId !== agentId) continue;
      if (toolUseId !== undefined && sig.toolUseId === toolUseId) continue;
      this.resolveSupersededQuestion(qid, 'agent-next-tool-call', sig.toolName);
    }
  }

  /**
   * A bare Escape reached the terminal through remi (#1155 lead decision):
   * the web client's Esc button, Telegram's `/interrupt`, or an attach
   * client's Esc key. It dismisses the dialog on screen, and Claude fires no
   * hook for that, so the MAIN agent's prompts waiting in the terminal are
   * resolved now (their notice dismissed) instead of counting for the rest
   * of the hold length; the chat guard and Stop then fall back to the
   * screen parse. Two things are left alone: a live hold (Claude closes the
   * held request itself, which the abort path handles) and a subagent's
   * entry (cleared by that agent's next tool call, `SubagentStop` or
   * `SessionEnd`). An Escape typed at the local terminal of a wrapper
   * session never passes through remi, so it does not reach here.
   */
  noteTerminalEscape(): void {
    for (const qid of [...this.terminalPrompts.keys()]) {
      if (this.holds.has(qid)) continue;
      const sig = this.openQuestionSignatures.get(qid);
      if (sig?.isSubagent === true) continue;
      this.resolveSupersededQuestion(qid, 'terminal-escape', sig?.toolName);
    }
  }

  /** Mark a prompt as waiting in the terminal, keeping its first time. */
  private markTerminalPrompt(questionId: UUID): void {
    if (!this.terminalPrompts.has(questionId)) this.terminalPrompts.set(questionId, Date.now());
  }

  /** True while `questionId`'s hook is held for a phone answer (#1126). The
   *  pending-question cap never evicts such a card. */
  isHeld(questionId: UUID): boolean {
    return this.holds.has(questionId);
  }

  /**
   * True while a MAIN-agent prompt's hook is held (#1126): its dialog is on
   * screen (it renders during the hold), so text typed into the PTY would
   * land in it and the Enter after it would confirm the highlighted option.
   * The chat guard (#1140) refuses chat text then, even when the PTY parser
   * has not recognized the menu. A held subagent prompt (daemon mode) does
   * not count: its dialog does not render while held.
   */
  hasMainHold(): boolean {
    for (const qid of this.holds.keys()) {
      if (this.openQuestionSignatures.get(qid)?.isSubagent === false) return true;
    }
    return false;
  }

  /**
   * Apply a phone answer to a held prompt (#1126). Synchronous end to end:
   * the hook response is resolved before this returns, so no other answer
   * or resolution signal can interleave. See `HeldAnswerOutcome`.
   *
   * The mapping is by meaning, never from a position on Claude's screen.
   * For a binary permission, from the card's own option flags:
   *   - Cancel, or a No option -> `deny` (a No may carry `message`);
   *   - a standing option (`suggestionIndex`) -> `allow` +
   *     `updatedPermissions: [standingGrantFor(suggestion).echo]`, only when
   *     the stashed suggestion is still one a card may offer;
   *   - the one-time Yes (labeled exactly "Yes", no suggestion) -> `allow`.
   * For an AskUserQuestion or ExitPlanMode (#1127), see `askDecision` and
   * `planDecision`. Anything else is refused and the hold stays.
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
    if (hold.kind === 'ask') return askDecision(hold.toolInput, answer);
    if (hold.kind === 'plan') return planDecision(hold.toolInput, answer, hold.subagent);
    if (answer.kind === 'cancel') return 'deny';
    if (answer.kind !== 'option') return null;
    const { option } = answer;
    if (option.isNo && !option.isYes) {
      const message =
        typeof answer.message === 'string' ? answer.message.trim().slice(0, DENY_MESSAGE_MAX) : '';
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
   * Escalate a main-context permission to the user. A binary prompt (#1126),
   * an AskUserQuestion or an ExitPlanMode (#1127) holds its hook for a phone
   * answer (`holdForAnswer`); a multi-choice permission or another
   * question-shaped tool is answered 'passthrough' and pushed immediately
   * (`escalatePassthrough`).
   */
  private escalateMain(
    input: PermissionRequestHookInput,
    signal: AbortSignal | undefined,
  ): Promise<PermissionDecision> {
    const kind = this.holdKindFor(input);
    if (kind === null) return Promise.resolve(this.escalatePassthrough(input));
    return this.holdForAnswer(input, signal, kind);
  }

  /**
   * Hold a binary prompt's hook for a phone answer (#1126, ADR 0031). The
   * card is stashed, the hold registered, and only then the card pushed, so
   * an answer can never arrive for a hold that does not exist yet. The
   * returned promise is what the hook server is blocked on; it settles
   * through `endHold`, exactly once. No question id means no card: answer
   * 'passthrough' at once and let Claude's dialog take it (with no gate
   * entry, its render may reach the phone only as a hook-less card).
   *
   * `signal` is the hook request's own abort signal: Claude closes the held
   * request when the user answers No or presses Esc in the terminal (no hook
   * event fires for that), when the session ends, or at its own hook
   * timeout. Any of those dismisses the card (`onHoldAborted`).
   */
  private holdForAnswer(
    input: PermissionRequestHookInput,
    signal: AbortSignal | undefined,
    kind: HoldKind,
  ): Promise<PermissionDecision> {
    if (signal?.aborted) return Promise.resolve('passthrough');
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
      const onAbort = (): void => this.onHoldAborted(qid);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.holds.set(qid, {
        kind,
        subagent: this.isSubagentEvent(input),
        resolve,
        timer,
        suggestions: input.permission_suggestions as readonly unknown[] | undefined,
        toolInput: input.tool_input,
        detachAbort: () => signal?.removeEventListener('abort', onAbort),
        startedAt: Date.now(),
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
   * answers it), tell the phone (`onReleasedToTerminal`, while the card is still
   * registered so the notice can name it), then dismiss the card. The
   * signature stays open: the prompt is still on screen, and a later tool
   * run, Stop or new user prompt resolves it.
   */
  private releaseAtDeadline(questionId: UUID, reason = 'hold_deadline'): void {
    if (!this.holds.has(questionId)) return;
    log(
      `[AutoApprove ${this.sessionTag}] Held ${questionId.slice(0, 8)} reached its deadline (${reason}); released to the terminal`,
    );
    this.releaseWithNotice(questionId, 'deadline', reason);
  }

  /**
   * Release a live hold to the terminal and tell the phone (#1126): the
   * notice first, while the card is still registered so it can name the
   * ask, then `releaseToTerminal`. Every release of a live hold that is not
   * an answer goes through here, so none is silent.
   */
  private releaseWithNotice(questionId: UUID, cause: TerminalReleaseCause, reason: string): void {
    const notify = this.deps.onReleasedToTerminal;
    if (notify) {
      try {
        notify(questionId, cause);
      } catch (err) {
        logError(`[AutoApprove ${this.sessionTag}] onReleasedToTerminal cue threw (ignored):`, err);
      }
      this.terminalNotices.add(questionId);
    }
    this.releaseToTerminal(questionId, reason);
  }

  /**
   * End a live hold with the empty response, dismiss its card, and keep the
   * prompt open in `terminalPrompts` (#1126): its dialog is still on screen
   * and the terminal answers it. Used at the deadline, and when an
   * ambiguous signal (a name + input match with no paired id, or an
   * identical re-request) suggests the hold may be stale: releasing early
   * costs the phone its card, never a decision, and keeping the prompt open
   * keeps its redraws from becoming a typed orphan card.
   */
  private releaseToTerminal(questionId: UUID, reason: string): void {
    this.markTerminalPrompt(questionId);
    this.endHold(questionId, 'passthrough');
    this.removeAndDismiss(questionId, reason);
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
    hold.detachAbort();
    this.holds.delete(questionId);
    this.rememberClosed(questionId);
    hold.resolve(decision);
  }

  /**
   * Claude closed a held request before any answer reached it (#1126): the
   * user answered No or pressed Esc in the terminal, or the session ended.
   * Nothing is left to answer, so the prompt is closed and its card
   * dismissed. The settle is a formality (the client is gone); `endHold`
   * keeps it exactly-once.
   *
   * Except at Claude's own hook timeout (`hookTimeoutMs`): Claude then
   * closes the request without deciding and its dialog stays, so the prompt
   * is released to the terminal like at the deadline, with its notice. The
   * deadline normally comes first; this covers a delayed timer (a sleeping
   * machine).
   */
  private onHoldAborted(questionId: UUID): void {
    const hold = this.holds.get(questionId);
    if (!hold) return;
    const timeoutMs = this.deps.hookTimeoutMs;
    if (
      timeoutMs !== undefined &&
      Date.now() - hold.startedAt >= timeoutMs - HOOK_TIMEOUT_MARGIN_MS
    ) {
      this.releaseAtDeadline(questionId, 'hook_timeout');
      return;
    }
    log(
      `[AutoApprove ${this.sessionTag}] Held ${questionId.slice(0, 8)} was closed by Claude (answered in the terminal, or the session ended); dismissing its card`,
    );
    this.openQuestionSignatures.delete(questionId);
    this.terminalPrompts.delete(questionId);
    this.endHold(questionId, 'passthrough');
    this.removeAndDismiss(questionId, 'hold_aborted');
  }

  /**
   * Record a `PreToolUse` (#1126): the call is in flight until its
   * `PostToolUse`, `PostToolUseFailure` or `PermissionDenied`
   * (`noteToolUseEnded`). A `PermissionRequest` for the same call pairs with
   * it (`pairToolUse`). Ignored without a `tool_use_id`.
   */
  notePreToolUse(observed: ObservedToolCall): void {
    if (observed.toolUseId === undefined) return;
    this.pruneInFlightToolUses();
    this.inFlightToolUses.delete(observed.toolUseId);
    this.inFlightToolUses.set(observed.toolUseId, {
      toolName: observed.toolName,
      toolInputKey: stableToolInputKey(observed.toolInput),
      agentId: observed.agentId,
      at: Date.now(),
    });
    if (this.inFlightToolUses.size > IN_FLIGHT_TOOL_USE_MAX) {
      const oldest = this.inFlightToolUses.keys().next();
      if (!oldest.done) this.inFlightToolUses.delete(oldest.value);
    }
  }

  /** The call with this id finished or was refused; it can no longer pair. */
  noteToolUseEnded(toolUseId: string | undefined): void {
    if (toolUseId !== undefined) this.inFlightToolUses.delete(toolUseId);
  }

  /**
   * The `tool_use_id` of the in-flight call this PermissionRequest asks
   * about (#1126): the one unfinished `PreToolUse` of the same agent, tool
   * and input. Consumed, so a second identical request pairs with the other
   * call. With two or more candidates (identical calls in flight) nothing is
   * paired: guessing could tie the prompt to the wrong call, and an unpaired
   * prompt falls back to the tool-name + input match, whose worst case is an
   * early empty release (the card is dismissed and the terminal answers),
   * never a decision.
   */
  private pairToolUse(input: PermissionRequestHookInput): string | undefined {
    if (this.inFlightToolUses.size === 0) return undefined;
    this.pruneInFlightToolUses();
    const key = stableToolInputKey(input.tool_input);
    const candidates = [...this.inFlightToolUses].filter(
      ([, call]) =>
        call.toolName === input.tool_name &&
        call.toolInputKey === key &&
        call.agentId === input.agent_id,
    );
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        log(
          `[AutoApprove ${this.sessionTag}] ${candidates.length} identical ${input.tool_name} calls in flight; not pairing this PermissionRequest with one`,
        );
      }
      return undefined;
    }
    const [toolUseId] = candidates[0] as [string, InFlightToolUse];
    this.inFlightToolUses.delete(toolUseId);
    return toolUseId;
  }

  /** Drop in-flight calls older than `IN_FLIGHT_TOOL_USE_TTL_MS`. */
  private pruneInFlightToolUses(): void {
    const cutoff = Date.now() - IN_FLIGHT_TOOL_USE_TTL_MS;
    for (const [id, call] of this.inFlightToolUses) {
      if (call.at < cutoff) this.inFlightToolUses.delete(id);
    }
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
   * Escalate a multi-choice string-label permission, or a question-shaped
   * tool that is not AskUserQuestion, and push it from the gate at once
   * (#625). Claude renders its native prompt and waits there; the user
   * answers the pushed card (a multi-choice digit typed via the PTY behind
   * the #1134 screen guard; a question-shaped tool's card is terminal-only)
   * or the terminal directly. With PTY question-emission gated
   * off for hooked sessions (#625), this push is the only one the escalation
   * gets.
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
   * How an escalated permission is held for the phone's answer, or null when
   * it is not held. AskUserQuestion and ExitPlanMode are held by name (#1127:
   * their structured answers were verified live for exactly these tools); a
   * plain allow/deny prompt is held as binary (#1126). A multi-choice
   * string-label permission and any other design / long-form question are
   * not held: they are answered 'passthrough' and pushed immediately.
   */
  private holdKindFor(input: PermissionRequestHookInput): HoldKind | null {
    if (input.tool_name === 'AskUserQuestion') return 'ask';
    if (input.tool_name === 'ExitPlanMode') return 'plan';
    const suggestions = input.permission_suggestions as readonly unknown[] | undefined;
    const alwaysEscalate = this.deps.alwaysEscalateTools ?? ALWAYS_ESCALATE_TOOLS;
    const binary =
      !isMultiChoicePermission(input.tool_name, suggestions) &&
      !isDesignQuestion(input.tool_name, input.tool_input, suggestions, alwaysEscalate);
    return binary ? 'binary' : null;
  }

  /**
   * Resolve a PermissionRequest to its hook response (#496). A binary prompt
   * the phone can answer is held for that answer (#1126); everything else is
   * answered 'passthrough':
   *   - a SUBAGENT-tagged event (`agent_id` present) is routed by
   *     `hasLocalTerminal` (see that dep), REGARDLESS of
   *     `isInSubagentContext()` (the tracker only brackets synchronous
   *     Task/Agent spawns, so team members and background subagents always
   *     observe it false; the tag on the event is the truth). With a local
   *     terminal it passes through and parks for its render
   *     (`passSubagentToTerminal`, ADR 0004); without one it is escalated
   *     exactly like a main-agent prompt (held when binary).
   *   - a MAIN-tagged event (no `agent_id`) is escalated (`escalateMain`). If
   *     `isInSubagentContext()` is true at that moment, that is the #710
   *     tracker-leak signature (a dropped PostToolUse(Task/Agent) completion),
   *     not a real subagent prompt: reset the tracker and escalate as main.
   */
  resolvePermission(
    input: PermissionRequestHookInput,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    if (this.isSubagentEvent(input)) {
      if (!this.deps.hasLocalTerminal) {
        log(
          `[Hooks] Subagent PermissionRequest with no local terminal; escalated like a main prompt: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
        );
        return this.escalateMain(input, signal);
      }
      log(
        `[Hooks] Subagent PermissionRequest passed to the terminal: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
      this.passSubagentToTerminal(input);
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
    return this.escalateMain(input, signal);
  }

  /**
   * Wrapper-mode routing for a subagent-tagged permission (#751, #1126): park
   * the rich question in the presence tracker so its render pushes an
   * informational "answer at the terminal" notice. The caller answers the
   * hook 'passthrough' so the dialog renders at all (a held background
   * subagent's dialog does not).
   *
   * A parkForPTY throw (or no park path at all) is absorbed: the passthrough
   * still stands and the notice is pushed at once (`pushTerminalNoticeNow`).
   *
   * #799: also registers the parked question's signature in
   * `openQuestionSignatures`, tagged `isSubagent: true` + this event's own
   * `agent_id`, so a matching subagent tool event (`cancelExternallyResolved`)
   * or that agent's `SubagentStop` (`cancelStaleForAgent`) can resolve it.
   * A re-park for the identical signature (the SAME agent re-asking) proves
   * the earlier parked/pushed record is dead and resolves it first.
   */
  private passSubagentToTerminal(input: PermissionRequestHookInput): void {
    let questionId: UUID | undefined;
    try {
      questionId = this.deps.parkForPTY?.(input);
    } catch (err) {
      logError(
        `[AutoApprove ${this.sessionTag}] parkForPTY threw (pushing the terminal notice now):`,
        err,
      );
    }
    let noticedNow = false;
    if (!questionId) {
      try {
        questionId = this.deps.pushTerminalNoticeNow?.(input);
        noticedNow = questionId !== undefined;
      } catch (err) {
        logError(`[AutoApprove ${this.sessionTag}] pushTerminalNoticeNow threw:`, err);
      }
    }
    if (!questionId) return;
    const observed: ObservedToolCall = {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id ?? this.pairToolUse(input),
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
    if (noticedNow) {
      this.markTerminalPrompt(questionId);
      this.terminalNotices.add(questionId);
    }
  }

  /**
   * A parked subagent prompt's dialog rendered and its "answer at the
   * terminal" notice was pushed (#1126): the prompt is now on screen
   * (`terminalPrompts`), and resolving it also dismisses the notice. A no-op
   * for a prompt no longer open.
   */
  noteTerminalNotice(questionId: UUID): void {
    if (!this.openQuestionSignatures.has(questionId)) return;
    this.markTerminalPrompt(questionId);
    this.terminalNotices.add(questionId);
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
   * P7), so it broadcasts `question_resolved` to every remi client and
   * dismisses the APNS card (Telegram does not dismiss, #1148). Throw-safe.
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
   * Stash + track an escalation the phone can answer: a main-context one,
   * or a subagent's with no local terminal (#1126). Returns the created
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
        // #1126: the id of the PreToolUse this request asks about, so the
        // terminal's Yes (its PostToolUse) closes exactly this prompt.
        toolUseId: input.tool_use_id ?? this.pairToolUse(input),
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
      // runtime ordering has not been observed against a live Claude Code.
      // Since #1126 the stronger key exists when pairing succeeds: two
      // requests each paired with its own PreToolUse carry different
      // tool_use_ids and do not cancel each other; only unpaired ones do,
      // and for a hold that only means an early empty release.
      this.cancelExternallyResolved(observed, 'duplicate-re-request');
      this.openQuestionSignatures.set(questionId, {
        toolName: observed.toolName,
        toolInputKey: stableToolInputKey(observed.toolInput),
        toolUseId: observed.toolUseId,
        // #711: tags this OPEN escalation main vs subagent/team-member, so a
        // mainOnly Stop (cancelStale) resolves only main-tagged entries.
        isSubagent: this.isSubagentEvent(input),
        // #799: the subagent's own agent_id when a daemon-mode subagent
        // prompt is escalated like a main one (#1126); undefined for main.
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
  cancelExternallyResolved(
    observed: ObservedToolCall,
    reason: string,
    opts: { readonly toolFinished?: boolean } = {},
  ): void {
    const match = this.findOpenQuestionMatching(observed);
    if (!match) {
      if (opts.toolFinished === true) this.releaseUnpairedStructuredHold(observed, reason);
      return;
    }
    if (!match.byId && this.holds.has(match.qid)) {
      // #1126: a name + input match with no paired id may belong to another,
      // identical call, so this live hold's dialog may still be up. Release
      // it to the terminal rather than closing it.
      log(
        `[AutoApprove ${this.sessionTag}] Held ${match.qid.slice(0, 8)} matched ${reason} by name and input only; released to the terminal`,
      );
      this.releaseWithNotice(match.qid, 'released', reason);
      return;
    }
    this.resolveSupersededQuestion(match.qid, reason, observed.toolName);
  }

  /**
   * An AskUserQuestion or ExitPlanMode finished (`PostToolUse` or
   * `PostToolUseFailure`) and matched no open escalation (#1127 review S4).
   * Its input never matches the request's (`{questions, answers}`, or `{}`
   * for a plan), so when the request was not paired with its `PreToolUse`
   * the name + input fallback cannot find it either, and the hold would last
   * until its deadline although the terminal answered it. When exactly one
   * hold of that tool and agent is open, and it and this event are not paired
   * to different calls, it is released to the terminal like any other
   * ambiguous match (`releaseWithNotice`): the empty response decides
   * nothing, the card is dismissed, the phone is told, and the prompt stays
   * open for orphan suppression until a hook signal closes it. With two or
   * more such holds nothing is released (no guess between them).
   */
  private releaseUnpairedStructuredHold(observed: ObservedToolCall, reason: string): void {
    if (observed.toolName !== 'AskUserQuestion' && observed.toolName !== 'ExitPlanMode') return;
    const sameTool = [...this.holds.keys()].filter((qid) => {
      const sig = this.openQuestionSignatures.get(qid);
      return sig?.toolName === observed.toolName && sig.agentId === observed.agentId;
    });
    if (sameTool.length !== 1) return;
    const qid = sameTool[0] as UUID;
    const sig = this.openQuestionSignatures.get(qid);
    if (sig?.toolUseId !== undefined && observed.toolUseId !== undefined) return;
    log(
      `[AutoApprove ${this.sessionTag}] Held ${qid.slice(0, 8)} (${observed.toolName}) finished unpaired (${reason}); released to the terminal`,
    );
    this.releaseWithNotice(qid, 'released', reason);
  }

  /** Find an open escalation matching `observed`, preferring an exact
   *  tool_use_id match (the id paired from the request's PreToolUse, #1126)
   *  over the tool_name + tool_input signature fallback. `byId` says which
   *  one matched. */
  private findOpenQuestionMatching(
    observed: ObservedToolCall,
  ): { qid: UUID; byId: boolean } | undefined {
    // Fast path: called on EVERY admitted PreToolUse/PostToolUse, so the
    // near-universal "no open escalation at all" case must not pay for a
    // stableToolInputKey stringify it can never use.
    if (this.openQuestionSignatures.size === 0) return undefined;
    let observedKey: string | undefined;
    for (const [qid, sig] of this.openQuestionSignatures) {
      if (sig.toolName !== observed.toolName) continue;
      // #799: never cross agents. A MAIN observation (agentId undefined) can
      // only match a MAIN-registered signature, and a subagent observation
      // only its OWN agent's signature.
      if (sig.agentId !== observed.agentId) continue;
      // Two DIFFERENT tool calls can legitimately share an identical
      // (tool_name, tool_input) (e.g. two `ls` calls in a row): if BOTH sides
      // carry a tool_use_id, it alone decides. It also decides when the
      // inputs differ (#1127): the PostToolUse of an AskUserQuestion answered
      // in the terminal carries `{questions, answers}`, and an ExitPlanMode's
      // carries `{}`, while their PermissionRequest carried the call's own
      // input (measured on Claude Code 2.1.287), so an input check would
      // never match the call that answered them. A tool_use_id names one
      // call, so equal ids are the same call whatever its input.
      if (observed.toolUseId !== undefined && sig.toolUseId !== undefined) {
        if (observed.toolUseId === sig.toolUseId) return { qid, byId: true };
        continue;
      }
      // When at least one side has no id, the signature alone is the best
      // available proof.
      observedKey ??= stableToolInputKey(observed.toolInput);
      if (sig.toolInputKey !== observedKey) continue;
      return { qid, byId: false };
    }
    return undefined;
  }

  /**
   * Cleanup for a question proven stale by an external signal (#673): stop
   * tracking its signature, end its hold with the empty response (#1126:
   * Claude ignores it once the prompt is answered, and it decides nothing
   * while the prompt is still up), remove it from the registry, and
   * broadcast its resolution so the pushed card clears on every remi client
   * and from APNS (`removeAndDismiss`; Telegram does not dismiss, #1148).
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
    this.terminalPrompts.delete(qid);
    this.endHold(qid, 'passthrough');
    this.removeAndDismiss(qid, reason, toolName);
    if (this.terminalNotices.delete(qid)) {
      this.safeCueWithArg('onTerminalNoticeResolved', this.deps.onTerminalNoticeResolved, qid);
    }
  }
}

/** A hook decision as one log fragment, without the deny message or the
 *  user's answers. */
function describeDecision(decision: PermissionDecision): string {
  if (typeof decision === 'string') return decision;
  if (decision.behavior === 'deny') {
    return decision.message === undefined ? 'deny' : 'deny (with message)';
  }
  if ('updatedInput' in decision) {
    return decision.updatedPermissions === undefined
      ? 'allow (answers in updatedInput)'
      : 'allow (input echoed, mode set)';
  }
  return 'allow (standing grant echoed)';
}

/**
 * The hook decision for a phone answer to a held AskUserQuestion (#1127), or
 * null to refuse it (the hold stays):
 *   - `selections` -> `askUserQuestionDecision` (every question answered,
 *     validated against the tool input);
 *   - a single card option or free text answers a one-question,
 *     single-select AskUserQuestion only (the lock screen and Telegram send
 *     one option, not `selections`); the option must be that question's own
 *     by value and label;
 *   - Cancel -> `deny` with "The user dismissed the question.", so the
 *     dialog closes and Claude reads why. Nothing is typed (no Esc).
 */
function askDecision(
  toolInput: Readonly<Record<string, unknown>>,
  answer: HeldAnswer,
): PermissionDecision | null {
  if (answer.kind === 'cancel') return { behavior: 'deny', message: ASK_DISMISSED_MESSAGE };
  if (answer.kind === 'ambiguous') return null;
  let selections: unknown;
  if (answer.kind === 'selections') {
    selections = answer.selections;
  } else {
    const questions = parseAskUserQuestion(toolInput);
    if (questions === null || questions.length !== 1 || questions[0]?.multiSelect) return null;
    if (answer.kind === 'text') {
      selections = [{ questionIndex: 0, optionIndices: [], text: answer.text }];
    } else {
      const index = askOptionIndex(questions, answer.option);
      if (index === null) return null;
      selections = [{ questionIndex: 0, optionIndices: [index] }];
    }
  }
  const result = askUserQuestionDecision(toolInput, selections);
  if (!result.ok) {
    log(`[AutoApprove] AskUserQuestion answer refused (${result.reason}); hold kept`);
    return null;
  }
  return result.decision;
}

/**
 * The hook decision for a phone answer to a held ExitPlanMode (#1127), or
 * null to refuse it: one of the plan card's own options
 * (`exitPlanModeDecision`; a subagent's plan has its own two, whose approval
 * sets no session mode), or Cancel, which keeps planning like a "No". Free
 * text and `selections` are not plan answers.
 */
function planDecision(
  toolInput: Readonly<Record<string, unknown>>,
  answer: HeldAnswer,
  subagent: boolean,
): PermissionDecision | null {
  if (answer.kind === 'cancel') return keepPlanningDecision();
  if (answer.kind !== 'option') return null;
  return exitPlanModeDecision(toolInput, answer.option, answer.message, subagent);
}
