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
 *     trigger a push by themselves. Auto-approve still injects in parallel;
 *     this tracker only governs the iOS notification path.
 *   - PTY (`onPTYPromptVisible`) is the truth signal: a prompt is on the
 *     user's terminal RIGHT NOW. Push immediately, merging hook metadata
 *     if a pending hook record matches (real option labels, agent_id, etc.).
 *   - Status transitions OUT of `'waiting'` (`onStatusChange`) clear any
 *     pending hook records. The user advanced past the prompt — auto-
 *     approve handled it silently, or the subagent stayed in the
 *     background, or the user answered in-terminal. No push needed.
 *
 * Pending hook records are keyed by agent (`agentId` or `'main'`), so two
 * concurrent agents (main + a subagent, #419) keep separate records and a
 * later subagent hook cannot clobber the main agent's option labels (#425).
 *
 * Upstream context (anthropics/claude-code #23983): subagent / Agent-Teams
 * permission requests do not fire PermissionRequest hooks at all. The PTY
 * is the only source for those. A PTY-only push path (no preceding hook
 * record) is therefore a first-class case here, not a fallback.
 */

import { MAIN_AGENT_ID } from '@remi/shared';
import type { AgentStatus, Question } from '@remi/shared';

export interface PushOptions {
  /**
   * This is a HELD escalation (Model B, #573). Its card is LOAD-BEARING — it
   * registers the question that makes the held hook answerable — not a cosmetic
   * PTY/hook echo. So it must BYPASS the content-dedup and deliver to the lock
   * screen even when a client is attached (it may be backgrounded). #603 Phase 3.
   */
  held?: boolean;
}

/**
 * Callable sink: the tracker's only output. Called when a push to iOS
 * should fire. Implementations forward to `MessageAPI.handleQuestion`,
 * which applies the content-identity QuestionDedup before the network
 * layer — unless `opts.held` marks the load-bearing held-hook card.
 */
export type PushQuestion = (question: Question, opts?: PushOptions) => void;

/** Pending-hook map key: the prompt's agent, or MAIN_AGENT_ID for the primary. */
function agentKey(question: Question): string {
  return question.agentId ?? MAIN_AGENT_ID;
}

/** Debounce (ms) before an orphan PTY prompt (#712: no pending hook record,
 *  no live registered question) is pushed. Guards a residual render flash —
 *  a prompt painted mid-redraw that is gone a moment later (status leaves
 *  'waiting', or `clearPending` fires, before the timer) — without holding a
 *  genuine orphan (agent-team permission, MCP elicitation dialog, a
 *  passthrough re-render after a held hook's card was already dismissed)
 *  long enough to matter to the user. */
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
}

export class QuestionPresenceTracker {
  /** Hook-derived questions not yet paired with PTY confirmation or cleared,
   *  keyed by agent. At most one per agent: a second hook for the SAME agent
   *  (e.g. PermissionRequest then Notification for one prompt) replaces the
   *  first, but different agents keep separate entries. A PTY prompt pairs with
   *  the same-agent entry, or (only when exactly one entry exists) the sole
   *  candidate; with 2+ different-agent entries it pushes bare (no guessing). */
  private pending = new Map<string, Question>();

  /** Keys of `pending` records PARKED by the gate awaiting PTY arbitration
   *  (#751), mapped to the epoch-ms they were parked. Unlike a normal pending
   *  record (an in-flight gate escalation whose own push is imminent), a
   *  parked record must NOT count as gate-owned in the #712 orphan check —
   *  the PTY render IS its push trigger — and it must SURVIVE the unscoped
   *  status-change clear (#763): in an agent-team session every other
   *  agent's hook activity flips status constantly, and wiping a still-live
   *  parked record loses the merged push (or the whole prompt, when an
   *  unrelated live question makes `hasLiveQuestions` suppress the orphan).
   *  A parked entry expires when its OWN agent advances
   *  (`noteAgentAdvanced` — the permission was allowlist-absorbed or
   *  answered), on consume (render pairing), on `clearPending`
   *  (restart/rotation), or after `PARKED_RECORD_TTL_MS`. Always a subset of
   *  `pending`'s keys; every `pending` delete/clear site mirrors onto this
   *  map. */
  private awaitingPTY = new Map<string, number>();

  /** True while a permission prompt is on the main PTY. Set by
   *  `onPTYPromptVisible`; reset by `onStatusChange` out of `'waiting'`
   *  AND by `clearPending` (the auto-approve cancelled branch confirms
   *  Claude advanced past the prompt without a status transition we can
   *  observe). Consumed by the auto-approve inject path to gate subagent
   *  injection: a background subagent's permission prompt never renders
   *  on the main PTY, so this flag stays false and the inject is
   *  dropped instead of typing into the main agent's input. */
  private ptyShowingQuestion = false;

  /** Count of MAIN-context auto-approve evals in flight. A PTY prompt that
   *  appears while this is > 0 is BUFFERED (not pushed): if the verdict is
   *  approve/deny/pick the prompt is auto-handled and must never reach the
   *  user; only an escalate verdict releases the buffered prompt. This is the
   *  fix for "every auto-approved permission still pushed APNS" (#484) — and it
   *  must buffer (not suppress-and-replay) because the rising-edge PTY emit
   *  (#486) fires only once, so a suppressed prompt would never re-emit.
   *
   *  SUBAGENT evals never open this window (#767): a held subagent hook blocks
   *  only that subagent, so a render arriving during its eval is some OTHER
   *  prompt (an agent-team teammate permission, an MCP dialog, a #751 parked
   *  render) — buffering it pairs the render with an unrelated verdict, and
   *  the next unrelated approve discards a real question. On sessions with a
   *  continuous subagent eval stream that ate every orphan render. A COUNTER
   *  (not the old boolean) because concurrent evals exist; the first verdict
   *  must not close a window another main eval still owns. */
  private mainEvalsInFlight = 0;
  /** The PTY prompt held while an auto-approve eval is in flight. Released by
   *  `onAutoApproveEscalate` (verdict = escalate), discarded by the
   *  status/clearPending resets (verdict = handled, or the prompt is gone). */
  private bufferedDuringEval: Question | null = null;

  /** Question ids already pushed via `pushHeldHook` (#573). A binary escalation
   *  that HOLDS its PermissionRequest hook (Model B, #573) never lets Claude
   *  render the native prompt, so `onPTYPromptVisible` cannot be the push
   *  trigger; the gate pushes the held question immediately and idempotently
   *  through here instead. Membership makes a repeat `pushHeldHook` for the same
   *  id a no-op, and guards the (rare) hold-timeout fail-open case where the PTY
   *  finally renders and would otherwise re-push the same prompt. Cleared on any
   *  reset (status-out-of-waiting / clearPending) so a new prompt cycle starts
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

  constructor(
    private readonly push: PushQuestion,
    private readonly deps: QuestionPresenceTrackerDeps = {},
  ) {}

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
   * PermissionRequest carries the tool + command + real option labels ("Allow
   * Bash: git push", Edit's Yes/Always/No), while the Notification is the bland
   * "Claude needs your permission to use Bash" with the hardcoded 3-set.
   * Letting the trailing notification win is exactly what garbled the push
   * text/options (issues 3+4). A same-agent source-less question (e.g. a
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
    // Re-insert so this agent's entry is the most recent (matters for the
    // PTY-pairing fallback below).
    this.pending.delete(key);
    this.pending.set(key, question);
    // A normal (gate-owned) record replaces any parked one for this agent;
    // parkAwaitingPTY re-adds the flag after routing through here (#751).
    this.awaitingPTY.delete(key);
  }

  /**
   * Park a subagent-tagged permission question awaiting PTY arbitration
   * (#751). The gate answered the hook 'passthrough' (no hold, no deny, no
   * push): Claude runs its normal permission flow, so either the session
   * allowlist absorbs the request silently (the record then expires on the
   * next status transition, like any pending record) or the native prompt
   * renders on the main PTY — `onOrphanPTYPrompt` recognizes the parked
   * record, merges its rich labels onto the parsed prompt, and pushes
   * immediately (no orphan debounce: hook + render is positive
   * double-confirmation). The PTY is the arbiter of whether the user is
   * asked.
   */
  parkAwaitingPTY(question: Question): void {
    this.recordPendingHook(question);
    // recordPendingHook may have kept a richer existing record instead of
    // this one; the parked flag applies to whatever record now owns the key
    // (both are hook-derived for the same agent's prompt cycle).
    this.awaitingPTY.set(agentKey(question), this.deps.nowMs?.() ?? Date.now());
    console.debug(
      `[QuestionPresenceTracker] Parked question awaiting PTY render (agent "${agentKey(question)}"): "${question.text.slice(0, 60)}"`,
    );
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
   * Push a held escalation's question IMMEDIATELY, without waiting for a PTY
   * render (#573). A binary escalation that HOLDS its PermissionRequest hook
   * (Model B, #573) blocks Claude's hook response, so Claude never renders the
   * native numbered prompt and `onPTYPromptVisible` never fires — meaning the
   * normal push trigger never runs and the question is never registered in
   * `sessionRegistry` nor pushed to the phone, leaving it UNANSWERABLE. The gate
   * decided the user MUST answer, so the PTY-presence gate (which exists only to
   * avoid pushing a silently auto-approved permission that never rendered) does
   * not apply: push now, under the SAME `questionId` the hold is keyed by.
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
   * record for option labels / agent_id: prefer the same-agent entry, else the
   * sole pending hook when exactly one exists (unambiguous). With 2+ pending
   * hooks from different agents and no agent match, push bare to avoid
   * misattributing another agent's labels (#425 / #483). When paired, the hook
   * contributes `options`, `agentId` (so the client keys the prompt to the right
   * agent), AND `text` — the hook's text carries the tool + command + agent
   * context (e.g. "code-reviewer · Bash: git push origin main"), whereas the
   * PTY's literal screen text is the bare terminal prompt ("Do you want to
   * proceed?"). The PTY contributes `id` / `allowsFreeText` / `isAnswered` and
   * its presence is the push trigger (#497). The consumed hook entry is removed.
   *
   * Options exception (#718): when the hook record's options are the daemon's
   * honest Yes/No FALLBACK (`hookRecord.optionsAreFallback`, set when
   * `permission_suggestions` had no usable entry) AND the PTY question has its
   * own non-empty options, the PTY's options win instead — the PTY parsed the
   * ACTUAL rendered prompt, so its options are strictly more trustworthy than
   * a bare substitute. Text/agentId/kind/questions/submitLabel/summary still
   * prefer the hook record as before; only the options selection changes.
   *
   * Pending is mutated BEFORE the push so a re-entrant call cannot re-merge
   * the same record. Push errors are caught and logged but not rethrown — the
   * next PTY emit for the same prompt retries WITHOUT the hook merge (PTY's
   * numbered options), which beats crashing on a network blip during APNS.
   */
  onPTYPromptVisible(ptyQuestion: Question): void {
    if (this.mainEvalsInFlight > 0) {
      // A MAIN permission eval owns this prompt: buffer it, do not push yet.
      // The verdict decides — onAutoApproveEscalate releases it; a status-
      // leaves-waiting / clearPending reset (auto-handled, or prompt gone)
      // discards it.
      //
      // Near-dormant under synchronous MAIN decisions (#496): Claude BLOCKS on
      // the hook response and does not render that permission's prompt during
      // the eval — the #484 APNS-flood guard for any async/parallel eval path.
      // Scoped to MAIN evals only (#767): a subagent eval blocks only its own
      // subagent, so renders arriving during one are other prompts entirely
      // and must flow, not buffer.
      console.debug(
        `[QuestionPresenceTracker] Buffering PTY prompt during main eval: "${ptyQuestion.text.slice(0, 60)}"`,
      );
      this.bufferedDuringEval = ptyQuestion;
      return;
    }
    this.pairAndPush(ptyQuestion);
  }

  /**
   * Pair-and-push core shared by every push trigger (#767): the buffer-window
   * check lives only in `onPTYPromptVisible`; the #751 parked-render path and
   * the escalate-release path call this directly so an in-flight eval cannot
   * re-capture a prompt that has already won its arbitration.
   */
  private pairAndPush(ptyQuestion: Question): void {
    const key = agentKey(ptyQuestion);
    let recordKey: string | undefined = this.pending.has(key) ? key : undefined;
    if (recordKey === undefined && this.pending.size === 1) {
      // Exactly one pending hook and the PTY did not name an agent we have a
      // record for: pairing is unambiguous (one candidate), so attach it.
      recordKey = [...this.pending.keys()][0];
    } else if (recordKey === undefined && this.pending.size > 1) {
      // 2+ pending hooks from DIFFERENT agents and the PTY question matches
      // none: do NOT guess. Pairing the most-recent would attach the wrong
      // agent's option labels (#425). Push the bare PTY question instead — its
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

    // #718: a fallback hook record must not overwrite the PTY's own options
    // when it has some — the PTY parsed the actual rendered prompt.
    const useHookOptions = !hookRecord?.optionsAreFallback || ptyQuestion.options.length === 0;

    const merged: Question =
      hookRecord && hookRecord.options.length > 0
        ? {
            ...ptyQuestion,
            // The hook text carries the tool/command/agent context; the PTY's is
            // the bare terminal prompt. Use the hook's when it has one (#497).
            text: hookRecord.text || ptyQuestion.text,
            options: useHookOptions ? [...hookRecord.options] : [...ptyQuestion.options],
            agentId: ptyQuestion.agentId ?? hookRecord.agentId,
            // #718 review: `optionsAreFallback` must describe whichever
            // `options` ended up on the merged question, not silently inherit
            // whatever `ptyQuestion` happened to carry from the `...ptyQuestion`
            // spread above (a different, unrelated signal). When the hook's
            // options won, mirror the hook record's own flag (true, or
            // undefined for a real derived set); when the PTY's options won,
            // they are concrete by construction, so this is always false.
            optionsAreFallback: useHookOptions ? hookRecord.optionsAreFallback : false,
            // #626/#628: the PTY base carries none of the structured fields, so a
            // merge must preserve the hook record's AskUserQuestion structure +
            // lock-screen summary — else a merged card loses questions[]/summary.
            // (Dormant while PTY emission is gated off for hooked sessions (#625),
            // but correct for the no-hook fallback + any future re-enable.)
            ...(hookRecord.kind ? { kind: hookRecord.kind } : {}),
            ...(hookRecord.questions ? { questions: hookRecord.questions } : {}),
            ...(hookRecord.submitLabel ? { submitLabel: hookRecord.submitLabel } : {}),
            ...(hookRecord.summary ? { summary: hookRecord.summary } : {}),
          }
        : ptyQuestion;

    this.ptyShowingQuestion = true;
    try {
      this.push(merged);
    } catch (err) {
      console.error(
        `[QuestionPresenceTracker] push sink threw: ${err instanceof Error ? err.message : String(err)}`,
      );
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
   * anthropics/claude-code #23983), a prompt re-rendered as passthrough after
   * a held hook was released (its card already dismissed, registry entry
   * removed), and MCP elicitation dialogs. Those must still reach the phone.
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
   * debounce fire re-checks ownership (an eval or a hook record could have
   * started in the window) before pushing through the normal
   * `onPTYPromptVisible` merge/push path.
   */
  onOrphanPTYPrompt(ptyQuestion: Question): void {
    // #751 PTY-arbiter: a parked subagent escalation whose prompt has now
    // rendered. Merge + push IMMEDIATELY through the pair core — no orphan
    // debounce (hook + render is positive double-confirmation), no gate-owned
    // / live-question suppression (an unrelated live card must not eat the one
    // prompt class this parking exists to surface), and CHECKED BEFORE the
    // eval buffer (#767): the parked record's own eval already settled, so an
    // in-flight eval here is some other agent's and must not capture — let
    // alone discard — a prompt that already won its arbitration.
    const parkedKey = this.matchAwaitingPTYKey(ptyQuestion);
    if (parkedKey !== undefined) {
      console.debug(
        `[QuestionPresenceTracker] Parked question's prompt rendered; pushing (agent "${parkedKey}"): "${ptyQuestion.text.slice(0, 60)}"`,
      );
      this.pairAndPush(ptyQuestion);
      return;
    }
    if (this.mainEvalsInFlight > 0) {
      // Same #484 semantics as onPTYPromptVisible: a MAIN eval owns this
      // prompt cycle; only its own escalate verdict may release it. Subagent
      // evals never open this window (#767).
      console.debug(
        `[QuestionPresenceTracker] Buffering orphan PTY prompt during main eval: "${ptyQuestion.text.slice(0, 60)}"`,
      );
      this.bufferedDuringEval = ptyQuestion;
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

  /** True when the auto-approve gate already owns `ptyQuestion`'s prompt
   *  cycle: either it registered a live question SOMEWHERE in the session
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
      // Re-check ownership: a main eval could have started, or the gate could
      // have taken the prompt (registered / stashed a same-agent hook
      // record), during the debounce window.
      if (this.mainEvalsInFlight > 0) {
        console.debug(
          `[QuestionPresenceTracker] Buffering orphan PTY prompt at debounce fire (main eval started): "${armed.text.slice(0, 60)}"`,
        );
        this.bufferedDuringEval = armed;
        return;
      }
      if (this.isGateOwnedCycle(armed)) {
        console.debug(
          `[QuestionPresenceTracker] Orphan PTY prompt suppressed at debounce fire (gate took ownership): "${armed.text.slice(0, 60)}"`,
        );
        return;
      }
      // Still orphaned: push through the SAME pair core a non-orphan PTY
      // prompt uses, per spec, rather than a bespoke bare push — that keeps
      // ptyShowingQuestion / pairing semantics identical (the buffer re-check
      // just ran above, so the core is called directly). A pending record for
      // a DIFFERENT agent (already ruled out as THIS agent's owner above) can
      // still attach via the core's own sole-candidate heuristic (#483); that
      // is pre-existing, general-purpose pairing behavior, not something this
      // fallback adds.
      this.pairAndPush(armed);
    }, ms);
    // Never let an armed 1.5s debounce block a graceful daemon shutdown
    // (mirrors the sibling hold/delivery timers in auto-approve-gate.ts).
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
      // everything else clears exactly as before.
      const now = this.deps.nowMs?.() ?? Date.now();
      for (const key of [...this.pending.keys()]) {
        const parkedAt = this.awaitingPTY.get(key);
        if (parkedAt !== undefined && now - parkedAt <= PARKED_RECORD_TTL_MS) continue;
        if (parkedAt !== undefined) {
          console.debug(
            `[QuestionPresenceTracker] Parked question expired (agent "${key}", TTL ${PARKED_RECORD_TTL_MS}ms elapsed without a render)`,
          );
        }
        this.pending.delete(key);
        this.awaitingPTY.delete(key);
      }
      this.ptyShowingQuestion = false;
      // The verdict window is over: any buffered prompt was auto-handled (the
      // agent advanced) or left the screen. Discard it — do not ping the user.
      this.mainEvalsInFlight = 0;
      this.bufferedDuringEval = null;
      // New prompt cycle starts fresh: a held push from the prior cycle must not
      // suppress an identical id in a future one (ids are unique, so this is
      // belt-and-suspenders, but keeps the set bounded). (#573)
      this.pushedHeldIds.clear();
      // #712: the prompt the armed orphan timer was waiting on is gone from
      // screen (Claude advanced past it) — cancel so it cannot fire a stale
      // push after the fact.
      this.cancelOrphanTimer();
    }
  }

  /**
   * An auto-approve LLM eval has STARTED for a permission. Until a MAIN-context
   * eval resolves, a PTY prompt is buffered, not pushed (so a silently
   * auto-approved permission never reaches the user). Paired with
   * `onAutoApproveEscalate` (release) and the status/clearPending resets
   * (discard). A SUBAGENT eval (#767) never opens the buffer window: its held
   * hook blocks only that subagent, so it cannot be the prompt now rendering —
   * see `mainEvalsInFlight`.
   */
  onAutoApproveStart(isSubagent = false): void {
    if (isSubagent) return;
    this.mainEvalsInFlight += 1;
  }

  /**
   * The auto-approve verdict was ESCALATE: the user must answer. End the buffer
   * window and release the held PTY prompt (re-running the pair+push core,
   * which now finds the hook record the escalation just stashed — NOT the
   * buffer-checking entry point, since a sibling main eval may still be in
   * flight and the escalate verdict owns the release). If no prompt was
   * buffered yet, the next `onPTYPromptVisible` pushes normally. A subagent
   * verdict (#767, the #751 park path) never opened the window, so it must not
   * release or discard another eval's buffered prompt.
   */
  onAutoApproveEscalate(isSubagent = false): void {
    if (isSubagent) return;
    this.mainEvalsInFlight = Math.max(0, this.mainEvalsInFlight - 1);
    const buffered = this.bufferedDuringEval;
    this.bufferedDuringEval = null;
    if (buffered !== null) {
      this.pairAndPush(buffered);
    }
  }

  /**
   * The auto-approve verdict was HANDLED automatically (approve/deny/pick
   * injected): the user must NOT see this prompt. Close the buffer window and
   * discard any buffered prompt. Surgical (does not touch pending hook records
   * of OTHER agents). EVERY main `onAutoApproveStart` must be matched by
   * exactly one of escalate / handled / a status-or-clear reset, or the buffer
   * would stick open and silently drop later prompts. A subagent verdict
   * (#767) is a no-op here: discarding on it was exactly how an unrelated
   * subagent approve destroyed a buffered teammate/parked prompt.
   */
  onAutoApproveHandled(isSubagent = false): void {
    if (isSubagent) return;
    this.mainEvalsInFlight = Math.max(0, this.mainEvalsInFlight - 1);
    if (this.bufferedDuringEval !== null) {
      console.debug(
        `[QuestionPresenceTracker] Discarding buffered PTY prompt (main eval auto-handled): "${this.bufferedDuringEval.text.slice(0, 60)}"`,
      );
    }
    this.bufferedDuringEval = null;
  }

  /**
   * Drop all pending hook records without firing a push, and clear the
   * PTY-presence flag. Used by the auto-approve cancelled branch and on
   * Claude restart (where the dying session's prompts must not merge stale
   * labels onto the new session's first prompt).
   */
  clearPending(): void {
    this.pending.clear();
    this.awaitingPTY.clear();
    this.ptyShowingQuestion = false;
    this.mainEvalsInFlight = 0;
    this.bufferedDuringEval = null;
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

  /** Cancel any armed orphan-prompt debounce timer and discard its candidate. */
  private cancelOrphanTimer(): void {
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
    this.armedOrphanQuestion = null;
  }

  /**
   * True when `onPTYPromptVisible` has fired and neither a non-`waiting`
   * status transition nor `clearPending` has cleared it since. Auto-
   * approve consumers MUST NOT inject PTY input for a subagent unless
   * this returns true — a background subagent emits hooks but its
   * prompt never reaches the main PTY, and injecting would type into
   * the parent agent's input.
   */
  isPromptVisibleOnPTY(): boolean {
    return this.ptyShowingQuestion;
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

  /** Test-only: number of pending records parked awaiting PTY arbitration (#751). */
  awaitingPTYCountForTest(): number {
    return this.awaitingPTY.size;
  }

  /** Test-only: whether an orphan-prompt debounce timer is currently armed. */
  hasArmedOrphanTimerForTest(): boolean {
    return this.orphanTimer !== null;
  }
}
