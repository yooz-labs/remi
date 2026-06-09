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

/**
 * Callable sink: the tracker's only output. Called when a push to iOS
 * should fire. Implementations forward to `MessageAPI.handleQuestion`,
 * which applies the content-identity QuestionDedup before the network
 * layer.
 */
export type PushQuestion = (question: Question) => void;

/** Pending-hook map key: the prompt's agent, or MAIN_AGENT_ID for the primary. */
function agentKey(question: Question): string {
  return question.agentId ?? MAIN_AGENT_ID;
}

export class QuestionPresenceTracker {
  /** Hook-derived questions not yet paired with PTY confirmation or cleared,
   *  keyed by agent. At most one per agent: a second hook for the SAME agent
   *  (e.g. PermissionRequest then Notification for one prompt) replaces the
   *  first, but different agents keep separate entries. A PTY prompt pairs with
   *  the same-agent entry, or (only when exactly one entry exists) the sole
   *  candidate; with 2+ different-agent entries it pushes bare (no guessing). */
  private pending = new Map<string, Question>();

  /** True while a permission prompt is on the main PTY. Set by
   *  `onPTYPromptVisible`; reset by `onStatusChange` out of `'waiting'`
   *  AND by `clearPending` (the auto-approve cancelled branch confirms
   *  Claude advanced past the prompt without a status transition we can
   *  observe). Consumed by the auto-approve inject path to gate subagent
   *  injection: a background subagent's permission prompt never renders
   *  on the main PTY, so this flag stays false and the inject is
   *  dropped instead of typing into the main agent's input. */
  private ptyShowingQuestion = false;

  /** True while the auto-approve LLM is deciding a permission. A PTY prompt
   *  that appears during this window is BUFFERED (not pushed): if the verdict
   *  is approve/deny/pick the prompt is auto-handled and must never reach the
   *  user; only an escalate verdict releases the buffered prompt. This is the
   *  fix for "every auto-approved permission still pushed APNS" (#484) — and it
   *  must buffer (not suppress-and-replay) because the rising-edge PTY emit
   *  (#486) fires only once, so a suppressed prompt would never re-emit. */
  private autoApproveInFlight = false;
  /** The PTY prompt held while an auto-approve eval is in flight. Released by
   *  `onAutoApproveEscalate` (verdict = escalate), discarded by the
   *  status/clearPending resets (verdict = handled, or the prompt is gone). */
  private bufferedDuringEval: Question | null = null;

  constructor(private readonly push: PushQuestion) {}

  /**
   * Hook fired (PermissionRequest or Notification(permission_prompt)).
   * Stash the question by agent; do NOT push yet. Push happens when PTY
   * confirms the prompt is visible, or never if status moves past 'waiting'
   * first.
   *
   * Replacement policy: per agent, the newer hook wins (correct for the
   * same-prompt double-fire: PermissionRequest then Notification). Different
   * agents no longer overwrite each other (#425).
   */
  recordPendingHook(question: Question): void {
    const key = agentKey(question);
    if (this.pending.has(key)) {
      console.debug(
        `[QuestionPresenceTracker] Replacing pending hook for agent "${key}" (old="${this.pending.get(key)?.text.slice(0, 50)}", new="${question.text.slice(0, 50)}")`,
      );
    }
    // Re-insert so this agent's entry is the most recent (matters for the
    // PTY-pairing fallback below).
    this.pending.delete(key);
    this.pending.set(key, question);
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
   * Pending is mutated BEFORE the push so a re-entrant call cannot re-merge
   * the same record. Push errors are caught and logged but not rethrown — the
   * next PTY emit for the same prompt retries WITHOUT the hook merge (PTY's
   * numbered options), which beats crashing on a network blip during APNS.
   */
  onPTYPromptVisible(ptyQuestion: Question): void {
    if (this.autoApproveInFlight) {
      // A permission eval owns this prompt: buffer it, do not push yet. The
      // verdict decides — onAutoApproveEscalate releases it; a status-leaves-
      // waiting / clearPending reset (auto-handled, or prompt gone) discards it.
      this.bufferedDuringEval = ptyQuestion;
      return;
    }
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
    }
    const hookRecord = recordKey !== undefined ? this.pending.get(recordKey) : undefined;
    if (recordKey !== undefined) {
      this.pending.delete(recordKey);
    }

    const merged: Question =
      hookRecord && hookRecord.options.length > 0
        ? {
            ...ptyQuestion,
            // The hook text carries the tool/command/agent context; the PTY's is
            // the bare terminal prompt. Use the hook's when it has one (#497).
            text: hookRecord.text || ptyQuestion.text,
            options: [...hookRecord.options],
            agentId: ptyQuestion.agentId ?? hookRecord.agentId,
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
   * Status transition observed. When status leaves 'waiting', the user
   * advanced past whatever prompts were up: drop all pending hook records
   * so they cannot push later (Claude is busy executing, the prompts are
   * gone from screen, the iOS cards would be stale).
   */
  onStatusChange(status: AgentStatus): void {
    if (status !== 'waiting') {
      this.pending.clear();
      this.ptyShowingQuestion = false;
      // The verdict window is over: any buffered prompt was auto-handled (the
      // agent advanced) or left the screen. Discard it — do not ping the user.
      this.autoApproveInFlight = false;
      this.bufferedDuringEval = null;
    }
  }

  /**
   * An auto-approve LLM eval has STARTED for a permission. Until it resolves,
   * a PTY prompt for it is buffered, not pushed (so a silently auto-approved
   * permission never reaches the user). Paired with `onAutoApproveEscalate`
   * (release) and the status/clearPending resets (discard).
   */
  onAutoApproveStart(): void {
    this.autoApproveInFlight = true;
  }

  /**
   * The auto-approve verdict was ESCALATE: the user must answer. End the buffer
   * window and release the held PTY prompt (re-running the normal pair+push
   * path, which now finds the hook record the escalation just stashed). If no
   * prompt was buffered yet, the next `onPTYPromptVisible` pushes normally.
   */
  onAutoApproveEscalate(): void {
    this.autoApproveInFlight = false;
    const buffered = this.bufferedDuringEval;
    this.bufferedDuringEval = null;
    if (buffered !== null) {
      this.onPTYPromptVisible(buffered);
    }
  }

  /**
   * The auto-approve verdict was HANDLED automatically (approve/deny/pick
   * injected, or a subagent default-deny): the user must NOT see this prompt.
   * Close the buffer window and discard any buffered prompt. Surgical (does not
   * touch pending hook records of OTHER agents). EVERY `onAutoApproveStart` must
   * be matched by exactly one of escalate / handled / a status-or-clear reset,
   * or the buffer would stick true and silently drop later prompts.
   */
  onAutoApproveHandled(): void {
    this.autoApproveInFlight = false;
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
    this.ptyShowingQuestion = false;
    this.autoApproveInFlight = false;
    this.bufferedDuringEval = null;
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
}
