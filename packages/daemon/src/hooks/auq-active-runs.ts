/**
 * Tracks which AskUserQuestion prompts are CURRENTLY being driven by an
 * in-flight `runAuqAnswer` (#661 review).
 *
 * `input-events.ts`'s `handleAuqAnswer` marks a question active for the exact
 * duration of its drive (before the first keystroke, cleared in `finally`
 * after `runAuqAnswer` settles) and `pty-session-setup.ts`'s post-escalation
 * terminal-answer detector consults this before touching a question.
 *
 * Without this, the detector races the runner's OWN success path on EVERY
 * remotely-answered multi-select: both read the same rolling PTY buffer, and
 * the detector runs synchronously in the same `onData` tick the closure
 * marker lands — strictly before the runner's next `sleep`/poll tick — so it
 * wins by event-loop ordering on the common (non-escalated) path. That
 * produces a duplicate `question_resolved` broadcast (the #652/#653 duplicate-
 * resolution bug class) and a misleading `'user-answered-auq-terminal'`
 * eval-cancel reason for a question the phone actually answered. Consulting
 * this tracker lets the detector skip any question the runner still owns and
 * only act once the runner has genuinely given up (or was never invoked).
 *
 * Session+question keyed (not bare question id) for symmetry with
 * `auqRunKey` in `input-events.ts`, though question ids are already unique
 * per session in practice.
 */

const activeRuns = new Set<string>();

function key(sessionId: string, questionId: string): string {
  return `${sessionId}:${questionId}`;
}

/** Mark a question's AUQ drive as started. Call before invoking `runAuqAnswer`. */
export function markAuqRunActive(sessionId: string, questionId: string): void {
  activeRuns.add(key(sessionId, questionId));
}

/** Clear a question's AUQ drive. Call in `finally` once `runAuqAnswer` settles. */
export function clearAuqRunActive(sessionId: string, questionId: string): void {
  activeRuns.delete(key(sessionId, questionId));
}

/** True while a question is being actively driven by `runAuqAnswer`. */
export function isAuqRunActive(sessionId: string, questionId: string): boolean {
  return activeRuns.has(key(sessionId, questionId));
}
