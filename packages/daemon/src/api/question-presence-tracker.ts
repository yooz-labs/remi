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

  constructor(private readonly push: PushQuestion) {}

  /**
   * Hook fired (PermissionRequest or Notification(permission_prompt)).
   * Stash the question; do NOT push yet. Push happens when PTY confirms
   * the prompt is visible, or never if status moves past 'waiting' first.
   */
  recordPendingHook(question: Question): void {
    this.pending = question;
  }

  /**
   * PTY parser saw a prompt on screen. Push immediately. If we have a
   * recent hook record, merge: PTY contributes `id` / `text` /
   * `allowsFreeText` / `isAnswered` (it reflects the screen) and the
   * hook contributes `options` (it knows real labels like
   * ['Yes', 'Always', 'No'] while PTY usually has numbered fallbacks).
   */
  onPTYPromptVisible(ptyQuestion: Question): void {
    const merged: Question =
      this.pending && this.pending.options.length > 0
        ? { ...ptyQuestion, options: [...this.pending.options] }
        : ptyQuestion;
    this.pending = null;
    this.push(merged);
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
    }
  }

  /**
   * Test-only inspection of the pending state. Exposed so the unit test
   * suite can assert state-machine invariants without resorting to
   * mocking the push sink.
   */
  hasPendingHookForTest(): boolean {
    return this.pending !== null;
  }
}
