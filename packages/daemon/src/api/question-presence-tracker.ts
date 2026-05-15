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
 *     pending hook record. The user advanced past the prompt — auto-
 *     approve handled it silently, or the subagent stayed in the
 *     background, or the user answered in-terminal. No push needed.
 *
 * Upstream context (anthropics/claude-code #23983): subagent / Agent-Teams
 * permission requests do not fire PermissionRequest hooks at all. The PTY
 * is the only source for those. A PTY-only push path (no preceding hook
 * record) is therefore a first-class case here, not a fallback.
 */

import type { AgentStatus, Question } from '@remi/shared';

/**
 * Callable sink: the tracker's only output. Called when a push to iOS
 * should fire. Implementations forward to `MessageAPI.handleQuestion`,
 * which applies the content-identity QuestionDedup before the network
 * layer.
 */
export type PushQuestion = (question: Question) => void;

export class QuestionPresenceTracker {
  /** The last hook-derived question we have not yet paired with PTY
   *  confirmation or cleared via status. At most one is held at a time:
   *  if a second hook arrives before the first paired/cleared, the newer
   *  one wins — Claude only renders one prompt on screen at a time, and
   *  the second hook is the more accurate description of the prompt the
   *  user will see. */
  private pending: Question | null = null;

  /** True between the most recent `onPTYPromptVisible` and the next
   *  `onStatusChange` that leaves `'waiting'`. Consumed by the
   *  auto-approve inject path to gate subagent injection: a background
   *  subagent's permission prompt never renders on the main PTY, so
   *  this flag stays false and the inject is dropped instead of
   *  typing into the main agent's input. */
  private ptyShowingQuestion = false;

  constructor(private readonly push: PushQuestion) {}

  /**
   * Hook fired (PermissionRequest or Notification(permission_prompt)).
   * Stash the question; do NOT push yet. Push happens when PTY confirms
   * the prompt is visible, or never if status moves past 'waiting' first.
   *
   * Replacement policy: the newer hook wins. This is correct for the
   * same-prompt double-fire case (PermissionRequest then Notification
   * for the same prompt) but is a known weak spot for concurrent
   * subagents (phase 4, #419) — if two different agents have prompts
   * in flight, the second silently overwrites the first. The PTY
   * presence gate still prevents the wrong push from firing for an
   * off-screen agent; what is lost is option-label accuracy when the
   * on-screen agent's hook arrived earlier. An agent_id-aware tracker
   * would fix this structurally; tracked as a follow-up.
   */
  recordPendingHook(question: Question): void {
    if (this.pending !== null) {
      console.debug(
        `[QuestionPresenceTracker] Overwriting pending hook (old="${this.pending.text.slice(0, 60)}", new="${question.text.slice(0, 60)}")`,
      );
    }
    this.pending = question;
  }

  /**
   * PTY parser saw a prompt on screen. Push immediately. If we have a
   * recent hook record, merge: PTY contributes `id` / `text` /
   * `allowsFreeText` / `isAnswered` (it reflects the screen) and the
   * hook contributes `options` (it knows real labels like
   * ['Yes', 'Always', 'No'] while PTY usually has numbered fallbacks).
   *
   * When the merge fires, `ptyQuestion.options` is intentionally
   * discarded — the hook record is the authoritative source for option
   * labels. A future PTY-side options parser would not change this
   * unless we promote PTY options past the hook (see merge rule).
   *
   * Pending is cleared BEFORE the push so a re-entrant call to this
   * method (push sink fires synchronous side effects that loop back
   * here) cannot re-merge the same hook record. Push errors are caught
   * and logged but not rethrown — the next PTY emit for the same prompt
   * (re-render) will retry the push WITHOUT the hook merge, falling
   * back to PTY's numbered options. That degraded UX is still preferable
   * to the daemon crashing on a network blip during APNS fan-out.
   */
  onPTYPromptVisible(ptyQuestion: Question): void {
    const merged: Question =
      this.pending && this.pending.options.length > 0
        ? { ...ptyQuestion, options: [...this.pending.options] }
        : ptyQuestion;
    this.pending = null;
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
   * advanced past whatever prompt was up: drop any pending hook record
   * so it cannot push later (Claude is busy executing, the prompt is
   * gone from screen, the iOS card would be stale).
   */
  onStatusChange(status: AgentStatus): void {
    if (status !== 'waiting') {
      this.pending = null;
      this.ptyShowingQuestion = false;
    }
  }

  /**
   * Drop any pending hook record without firing a push. Used by the
   * auto-approve cancelled branch where Claude has advanced past the
   * prompt without a status transition we can observe — leaving the
   * pending in place would merge stale option labels onto the NEXT
   * unrelated prompt's PTY emit.
   */
  clearPending(): void {
    this.pending = null;
  }

  /**
   * True when the PTY parser has reported a permission prompt is on
   * screen and no status transition since has cleared it. Used by the
   * auto-approve inject path to gate subagent injection: only inject
   * "1"/"3" when a prompt is actually visible to consume the input.
   * A background subagent emits PermissionRequest hooks but its
   * prompt never reaches the main PTY, so this stays false and the
   * inject is dropped (caller falls through to escalateToUser, where
   * the lack of PTY confirmation also prevents a spurious push).
   */
  isPromptVisibleOnPTY(): boolean {
    return this.ptyShowingQuestion;
  }

  /**
   * Test-only inspection of the pending state. Exposed so the unit test
   * suite can assert state-machine invariants without resorting to
   * mocking the push sink.
   */
  hasPendingForTest(): boolean {
    return this.pending !== null;
  }
}
