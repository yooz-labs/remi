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
 *
 * #814: parking is not the end of the story. When a parked subagent prompt
 * actually RENDERS on the main PTY, the tracker calls back into
 * `arbitrateParkedRender`, and THAT is where the permission is evaluated —
 * the first moment we know a human would otherwise be interrupted. The hook
 * was answered 'passthrough' long before, so the verdict is delivered by PTY
 * inject (approve/deny/pick type the matching option into the prompt on
 * screen) instead of by hook response; only what the policy will not decide
 * becomes a pushed card. Every failure direction — no verdict, an
 * unidentifiable option, a failed inject, a vanished prompt — resolves to
 * "ask the human", never to a fabricated answer.
 *
 * #799: `parkSubagentForPTY` registers a signature too (tagged `isSubagent`
 * + the event's own `agent_id`), closing the gap where a subagent/teammate
 * permission answered in the terminal had NO removal path at all (only
 * `escalateToUser`, main-context-only, ever populated the map pre-#799).
 * Subagent PreToolUse/PostToolUse in `hook-bridge-setup.ts` now also call
 * `cancelExternallyResolved` (with the event's own `agent_id`, scoped so it
 * can never cross-resolve a different agent's or main's still-open
 * escalation) before their early return — the same signature match main
 * gets, so a subagent permission answered directly in the terminal (the
 * matching tool then runs) is resolved through the normal `removeQuestion`
 * + `onResolved` funnel instead of leaking forever.
 *
 * A tool-signature match cannot cover a permission REJECTED in the terminal
 * ("No" / "keep planning" — a deny produces no tool call at all). Two more
 * triggers close that gap, both routing through the SAME funnel instead of a
 * silent bookkeeping-only delete:
 *   - `cancelStale('Stop', {mainOnly:true})`: Claude cannot fire `Stop`
 *     ("finished responding") while still genuinely blocked rendering its
 *     own native passthrough prompt (design/multi-choice, e.g. ExitPlanMode),
 *     so a MAIN-tagged signature still open at Stop proves it was resolved
 *     without a matching tool call ever firing.
 *   - `cancelStaleForAgent`, called from `SubagentStop`: that agent's own
 *     turn is over, so anything still open for it cannot still be blocking —
 *     the single-agent mirror of the Stop reasoning above.
 */

import { errorToString } from '@remi/shared';
import type { Question, QuestionOption, UUID } from '@remi/shared';

import type {
  ParkedRenderVerdict,
  QuestionPresenceTracker,
} from '../api/question-presence-tracker.ts';
import { log, logError } from '../cli/logger.ts';
import type { PermissionDecision, PermissionRequestHookInput } from '../hooks/index.ts';
import { type DeliveryOutcome, isDelivered } from '../notifications/notification-dispatcher.ts';
import type { SessionRegistry } from '../session/index.ts';
import { buildDenyMessage } from './deny-floor.ts';
import { isDesignQuestion, isMultiChoicePermission } from './multichoice.ts';
import type { PrecedentReader } from './precedent.ts';
import type { AutoApproveResult, DenySource } from './types.ts';

/** Hard cap on `parkedInputs` (#814). One entry per parked subagent
 *  permission awaiting a PTY render; a real agent fleet holds a handful at
 *  once, so this only ever trips on a pathological park-and-never-advance
 *  loop, where dropping the OLDEST (whose prompt has long since not rendered)
 *  is the right eviction. */
const MAX_PARKED_INPUTS = 64;

/** Hard cap on `retiredEscalations` (#1005). Only needs to outlive the gap
 *  between a retirement and the PTY render it must suppress, which is a
 *  render cycle; sized generously above `MAX_PARKED_INPUTS` because forgetting
 *  early fails toward an extra card, not toward silence. */
const MAX_RETIRED_ESCALATIONS = 256;

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
  /** #799: the escalating event's own `input.agent_id` (undefined for a MAIN
   *  event). Lets `findOpenQuestionMatching` and `cancelStaleForAgent` scope
   *  a match to the EXACT agent that opened it -- without this, two
   *  different agents (or a subagent and main) issuing an identical
   *  (tool_name, tool_input) could
   *  cross-resolve each other's unrelated escalation. */
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
   *  exactly -- see `ToolSignature.agentId`. */
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

/** A label that PERSISTS a permission ("Yes, and don't ask again…", "Always",
 *  "Yes, always allow: …"). Never auto-answerable (#814): committing a
 *  standing permission rule on the user's behalf is the user's call, not the
 *  model's — the model may only answer this ONE prompt. */
function isPersistingLabel(label: string): boolean {
  return /\balways\b|don'?t\s+ask\s+again/i.test(label);
}

/** The plain one-time "Yes" among `options`, by flag first (hook-derived
 *  options carry `isYes`) then by label (PTY-parsed numbered options carry no
 *  flags at all — see `question-parser.ts`). Undefined when no option can be
 *  identified confidently; the caller escalates rather than guessing. */
function findApproveOption(options: readonly QuestionOption[]): QuestionOption | undefined {
  return (
    options.find(
      (o) => o.isYes && o.suggestionIndex === undefined && !isPersistingLabel(o.label),
    ) ?? options.find((o) => /^\s*yes\b/i.test(o.label) && !isPersistingLabel(o.label))
  );
}

/** The "No" among `options` — same flag-then-label strategy as
 *  {@link findApproveOption}. */
function findDenyOption(options: readonly QuestionOption[]): QuestionOption | undefined {
  return options.find((o) => o.isNo) ?? options.find((o) => /^\s*no\b/i.test(o.label));
}

/**
 * The PTY input that expresses `result` on the prompt currently rendered
 * (#814), or undefined when no option can be identified — in which case the
 * caller escalates to the user instead of typing a guess (the #751 hazard:
 * a wrong digit answers the wrong thing).
 *
 * `ptyOptions` (what the parser read off the ACTUAL screen) is preferred over
 * `renderedOptions` (the merged card's, which may be the hook's own set): the
 * value submitted is a 1-based index into the prompt as drawn, so the screen
 * is the ground truth for numbering. The merged set is the fallback for
 * prompt shapes the parser could not enumerate.
 *
 * Exported for direct unit testing of the mapping, independent of the gate.
 */
export function autoAnswerValue(
  result: AutoApproveResult,
  renderedOptions: readonly QuestionOption[],
  ptyOptions: readonly QuestionOption[],
): string | undefined {
  if (result.decision === 'pick') {
    // A pick index was chosen against the PARK-TIME options, and this path has
    // an unbounded gap between park and render (Claude's own permission flow
    // runs in between) — so unlike the synchronous main path, the index is not
    // guaranteed to still address the same option, or any option at all.
    // Accept it only when the prompt ON SCREEN actually has that many options;
    // otherwise return undefined and let the caller escalate.
    const screen = ptyOptions.length > 0 ? ptyOptions : renderedOptions;
    if (result.pickIndex === undefined || screen.length === 0) return undefined;
    return result.pickIndex >= 1 && result.pickIndex <= screen.length
      ? String(result.pickIndex)
      : undefined;
  }
  if (result.decision !== 'approve' && result.decision !== 'deny') return undefined;
  const find = result.decision === 'approve' ? findApproveOption : findDenyOption;
  return (find(ptyOptions) ?? find(renderedOptions))?.value;
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
    /** Q9 (#893): recent-human-turns authority summary, see
     *  `AutoApproveGateDeps.getAuthority`. Threaded straight through to
     *  `buildPrompt`'s CONVERSATION CONTEXT block; the trust boundary itself
     *  is enforced inside the evaluator, not here. */
    authority?: string,
    /** #976: this session's precedent, READ-ONLY. See
     *  `AutoApproveGateDeps.getPrecedent`; the matrix that bounds what a
     *  precedent may authorize lives inside the evaluator, not here. */
    precedent?: PrecedentReader,
    /** ADR 0025: the hook's `agent_type`, selecting a
     *  `[auto_approve.agents.<type>]` section for the deterministic layers.
     *  Undefined = base policy, so every pre-0025 caller is unchanged. */
    agentType?: string,
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
  /**
   * #1024: the deterministic, pre-LLM portion of `evaluate()` ONLY -- deny
   * (list + groups) checked first, then `allow`, then `approve_groups`. No
   * network, no model, no queue. Lets `resolvePermission`'s subagent branch
   * answer a config-authorized request at hook time without ever reaching
   * the LLM (ADR 0004 still forbids that unconditionally).
   *
   * Optional: a minimal test double that never exercises the hook-time
   * subagent shortcut may omit it, in which case the gate treats every
   * subagent-tagged event as having no deterministic verdict -- i.e. the
   * pre-#1024 park-unconditionally behavior.
   */
  evaluateDeterministic?(
    toolName: string,
    toolInput: Record<string, unknown>,
    /** ADR 0025: selects this agent's `[auto_approve.agents.<type>]` section.
     *  This is the only layer a subagent reaches at hook time, so a per-agent
     *  grant that did not arrive here would be unreachable for exactly the
     *  requests it was written for. */
    agentType?: string,
  ):
    | { decision: 'approve'; reasoning: string }
    | { decision: 'deny-covered'; reasoning: string; denySource: DenySource }
    | null;
}

export interface AutoApproveGateDeps {
  /** null => no auto-approve configured; the no-AA escalate/default-deny path runs. */
  service: AutoApproveEvaluator | null;
  sessionRegistry: SessionRegistry;
  tracker: QuestionPresenceTracker;
  /** Wraps `HookEventBridge.isInSubagentContext()`. Read live per branch (async TOCTOU). */
  isInSubagentContext: () => boolean;
  /**
   * Q9 (#893): this session's authority summary — the human's own typed
   * turns, from `UserPromptSubmit` (primary) with a filtered transcript
   * fallback (`auto-approve/authority.ts`'s `resolveAuthority`). Read fresh
   * on every eval call site below so a turn submitted mid-session is picked
   * up immediately. Absent, or an empty/whitespace string, means no
   * CONVERSATION CONTEXT block — identical prompt/behavior to pre-#893.
   * Synchronous and cheap: both sources are in-memory (a ring buffer / an
   * already-loaded `TranscriptWatcher`'s cached entries), never a disk read
   * at call time.
   */
  getAuthority?: () => string;
  /**
   * #976: this session's precedent store, as a READ-ONLY reader.
   *
   * Read fresh per eval for the same reason as `getAuthority`: an answer given
   * mid-session must count for the next permission, not the one after that.
   *
   * A `PrecedentReader` and never the `PrecedentStore` itself, deliberately.
   * `handleAnswer` (`cli/handlers/input-events.ts`) is the single writer, and
   * that has to hold BY CONSTRUCTION rather than by convention: the gate types
   * its own approvals into rendered subagent prompts under ADR 0004, so a gate
   * that could `record()` would launder machine verdicts into human precedent
   * and then authorize future machine approvals from them. Handing out a
   * reader makes that self-licensing loop unrepresentable.
   *
   * Absent => no precedent in either direction; pre-#976 behavior exactly.
   */
  getPrecedent?: () => PrecedentReader | undefined;
  /**
   * Reset the subagent-context tracker (#710). Called ONLY when a MAIN-tagged
   * PermissionRequest (`agent_id` absent) observes `isInSubagentContext()`
   * stuck true — proof of a tracker leak (a dropped PostToolUse(Task/Agent)
   * completion), never a real subagent prompt (those carry `agent_id` and
   * park for PTY arbitration instead, #751). Optional so tests that don't
   * wire it degrade to a no-op; the escalate-as-main recovery still happens
   * without it, just without clearing the leaked state.
   */
  resetSubagentContext?: () => void;
  /**
   * Park a subagent-tagged escalation for PTY arbitration (#751): stash its
   * rich question in the `QuestionPresenceTracker` (via
   * `parkAwaitingPTY(hookBridge.buildPermissionQuestion(input))`) WITHOUT
   * pushing or registering it. The gate answers the hook 'passthrough'; the
   * question only surfaces if Claude's native prompt actually renders on the
   * PTY. Optional so tests that don't wire it degrade to a plain passthrough
   * (the rendered prompt then pushes bare via the #712 orphan path).
   *
   * Returns the parked `Question.id` (#799) so `parkSubagentForPTY` can
   * register it in `openQuestionSignatures` the same way `escalateToUser`
   * does for a main escalation -- without an id there is nothing for a later
   * matching subagent tool event or `SubagentStop` to resolve, which was the
   * root cause of #799 (a subagent question answered in the terminal never
   * left the pending store). `undefined` when the dep is unwired or throws.
   *
   * #807: takes no `summary` — a subagent permission is never evaluated, so
   * there is no LLM reasoning to fold into the question text (`escalate`, the
   * main-context sibling, still carries one).
   */
  parkForPTY?: (input: PermissionRequestHookInput) => UUID | undefined;
  /**
   * Every subagent-tagged permission that passed through unevaluated (#807),
   * reported to the sink for observation ONLY — the decision is already made
   * and returned by the time this fires, so a sink cannot influence it.
   *
   * Two purposes: the destructive-command alert (`SubagentAlerter` decides
   * which of these are worth notifying about — see `subagent-alert.ts`), and
   * the audit trail #756 direction (d) asked for, so a silently-handled
   * background permission is silent but not invisible.
   *
   * Fire-and-forget and throw-safe, like the cosmetic cues: a sink that throws
   * is logged and absorbed, never propagated into the hook response.
   */
  onSubagentPassthrough?: (input: PermissionRequestHookInput) => void;
  /**
   * Every `deny` this gate returns to the hook (#1015), reported for
   * observation ONLY — like `onSubagentPassthrough` above, the decision is
   * already made by the time this fires and a sink cannot influence it.
   *
   * A deny is the one verdict with no user-facing surface of its own: it
   * creates no `Question`, so no card is pushed and no `question_resolved`
   * broadcast follows. Claude is told why (`buildDenyMessage`) and the human
   * is told nothing. This dep is the human's channel.
   *
   * `source` says which mechanism refused, so the sink can treat the user's
   * own standing `config.toml` rule differently from a model deny that merely
   * survived the floor — see `DenySource`.
   *
   * Fire-and-forget and throw-safe, like the cosmetic cues: a sink that throws
   * is logged and absorbed, never propagated into the hook response.
   */
  onAutoDenied?: (input: PermissionRequestHookInput, source: DenySource, reasoning: string) => void;
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
   *  releases the buffered PTY prompt. #484. `ctx.isSubagent` (#767): a
   *  subagent verdict (the #751 park path) never opened the tracker's buffer
   *  window, so the setup layer must not let it release — or discard — a
   *  prompt buffered by a MAIN eval still in flight. */
  onEscalate?: (ctx: { isSubagent: boolean }) => void;
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
   *  advanced past the prompt). Drives the terminal cue back to idle. #513.
   *
   *  Deliberately carries NO `ctx.isSubagent`, unlike `onEvalStart` /
   *  `onEscalate` / `onHandled`: this cue is reachable only from MAIN-context
   *  evals. `resolvePermission` returns early for an `agent_id` event before any
   *  eval (#807), and the post-render subagent path
   *  (`arbitrateParkedRender`) routes a `cancelled` verdict to
   *  `escalateRenderedParked()` — i.e. to `onEscalate`, not here. A ctx
   *  parameter would therefore be `false` at every call site, and a
   *  subagent guard built on it would be untestable dead code (#970, asserted
   *  by "a cancelled parked render escalates" in the gate tests). */
  onCancelled?: () => void;
  /**
   * Called when a HELD hook's Part-B late verdict resolved to 'cancelled' --
   * `reconcileLateVerdict` found Claude had already advanced past the prompt
   * while the early push+hold (#573) was showing, and released the hold to
   * passthrough. The held-path sibling of `onCancelled` above, closing the
   * SAME class of gap #970 found there: the client pill was moved off
   * 'evaluating' to 'waiting' when the hold was created (`onEscalate` ->
   * the question path's own broadcast), but nothing moved it again when the
   * verdict turned out to be "nothing to decide" -- the pill would sit on a
   * now-stale 'waiting' regardless of what the session actually became in
   * the meantime.
   *
   * Deliberately NOT folded into `onCancelled` itself: that cue fires from
   * `resolvePermission`'s own eval loop and `releaseHeld` is a completely
   * different exit (a HELD hook's late-verdict reconciliation), so sharing
   * one callback would make a caller's cue handler guess which path it is
   * in. Also carries no `ctx.isSubagent`, for the same reason `onCancelled`
   * does not: Part B (`maybePushOnSlowEval`) refuses to arm at all for a
   * subagent-tagged input or while `isInSubagentContext()` is true, so this
   * cue is unreachable from anywhere but a MAIN-context hold -- a ctx
   * parameter would be `false` at every call site and an isSubagent guard
   * built on it would be untestable dead code, exactly as documented on
   * `onCancelled`. */
  onHeldCancelled?: () => void;
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
  /**
   * What `escalateMain` does with a main-agent BINARY operation it cannot
   * approve (#1045 phase 6). `'escalate'` (absent = default) holds/pushes as
   * before, byte-for-byte; `'deny'` refuses with a reason instead of asking,
   * so the agent self-corrects and the human is not pinged. Never consulted
   * for a non-binary (multichoice / design / plan-mode) escalate — those
   * always passthrough regardless of this setting — nor for a subagent's
   * parked-render residue (ADR 0004), which has its own path and does not
   * call `escalateMain` at all. From `auto_approve.residual_action`; see
   * `ResidualAction`'s doc for the full semantics and the caveat on when
   * `'deny'` is actually a good idea. */
  residualAction?: 'escalate' | 'deny';
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
  /**
   * Held question ids whose notification was CONFIRMED delivered (#603 probe
   * resolved in_app/pushed). The #733 hold-timeout handoff cue fires only for
   * these (or when delivery gating is disabled entirely): "timed out waiting
   * for you" is only meaningful if the user was actually notified — a hold
   * whose delivery was never confirmed is the undeliverable machinery's
   * problem, not a handoff. Entries are dropped in `releaseHeld`.
   */
  private readonly confirmedDeliveries = new Set<UUID>();

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
   * Every OPEN escalation this gate has created (held OR passthrough, MAIN or
   * subagent), keyed by `Question.id`, by its (tool_name, tool_input, agentId)
   * signature (#673, #799). Entry lifecycle: created in `escalateToUser` on a
   * successful MAIN escalation, or in `parkSubagentForPTY` (#799) on a parked
   * subagent one; removed by exactly TWO owners, unconditionally (regardless
   * of whether a hold existed), so no exit path can leak an entry:
   *   - the public `resolveHeld` (a separate, non-delegating path — it owns
   *     its own delete);
   *   - the private `releaseHeld`, which EVERY other resolution path funnels
   *     through: `releaseHeldAsPassthrough` (normal answer), `failOpenHeld`
   *     (hold-timeout / undelivered-notification fail-open),
   *     `reconcileLateVerdict`'s cancelled branch (Part B),
   *     `resolveSupersededQuestion` (#673's own external-resolution / stale
   *     -duplicate cleanup, also the funnel `cancelStaleForAgent` (#799) and
   *     `cancelStale`'s mainOnly Stop sweep (#799) use), and `releaseAllHolds`
   *     (#799 -- so the mainOnly Stop sweep below never re-finds and double
   *     -resolves a qid it just released via a held hook).
   * `cancelStale` (non-mainOnly) / `forceRelease` (#948) route every survivor
   * through `resolveSupersededQuestion` too, via the shared
   * `resolveAllOpenQuestions` -- session end / force-release means nothing
   * tracked is relevant after either, but that funnel (not a wholesale
   * `.clear()`) is what fires `question_resolved` + the APNS dismiss + the
   * live-sessions mirror for a survivor whose card is still sitting in the
   * store (#948: a PASSTHROUGH escalation, e.g. AskUserQuestion, is tracked
   * ONLY here — a bare `.clear()` dropped its bookkeeping with nothing left
   * to resolve its card). A stale entry is harmless regardless (a signature
   * match just triggers a redundant, idempotent cleanup), but MUST NOT be
   * able to accumulate indefinitely: an un-deleted entry from a timed-out/
   * cancelled hold would sit for the rest of the process lifetime and could
   * fire a spurious `notifyResolved` for a question dead for hours on a
   * much-later, unrelated duplicate of the same command.
   */
  private readonly openQuestionSignatures = new Map<UUID, ToolSignature>();

  /**
   * Ids of escalations this gate has RETIRED — resolved, released, or answered
   * on the user's behalf (#1005).
   *
   * Exists so `arbitrateParkedRender` can tell "this permission is already
   * settled" from "I have never heard of this id". Those look identical in
   * `openQuestionSignatures` (absent either way) and need opposite handling:
   * settled must not push a card, unknown MUST still push, because an id the
   * gate has no record of is one it has no evidence about and the standing
   * rule is that ambiguity resolves toward showing the user.
   *
   * A card pushed for a retired escalation is unremovable by design: retirement
   * already deleted the signature entry, and every sweep this gate has iterates
   * that map. So the cost of getting this wrong is not a redundant prompt, it
   * is a permanent one.
   *
   * Bounded like `parkedInputs`: insertion-ordered, oldest evicted past the
   * cap. Forgetting an old retirement fails toward pushing (a redundant card
   * the user can dismiss), never toward silence.
   */
  private readonly retiredEscalations = new Set<UUID>();

  /** Record a retirement, bounded like `parkedInputs` (oldest evicted). */
  private markRetired(questionId: UUID): void {
    this.retiredEscalations.delete(questionId);
    this.retiredEscalations.add(questionId);
    while (this.retiredEscalations.size > MAX_RETIRED_ESCALATIONS) {
      const oldest = this.retiredEscalations.values().next().value;
      if (oldest === undefined) break;
      this.retiredEscalations.delete(oldest);
    }
  }

  /**
   * The original hook input of every PARKED subagent permission (#814), keyed
   * by the parked `Question.id`. The hook itself was answered 'passthrough'
   * immediately (#807), so this is the only surviving record of what the
   * permission actually asked for — and it is what `arbitrateParkedRender`
   * evaluates if and when Claude's native prompt renders on the main PTY.
   *
   * Entries are deleted the moment an arbitration consumes one (exactly one
   * evaluation per park), and by every resolution path that retires the
   * matching `openQuestionSignatures` entry (`releaseHeld`, `resolveHeld`,
   * and — via `resolveAllOpenQuestions`, #948 — `cancelStale`'s teardown
   * branch and `forceRelease`), so a permission whose prompt never renders
   * cannot linger. `MAX_PARKED_INPUTS` is the backstop
   * for the one shape none of those cover: an agent that parks repeatedly and
   * never advances, ends, or renders — oldest-first eviction bounds the map at
   * a size far above any real fleet's concurrent parks.
   */
  private readonly parkedInputs = new Map<UUID, PermissionRequestHookInput>();

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
    // #673 / #711 / #948: every OPEN escalation this gate has tracked (held
    // above, or a passthrough one with no hold) is moot on a full teardown --
    // resolved through the SAME funnel a tool-signature match uses, below,
    // never a silent bookkeeping-only delete. On a mainOnly Stop, only the
    // MAIN-tagged entries are moot; a teammate's is not (its hold, if any,
    // was just spared above, and its signature must stay trackable for
    // external-resolution cancellation).
    if (mainOnly) {
      // #799: a MAIN-tagged signature STILL open here was never held (a held
      // one was already released + unregistered by releaseAllHolds above) --
      // it is a PASSTHROUGH escalation (multi-choice / design, e.g.
      // ExitPlanMode) Claude rendered natively and is still tracking. Claude
      // cannot fire `Stop` ("finished responding") while genuinely blocked
      // rendering that native prompt, so a MAIN Stop observing it still open
      // proves it was resolved WITHOUT a matching tool call ever firing --
      // most commonly a rejection ("No" / "keep planning") answered directly
      // in the terminal, the one #799 gap `cancelExternallyResolved` can
      // never catch (a deny produces no PreToolUse to match against). Route
      // each survivor through the SAME funnel a tool-signature match uses
      // (not a silent bookkeeping-only delete), so question_resolved + APNS
      // dismiss + the live-sessions mirror all fire for it too. Skip
      // subagent-tagged entries: a Stop means only the LEAD agent finished,
      // and a teammate may still be mid-turn -- its still-open escalation is
      // not moot yet (that agent's own eventual `SubagentStop` resolves it
      // via `cancelStaleForAgent`).
      for (const [qid, sig] of [...this.openQuestionSignatures]) {
        if (sig.isSubagent) continue;
        this.resolveSupersededQuestion(qid, reason, sig.toolName);
      }
    } else {
      // #948: a full teardown has no still-running teammate to protect (see
      // this method's own docstring above: "there is no 'the rest of the
      // team is still going' case once the session has ended"), so EVERY
      // survivor is resolved here -- main OR subagent -- unlike the mainOnly
      // sweep's `isSubagent` skip just above. This used to be a silent
      // `openQuestionSignatures.clear()` + `parkedInputs.clear()`: exactly
      // the "bookkeeping-only delete" the mainOnly branch's own comment
      // warns against, and it left a passthrough escalation's card (e.g.
      // AskUserQuestion / ExitPlanMode, tracked only in
      // `openQuestionSignatures`) sitting in the store with nothing left to
      // resolve it (#948).
      this.resolveAllOpenQuestions(reason);
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
   * #948: resolve EVERY currently-open escalation (main or subagent) through
   * `resolveSupersededQuestion` instead of a silent bookkeeping-only delete.
   * The shared implementation for the two REAL teardown paths, where nothing
   * tracked can possibly still be relevant afterward: `cancelStale`'s
   * non-mainOnly branch (`SessionEnd`) and `forceRelease` (`remi unstick`).
   *
   * Deliberately does NOT filter by `sig.isSubagent` the way the mainOnly
   * `Stop` sweep in `cancelStale` does -- that filter exists because a `Stop`
   * means only the LEAD agent finished while a teammate may still be
   * mid-turn (see `cancelStale`'s own docstring); neither teardown path has
   * such a survivor to protect.
   *
   * `parkedInputs` needs no separate clear call here. Every parked entry is
   * registered under the SAME question id as its `openQuestionSignatures`
   * counterpart (`parkSubagentForPTY` sets both together in one call), and
   * the only two ways a `parkedInputs` entry is ever removed WITHOUT its
   * signature counterpart also being removed are `arbitrateParkedRender`
   * consuming it (the signature survives, now tracking an actual pushed
   * card -- correctly still open) and `rememberParkedInput`'s
   * `MAX_PARKED_INPUTS` eviction (same). Neither direction lets a
   * `parkedInputs` entry outlive its signature. `releaseHeld` -- reached by
   * every `resolveSupersededQuestion` call below -- unconditionally deletes
   * BOTH maps' entries for the qid it processes, before anything downstream
   * can throw, so this loop retires every parked entry as a side effect of
   * retiring its signature.
   */
  private resolveAllOpenQuestions(reason: string): void {
    for (const [qid, sig] of [...this.openQuestionSignatures]) {
      this.resolveSupersededQuestion(qid, reason, sig.toolName);
    }
  }

  /**
   * #799: resolve every OPEN escalation this gate still tracks for ONE exact
   * subagent/team-member `agent_id` -- the single-agent mirror of
   * `cancelStale('Stop', {mainOnly:true})`'s reasoning above. Called from
   * `SubagentStop`: that event fires only once THAT agent's own turn is
   * fully over, so any escalation still open for it (whether its rich
   * question was ever pushed to a client, or only parked awaiting a PTY
   * render that never came) can no longer be "about to run a tool" for that
   * agent. This is the one unambiguous signal for a subagent permission
   * REJECTED in the terminal (or silently absorbed by the allowlist without
   * a render): a deny produces no tool call, so the #799 tool-signature
   * match (`cancelExternallyResolved`, wired on subagent PreToolUse/
   * PostToolUse) can never catch it.
   *
   * Scoped strictly to `agentId`: a DIFFERENT agent's still-open escalation
   * (including main's, whose signatures never carry an agentId) is left
   * completely untouched, so one teammate finishing can never phantom-
   * resolve another teammate's -- or the lead's -- still-pending prompt.
   * Each match funnels through `resolveSupersededQuestion`, so
   * `removeQuestion` + `onResolved` (question_resolved broadcast + APNS
   * dismiss) fire exactly as a matching tool call would.
   */
  cancelStaleForAgent(agentId: string, reason: string): void {
    for (const [qid, sig] of [...this.openQuestionSignatures]) {
      if (sig.agentId !== agentId) continue;
      this.resolveSupersededQuestion(qid, reason, sig.toolName);
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
   * the LLM eval and a question are stuck and the phone has no device visibility.
   * Releases EVERY held hook to passthrough (the native terminal prompt), aborts
   * the in-flight eval, and drains queued evals so they escalate gracefully
   * instead of seizing the freed GPU. Safe with no service configured (only
   * releases holds). Returns a summary for the caller to log.
   */
  forceRelease(reason: string): { holds: number; cancelled: boolean; drained: number } {
    const holds = this.pendingHolds.size;
    this.releaseAllHolds('passthrough', reason);
    this.evalIdByQuestion.clear();
    // #673 / #948: mirrors cancelStale's non-mainOnly teardown branch -- a
    // force-release is at least as final as a session end, so every
    // remaining survivor (main or subagent) is resolved through the SAME
    // funnel a tool-signature match uses, not a silent bookkeeping-only
    // delete (see `resolveAllOpenQuestions`'s own docstring for why
    // `parkedInputs` needs no separate clear call).
    this.resolveAllOpenQuestions(reason);
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
   * #970 note: `markHandled` below ALSO fires the #576 client status broadcast
   * (`onHandled` -> `broadcastAutoApproveStatus('approved')`), so a Part-B late
   * verdict reconciled through here (`reconcileLateVerdict`'s allow/deny
   * branches, which call this method) was ALREADY total before the #970 fix --
   * verified by grep AND by a regression test in hook-bridge-setup.test.ts,
   * because an earlier pass at this same enumeration (ADR 0020) claimed
   * otherwise without checking this call site. The one late-verdict outcome
   * that genuinely reached no cue was the CANCELLED branch, which calls
   * `releaseHeld` (a separate method, no `markHandled`) -- see `onHeldCancelled`
   * on `AutoApproveGateDeps` for that fix.
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
    // #1005: pair every signature retirement with a positive record of it,
    // so a later parked render can tell "settled" from "never seen".
    this.markRetired(questionId);
    this.parkedInputs.delete(questionId); // #814, see releaseHeld
    this.confirmedDeliveries.delete(questionId); // #733: same unconditional cleanup
    const hold = this.pendingHolds.get(questionId);
    if (!hold) return false;
    clearTimeout(hold.timer);
    this.pendingHolds.delete(questionId);
    // Remove the registry entry too (#585, P7 FIX 2): the held question was
    // registered via pushHeldHook -> addQuestion, so resolving the hold without
    // this leaves a ghost card that replays on reconnect and lets a late
    // handleAnswer find it "live" and misroute. The user-answer path also
    // removes it in handleAnswer's finally; a double-remove is idempotent.
    this.deps.sessionRegistry.removeQuestion(
      this.sessionId,
      questionId,
      `resolveHeld:${decision}`,
      undefined,
      'AutoApproveGate.resolveHeld',
    );
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
   *
   * #970 totality note: no client status cue needed. This path only runs
   * because a client JUST answered (input-events.ts), so the answering
   * client already knows the outcome, and the PTY inject that follows
   * triggers the normal PreToolUse -> 'executing' status update for every
   * OTHER connected client, same as `onEscalate` relies on elsewhere.
   */
  releaseHeldAsPassthrough(questionId: UUID): boolean {
    // #673: openQuestionSignatures cleanup lives in the private releaseHeld
    // itself (the single owner every internal caller funnels through), so
    // there is nothing extra to do here.
    return this.releaseHeld(questionId, 'passthrough', 'released-passthrough-for-pty-answer');
  }

  /** Resolve pending holds with one decision + reason. Used by `cancelStale`
   *  (session teardown, or a mainOnly-scoped Stop, #711) -- `mainOnly`
   *  releases only holds NOT tagged subagent, leaving a teammate's hold (and
   *  its timer) intact so it stays answerable via `resolveHeld`. Delegates
   *  the per-hold teardown entirely to `releaseHeld` (its single owner, see
   *  that method's docstring) so the timer/registry/signature/delivery
   *  cleanup is never duplicated here -- #799's mainOnly Stop sweep in
   *  `cancelStale` depends on `releaseHeld` having already dropped this qid's
   *  `openQuestionSignatures` entry, or it would re-find it and double-fire
   *  `notifyResolved`.
   *
   *  #970 totality note: no client status cue fires here either. Both callers
   *  (`Stop` mainOnly, `SessionEnd`) are hook events the setup layer ALSO
   *  drives through the ordinary status path in the same synchronous handler,
   *  immediately after `cancelStale` returns (`onStatusChange('idle')` for
   *  both) -- the same "the question path's own status already covers it"
   *  reasoning `onEscalate` relies on, not a new exception. */
  private releaseAllHolds(decision: PermissionDecision, reason: string, mainOnly = false): void {
    const targets = mainOnly
      ? [...this.pendingHolds].filter(([, hold]) => !hold.isSubagent)
      : [...this.pendingHolds];
    if (targets.length === 0) return;
    log(
      `[AutoApprove ${this.sessionTag}] Releasing ${targets.length} held hook(s) as ${decision} (${reason}${mainOnly ? ', main-only' : ''})`,
    );
    for (const [qid] of targets) {
      // The session is going away (Stop/SessionEnd); dismiss the pushed card on
      // every client BEFORE resolving so it does not linger after the prompt is
      // gone (#585, P7). `releaseHeld` then clears the timer, drops the registry
      // + signature/delivery bookkeeping, and resolves the hook.
      this.notifyResolved(qid, 'cancelled');
      this.releaseHeld(qid, decision, reason);
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
        // live (an answered/cancelled hold never fires a stale handoff;
        // failOpenHeld below no-ops the same way) AND on the user having been
        // reachable: either delivery was CONFIRMED (in_app/pushed), or delivery
        // gating is disabled so there is no confirmation signal at all (legacy
        // hold — assume the push went out). A hold whose delivery was pending/
        // failed is the #603 undeliverable machinery's territory — pushing
        // "timed out waiting for you" at someone who was never notified would
        // be noise on a channel that is likely broken anyway.
        const gatingDisabled = (this.deps.deliveryConfirmMs ?? 0) <= 0;
        if (this.pendingHolds.has(qid) && (gatingDisabled || this.confirmedDeliveries.has(qid))) {
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
   *
   * #970 totality note: this deliberately fires NO client status cue. Every
   * path into a hold (immediate binary escalation or Part B's early push)
   * already moved the pill to 'waiting' via `onEscalate` before a hold could
   * ever exist, and failing open here does not change what the client is
   * actually waiting on -- the SAME permission is still unanswered, just
   * rendered in the terminal now instead of held on the hook. 'waiting'
   * stays true; broadcasting anything else here would be the wrong-status
   * failure mode ADR 0020 warns is as bad as a stuck one.
   */
  private failOpenHeld(qid: UUID, logMessage: string): void {
    if (!this.pendingHolds.has(qid)) return;
    log(`[AutoApprove ${this.sessionTag}] ${logMessage}`);
    // Dismiss the stale card everywhere BEFORE resolving (#585, P7); releaseHeld
    // then clears the timer, drops the registry entry, and resolves passthrough.
    this.notifyResolved(qid, 'cancelled');
    this.releaseHeld(qid, 'passthrough', 'hold-fail-open');
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
        if (result !== 'timeout' && isDelivered(result)) {
          // Confirmed: keep holding — and remember it, so a later hold-timeout
          // knows the user really WAS notified and a #733 handoff notice is
          // meaningful (see the cue gate in createHold).
          this.confirmedDeliveries.add(qid);
          return;
        }
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
   *
   * #1045 phase 6: when `residualAction === 'deny'` AND the escalation is
   * BINARY, this refuses with a reason instead of asking — deliberately gated
   * on `isBinaryEscalation`, not on the caller, because all three call sites
   * (no-service edge, eval-error, primary escalate verdict) can carry a
   * non-binary input (e.g. `ExitPlanMode`) straight into this method. A
   * multi-choice / design escalate must stay a passthrough regardless of this
   * setting, so the deny conversion sits in the SAME branch that would
   * otherwise have held it, never in the passthrough branch. `reasoning` is
   * required (unlike `summary`, still cosmetic) because it is what
   * `buildDenyMessage` puts in front of Claude — the whole point of choosing
   * `deny` over `escalate` is that the agent gets told why.
   */
  private escalateMain(
    input: PermissionRequestHookInput,
    reasoning: string,
    summary?: string,
  ): Promise<PermissionDecision> {
    if (!this.isBinaryEscalation(input)) {
      return Promise.resolve(this.escalatePassthrough(input, summary));
    }
    if (this.deps.residualAction === 'deny') {
      // Balance the buffer-window counter, exactly as the synchronous model-deny
      // branch does before returning `{behavior:'deny'}` (the `markHandled` a
      // screen up). `resolvePermission` already fired `onEvalStart` ->
      // `onAutoApproveStart()` for this main-context eval; converting to a deny
      // here without `markHandled` leaves `mainEvalsInFlight` stuck > 0, which
      // buffers and then silently drops the NEXT escalated prompt's push
      // (`QuestionPresenceTracker`'s "every onAutoApproveStart must be matched"
      // invariant). Found in the epic-wide review (2026-08-16); the existing
      // residual tests use `service:null`, which hits the no-service edge that
      // returns before `onEvalStart`, so they never exercised this. `escalateMain`
      // is always main context, so `isSubagentEvent` is false, but derive it
      // rather than hardcode to stay correct if that ever changes.
      this.markHandled(this.isSubagentEvent(input));
      // #1015: a residual-converted deny is exactly as invisible to the user
      // as any other deny -- report it through the same sink so cli.ts logs
      // it unconditionally, even though (unlike model-floor) it deliberately
      // does not push. See DenySource's 'residual' doc for why.
      this.reportDeny(input, {
        decision: 'deny',
        reasoning,
        durationMs: 0,
        model: '',
        denySource: { kind: 'residual', pattern: '' },
      });
      return Promise.resolve({ behavior: 'deny', message: buildDenyMessage(reasoning) });
    }
    return this.escalateAndHold(input, summary);
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
   *   - a SUBAGENT-TAGGED event (`agent_id` present) the config's own
   *     deterministic layers already APPROVE (deny checked first, then
   *     `allow`, then `approve_groups` -- `service.evaluateDeterministic`,
   *     #1024) -> answer the hook 'allow' directly. No park, no PTY render,
   *     no LLM: ADR 0004 still holds, this is a 0ms config match, not a
   *     model evaluation.
   *   - every OTHER subagent-tagged event (config does not deterministically
   *     approve it -- including one its `deny`/`deny_groups` covers, which
   *     is NOT turned into a hook-time deny; see `evaluateDeterministic`'s
   *     doc for why) -> park the rich question in the presence tracker +
   *     'passthrough' (#751 PTY-arbiter) WITHOUT ever running the LLM at
   *     hook time (#807), and REGARDLESS of `isInSubagentContext()` (the
   *     tracker only brackets synchronous Task/Agent spawns, so team members
   *     and async/background subagents always observe it false — the tag on
   *     the event itself is the truth). Claude then runs its NORMAL
   *     permission flow: the session allowlist may absorb the request
   *     silently, or the native prompt renders on the main PTY — where
   *     `arbitrateParkedRender` (#814) evaluates it and either answers it on
   *     screen or pushes the merged card (answers inject; nothing is held).
   *     Replaces three prior behaviors: silent default-deny (sync-Task
   *     shape, broke teammates with no trace), hold+push-as-main (async/team
   *     shape, pushed cards for prompts the user never saw asked), and
   *     evaluate-then-route (#751's shape, which spent a GPU-backed LLM call
   *     per background tool call and silently applied its allow/deny verdict
   *     to a prompt no human ever saw).
   *   - a MAIN-tagged event (no `agent_id`) with `isInSubagentContext()` true
   *     -> this is the #710 tracker-leak signature (a PostToolUse(Task/Agent)
   *     completion tagged with the spawned agent's own agent_id was dropped
   *     before popping the tracker), NOT a real subagent prompt. Reset the
   *     tracker and escalate as main instead of silently denying the main
   *     agent forever.
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

    // #807: a subagent-tagged permission NEVER reaches the LLM at hook time,
    // with or without auto-approve configured.
    //
    // Claude blocks on this hook response, so at decision time we cannot know
    // whether the prompt will ever render on the main PTY — and empirically
    // most never do (a live 0.6.22 session logged 16 subagent
    // PermissionRequests against 2 renders). Evaluating them ALL with the LLM
    // meant one GPU-backed call per background tool call, and every
    // approve/deny verdict was applied to a prompt no human ever saw and no
    // card ever recorded.
    //
    // #1024 amendment: that reasoning applies to the LLM specifically (GPU
    // cost + unknowable render state), not to a 0ms config-authorized match.
    // So before parking, ask ONLY the deterministic layers -- deny, then
    // allow, then approve_groups, the exact matcher calls `evaluate()` itself
    // runs first (`evaluateDeterministic`, shared so the two can never drift).
    // A deterministic APPROVE answers the hook directly, no park, no render,
    // no LLM. Anything else -- no deterministic verdict, OR the config's own
    // deny layer covers it -- parks + passthroughs exactly as before #1024:
    // a hook-time deny still has no human-visible channel for a subagent (no
    // render has happened yet to carry `buildDenyMessage`), so ADR 0004's
    // PTY-arbiter policy still owns that case.
    //
    // Either way, the evaluation itself is not skipped, only DEFERRED for
    // anything not deterministically approved: if the prompt renders,
    // `arbitrateParkedRender` (#814) evaluates it at that point (LLM
    // included) and answers it by PTY inject, or pushes a card the phone can
    // answer. That is the async route this hook response could never take.
    if (isSubagent) {
      // ADR 0025: the agent's own section decides here. This is the ONLY layer
      // a subagent can reach at hook time (the LLM never runs -- ADR 0004), so
      // without this a per-agent grant would be unreachable for exactly the
      // requests it was written for.
      const deterministic = service?.evaluateDeterministic?.(
        input.tool_name,
        input.tool_input,
        input.agent_type,
      );
      if (deterministic?.decision === 'approve') {
        log(
          `[Hooks] Subagent PermissionRequest answered allow at hook time (deterministic): agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name} - ${deterministic.reasoning}`,
        );
        // Observation only, the SAME cue the park path fires below:
        // subagent_alert visibility must not depend on whether this call was
        // ALSO deterministically approved -- e.g. a `curl` command an
        // approve group covers still deserves the same audit trail a parked
        // one gets (subagent-alert.ts matches on the raw input, not on how
        // the hook was answered).
        //
        // Deliberately NOT `markHandled()`: every existing `markHandled(true)`
        // call site (see `arbitrateParkedRender`) is preceded by its own
        // `onEvalStart({isSubagent:true})`, which is what keeps the shared
        // per-session `inFlight` eval count (#560/#576, `status-writer.ts`)
        // balanced. This path never opens that counter -- firing only the
        // "end" half here could decrement a genuinely in-flight MAIN eval's
        // count if one happens to be running concurrently, which is exactly
        // the kind of miscounted cue ADR 0020 exists to catch. Nothing else
        // `markHandled` does applies here either: the tracker's
        // `onAutoApproveHandled(isSubagent=true)` and the client status
        // broadcast are both already no-ops for a subagent permission.
        this.safeCueWithArg('onSubagentPassthrough', this.deps.onSubagentPassthrough, input);
        return 'allow';
      }
      log(
        `[Hooks] Subagent PermissionRequest passed through UNEVALUATED (PTY arbitrates): agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
      this.parkSubagentForPTY(input);
      // Observation only, AFTER the routing above is settled: one branch of
      // Claude's own permission flow allows a call without ever rendering it
      // (an allowlist-covered command), so the parked record never pairs and
      // nothing else would ever mention it. The sink decides what is worth a
      // notification; it cannot change this decision.
      this.safeCueWithArg('onSubagentPassthrough', this.deps.onSubagentPassthrough, input);
      return 'passthrough';
    }

    // No auto-approve: main escalates to the user (holding the hook when
    // binary, #573).
    if (!service) {
      if (isInSubagentContext()) {
        // #710: a MAIN-tagged event (no agent_id) with the tracker stuck true
        // means the tracker leaked, not a real subagent prompt. Reset it so
        // the leak cannot linger (a genuine sync-Task bracket pops on its own
        // PostToolUse; only a leak survives to be observed here).
        //
        // #716 (blanket-reset tradeoff): resetSubagentContext() clears ALL
        // tracked use_ids, not just the leaked one -- it cannot tell which
        // entry is stale. Post-#751 that is harmless for routing: subagent
        // routing keys on the event's own agent_id, never on the tracker.
        logError(
          `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}, no-service path); resetting tracker. Possible subagent-context tracker leak.`,
        );
        this.deps.resetSubagentContext?.();
      }
      return this.escalateMain(input, 'auto-approve had no evaluation service for this operation');
    }

    // Everything below is MAIN-context by construction: the #807 early return
    // above is the only path an `agent_id`-tagged event can take, so
    // `isSubagent` is false from here down. It is still threaded through
    // `evaluate` / `evalIsSubagentById` / `markHandled` rather than hardcoded,
    // because the post-render subagent evaluation (the #807 follow-up) will
    // re-enter this machinery with it true.

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
        this.authorityForEval(),
        this.precedentForEval(),
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
        // #710: MAIN-tagged + stuck tracker == leak, not a real subagent
        // prompt. Reset and fall through to escalateMain below. Blanket-reset
        // tradeoff (clears ALL tracked use_ids, not just the leaked one):
        // see the no-service branch above (#716).
        logError(
          `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}, eval-error path); resetting tracker and escalating. Possible subagent-context tracker leak.`,
        );
        this.deps.resetSubagentContext?.();
      }
      return this.escalateMain(input, `auto-approve evaluation failed: ${errorToString(err)}`);
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
      this.reportDeny(input, result);
      // #976: carry the reason to Claude instead of a bare refusal, so it can
      // route around or ask the user rather than guess. `interrupt` is left
      // unset (false) so the turn continues and it can act on the message.
      return { behavior: 'deny', message: buildDenyMessage(result.reasoning) };
    }
    if (result.decision === 'pick') {
      // Multi-choice pick (#399): the response can't express it, so render the
      // prompt (passthrough) and inject the 1-based index into the PTY.
      //
      // The index was validated against options length upstream. The
      // discriminated union guarantees pickIndex, but guard defensively: a
      // malformed result must escalate, not silently fall through.
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
    // A MAIN-tagged event (agent_id absent) with isInSubagentContext() true is
    // NOT a real subagent prompt: it is the #710 tracker-leak signature (a
    // PostToolUse(Task/Agent) completion stamped with the SPAWNED agent's own
    // agent_id never popped the use_id an earlier untagged PreToolUse tracked).
    // Denying it would silently drop the main agent's own prompts (including
    // AskUserQuestion) forever, so reset the tracker and fall through to
    // escalate as main instead. Blanket-reset tradeoff (clears ALL tracked
    // use_ids, not just the leaked one): see the no-service branch above (#716).
    if (isInSubagentContext()) {
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
    // #711: the second opinion is deliberately NOT tagged in evalIsSubagentById
    // (`runSecondOpinion` passes no evalId) -- the same "Claude blocks on the
    // hook while the gate evaluates" invariant that keeps a MAIN primary eval
    // from ever being in flight at Stop applies here too, since Claude is still
    // blocked on this same hook response while it runs. A mainOnly Stop
    // therefore has nothing to cancel for this call by construction; leaving it
    // untracked is correct, not a gap. #730: scope IS passed so a full
    // teardown's scoped, untargeted-by-evalId cancel can still abort it.
    const second = await this.runSecondOpinion(input, isSubagent);
    if (second !== null) {
      if (second.decision === 'approve') {
        log(`[AutoApprove ${this.sessionTag}] escalate_model (${escalateModel}) approved`);
        this.markHandled(isSubagent);
        return 'allow';
      }
      if (second.decision === 'deny') {
        log(`[AutoApprove ${this.sessionTag}] escalate_model (${escalateModel}) denied`);
        this.markHandled(isSubagent);
        this.reportDeny(input, second);
        // #976: same reasoned deny as the primary path above, carrying the
        // SECOND opinion's reasoning since that is the verdict being applied.
        return { behavior: 'deny', message: buildDenyMessage(second.reasoning) };
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
    return this.escalateMain(
      input,
      result.reasoning,
      result.decision === 'escalate' ? result.summary : undefined,
    );
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
    // do not arm the race. #751: the subagent check keys on the event's own
    // agent_id (the tracker misses async/team spawns); the tracker is ALSO
    // consulted live (it may close before the verdict) to cover legacy events
    // without agent_id, since arming an early USER push for a subagent prompt
    // would be wrong either way.
    if (
      pushHoldMs <= 0 ||
      !this.isBinaryEscalation(input) ||
      this.isSubagentEvent(input) ||
      this.deps.isInSubagentContext()
    ) {
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
    void this.reconcileLateVerdict(input, safeEval, questionId);
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
    input: PermissionRequestHookInput,
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
      // #1015: the THIRD deny path, and the least visible of the three. The
      // user already has a card on their lock screen saying "needs your
      // permission"; this dismisses it with a quiet content-available push
      // carrying no title and no body. Without the report, the card simply
      // vanishes and the refusal is invisible — worse than the synchronous
      // deny, because the user saw a prompt and then saw it disappear.
      //
      // Found in review of this change, not by writing it: `reportDeny` was
      // wired at the two SYNCHRONOUS deny returns and this async one was
      // missed. It needed `input` threaded down a level, which is exactly why
      // it was easy to miss and why the parameter now exists.
      this.reportDeny(input, result);
      this.notifyResolved(qid, 'auto_denied');
      this.resolveHeld(qid, 'deny');
    } else if (result.decision === 'cancelled') {
      // Claude advanced past the prompt during the slow eval; fail the hold open.
      this.deps.tracker.clearPending();
      this.notifyResolved(qid, 'cancelled');
      this.releaseHeld(qid, 'passthrough', 'part-b-cancelled');
      // #970: releaseHeld (unlike resolveHeld) never calls markHandled, so
      // nothing else on this branch tells the client the pill is stale. The
      // pill was moved to 'waiting' when the hold was created (onEscalate)
      // and nothing has corrected it since -- the exact gap onCancelled closed
      // for the non-held path. See onHeldCancelled's own doc for why this is a
      // separate cue rather than reusing onCancelled.
      this.safeCue('onHeldCancelled', this.deps.onHeldCancelled);
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
   *
   * `reason` (#808) names the caller/signal for the opt-in question-lifecycle
   * trace; `toolName`, when the caller knows it, is carried onto the same
   * trace record.
   */
  private releaseHeld(
    questionId: UUID,
    decision: PermissionDecision,
    reason = 'held-released',
    toolName?: string,
  ): boolean {
    this.openQuestionSignatures.delete(questionId);
    // #1005: pair every signature retirement with a positive record of it,
    // so a later parked render can tell "settled" from "never seen".
    this.markRetired(questionId);
    // #814: a parked permission resolved through any of these paths can never
    // be arbitrated on render any more; retire its remembered hook input with
    // the signature it belongs to.
    this.parkedInputs.delete(questionId);
    // #733: unconditional for the same leak reason as the signature delete
    // above — every hold exit path funnels through here.
    this.confirmedDeliveries.delete(questionId);
    const hold = this.pendingHolds.get(questionId);
    if (!hold) return false;
    clearTimeout(hold.timer);
    this.pendingHolds.delete(questionId);
    // Drop the registry entry so no ghost card replays (#585, P7 FIX 2). The
    // user-answer path (releaseHeldAsPassthrough -> handleAnswer finally) also
    // removes it; a double-remove is idempotent.
    this.deps.sessionRegistry.removeQuestion(
      this.sessionId,
      questionId,
      reason,
      toolName,
      'AutoApproveGate.releaseHeld',
    );
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
    this.deps.tracker.onAutoApproveHandled(isSubagent);
    this.safeCueWithArg('onHandled', this.deps.onHandled, { isSubagent });
  }

  /**
   * #751 PTY-arbiter routing for a subagent-tagged permission the gate cannot
   * decide (escalate verdict, eval error, forfeited pick, or no auto-approve):
   * park the rich question in the presence tracker, then close the #484
   * buffer window via the onEscalate cue (semantically this IS an escalation,
   * just PTY-mediated; the terminal statusline reads 'escalated'). The caller
   * answers the hook 'passthrough': Claude runs its normal permission flow,
   * so the session allowlist may absorb the request silently, or the native
   * prompt renders on the main PTY and the tracker pairs the parked record
   * with it and pushes the merged card (answers inject; nothing is held).
   * Park FIRST, cue SECOND — the cue may release a buffered PTY prompt whose
   * pair+push must be able to find the record (mirrors escalateToUser).
   *
   * A parkForPTY throw is absorbed: the passthrough still stands, and the
   * rendered prompt degrades to a bare #712 orphan push instead of a merged
   * one.
   *
   * #799: also registers the parked question's signature in
   * `openQuestionSignatures`, tagged `isSubagent: true` + this event's own
   * `agent_id` -- the SAME bookkeeping `escalateToUser` does for a main
   * escalation. Without this, a subagent permission answered directly in the
   * terminal (approved -> the matching tool runs, or the allowlist absorbs
   * it) had no way to ever leave `sessionRegistry.currentQuestions`: neither
   * `cancelExternallyResolved` (no signature to match) nor `cancelStale`
   * (subagent holds never exist) could reach it. A later matching subagent
   * PreToolUse/PostToolUse (`cancelExternallyResolved`, wired in
   * `hook-bridge-setup.ts`) or that agent's own `SubagentStop`
   * (`cancelStaleForAgent`) can now find and resolve it through the normal
   * `removeQuestion` + `onResolved` funnel. Mirrors `escalateToUser`'s own
   * duplicate-re-request cleanup: a re-park for the identical signature (the
   * SAME agent re-asking) proves the earlier parked/pushed record is dead.
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
    if (questionId) {
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
      // #814: keep the hook input so this permission can still be EVALUATED if
      // its prompt renders. Nothing else survives the passthrough answer.
      this.rememberParkedInput(questionId, input);
    }
    this.safeCueWithArg('onEscalate', this.deps.onEscalate, { isSubagent: true });
  }

  /** Stash a parked permission's hook input (#814), evicting oldest-first at
   *  `MAX_PARKED_INPUTS`. Map iteration order is insertion order, so the first
   *  key is the oldest park. */
  private rememberParkedInput(questionId: UUID, input: PermissionRequestHookInput): void {
    if (this.parkedInputs.size >= MAX_PARKED_INPUTS) {
      const oldest = this.parkedInputs.keys().next();
      if (!oldest.done) {
        this.parkedInputs.delete(oldest.value);
        // logError, not log: hitting this cap is anomalous (an agent parking
        // in a loop without ever advancing, ending or rendering), and the
        // evicted permission can no longer be evaluated if it does render.
        logError(
          `[AutoApprove ${this.sessionTag}] parkedInputs at cap (${MAX_PARKED_INPUTS}); evicted the oldest parked permission ${oldest.value.slice(0, 8)} — if its prompt renders it will escalate unevaluated`,
        );
      }
    }
    this.parkedInputs.set(questionId, input);
  }

  /**
   * #814: a PARKED subagent permission's prompt has now RENDERED on the main
   * PTY — the moment it becomes a question a human would actually be
   * interrupted by. THIS is where it gets evaluated.
   *
   * #807 deliberately does not evaluate a subagent permission at hook time:
   * Claude blocks on that response, so the gate cannot know whether the prompt
   * will ever render, and most never do (16 hooks -> 2 renders in a live
   * session). The render removes that uncertainty, so the eval is worth its
   * GPU here and only here. The hook was answered 'passthrough' long ago, so
   * the verdict is delivered by PTY inject rather than by hook response — the
   * async route #814 exists for.
   *
   * Outcomes:
   *   - approve / deny / pick -> type the matching option into the prompt on
   *     screen (the SAME resolution a phone answer performs) and report
   *     `answered`: the user is never interrupted. The inject is gated on the
   *     prompt still being visible (`inject`'s subagent PTY-presence check),
   *     so a prompt answered in the terminal mid-eval cannot be typed over.
   *   - escalate (optionally after the `escalate_model` second opinion) ->
   *     `push`, carrying the model's lock-screen summary: the card the user
   *     answers from the phone.
   *   - anything unresolvable (no service, no remembered input, an eval error,
   *     a verdict whose option cannot be identified on the rendered prompt)
   *     -> `push`. Every failure direction is "ask the human," never a
   *     fabricated answer.
   *
   * Never throws (the tracker treats a rejection as `push` anyway).
   */
  async arbitrateParkedRender(
    parkedQuestionId: UUID,
    rendered: Question,
    ptyPrompt: Question,
  ): Promise<ParkedRenderVerdict> {
    const input = this.parkedInputs.get(parkedQuestionId);
    const service = this.deps.service;
    // #1005: this escalation was RETIRED (resolved / released / answered).
    // Pushing here mints a card for a permission that is already settled, and
    // -- because retirement deleted its `openQuestionSignatures` entry on the
    // way out -- that card lands OUTSIDE every removal path this gate has: the
    // signature sweeps and `cancelStaleForAgent` both iterate that map. Only
    // LRU eviction or a user answer could ever remove it, which is how 7 of the
    // 8 cards found stuck in a live pending set were born (2.5-12.5h lifetimes,
    // `lru_eviction` their only removal).
    //
    // Keyed on POSITIVE evidence of retirement, never on the absence of a
    // signature entry. Absence cannot tell "was retired" from "was never
    // parked", and those need opposite handling: an id this gate knows nothing
    // about is one it has no evidence about, so it must still fail open to the
    // user. (An existing test, "an unknown parked id pushes without
    // evaluating", pins exactly that and caught this when the check was written
    // the absent-entry way.)
    if (this.retiredEscalations.has(parkedQuestionId)) {
      log(
        `[AutoApprove ${this.sessionTag}] Parked render for ${parkedQuestionId.slice(0, 8)} already retired; not pushing`,
      );
      return { outcome: 'answered' };
    }
    if (input === undefined || service === null) {
      // No auto-approve, or the park was already consumed/retired (an external
      // resolution, a session teardown, a duplicate render, a MAX_PARKED_INPUTS
      // eviction). Push: the prompt is on screen and nobody else is going to
      // surface it. No re-key needed (#887): `rendered.id` IS `parkedQuestionId`
      // — the tracker adopts the hook's id at merge time instead of minting a
      // new one from the PTY parse — so `openQuestionSignatures` (keyed by
      // `parkedQuestionId` since `parkSubagentForPTY`) already matches the id
      // of the card about to be pushed.
      log(
        `[AutoApprove ${this.sessionTag}] Parked render for ${parkedQuestionId.slice(0, 8)} not evaluated (${service === null ? 'no auto-approve service' : 'no parked input'}); pushing to the user`,
      );
      return { outcome: 'push' };
    }
    // Exactly one evaluation per park: a second render of the same prompt
    // (or a re-entrant call) must not start a second eval.
    this.parkedInputs.delete(parkedQuestionId);

    log(
      `[AutoApprove ${this.sessionTag}] Parked subagent prompt RENDERED; evaluating now (agent=${input.agent_id?.slice(0, 8) ?? 'n/a'} type=${input.agent_type ?? 'n/a'} tool=${input.tool_name})`,
    );
    // isSubagent: true throughout — this opens the terminal cue but neither the
    // #484 main buffer window (#767) nor the client status pill (#711).
    this.safeCueWithArg('onEvalStart', this.deps.onEvalStart, { isSubagent: true });

    const evalId = ++this.evalSeq;
    this.evalIsSubagentById.set(evalId, true);
    // Keyed by the PARKED question id so `cancelEvalForQuestion` (external
    // resolution, a user answer that beat us) aborts exactly this eval.
    this.evalIdByQuestion.set(parkedQuestionId, evalId);
    let result: AutoApproveResult;
    try {
      result = await service.evaluate(
        input.tool_name,
        input.tool_input,
        this.sessionTag,
        input.permission_suggestions as readonly unknown[] | undefined,
        undefined,
        evalId,
        this.sessionId,
        true,
        this.authorityForEval(),
        this.precedentForEval(),
        // ADR 0025: the same agent section that governs the hook-time path must
        // govern the render-time one, or a parked request would be judged under
        // a different policy than the one that declined to approve it.
        input.agent_type,
      );
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] Parked-render eval threw; escalating:`, err);
      return this.escalateRenderedParked();
    } finally {
      this.evalIsSubagentById.delete(evalId);
      if (this.evalIdByQuestion.get(parkedQuestionId) === evalId) {
        this.evalIdByQuestion.delete(parkedQuestionId);
      }
    }

    if (result.decision === 'cancelled') {
      // #1005: distinguish WHOSE resolution cancelled this eval. If this
      // question's own bookkeeping is gone, the cancel was ITS resolution --
      // the permission is settled and a card would be a zombie born outside
      // every removal path (see the retired-park check at the top).
      //
      // The tracker cannot be relied on to drop it instead: `isPromptCurrent`'s
      // text fallback matches "Do you want to proceed?", which is what EVERY
      // Claude Code permission prompt renders, so with agent-team traffic
      // something text-identical is almost always on screen. That check is
      // structurally blind here.
      if (this.retiredEscalations.has(parkedQuestionId)) {
        log(
          `[AutoApprove ${this.sessionTag}] Parked-render eval cancelled by its own resolution: ${result.reasoning}`,
        );
        this.markHandled(true);
        return { outcome: 'answered' };
      }
      // The entry survives, so the cancel was collateral -- a SIBLING's
      // PostToolUse aborted this eval. The prompt may well still be live, so
      // keep failing open to the user. Mapping `cancelled` to `answered`
      // unconditionally would swallow it.
      log(`[AutoApprove ${this.sessionTag}] Parked-render eval cancelled: ${result.reasoning}`);
      return this.escalateRenderedParked();
    }

    if (result.decision === 'approve' || result.decision === 'deny' || result.decision === 'pick') {
      if (await this.answerRenderedParked(input, result, rendered, ptyPrompt)) {
        // Answered on the user's behalf. The parked question was never
        // registered or pushed (parking only stashes it in the tracker), so
        // there is no card to dismiss — only the open-escalation bookkeeping
        // to retire, which a deny in particular would otherwise leak until
        // SubagentStop (a denial fires no tool call to match against).
        this.openQuestionSignatures.delete(parkedQuestionId);
        // #1005: pair every signature retirement with a positive record of it,
        // so a later parked render can tell "settled" from "never seen".
        this.markRetired(parkedQuestionId);
        this.markHandled(true);
        return { outcome: 'answered' };
      }
      return this.escalateRenderedParked();
    }

    // escalate: consult the second opinion before interrupting the user, the
    // same courtesy a main-context escalate gets (#522). Skipped once this
    // prompt is no longer the one on screen — nobody is waiting on that answer.
    if (this.deps.tracker.isPromptCurrent(rendered.id, ptyPrompt.text)) {
      // Tracked under the parked id (the primary eval's entry is already
      // retired by its `finally`), so a terminal answer landing mid-second-
      // opinion still frees the GPU (#617). Unlike the main-context caller,
      // Claude is NOT blocked on a hook here — the prompt is live and
      // answerable in the terminal — so leaving it untracked would be a real
      // gap, not the by-construction non-issue it is there.
      const secondEvalId = ++this.evalSeq;
      this.evalIsSubagentById.set(secondEvalId, true);
      this.evalIdByQuestion.set(parkedQuestionId, secondEvalId);
      let second: AutoApproveResult | null;
      try {
        second = await this.runSecondOpinion(input, true, secondEvalId);
      } finally {
        this.evalIsSubagentById.delete(secondEvalId);
        if (this.evalIdByQuestion.get(parkedQuestionId) === secondEvalId) {
          this.evalIdByQuestion.delete(parkedQuestionId);
        }
      }
      if (
        second !== null &&
        (second.decision === 'approve' || second.decision === 'deny') &&
        (await this.answerRenderedParked(input, second, rendered, ptyPrompt))
      ) {
        this.openQuestionSignatures.delete(parkedQuestionId);
        // #1005: pair every signature retirement with a positive record of it,
        // so a later parked render can tell "settled" from "never seen".
        this.markRetired(parkedQuestionId);
        this.markHandled(true);
        log(
          `[AutoApprove ${this.sessionTag}] escalate_model (${this.deps.escalateModel}) ${second.decision === 'deny' ? 'denied' : 'approved'} a parked render (${input.tool_name})`,
        );
        return { outcome: 'answered' };
      }
    }
    return this.escalateRenderedParked(result.summary);
  }

  /**
   * Type an auto-approve verdict into the parked prompt now on screen (#814).
   * Returns false — and the caller escalates — when the verdict cannot be
   * expressed safely, which is deliberately the DEFAULT for anything
   * ambiguous:
   *
   *   - no option on the rendered prompt matches the verdict (never guess a
   *     digit: the #751 wrong-option hazard);
   *   - `rendered` is no longer THE prompt on screen. Presence alone is not
   *     enough here: an eval can outlive its prompt (a terminal deny fires no
   *     tool call, so nothing cancels it) and the NEXT prompt would then take
   *     the answer meant for this one. `isPromptCurrent` is checked as late as
   *     possible, immediately before the write;
   *   - the inject itself fails (PTY gone, submitInput threw).
   */
  private async answerRenderedParked(
    input: PermissionRequestHookInput,
    result: AutoApproveResult,
    rendered: Question,
    ptyPrompt: Question,
  ): Promise<boolean> {
    const value = autoAnswerValue(result, rendered.options, ptyPrompt.options);
    if (value === undefined) {
      logError(
        `[AutoApprove ${this.sessionTag}] Parked-render verdict '${result.decision}' has no usable option on the rendered prompt (${ptyPrompt.options.length || rendered.options.length} option(s)); escalating instead of guessing`,
      );
      return false;
    }
    if (!this.deps.tracker.isPromptCurrent(rendered.id, ptyPrompt.text)) {
      log(
        `[AutoApprove ${this.sessionTag}] Parked render ${rendered.id.slice(0, 8)} is no longer the prompt on screen; NOT typing "${value}" into whatever replaced it`,
      );
      return false;
    }
    if (!(await this.inject(input, value, `parked-render-${result.decision}`))) {
      log(
        `[AutoApprove ${this.sessionTag}] Parked-render inject failed (prompt gone or PTY unavailable); escalating`,
      );
      return false;
    }
    log(
      `[AutoApprove ${this.sessionTag}] Parked render auto-${result.decision === 'deny' ? 'denied' : 'answered'} (${input.tool_name}, option "${value}"): ${result.reasoning}`,
    );
    return true;
  }

  /**
   * Hand a rendered parked prompt to the user (#814): close the eval cue and
   * report `push`.
   *
   * Pre-#887 this also had to re-key `openQuestionSignatures` from
   * `parkedQuestionId` onto `rendered.id`: the parked render pushed the MERGED
   * question, whose id used to come from the freshly-parsed PTY question, NOT
   * from the parked hook question the signature was registered under. Missing
   * that re-key meant every later resolution signal (a matching PreToolUse,
   * `SubagentStop`, a phone answer) would remove/dismiss the parked id while
   * the client held a card under the rendered id — the #808 stale-card class.
   * #887 removed the mismatch at its source instead of patching around it:
   * `QuestionPresenceTracker.consumeAndMerge` now ADOPTS the hook's id for the
   * merged question, so `rendered.id` IS `parkedQuestionId` here by
   * construction, and `openQuestionSignatures` never needs to move.
   */
  private escalateRenderedParked(summary?: string): ParkedRenderVerdict {
    this.safeCueWithArg('onEscalate', this.deps.onEscalate, { isSubagent: true });
    return summary === undefined ? { outcome: 'push' } : { outcome: 'push', summary };
  }

  /**
   * Second-opinion eval (#522): a heavier `escalate_model` may resolve what the
   * fast model would escalate, before the user is bothered. Returns null when
   * no `escalate_model` is configured (or no service exists). Never throws — an
   * error becomes an `escalate` result, so callers only ever see "still unsure."
   *
   * Shared by the main synchronous path and the #814 parked-render path.
   * `evalId` is optional because the two callers differ: the main path omits it
   * (Claude is blocked on the hook while it runs, so there is nothing that
   * could cancel it), while the parked-render path passes one — its prompt is
   * live in the terminal and a direct answer there must free the GPU (#617).
   * `scope` is always passed, so a full-teardown cancel reaches either.
   */
  private async runSecondOpinion(
    input: PermissionRequestHookInput,
    isSubagent: boolean,
    evalId?: number,
  ): Promise<AutoApproveResult | null> {
    // ADR 0025: the second opinion re-runs `evaluateDeterministic`, so it needs
    // the SAME agent policy the first eval used. Omitting it resolved to the
    // BASE policy and silently undid a per-agent narrowing: a `pr-review`
    // section restricting `approve_groups` is escalated by the first eval, then
    // deterministically approved at 0ms by this one under the base groups --
    // and logged as if the heavy model had agreed.
    const escalateModel = this.deps.escalateModel;
    const service = this.deps.service;
    if (!escalateModel || service === null) return null;
    try {
      return await service.evaluate(
        input.tool_name,
        input.tool_input,
        this.sessionTag,
        input.permission_suggestions as readonly unknown[] | undefined,
        escalateModel,
        evalId,
        this.sessionId,
        isSubagent,
        this.authorityForEval(),
        this.precedentForEval(),
        input.agent_type,
      );
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] escalate_model second opinion threw:`, err);
      return {
        decision: 'escalate',
        reasoning: 'second-opinion error',
        durationMs: 0,
        model: escalateModel,
      };
    }
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
   * Report a `deny` this gate is about to return to the hook (#1015).
   *
   * Called from BOTH deny returns — the primary verdict and the
   * `escalate_model` second opinion — because both are equally invisible to
   * the user, and a second-opinion deny is if anything the more surprising of
   * the two (the fast model wanted to ask; the heavy one refused outright).
   *
   * Deliberately reads `denySource` off the result rather than re-deriving it:
   * the service knows which mechanism refused, and a second derivation here is
   * the drift this module has been bitten by repeatedly (see `DenySource`).
   *
   * A result with NO `denySource` is reported as a `model-floor` deny with an
   * empty pattern rather than being dropped. That combination should be
   * unreachable — every `return { decision: 'deny' }` in `evaluate` tags
   * itself — but "the tag went missing" must not silently restore the exact
   * invisibility this dep exists to end. Reporting too much is a nuisance;
   * reporting nothing is the bug.
   */
  private reportDeny(input: PermissionRequestHookInput, result: AutoApproveResult): void {
    const fn = this.deps.onAutoDenied;
    if (!fn) return;
    const source: DenySource =
      'denySource' in result && result.denySource !== undefined
        ? result.denySource
        : { kind: 'model-floor', pattern: '' };
    try {
      fn(input, source, result.reasoning);
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] onAutoDenied sink threw (ignored):`, err);
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
   * Read this eval's authority text (Q9, #893) via `deps.getAuthority`, fresh
   * per call so a mid-session turn is picked up immediately. Throw-safe like
   * the cues above: a failure here must escalate the eval toward its normal
   * "no authority" behavior, never abort the permission decision itself.
   */
  private authorityForEval(): string | undefined {
    const getAuthority = this.deps.getAuthority;
    if (!getAuthority) return undefined;
    try {
      const text = getAuthority();
      return text.trim().length > 0 ? text : undefined;
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] getAuthority threw (ignored):`, err);
      return undefined;
    }
  }

  /**
   * Read this session's precedent reader (#976) via `deps.getPrecedent`, fresh
   * per call so an answer given moments ago counts for THIS permission rather
   * than the one after it.
   *
   * Throw-safe like `authorityForEval` above, and the failure direction is the
   * point: returning `undefined` means the evaluator consults no precedent, so
   * a repeat gets asked again (a nuisance) and, more importantly, the DENY
   * direction falls back to whatever the model and the other guards say. Both
   * are the pre-#976 behavior; neither can turn a refusal into an approval.
   */
  private precedentForEval(): PrecedentReader | undefined {
    const getPrecedent = this.deps.getPrecedent;
    if (!getPrecedent) return undefined;
    try {
      return getPrecedent();
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] getPrecedent threw (ignored):`, err);
      return undefined;
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
      this.safeCueWithArg('onEscalate', this.deps.onEscalate, {
        isSubagent: this.isSubagentEvent(input),
      });
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
      // escalation for it can never be answered through its own hook response
      // again -- that response already went to a stale hook call. Clean it up
      // BEFORE tracking the new one (the new questionId is not registered yet,
      // so this can never find/cancel itself).
      //
      // Baked-in assumption: Claude Code processes a turn's tool-permission
      // hooks SEQUENTIALLY, so two identical-signature MAIN-context
      // escalations can never be genuinely concurrent/live at once -- an
      // incoming duplicate always means the earlier one is dead. If Claude
      // Code ever parallelizes main-context tool-permission dispatch, this
      // invariant breaks and this check would need a stronger key (e.g.
      // requiring tool_use_id) before it could keep firing safely.
      //
      // UNVERIFIED (#886): this used to cite cc-ref's conversation.rs:370 as
      // proof of sequential dispatch. cc-ref is a disavowed third-party
      // reimplementation (ADR 0006) and was never valid evidence for Claude
      // Code's actual concurrency model, and static extraction from the
      // installed binary (strings + minified-source reading, #886's method
      // for everything else in this file) cannot settle a runtime ordering
      // question either -- there is no way to observe dispatch order without
      // firing two identical-signature PermissionRequests back-to-back
      // against a live Claude Code and watching what arrives. That capture
      // is the #885 epic's named experiment and has not been run. Until it
      // is, treat this as a load-bearing, unverified assumption, not a
      // verified fact -- behavior is left unchanged here because the
      // alternative (a stronger key) is a real design change that needs its
      // own testing, not a side effect of a documentation pass.
      this.cancelExternallyResolved(observed, 'duplicate-re-request');
      this.openQuestionSignatures.set(questionId, {
        toolName: observed.toolName,
        toolInputKey: stableToolInputKey(observed.toolInput),
        toolUseId: observed.toolUseId,
        // #711: tags this OPEN escalation main vs subagent/team-member, so a
        // mainOnly Stop (cancelStale) clears only main-tagged entries here.
        isSubagent: this.isSubagentEvent(input),
        // #799: always undefined here -- escalateToUser is main-context only
        // (see the class doc); kept for ToolSignature's shape symmetry with
        // parkSubagentForPTY's own registration.
        agentId: observed.agentId,
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
      // only its OWN agent's signature -- otherwise two different agents (or
      // a subagent and main) issuing the identical (tool_name, tool_input)
      // could resolve each other's unrelated escalation.
      if (sig.agentId !== observed.agentId) continue;
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
   *
   * `toolName` (#808), when the caller knows it (a signature match or a
   * tracked `ToolSignature` both carry it), is carried onto the
   * question-lifecycle trace record for this removal.
   *
   * #970 totality note: no client status cue fires here. All three callers
   * already have their own status coverage:
   *   - `cancelExternallyResolved` (PreToolUse/PostToolUse/PermissionDenied
   *     match) runs INSIDE the same synchronous hook handler that also drives
   *     `handlers.onPreToolUse` etc. -> `onStatusChange('executing', ...)` for
   *     the identical event, so the pill is corrected in the same tick.
   *   - `cancelStale`'s mainOnly Stop sweep runs before `handlers.onStop`'s
   *     own `onStatusChange('idle')` in that same Stop handler -- see the
   *     note on `releaseAllHolds` above.
   *   - `cancelStaleForAgent` (SubagentStop) only ever matches a
   *     `sig.isSubagent` entry, and #711 never broadcasts the MAIN client
   *     pill for a subagent/team-member eval or hold in the first place --
   *     there is nothing to correct.
   */
  private resolveSupersededQuestion(qid: UUID, reason: string, toolName?: string): void {
    log(
      `[AutoApprove ${this.sessionTag}] Externally resolved ${qid.slice(0, 8)} (${reason}); clearing stale escalation`,
    );
    try {
      this.releaseHeld(qid, 'passthrough', reason, toolName);
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
      this.deps.sessionRegistry.removeQuestion(
        this.sessionId,
        qid,
        reason,
        toolName,
        'AutoApproveGate.resolveSupersededQuestion',
      );
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
