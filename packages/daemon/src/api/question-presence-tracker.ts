/**
 * QuestionPresenceTracker — pair hook-derived question metadata with
 * PTY-derived screen presence so APNS push fires only when the user is
 * actually looking at a prompt.
 *
 * The pre-Phase-3 design used two time-based heuristics:
 *   - A 5 s `lastPermissionEmitAt` window in HookEventBridge that suppressed
 *     a trailing Notification(permission_prompt) and the PTY parser's echo.
 *   - A 1 s `PERMISSION_INJECT_ACK_TIMEOUT_MS` timer in hook-bridge-setup
 *     that fired a phantom escalation when no follow-up hook event arrived
 *     within the window — even though most Bash commands take longer than
 *     1 s to emit PostToolUse, so the timer false-fired constantly.
 *
 * This tracker replaces both. Pairing is structural rather than time-based:
 *
 *   - Hooks (`recordPendingHook`) carry tool / option metadata but do NOT
 *     trigger a push by themselves; this tracker only governs the iOS
 *     notification path.
 *   - PTY (`onPTYPromptVisible`) is the truth signal: a prompt is on the
 *     user's terminal RIGHT NOW. Push immediately, merging hook metadata
 *     if a pending hook record matches (tool + command text, agent_id,
 *     etc.; the options stay the screen's own, #1134).
 *   - Status transitions OUT of `'waiting'` (`onStatusChange`) clear any
 *     pending hook records. The user advanced past the prompt — Claude's own
 *     permission rules handled it silently, or the subagent stayed in the
 *     background, or the user answered in-terminal. No push needed.
 *
 * Pending hook records are keyed by agent (`agentId` or `'main'`), so two
 * concurrent agents (main + a subagent, #419) keep separate records and a
 * later subagent hook cannot clobber the main agent's record (#425).
 *
 * Stale-as-written correction (#886): this comment used to claim subagent /
 * Agent-Teams permission requests never fire PermissionRequest hooks at all,
 * citing upstream anthropics/claude-code #23983. That is contradicted by
 * AutoApproveGate.resolvePermission's own logging: a live 0.6.22 session
 * recorded 16 subagent-tagged (`agent_id` present) PermissionRequest hooks
 * against only 2 PTY renders. Task-tool /
 * background-subagent escalations DO fire the hook -- they are parked
 * (ADR 0004) and passed through unconditionally, and MOST never render,
 * which is different from "never fires." What #23983 may still describe
 * correctly is narrower: native Agent-Teams teammate prompts specifically
 * (as opposed to Task-tool subagents generally) possibly firing no hook at
 * all. That narrower claim was not independently re-verified here. Either
 * way, a PTY-only push path (no preceding hook record) stays a first-class
 * case in this tracker, not a fallback -- it just is not the ONLY source for
 * subagent prompts the way this comment previously implied.
 *
 * Render-resolution (#888/#920): a PTY-only pushed question has no hook and
 * so no tool signature for `AutoApproveGate` to resolve it by -- its only
 * exits used to be the user answering it or the `MAX_PENDING_QUESTIONS` LRU
 * cap, which measured as a real leak (12 of 29 source-less questions never
 * removed in one working day's capture, one still pending 2h51m later).
 * `observedRenderOwnedQuestion` + `deps.onHooklessQuestionGone` close that gap,
 * but ONLY on a CONFIRMED-delivered replacement push in `pairAndPush` --
 * the `QuestionRegistrationOutcome` returned directly by the `push` call is
 * the confirmation gate (#888 criterion iii; formerly a separate
 * `deps.isQuestionLive` re-query of the store, deleted once the push call
 * itself could report its own outcome). An id-comparison-only version of
 * this (this file's own V1) could resolve a question that never actually
 * left the screen: the PTY parser mints a fresh id on every parse
 * regardless of content (#486), and the replacement's own push can be
 * silently eaten by `QuestionDedup`'s 5s window -- found in review, see
 * `pairAndPush`'s doc for the full failure chain. Status-leaves-'waiting'
 * and `clearPending` were dropped as triggers for the same reason (both can
 * fire on a signal unrelated to whether THIS question's render is actually
 * gone); see their own reset comments. See `pairAndPush` and
 * `noteHooklessGone`.
 */

import { MAIN_AGENT_ID } from '@remi/shared';
import type { AgentStatus, Question, QuestionOption } from '@remi/shared';
import type { QuestionRegistrationOutcome } from './message-api.ts';

export interface PushOptions {
  /**
   * The gate decided this card must reach the user NOW (`pushHeldHook`), so it
   * is LOAD-BEARING, not a cosmetic PTY/hook echo: it BYPASSES the
   * content-dedup and delivers to the lock screen even when a client is
   * attached (it may be backgrounded). #603 Phase 3. Callers: a held binary
   * permission prompt (Model B, #573, restored by #1126) and a multi-choice /
   * design escalation.
   */
  held?: boolean;
}

/**
 * Callable sink: the tracker's only output. Called when a push to iOS
 * should fire. Implementations forward to `MessageAPI.handleQuestion`,
 * which applies the content-identity QuestionDedup before the network
 * layer — unless `opts.held` marks the load-bearing held-hook card.
 *
 * Returns `MessageAPI.handleQuestion`'s own `QuestionRegistrationOutcome`
 * (#888 criterion iii) — `pairAndPush` consumes this DIRECTLY as its
 * confirmed-delivery signal instead of re-querying the store afterward (the
 * deleted `isQuestionLive` dep). `| undefined` (not `| void` — this
 * codebase's lint config forbids `void` inside a union) covers a push sink
 * that does not participate in the outcome contract; production always
 * returns the real outcome because `cli.ts` wires this straight to
 * `messageApi.handleQuestion`.
 */
export type PushQuestion = (
  question: Question,
  opts?: PushOptions,
) => QuestionRegistrationOutcome | undefined;

/** Why a pending record pushes on its PTY render; see `awaitingPTY`. */
type RenderMarkKind = 'parked-subagent' | 'push-on-render';

/** The one card the current on-screen prompt owns, and what identifies it. */
interface RenderOwnedCard {
  readonly id: string;
  /** Agent the PTY prompt belonged to; a different agent never supersedes. */
  readonly agent: string;
  /** Raw PTY text, so a byte-identical redraw is not read as a replacement. */
  readonly text: string;
}

/** Pending-hook map key: the prompt's agent, or MAIN_AGENT_ID for the primary. */
function agentKey(question: Question): string {
  return question.agentId ?? MAIN_AGENT_ID;
}

/**
 * A screen-parsed option with `isYes`/`isNo` derived from its label (#1134).
 * The parser reads a numbered menu as bare picks (both flags false), so a
 * merged card built from the screen would otherwise lose the yes/no meaning
 * the hook's options carried: the lock-screen category, the client's
 * styling and the answer path's allow/deny classification all read these
 * flags. Conservative: only a label that starts with the exact word "Yes" or
 * "No" counts (case-sensitive, so "Yesterday", "None" and "yes" do not).
 * Labels and values are untouched; flags already set are kept.
 */
function withScreenLabelFlags(option: QuestionOption): QuestionOption {
  const label = option.label.trim();
  return {
    ...option,
    isYes: option.isYes || /^Yes\b/.test(label),
    isNo: option.isNo || /^No\b/.test(label),
  };
}

/** Debounce (ms) before an orphan PTY prompt (#712: no pending hook record,
 *  no live registered question) is pushed. Guards a residual render flash —
 *  a prompt painted mid-redraw that is gone a moment later (status leaves
 *  'waiting', or `clearPending` fires, before the timer) — without holding a
 *  genuine orphan (agent-team permission, MCP elicitation dialog, a
 *  re-render of a prompt whose card was already dismissed) long enough to
 *  matter to the user. */
const DEFAULT_ORPHAN_DEBOUNCE_MS = 1500;

/** How long a parked awaiting-PTY record (#751) survives other agents'
 *  status churn (#763). A prompt that will render does so within
 *  milliseconds of the hook's passthrough answer; one that never renders is
 *  normally expired by its own agent's next PreToolUse (`noteAgentAdvanced`).
 *  The TTL is the backstop for an agent that stalls without either signal,
 *  so a stale parked record cannot merge onto an unrelated prompt minutes
 *  later. */
const PARKED_RECORD_TTL_MS = 120_000;

export interface QuestionPresenceTrackerDeps {
  /** True iff the session currently has at least one registered, unanswered
   *  question (`sessionRegistry.getSession(id)?.currentQuestions.size > 0`).
   *  Used ONLY by the #712 orphan-prompt fallback: every gate-pushed
   *  escalation (held or passthrough) registers a question via `addQuestion`
   *  before or synchronously with the corresponding PTY render, so this is
   *  what tells an orphan PTY prompt apart from an echo of something the
   *  gate already owns. Absent (e.g. existing tests / no-hook-server
   *  construction) is treated as "no live questions". MUST be synchronous
   *  and non-throwing (same contract as `MessageApiSetupDeps.pushConfig` /
   *  `getClaudeSessionId`): it runs inline in the PTY-parse callback with no
   *  surrounding try/catch at the call site — `isGateOwnedCycle` guards
   *  against a throw, but implementations should still absorb their own
   *  errors rather than relying on that. */
  hasLiveQuestions?: () => boolean;
  /** Override for `DEFAULT_ORPHAN_DEBOUNCE_MS`. Exists so tests can use a
   *  short real timer instead of faking time. */
  orphanDebounceMs?: number;
  /** Clock override for the parked-record TTL (#763). Defaults to Date.now. */
  nowMs?: () => number;
  /**
   * The render-resolution transition (#888/#920 hard requirement): fired when
   * a genuinely HOOK-LESS pending question's only evidence -- the PTY render
   * -- is gone. A hook-less question (no PermissionRequest/Notification ever
   * fired for it: an agent-team native prompt, a bare subprocess `(y/n)`) has
   * no tool signature for `AutoApproveGate.cancelExternallyResolved` or the
   * Stop/SubagentStop sweeps to match, so absent this callback it can leave
   * `SessionRegistry.currentQuestions` only via the user answering it or the
   * `MAX_PENDING_QUESTIONS` LRU cap -- the #920 measured leak (12 of 29
   * source-less questions never removed over one working day, one still
   * pending 2h51m later).
   *
   * Fires ONLY from `pairAndPush`, and ONLY once the `QuestionRegistrationOutcome`
   * returned by the `push` call CONFIRMS the replacement that superseded it
   * actually registered -- see `pairAndPush`'s doc for why an
   * id/status/restart-based trigger without that confirmation is unsound
   * (found in review of the first version of this mechanism, #888). Does NOT
   * touch push decisions (ADR 0004 unchanged) -- this only tells
   * the caller a PREVIOUSLY PUSHED question's evidence is gone, so it can be
   * removed from the pending store.
   *
   * MUST be synchronous and non-throwing (same contract as
   * `hasLiveQuestions`): invoked with no surrounding try/catch at most call
   * sites, but a throw is still caught internally and logged, never
   * propagated. `reason` is a short signal string carried onto the
   * question-lifecycle trace.
   */
  onHooklessQuestionGone?: (questionId: string, reason: string) => void;
}

export class QuestionPresenceTracker {
  /** Hook-derived questions not yet paired with PTY confirmation or cleared,
   *  keyed by agent. At most one per agent: a second hook for the SAME agent
   *  (e.g. PermissionRequest then Notification for one prompt) replaces the
   *  first, but different agents keep separate entries. A PTY prompt pairs with
   *  the same-agent entry, or (only when exactly one entry exists) the sole
   *  candidate; with 2+ different-agent entries it pushes bare (no guessing). */
  private pending = new Map<string, Question>();

  /** Keys of `pending` records that push on their PTY render instead of
   *  through the gate, mapped to when they were marked and why. Two kinds:
   *  `parked-subagent`, a subagent escalation PARKED for its PTY render
   *  (#751), and `push-on-render`, a binary main-agent escalation the gate
   *  answered 'passthrough' (`pushOnRender`, #1121). Unlike a normal pending
   *  record (an in-flight gate escalation whose own push is imminent), a
   *  parked record must NOT count as gate-owned in the #712 orphan check —
   *  the PTY render IS its push trigger — and it must SURVIVE the unscoped
   *  status-change clear (#763): in an agent-team session every other
   *  agent's hook activity flips status constantly, and wiping a still-live
   *  parked record loses the merged push (or the whole prompt, when an
   *  unrelated live question makes `hasLiveQuestions` suppress the orphan).
   *  A parked entry expires when its OWN agent advances
   *  (`noteAgentAdvanced` — Claude's own rules allowed the call, or it was
   *  answered), on consume (render pairing), on `clearPending`
   *  (restart/rotation), or after `PARKED_RECORD_TTL_MS`. Always a subset of
   *  `pending`'s keys; every `pending` delete/clear site mirrors onto this
   *  map. Only `parked-subagent` takes the #763 exemption: a `push-on-render`
   *  mark belongs to the main agent, which has no `noteAgentAdvanced` path,
   *  so its own status leaving 'waiting' is how its prompt cycle ends. */
  private awaitingPTY = new Map<
    string,
    { at: number; kind: RenderMarkKind; onRender?: (merged: Question) => void }
  >();

  /** Agent keys whose `push-on-render` record was REPLACED by a newer hook
   *  before its prompt rendered (#1121 review). Two outstanding prompts for
   *  one agent cannot be paired by agent key and render order: whichever
   *  dialog renders first would wear the other's text and options. The next
   *  `pushOnRender` for such a key therefore declines to mark, so both
   *  renders take the orphan path and push the screen's own prompt. Cleared
   *  when consumed, when status leaves 'waiting', and on `clearPending`. */
  private ambiguousRenderKeys = new Set<string>();

  /** True while a prompt this tracker pushed is on the main PTY. Set when a
   *  render is paired and pushed; reset by `onStatusChange` out of
   *  `'waiting'` AND by `clearPending`. Half of `isPromptCurrent`. */
  private ptyShowingQuestion = false;

  /** The id of the LAST PTY question this tracker observed (#814), set on
   *  entry to every PTY-render callback — before any pushing or suppression
   *  decision — and cleared by the same resets as `ptyShowingQuestion`.
   *
   *  `ptyShowingQuestion` alone answers "is SOME prompt on screen", which is
   *  not enough before typing an answer: an answer meant for prompt A must
   *  never be typed into prompt B just because B happens to be showing (the
   *  #751 wrong-prompt hazard, see `isPromptCurrent`). Each PTY emit mints a
   *  fresh question id (rising-edge, #486), so id identity is exactly the
   *  "still the same prompt" test. */
  private observedPTYQuestionId: string | null = null;

  /** The TEXT of the last observed PTY question (#814). A prompt that merely
   *  REDRAWS re-emits under a fresh id (rising edge on a changed fingerprint,
   *  #486), so id identity alone would call a live prompt "gone" and drop its
   *  card. Text is the stable half of the identity: same text => same prompt
   *  cycle. Two DIFFERENT prompts with byte-identical text (the same agent
   *  re-asking the same command) are indistinguishable here by construction —
   *  and answering the second with the first's answer is the same answer to
   *  the same question, which is why that collapse is acceptable. */
  private observedPTYText: string | null = null;

  /** The OPTIONS of the last observed PTY question (#1134), set and cleared
   *  with `observedPTYQuestionId`. What the screen numbers right now: the
   *  answer path checks a value against these before typing it, because a
   *  digit Claude's menu does not show is ignored and the Enter after it
   *  confirms whatever option is highlighted. */
  private observedPTYOptions: readonly QuestionOption[] | null = null;

  /**
   * The id of the currently-PUSHED hook-less question, if any (#888/#920).
   * Set by `pairAndPush` when a merge produces a question with NO pairing
   * hook record (`hookRecord === undefined` in `consumeAndMerge` -- a
   * genuinely hook-less prompt), cleared (and `deps.onHooklessQuestionGone`
   * fired) the moment that evidence is gone: a DIFFERENT render supersedes it
   * (see `pairAndPush`), status leaves 'waiting', or `clearPending` runs.
   *
   * Distinct from `observedPTYQuestionId` (the RAW pre-merge PTY parse id,
   * half of `isPromptCurrent`) because the id that matters here
   * is the one actually registered in `SessionRegistry.currentQuestions` --
   * for a hook-less question that IS the same value (no merge changes it),
   * but tracking it separately keeps this mechanism decoupled from the
   * prompt-identity fields it must not affect.
   *
   * A hook-PAIRED question is never tracked here: it already has a
   * signature-matched removal path (`AutoApproveGate.cancelExternallyResolved`
   * / the Stop sweeps), so this mechanism -- scoped tightly to the one cohort
   * that has no other exit -- leaves it alone.
   */
  private observedRenderOwnedQuestion: RenderOwnedCard | null = null;

  /** Question ids already pushed via `pushHeldHook` (#573). Membership makes
   *  a repeat `pushHeldHook` for the same id a no-op. Cleared on any reset
   *  (status-out-of-waiting / clearPending) so a new prompt cycle starts
   *  fresh. */
  private pushedHeldIds = new Set<string>();

  /** Armed orphan-prompt debounce timer (#712), or null when none is armed.
   *  Cancelled by `onStatusChange` (status leaves `'waiting'`) and by
   *  `clearPending`, so no stale timer can outlive the prompt cycle or the
   *  session. */
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
  /** The PTY question armed on `orphanTimer`. A second orphan prompt arriving
   *  before the timer fires REPLACES this (not merges): only the latest
   *  candidate pushes, once — mirroring the rising-edge-only PTY emission
   *  (#486), which never re-emits for the tracker to catch on a later tick. */
  private armedOrphanQuestion: Question | null = null;

  /** "Is a hook-backed prompt open?" (#1126), installed by `setupHookBridge`
   *  from the permission gate. Null until installed (no hook server, or
   *  tests), which reads as false. See `setHookPromptProbe`. */
  private hookPromptProbe: (() => boolean) | null = null;

  constructor(
    private readonly push: PushQuestion,
    private readonly deps: QuestionPresenceTrackerDeps = {},
  ) {}

  /**
   * Install the gate's "is a hook-backed prompt open?" read (#1126). While it
   * answers true, a PTY render is not an orphan: it is the open hook-backed
   * prompt (or a redraw of it), whose card is the gate's to push and whose
   * answer goes through the hook or the terminal, never through a card
   * rebuilt from the screen and answered by typing. That matters after a
   * hold ends with the dialog still up (the deadline): the card is gone, so
   * the live-question check no longer suppresses the redraw. Genuinely
   * hook-less prompts (sandbox network, trust, agent-team dialogs) render
   * while no hook-backed prompt is open, and still take the orphan path.
   * `setupHookBridge` calls this once, where the gate and tracker meet.
   */
  setHookPromptProbe(probe: () => boolean): void {
    this.hookPromptProbe = probe;
  }

  /**
   * Hook fired (PermissionRequest or Notification(permission_prompt)).
   * Stash the question by agent; do NOT push yet. Push happens when PTY
   * confirms the prompt is visible, or never if status moves past 'waiting'
   * first.
   *
   * Replacement policy: per agent, the newer hook normally wins. The one
   * exception (#574): a pending rich `PermissionRequest` is authoritative and
   * is NOT evicted by any other shape — only a NEWER `PermissionRequest` (a new
   * permission cycle) may replace it. Claude fires both a PermissionRequest and
   * a generic `Notification(permission_prompt)` for one prompt; the
   * PermissionRequest carries the tool + command ("Allow Bash: git push"),
   * while the Notification is the bland "Claude needs your permission to use
   * Bash". Letting the trailing notification win is exactly what garbled the
   * push text (issues 3+4); since #1134 the merged card's options come from
   * the screen either way. A same-agent source-less question (e.g. a
   * StopFailure "Retry?" card) must likewise not silently evict the pending
   * permission request and leave the real prompt without a push. Different
   * agents never overwrite each other (#425).
   */
  recordPendingHook(question: Question): void {
    const key = agentKey(question);
    const existing = this.pending.get(key);
    if (existing) {
      // A pending rich permission request stays put unless the incoming is a
      // newer permission request: a generic Notification or a source-less
      // StopFailure-shaped question for the same agent must NOT evict it.
      //
      // Currently UNREACHABLE, deliberately kept (#890/Q5): both entry points
      // -- `hook-bridge-setup.ts`'s `onQuestion` (gated to
      // `source === 'permission_request'`) and `parkAwaitingPTY` below (always
      // a permission question) -- now pass only 'permission_request', because
      // Q5 deleted the 'notification' synthesis that was the other caller.
      // Not deleted: this is the invariant that makes adding a future stashed
      // source safe, and re-deriving it after a regression is how #574 was
      // found in the first place.
      if (existing.source === 'permission_request' && question.source !== 'permission_request') {
        console.debug(
          `[QuestionPresenceTracker] Keeping richer pending permission_request for agent "${key}"; not evicting with source="${question.source ?? 'undefined'}" (kept="${existing.text.slice(0, 50)}", dropped="${question.text.slice(0, 50)}")`,
        );
        return;
      }
      console.debug(
        `[QuestionPresenceTracker] Replacing pending hook for agent "${key}" (old="${existing.text.slice(0, 50)}", new="${question.text.slice(0, 50)}")`,
      );
    }
    if (existing && this.awaitingPTY.get(key)?.kind === 'push-on-render') {
      this.ambiguousRenderKeys.add(key);
      console.error(
        `[QuestionPresenceTracker] A new hook replaced agent "${key}"'s unrendered push-on-render record ("${existing.text.slice(0, 50)}"); its render will push bare`,
      );
    }
    // Re-insert so this agent's entry is the most recent (matters for the
    // PTY-pairing fallback below).
    this.pending.delete(key);
    this.pending.set(key, question);
    // A normal (gate-owned) record replaces any parked one for this agent;
    // parkAwaitingPTY re-adds the flag after routing through here (#751).
    this.awaitingPTY.delete(key);
  }

  /**
   * Park a subagent-tagged permission question awaiting its PTY render
   * (#751). The gate answered the hook 'passthrough' (no push yet): Claude
   * runs its normal permission flow, so either its own permission rules
   * allow the request silently (the record then expires when that agent
   * advances, or after `PARKED_RECORD_TTL_MS`; see `awaitingPTY`) or the
   * native prompt renders on the main PTY — `onOrphanPTYPrompt` recognizes the parked
   * record and merges its rich text onto the parsed prompt (no orphan
   * debounce: hook + render is positive double-confirmation). The PTY is the
   * arbiter of whether the user is told.
   *
   * With `opts.onRender` (#1126, every production park) the render calls it
   * with the merged question INSTEAD of pushing an answerable card: the
   * hook was answered 'passthrough', so only the terminal can answer, and
   * the phone gets an "answer at the terminal" notice. Without it the render
   * pushes a card, as before #1126.
   */
  parkAwaitingPTY(question: Question, opts: { onRender?: (merged: Question) => void } = {}): void {
    this.recordPendingHook(question);
    // recordPendingHook may have kept a richer existing record instead of
    // this one; the parked flag applies to whatever record now owns the key
    // (both are hook-derived for the same agent's prompt cycle).
    this.awaitingPTY.set(agentKey(question), {
      at: this.deps.nowMs?.() ?? Date.now(),
      kind: 'parked-subagent',
      ...(opts.onRender ? { onRender: opts.onRender } : {}),
    });
    console.debug(
      `[QuestionPresenceTracker] Parked question awaiting PTY render (agent "${agentKey(question)}"): "${question.text.slice(0, 60)}"`,
    );
  }

  /**
   * Mark an already-stashed hook record (located by `Question.id`) to push
   * when its prompt renders, through the same parked branch of
   * `onOrphanPTYPrompt` a subagent park uses: merge onto the parsed prompt
   * (the card takes the screen's options, #1134), then push. The gate calls
   * this for every binary main-context escalation
   * (`AutoApproveGate.escalateForRender`; nothing holds since #1125):
   * without the mark, `isGateOwnedCycle` reads the stashed record as "the gate
   * already pushed this" and suppresses the only render that could surface it.
   * Returns false when no pending record carries that id (nothing to mark), or
   * when the record replaced an unrendered one for the same agent (see
   * `ambiguousRenderKeys`); the record is then dropped and the render pushes
   * bare through the orphan path.
   */
  pushOnRender(questionId: string): boolean {
    for (const [key, q] of this.pending) {
      if (q.id !== questionId) continue;
      if (this.ambiguousRenderKeys.delete(key)) {
        // Unpairable (see `ambiguousRenderKeys`): drop the record so neither
        // render counts as gate-owned and each pushes the screen's own prompt.
        this.pending.delete(key);
        console.error(
          `[QuestionPresenceTracker] pushOnRender: two outstanding prompts for agent "${key}"; not pairing "${q.text.slice(0, 50)}", its render pushes bare`,
        );
        return false;
      }
      this.awaitingPTY.set(key, {
        at: this.deps.nowMs?.() ?? Date.now(),
        kind: 'push-on-render',
      });
      console.debug(
        `[QuestionPresenceTracker] Unheld escalation awaiting its render (agent "${key}"): "${q.text.slice(0, 60)}"`,
      );
      return true;
    }
    console.debug(
      `[QuestionPresenceTracker] pushOnRender: no pending record for question ${questionId.slice(0, 8)}`,
    );
    return false;
  }

  /**
   * An agent-tagged PreToolUse arrived (#763): that agent's pending
   * permission resolved WITHOUT a PTY render for us to pair (the session
   * allowlist absorbed it after the gate's passthrough, or it was answered
   * out-of-band). Its parked record is dead — expire it so it cannot
   * stale-merge onto a later unrelated prompt. Scoped strictly to that
   * agent's key; other agents' parked records are untouched.
   */
  noteAgentAdvanced(agentId: string | undefined): void {
    if (agentId === undefined) return;
    if (this.awaitingPTY.delete(agentId)) {
      this.pending.delete(agentId);
      console.debug(
        `[QuestionPresenceTracker] Parked question expired (agent "${agentId}" advanced without a render)`,
      );
    }
  }

  /**
   * Push an escalation's question IMMEDIATELY, without waiting for a PTY
   * render. Callers: a binary prompt whose PermissionRequest hook is held for
   * the phone's answer (Model B, #573; `AutoApproveGate.holdForAnswer`,
   * #1126), and a multi-choice / design escalation
   * (`AutoApproveGate.escalatePassthrough`, #625). Neither waits for a
   * render. Pushes under the stashed question's own id.
   *
   * Locates the stashed hook record by id (the `pending` map is agent-keyed, so
   * we scan its values for the matching `Question.id`), routes it through the
   * same `push` sink as `onPTYPromptVisible` (-> MessageAPI.handleQuestion ->
   * addQuestion + maybePush), and removes the consumed record so the normal
   * pair-merge cannot push it a second time. Idempotent: a repeat call for the
   * same id (or one whose record was already consumed) is a no-op, guarded by
   * `pushedHeldIds`. Returns true iff a push fired.
   */
  pushHeldHook(questionId: string): boolean {
    if (this.pushedHeldIds.has(questionId)) return false;
    let recordKey: string | undefined;
    for (const [key, q] of this.pending) {
      if (q.id === questionId) {
        recordKey = key;
        break;
      }
    }
    if (recordKey === undefined) {
      // No stashed record for this id: the hook was never recorded (e.g. a
      // restart cleared pending between escalate and this call). Nothing to push.
      console.debug(
        `[QuestionPresenceTracker] pushHeldHook: no pending record for question ${questionId.slice(0, 8)}`,
      );
      return false;
    }
    const question = this.pending.get(recordKey) as Question;
    // Consume BEFORE the push so a re-entrant call cannot re-push the same
    // record, and so a later onPTYPromptVisible has no record to merge.
    this.pending.delete(recordKey);
    this.awaitingPTY.delete(recordKey);
    this.pushedHeldIds.add(questionId);
    try {
      // held: bypass the cosmetic dedup + deliver regardless of an attached
      // client — the held card is load-bearing for answerability (#603 Phase 3).
      this.push(question, { held: true });
    } catch (err) {
      console.error(
        `[QuestionPresenceTracker] pushHeldHook push sink threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  /**
   * PTY parser saw a prompt on screen. Push immediately. Pair with a hook
   * record for text / agent_id: prefer the same-agent entry, else the
   * sole pending hook when exactly one exists (unambiguous). With 2+ pending
   * hooks from different agents and no agent match, push bare to avoid
   * misattributing another agent's command (#425 / #483). When paired, the hook
   * contributes `id` (#887: identity is minted ONCE, at hook arrival — see
   * `consumeAndMerge`), `agentId` (so the client keys the prompt to the right
   * agent), AND `text` — the hook's text carries the tool + command + agent
   * context (e.g. "code-reviewer · Bash: git push origin main"), whereas the
   * PTY's literal screen text is the bare terminal prompt ("Do you want to
   * proceed?"). The PTY contributes `options`, `allowsFreeText` / `isAnswered`
   * and its presence is the push trigger (#497). The consumed hook entry is
   * removed. With NO hook record (a genuinely hook-less prompt: an agent-team
   * native prompt, or a subprocess `(y/n)`), the PTY's own freshly-parsed `id`
   * IS the identity — there is no other source for one.
   *
   * Options rule (#1134, replacing #718's "the hook's options win unless they
   * are the fallback"): when the PTY parse has options, they are the merged
   * card's options, labels and values unchanged. A merged card is answered by
   * typing its option value into the PTY, so it must carry the screen's
   * numbering; the hook's suggestion-derived set does not match Claude's
   * dialog one-for-one, and a mismatch typed a phone "No" as an approval. The
   * hook's options are kept only when the parse has none. The parse carries
   * no yes/no flags, so the merge derives them from the screen labels
   * (`withScreenLabelFlags`).
   * Text/agentId/kind/questions/submitLabel still prefer the hook record
   * (`summary`, which the removed evaluator wrote, is no longer carried,
   * #1125).
   *
   * Pending is mutated BEFORE the push so a re-entrant call cannot re-merge
   * the same record. Push errors are caught and logged but not rethrown — the
   * next PTY emit for the same prompt retries WITHOUT the hook merge (PTY's
   * numbered options), which beats crashing on a network blip during APNS.
   */
  onPTYPromptVisible(ptyQuestion: Question): void {
    // #814, before any branch: record what is on screen now.
    this.observePTYQuestion(ptyQuestion);
    this.pairAndPush(ptyQuestion);
  }

  /**
   * Pair-and-push core shared by the render-driven push triggers
   * (`onPTYPromptVisible` and the orphan debounce).
   *
   * #888/#920 render-resolution, CONFIRMED-delivery gate: the confirmation
   * that a hook-less question's replacement actually registered comes
   * DIRECTLY from `push`'s own `QuestionRegistrationOutcome` return value
   * (#888 criterion iii) rather than a separate `isQuestionLive` re-query of
   * the store after the fact -- the information flows from the call itself.
   * The push is synchronous end to end (push -> `MessageAPI.handleQuestion`
   * -> `QuestionDedup` -> `SessionRegistry.addQuestion`), so the returned
   * outcome is exactly as current as a post-hoc store query would have been.
   *
   * An id-comparison-only version of this check (this file's own V1) could
   * resolve a question that never actually left the screen, for two reasons
   * found in review:
   *   1. The PTY parser mints a FRESH id on every single parse (#486), even
   *      when a prompt merely REDRAWS with unchanged text -- the exact
   *      hazard `isPromptCurrent`'s own text fallback already documents
   *      elsewhere in this file ("a prompt that merely redraws re-emits
   *      under a fresh id ... matching on the id alone would call a live
   *      prompt gone"). V1 applied no such guard to this mechanism.
   *   2. Even a GENUINELY different render can be silently swallowed by
   *      `QuestionDedup`'s 5s same-fingerprint window before it ever reaches
   *      `SessionRegistry.addQuestion` -- and V1 resolved the OLD id
   *      regardless, on the strength of the new render having merely been
   *      PARSED, not actually delivered. Reachable in production: a false-
   *      positive PTY-text status parse (`output-processor.ts`'s >= 0.5
   *      confidence gate) flips status out of 'waiting' without resetting
   *      `QuestionDedup` (cli.ts only resets it when no hook server is
   *      active), status flips back to 'waiting' with the SAME prompt still
   *      on screen, the redraw parses under a fresh id, and dedup silently
   *      eats it -- net effect: the daemon told the client the question was
   *      cancelled while the identical prompt sat unanswered on the real
   *      screen. That is the disqualifying failure for this epic.
   *
   * A push whose returned status is not `'registered'` (deduped, or the push
   * sink does not report an outcome at all) changes nothing: an unconfirmed
   * push must not resolve anything, matching the "fail toward showing" rule
   * every other ambiguous path in this codebase follows ("every ambiguous path
   * resolves toward showing the user"). Losing this ONE
   * resolution trigger on an unconfirmed push is an acceptable cost;
   * swallowing a live question is not.
   */
  private pairAndPush(ptyQuestion: Question): void {
    // `hookRecord` is deliberately not read here any more: #1005 widened the
    // render-owned slot to EVERY confirmed render-born card, hook-paired or
    // not, so whether a hook was consumed no longer changes what is tracked.
    const { merged } = this.consumeAndMerge(ptyQuestion);
    this.ptyShowingQuestion = true;
    this.pushRenderBorn(merged, ptyQuestion.text);
  }

  /**
   * Push a render-born card and, on a CONFIRMED registration, give it the
   * render-owned slot (#1005 Change B), so the next render on this screen
   * resolves it. Used by every render-born push site: `pairAndPush`, and the
   * marked branch of `onOrphanPTYPrompt` (a parked subagent, or a main
   * `push-on-render` mark, #1121). Without
   * the slot, a card whose prompt was denied in the terminal (no tool run, so
   * no `cancelExternallyResolved`) stayed live until the `Stop` sweep, and a
   * phone tap on it while a later prompt was on screen passed the
   * any-prompt-observed guard and typed into that later prompt.
   */
  private pushRenderBorn(merged: Question, ptyText: string, context?: string): void {
    const outcome = this.pushMerged(merged, context);
    if (outcome?.status !== 'registered') {
      // Not confirmed (deduped, or the push sink returned no outcome):
      // nothing is known to have changed. Leave `observedRenderOwnedQuestion`
      // exactly as it was -- if it was tracking an older id, that question
      // is STILL the best evidence of what's on screen, and must not be
      // resolved on the strength of a replacement that never actually
      // registered.
      return;
    }
    this.adoptRenderOwnedQuestion({
      id: merged.id,
      // Scope by the MERGED question, not the raw PTY parse. The parse often
      // carries no `agentId` at all (`Do you want to proceed?` says nothing
      // about whose permission it is), so keying on it filed a parked SUBAGENT
      // card under `main` — and the next main-agent prompt then superseded it,
      // which is the very cross-agent bleed the scoping exists to stop. The
      // merge takes the hook record's agent, which is the one that knows.
      agent: agentKey(merged),
      text: ptyText,
    });
  }

  /**
   * Record `id` as THE card this screen's prompt owns, resolving whatever card
   * held that slot before it (#1005 Change B).
   *
   * One PTY renders one prompt, so at most one render-born card can be live.
   * A confirmed-registered replacement render IS the screen's current prompt,
   * which makes the previous card's prompt provably gone — the same reasoning
   * #888/#920 already applied, but that version was scoped to `hookRecord ===
   * undefined` and so covered only genuinely hook-less cards.
   *
   * The excluded cohort is where the leak lived. A parked subagent escalation
   * is hook-BORN, but its hook was answered `passthrough` at park time (ADR
   * 0004), so the PTY render is its only living evidence — identical in
   * lifecycle to a hook-less card, and previously tracked by nothing. Its exits
   * were an exact-signature tool-run match, a phone answer, or `SubagentStop`;
   * a terminal DENY fires no tool call, the lead-`Stop` sweep skips subagent
   * entries (#711), and an agent-team teammate can run for days without
   * `SubagentStop`. So those cards had no working exit and accumulated until
   * LRU eviction.
   *
   * Cards pushed at hook time (`pushHeldHook`) never reach here: that
   * trigger consumes the hook record, so the native render that follows is
   * an echo the live-question check (and, once the card is gone, the
   * hook-prompt probe, #1126) suppresses, not a render-born card.
   */
  private adoptRenderOwnedQuestion(card: RenderOwnedCard): void {
    const previous = this.observedRenderOwnedQuestion;
    if (previous !== null && previous.id !== card.id && this.supersedes(previous, card)) {
      this.noteHooklessGone('pty_render_superseded');
    }
    this.observedRenderOwnedQuestion = card;
  }

  /**
   * True when `next` genuinely REPLACES `previous` on screen, rather than
   * merely following it.
   *
   * Two refusals, both found by driving concurrent agents through the real
   * stack (#1008 review):
   *
   * 1. **A different agent's prompt proves nothing about this one.** Every
   *    other piece of state in this file is agent-keyed (`pending`,
   *    `awaitingPTY`, dedup — see #425/#767/#799 for why
   *    cross-agent bleed is dangerous); this slot was the exception. Subagent
   *    B rendering an unrelated permission silently resolved subagent A's
   *    escalated card: no answer, no tool run, no `SubagentStop`. Worse, the
   *    cli.ts funnel then deleted A's `openQuestionSignatures` entry, killing
   *    the exact-signature exit as well — reproducing the unremovable card
   *    #1005 exists to fix, through a different door.
   *
   * Text identity is deliberately NOT a second refusal here, though a review
   * proposed it. A same-text redraw superseding is #888's stated policy ("the
   * guard is delivery, not text identity"), and the harm does not apply: a
   * supersede only fires on a CONFIRMED-registered replacement, so the user
   * still holds a card for that prompt — the new one. Cross-agent is the
   * asymmetric case, and the only one that leaves a prompt with no card at all.
   */
  private supersedes(previous: RenderOwnedCard, next: RenderOwnedCard): boolean {
    return previous.agent === next.agent;
  }

  /**
   * Clear and report the currently-tracked hook-less question as gone
   * (#888/#920), if one is tracked. No-op when `observedRenderOwnedQuestion` is
   * null (nothing to resolve) or no `onHooklessQuestionGone` dep is wired
   * (pre-#888 behavior: hook-less questions are never actively resolved).
   * The dep is invoked outside any try/catch at some call sites, so a throw
   * is caught and logged here rather than trusted to the caller.
   */
  private noteHooklessGone(reason: string): void {
    const card = this.observedRenderOwnedQuestion;
    if (card === null) return;
    const id = card.id;
    this.observedRenderOwnedQuestion = null;
    try {
      this.deps.onHooklessQuestionGone?.(id, reason);
    } catch (err) {
      console.error(
        `[QuestionPresenceTracker] onHooklessQuestionGone threw for ${id.slice(0, 8)} (${reason}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Consume the pending hook record this PTY prompt pairs with (if any) and
   * return the question to push. Shared by `pairAndPush` and the marked branch
   * of `onOrphanPTYPrompt` (#814). Mutates `pending` / `awaitingPTY` before
   * returning, so a re-entrant call cannot re-merge the same record.
   */
  private consumeAndMerge(ptyQuestion: Question): {
    merged: Question;
    hookRecord: Question | undefined;
  } {
    const key = agentKey(ptyQuestion);
    let recordKey: string | undefined = this.pending.has(key) ? key : undefined;
    if (recordKey === undefined && this.pending.size === 1) {
      // Exactly one pending hook and the PTY did not name an agent we have a
      // record for: pairing is unambiguous (one candidate), so attach it.
      recordKey = [...this.pending.keys()][0];
    } else if (recordKey === undefined && this.pending.size > 1) {
      // 2+ pending hooks from DIFFERENT agents and the PTY question matches
      // none: do NOT guess. Pairing the most-recent would attach the wrong
      // agent's command text (#425). Push the bare PTY question instead — its
      // numbered options suffice for the user to answer — and log loudly so the
      // ambiguity is observable rather than a silent misattribution.
      console.warn(
        `[QuestionPresenceTracker] PTY prompt (agent "${key}") matches none of [${[...this.pending.keys()].join(', ')}]; pushing bare to avoid cross-agent misattribution`,
      );
      // The ambiguous hooks are unresolvable for this prompt; drop them so they
      // can't stale-merge onto a later unrelated prompt (recordKey stays
      // undefined here, so the delete below would otherwise skip them).
      this.pending.clear();
      this.awaitingPTY.clear();
    }
    const hookRecord = recordKey !== undefined ? this.pending.get(recordKey) : undefined;
    if (recordKey !== undefined) {
      this.pending.delete(recordKey);
      this.awaitingPTY.delete(recordKey);
    }

    // #1134: a merged card is answered by typing its option value into the
    // PTY, so its options must be the ones the screen numbers, never the
    // hook's. The hook's options are a reconstruction from
    // `permission_suggestions` that Claude Code does not render one-for-one:
    // live, two structured suggestions built a 4-option card over a 3-option
    // dialog, the phone's "No" typed 4, Claude ignored it and Enter confirmed
    // "1. Yes". The pre-#1134 rule (#718: the hook's options win unless they
    // are the Yes/No fallback) is what kept that 4-option card. The hook's
    // options survive only when the parse has none to offer; `handleAnswer`
    // then refuses to type any of them, because none is on screen.
    const useHookOptions = ptyQuestion.options.length === 0;

    const merged: Question =
      hookRecord && hookRecord.options.length > 0
        ? {
            ...ptyQuestion,
            // #887: ADOPT the hook's id instead of the PTY's freshly-parsed one.
            // Identity is minted ONCE, at first sight — hook arrival for a
            // hook-born question, the PTY parse only for a genuinely hook-less
            // one (the `: ptyQuestion` branch below, where no hookRecord exists
            // at all). A prompt that redraws while still pending re-parses under
            // a fresh PTY id every time (#486), but that id is a disposable
            // parse artifact once a hookRecord exists to pair with — it is
            // discarded here, never observed downstream. This is what used to
            // require the gate's `rekeySignatureToRendered`: with the id stable
            // across the hook -> PTY-render hop, `openQuestionSignatures` (keyed
            // by the hook's id at park/escalate time) already matches the id of
            // the card this method is about to push, so there is nothing left
            // to re-key.
            id: hookRecord.id,
            // The hook text carries the tool/command/agent context; the PTY's is
            // the bare terminal prompt. Use the hook's when it has one (#497).
            text: hookRecord.text || ptyQuestion.text,
            options: useHookOptions
              ? [...hookRecord.options]
              : ptyQuestion.options.map(withScreenLabelFlags),
            agentId: ptyQuestion.agentId ?? hookRecord.agentId,
            promptId: hookRecord.promptId ?? ptyQuestion.promptId,
            // #1134 review: whether the prompt takes free text is the TOOL's
            // property, which the hook knows (a permission dialog takes a
            // pick, so false). The parser marks every Claude selection box as
            // free-text capable, and the `...ptyQuestion` spread carried that
            // onto the card, which made `handleAnswer` type free text into
            // the menu, where Claude ignores it and Enter confirms the
            // highlighted option.
            allowsFreeText: hookRecord.allowsFreeText,
            // #888 review finding: the `...ptyQuestion` spread above silently
            // carried `ptyQuestion.source` ('pty', once question-parser sets
            // it -- #920) onto a HOOK-PAIRED merged question, which has a
            // signature-matched removal path (`openQuestionSignatures`) a
            // genuinely hook-less question does not. Left uncorrected, adding
            // `source: 'pty'` to the parser would have mislabeled every
            // hook-paired render as the unresolvable-by-signature cohort,
            // muddying the exact measurement #920's acceptance criterion asks
            // for. The hook's own source is authoritative here, mirroring
            // text/options/agentId above. That source is always
            // 'permission_request' since #890/Q5 deleted the 'notification'
            // synthesis -- the only other value that ever reached this stash.
            source: hookRecord.source ?? ptyQuestion.source,
            // #718 review: `optionsAreFallback` must describe whichever
            // `options` ended up on the merged question, not silently inherit
            // whatever `ptyQuestion` happened to carry from the `...ptyQuestion`
            // spread above (a different, unrelated signal). When the hook's
            // options were kept (the parse had none, #1134), mirror the hook
            // record's own flag (true, or undefined for a real derived set);
            // when the PTY's options won, they are concrete by construction,
            // so this is always false.
            optionsAreFallback: useHookOptions ? hookRecord.optionsAreFallback : false,
            // #626: the PTY base carries none of the structured fields, so a
            // merge must preserve the hook record's AskUserQuestion structure —
            // else a merged card loses questions[].
            // (Dormant while PTY emission is gated off for hooked sessions (#625),
            // but correct for the no-hook fallback + any future re-enable.)
            ...(hookRecord.kind ? { kind: hookRecord.kind } : {}),
            ...(hookRecord.questions ? { questions: hookRecord.questions } : {}),
            ...(hookRecord.submitLabel ? { submitLabel: hookRecord.submitLabel } : {}),
          }
        : // NOTE (#887 review): identity adoption above is gated on
          // `options.length > 0`, so an optionless hook record falls here and
          // the PTY's own id survives. That is DELIBERATE for the
          // `recordPendingHook` path -- `question-presence-tracker.test.ts`
          // asserts `toBe(ptyQ)`, i.e. no merge at all, for the
          // addDirectories-only case hook-event-bridge filters to empty.
          //
          // It is a latent hazard only on the PARKED path, where
          // `openQuestionSignatures` is keyed by the hook id at park time: a
          // future producer emitting an optionless PARKED record would push a
          // card under the PTY id and reintroduce the #808 mismatch, with no
          // `rekeySignatureToRendered` left to catch it. Unreachable today
          // (every producer guarantees at least the honest Yes/No pair).
          //
          // Not fixed here: separating the two paths' merge policy is exactly
          // the "one owner for identity" work in #888, and changing it now
          // would break the deliberate assertion above to defend a case that
          // cannot occur.
          ptyQuestion;

    return { merged, hookRecord };
  }

  /** Push a merged question through the sink. Push errors are caught and
   *  logged but not rethrown — for a live render the next PTY emit for the
   *  same prompt retries WITHOUT the hook merge, which beats crashing on a
   *  network blip. Returns the sink's `QuestionRegistrationOutcome` (#888
   *  criterion iii) so `pairAndPush` can consume it directly as its
   *  confirmed-delivery signal; a thrown push (caught below) or a sink that
   *  reports no outcome both surface as `undefined`, treated identically by
   *  the caller (not confirmed).
   *
   *  `context` (#814) names the caller in the error line. */
  private pushMerged(
    merged: Question,
    context = 'render',
  ): QuestionRegistrationOutcome | undefined {
    try {
      return this.push(merged);
    } catch (err) {
      console.error(
        `[QuestionPresenceTracker] push sink threw (${context}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * PTY parser saw a prompt on screen for a HOOKED session, where the #625
   * gate normally owns every push (cli.ts routes here instead of
   * `onPTYPromptVisible` when a hook server is active). Most PTY renders in a
   * hooked session are an ECHO of something the gate already pushed — its own
   * PermissionRequest escalation, rendered natively once the hook response
   * returns — and re-pushing those is the #625 phantom flood. But some
   * prompts reach ONLY the PTY (#712): Claude's native agent-team permission
   * prompts (no PermissionRequest hook fires for these at all, see
   * anthropics/claude-code #23983), and a prompt re-rendered after its card
   * was already dismissed (registry entry removed). Those must still reach
   * the phone. (MCP elicitation dialogs USED
   * to belong on this list; since #889 the `Elicitation` hook is registered
   * and pushes the card itself, so its PTY render is a gate-owned echo like
   * any other -- suppressed below via the live-question check, not orphaned.)
   *
   * Disambiguation is structural, not content-based: if the gate already owns
   * this prompt cycle, EITHER it has already registered a live question
   * (`hasLiveQuestions`, backed by `sessionRegistry` — a global check, since a
   * gate push registers regardless of which agent it was for) OR THIS SAME
   * AGENT still has a hook record stashed mid-flight (`pending`, scoped by
   * `agentKey` — an unrelated agent's in-flight hook must not swallow a
   * genuine main-screen orphan for the whole window it's pending). If neither
   * is true, nothing else is ever going to push this prompt — it is a genuine
   * orphan.
   *
   * Orphans are not pushed immediately: `armOrphanTimer` arms a short
   * debounce so a residual render flash never reaches the phone, and the
   * debounce fire re-checks ownership (a hook record could have arrived in
   * the window) before pushing through the normal
   * `onPTYPromptVisible` merge/push path.
   */
  onOrphanPTYPrompt(ptyQuestion: Question): void {
    // #814: record what is on screen NOW before any branch below decides to
    // push or suppress, so an answer meant for an earlier prompt can see that
    // it has been superseded (`isPromptCurrent`).
    this.observePTYQuestion(ptyQuestion);
    // #751: a parked subagent escalation, or a main-agent `push-on-render`
    // mark (#1121), whose prompt has now rendered. Merge + push IMMEDIATELY
    // through the pair core — no orphan debounce (hook + render is positive
    // double-confirmation) and no gate-owned / live-question suppression (an
    // unrelated live card must not eat the one prompt class this marking
    // exists to surface).
    const markedKey = this.matchAwaitingPTYKey(ptyQuestion);
    if (markedKey !== undefined) {
      console.debug(
        `[QuestionPresenceTracker] Marked question's prompt rendered (agent "${markedKey}"): "${ptyQuestion.text.slice(0, 60)}"`,
      );
      const onRender = this.awaitingPTY.get(markedKey)?.onRender;
      const { merged } = this.consumeAndMerge(ptyQuestion);
      if (onRender) {
        // #1126: a prompt only the terminal can answer. Its notice, never a
        // card; the gate keeps the prompt open, so its redraws are echoes.
        try {
          onRender(merged);
        } catch (err) {
          console.error(
            `[QuestionPresenceTracker] parked render callback threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
      this.ptyShowingQuestion = true;
      this.pushRenderBorn(merged, ptyQuestion.text);
      return;
    }
    if (this.isGateOwnedCycle(ptyQuestion)) {
      console.debug(
        `[QuestionPresenceTracker] Orphan PTY prompt suppressed (gate owns this cycle): "${ptyQuestion.text.slice(0, 60)}"`,
      );
      return;
    }
    this.armOrphanTimer(ptyQuestion);
  }

  /** True when the permission gate already owns `ptyQuestion`'s prompt
   *  cycle: it holds or relays an open hook-backed prompt (`hookPromptProbe`,
   *  #1126), or it registered a live question SOMEWHERE in the session
   *  (`hasLiveQuestions` — global, a gate push registers regardless of
   *  agent), or THIS agent specifically still has a hook record stashed
   *  mid-flight (`pending`, scoped by `agentKey` — a different agent's
   *  pending record must not suppress this one; that would swallow the
   *  exact main-screen orphan class #712 exists to fix). This is the check
   *  that keeps the #625 phantom flood dead while still letting a genuine
   *  orphan through. `hasLiveQuestions` is an injected dep and MUST be
   *  non-throwing by contract, but a throw is still caught here and treated
   *  as "no live questions" (fail-open: a possibly-redundant push is far
   *  better than crashing the daemon or silently swallowing a real orphan). */
  private isGateOwnedCycle(ptyQuestion: Question): boolean {
    // A parked record (#751) never claims ownership: its push TRIGGER is the
    // PTY render this check would otherwise suppress.
    const key = agentKey(ptyQuestion);
    if (this.pending.has(key) && !this.awaitingPTY.has(key)) return true;
    try {
      // #1126: a hook-backed prompt is open, so this render is it.
      if (this.hookPromptProbe?.() === true) return true;
      return this.deps.hasLiveQuestions?.() ?? false;
    } catch (err) {
      console.error(
        `[QuestionPresenceTracker] hasLiveQuestions() threw: ${err instanceof Error ? err.message : String(err)}; treating as no live questions`,
      );
      return false;
    }
  }

  /** Arm (or replace) the orphan debounce timer with `ptyQuestion` as the
   *  sole candidate to push when it fires. */
  private armOrphanTimer(ptyQuestion: Question): void {
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
    }
    this.armedOrphanQuestion = ptyQuestion;
    const ms = this.deps.orphanDebounceMs ?? DEFAULT_ORPHAN_DEBOUNCE_MS;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      const armed = this.armedOrphanQuestion;
      this.armedOrphanQuestion = null;
      if (armed === null) return;
      // Re-check ownership: the gate could have taken the prompt (registered
      // / stashed a same-agent hook record) during the debounce window.
      if (this.isGateOwnedCycle(armed)) {
        console.debug(
          `[QuestionPresenceTracker] Orphan PTY prompt suppressed at debounce fire (gate took ownership): "${armed.text.slice(0, 60)}"`,
        );
        return;
      }
      // Still orphaned: push through the SAME pair core a non-orphan PTY
      // prompt uses, per spec, rather than a bespoke bare push — that keeps
      // ptyShowingQuestion / pairing semantics identical. A pending record for
      // a DIFFERENT agent (already ruled out as THIS agent's owner above) can
      // still attach via the core's own sole-candidate heuristic (#483); that
      // is pre-existing, general-purpose pairing behavior, not something this
      // fallback adds.
      this.pairAndPush(armed);
    }, ms);
    // Never let an armed 1.5s debounce block a graceful daemon shutdown.
    this.orphanTimer.unref?.();
  }

  /**
   * Status transition observed. When status leaves 'waiting', the user
   * advanced past whatever prompts were up: drop all pending hook records
   * so they cannot push later (Claude is busy executing, the prompts are
   * gone from screen, the iOS cards would be stale).
   */
  onStatusChange(status: AgentStatus): void {
    if (status !== 'waiting') {
      // #763: spare still-fresh PARKED records — the main status pipeline
      // flips on every agent's hook activity, and a teammate's routine
      // PreToolUse must not wipe another agent's parked question before its
      // prompt had a chance to render. Parked entries have their own
      // lifecycle (own-agent advance / render consume / TTL / clearPending);
      // everything else clears exactly as before. A `pushOnRender` mark is
      // not spared: the main agent has no `noteAgentAdvanced` path, so
      // leaving 'waiting' is how its prompt cycle ends, and a stale main
      // record would merge onto the next one.
      const now = this.deps.nowMs?.() ?? Date.now();
      for (const key of [...this.pending.keys()]) {
        const mark = this.awaitingPTY.get(key);
        if (mark?.kind === 'parked-subagent') {
          if (now - mark.at <= PARKED_RECORD_TTL_MS) continue;
          console.debug(
            `[QuestionPresenceTracker] Parked question expired (agent "${key}", TTL ${PARKED_RECORD_TTL_MS}ms elapsed without a render)`,
          );
        } else if (mark?.kind === 'push-on-render') {
          // Error level: this card never reached the phone. Either Claude
          // never showed the dialog, or the PTY parser did not recognize it.
          console.error(
            `[QuestionPresenceTracker] push-on-render record cleared without a render; no card was pushed (agent "${key}"): "${(this.pending.get(key)?.text ?? '').slice(0, 60)}"`,
          );
        }
        this.pending.delete(key);
        this.awaitingPTY.delete(key);
      }
      this.ambiguousRenderKeys.clear();
      this.ptyShowingQuestion = false;
      // #814: nothing is on screen now.
      this.clearObservedPTYQuestion();
      // #888/#920 review fix: deliberately NOT a hook-less resolution trigger.
      // `status` here can come from a PTY-TEXT-parsed guess
      // (`output-processor.ts`, confidence >= 0.5, not certainty) as well as
      // a real hook event, and the tracker cannot tell which -- V1 treated
      // any status-leaves-waiting as "the render is gone" and a false
      // positive could resolve a question that never actually left the
      // screen (found in review of #888). `observedRenderOwnedQuestion` is
      // deliberately left untouched (not even nulled) so a LATER, genuinely
      // CONFIRMED supersession in `pairAndPush` can still resolve it --
      // losing this trigger costs a delayed cleanup, not a wrong one.
      // New prompt cycle starts fresh: an immediate push from the prior cycle
      // must not suppress an identical id in a future one (ids are unique, so
      // this is belt-and-suspenders, but keeps the set bounded). (#573)
      this.pushedHeldIds.clear();
      // #712: the prompt the armed orphan timer was waiting on is gone from
      // screen (Claude advanced past it) — cancel so it cannot fire a stale
      // push after the fact.
      this.cancelOrphanTimer();
    }
  }

  /**
   * Drop all pending hook records without firing a push, and clear the
   * PTY-presence flag. Used on a transcript rotation and on Claude restart
   * (where the dying session's prompts must not lend their identity and text
   * to the new session's first prompt; options never come from a hook record
   * since #1134).
   */
  clearPending(): void {
    this.pending.clear();
    this.awaitingPTY.clear();
    this.ambiguousRenderKeys.clear();
    this.ptyShowingQuestion = false;
    this.clearObservedPTYQuestion();
    // #888/#920 review fix: deliberately NOT a hook-less resolution trigger,
    // for the SAME reason as `onStatusChange` -- see that reset's comment.
    // The real-restart call site (`TranscriptBinder.onRotation` via
    // `hook-bridge-setup.ts`) already resolves every pending question,
    // hook-less or not, through `resolveAndClearQuestions` +
    // `sessionRegistry.clearQuestions` immediately alongside this call.
    this.pushedHeldIds.clear();
    // #712: the prompt was answered in-terminal or the session is rotating —
    // either way an armed orphan timer for it must not fire a stale push.
    this.cancelOrphanTimer();
  }

  /** Match a rendered PTY prompt to a PARKED (#751 awaiting-PTY) record: an
   *  exact agent-key match, or the sole-candidate fallback (exactly one
   *  pending record and it is parked — PTY prompts rarely name their agent,
   *  mirroring `onPTYPromptVisible`'s own pairing heuristic). With 2+ pending
   *  records and no exact match, no guess is made here; the prompt falls to
   *  the normal owned/orphan logic.
   *
   *  ACCEPTED tradeoff (#763 finding 2): the sole-candidate fallback can pair
   *  an unrelated render (e.g. a hook-less agent-team prompt) with the single
   *  parked record, same as the pre-existing #483/#717 pairing heuristic.
   *  Parking's longer lifetime widens the window, but own-agent-advance
   *  expiry (`noteAgentAdvanced`) + the TTL bound it; revisit only if soaks
   *  show real misattribution. */
  private matchAwaitingPTYKey(ptyQuestion: Question): string | undefined {
    const key = agentKey(ptyQuestion);
    if (this.awaitingPTY.has(key) && this.pending.has(key)) return key;
    if (this.pending.size === 1) {
      const sole = [...this.pending.keys()][0] as string;
      if (this.awaitingPTY.has(sole)) return sole;
    }
    return undefined;
  }

  /** Record `ptyQuestion` as what the screen shows now (#814, #1134). Called
   *  on entry to every PTY-render callback, before any push, buffer, suppress
   *  or arbitrate decision, so the observation never depends on who owns the
   *  prompt. */
  private observePTYQuestion(ptyQuestion: Question): void {
    this.observedPTYQuestionId = ptyQuestion.id;
    this.observedPTYText = ptyQuestion.text;
    this.observedPTYOptions = ptyQuestion.options;
  }

  /** Forget the observed prompt: nothing is known to be on screen. */
  private clearObservedPTYQuestion(): void {
    this.observedPTYQuestionId = null;
    this.observedPTYText = null;
    this.observedPTYOptions = null;
  }

  /** Cancel any armed orphan-prompt debounce timer and discard its candidate. */
  private cancelOrphanTimer(): void {
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
    this.armedOrphanQuestion = null;
  }

  /**
   * True when the PTY parser's most recent observation is a prompt that has
   * not been cleared since — "is SOMETHING on screen right now", regardless of
   * who owns it (#1002).
   *
   * Weaker than the `ptyShowingQuestion` flag behind `isPromptCurrent`, and
   * deliberately so. That flag means "THIS tracker pushed a card off a PTY
   * render", which is true for the hookless, orphan and marked-render paths
   * and FALSE for the most common case of all: a gate-owned hook card whose
   * native prompt renders is routed to `onOrphanPTYPrompt`, recognised as an
   * echo of something already pushed, and suppressed without ever setting the
   * flag. Verified by probing this class directly rather than by reading it.
   *
   * `observedPTYQuestionId` has no such gap: `onOrphanPTYPrompt` records it
   * before any branch decides to push or suppress, and both
   * `onStatusChange` (away from `waiting`) and `clearPending` null it. So it
   * answers "is a prompt on screen" for every cohort, which is exactly what a
   * caller about to type a digit into the PTY needs to know, and all it needs
   * to know.
   */
  isPromptObservedOnPTY(): boolean {
    return this.observedPTYQuestionId !== null;
  }

  /**
   * The options of the prompt the PTY parser last observed on screen
   * (#1134), or null when no prompt is observed (same lifetime as
   * `isPromptObservedOnPTY`). An empty array means a prompt is on screen
   * but it is not an option menu (a free-text prompt).
   *
   * This is the screen's numbering, which a card's numbering is not
   * guaranteed to match: a card pushed by id before its render carries the
   * hook's options, and a card registered before the screen changed carries
   * the old ones. The
   * answer path checks every option value it is about to type against this,
   * because Claude ignores a digit its menu does not show and the Enter
   * that follows confirms the highlighted option, usually "1. Yes".
   */
  observedPromptOptions(): readonly QuestionOption[] | null {
    return this.observedPTYQuestionId === null ? null : this.observedPTYOptions;
  }

  /**
   * True when `questionId` is BOTH on screen and still the LATEST prompt this
   * tracker observed (#814). The identity half is what presence alone cannot
   * express, and it is load-bearing before typing an answer into the PTY:
   * with presence alone, an answer meant for a prompt that was since answered
   * in the terminal would be typed into whatever prompt replaced it (the #751
   * wrong-prompt hazard). Used by the answer path's #920 guard for
   * `source: 'pty'` cards.
   *
   * `ptyText` matters because a prompt that merely REDRAWS re-emits under a
   * fresh id (#486) — matching on the id alone would call a prompt still
   * sitting on screen "gone" and silently drop its card. Either half matching
   * means the same prompt cycle; see `observedPTYText` for the one collapse
   * this accepts.
   */
  isPromptCurrent(questionId: string, ptyText?: string): boolean {
    if (!this.ptyShowingQuestion) return false;
    if (this.observedPTYQuestionId === questionId) return true;
    return ptyText !== undefined && this.observedPTYText === ptyText;
  }

  /**
   * Test-only inspection of pending state. Exposed so the unit test suite
   * can assert state-machine invariants without mocking the push sink.
   */
  hasPendingForTest(): boolean {
    return this.pending.size > 0;
  }

  /** Test-only: number of distinct agents with a pending hook record. */
  pendingCountForTest(): number {
    return this.pending.size;
  }

  /** Test-only: number of pending records marked to push on their PTY render (#751, #1121). */
  awaitingPTYCountForTest(): number {
    return this.awaitingPTY.size;
  }

  /** Test-only: whether an orphan-prompt debounce timer is currently armed. */
  hasArmedOrphanTimerForTest(): boolean {
    return this.orphanTimer !== null;
  }

  /** Test-only: the id of the currently-tracked hook-less question, if any
   *  (#888/#920), or null when none is tracked. */
  observedRenderOwnedQuestionForTest(): string | null {
    return this.observedRenderOwnedQuestion?.id ?? null;
  }
}
