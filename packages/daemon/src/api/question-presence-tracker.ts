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
   *  first, but different agents keep separate entries. Insertion order is
   *  preserved so the PTY-pairing fallback can pick the most recent. */
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
   * record for option labels / agent_id: prefer the same agent, else fall
   * back to the most-recent pending hook (PTY output does not reliably name
   * the agent — #425). When paired, the hook contributes `options` and
   * `agentId` (so the client keys the prompt to the right agent) while PTY
   * contributes `id` / `text` / `allowsFreeText` / `isAnswered` (it reflects
   * the screen). The consumed hook entry is removed.
   *
   * Pending is mutated BEFORE the push so a re-entrant call cannot re-merge
   * the same record. Push errors are caught and logged but not rethrown — the
   * next PTY emit for the same prompt retries WITHOUT the hook merge (PTY's
   * numbered options), which beats crashing on a network blip during APNS.
   */
  onPTYPromptVisible(ptyQuestion: Question): void {
    const key = agentKey(ptyQuestion);
    let recordKey: string | undefined = this.pending.has(key) ? key : undefined;
    if (recordKey === undefined && this.pending.size > 0) {
      // Most-recent pending hook (Map preserves insertion order). The PTY did
      // not name an agent we have a record for, so this may attach the wrong
      // agent's option labels (#425). Log it so the misattribution is
      // observable rather than silent.
      const keys = [...this.pending.keys()];
      recordKey = keys[keys.length - 1];
      console.warn(
        `[QuestionPresenceTracker] PTY prompt (agent "${key}") has no matching hook; pairing most-recent "${recordKey}" of [${keys.join(', ')}] — option labels may be misattributed`,
      );
    }
    const hookRecord = recordKey !== undefined ? this.pending.get(recordKey) : undefined;
    if (recordKey !== undefined) {
      this.pending.delete(recordKey);
    }

    const merged: Question =
      hookRecord && hookRecord.options.length > 0
        ? {
            ...ptyQuestion,
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
    }
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
