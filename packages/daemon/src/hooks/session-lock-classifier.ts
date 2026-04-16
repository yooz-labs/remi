/**
 * Classifies hook events by session_id relative to our tracked main session.
 *
 * Background: Claude Code subagents (spawned via TaskCreate/TeamCreate/Task)
 * have DIFFERENT session_ids than their parent main session, but fire hooks to
 * the SAME hook server (shared .claude/settings.local.json). A naive "different
 * session_id == restart" rule hijacks our lock onto a subagent, breaking both
 * filter and routing:
 *   - Main's events get filtered out (session_id no longer matches)
 *   - Subagent's events pass the filter → auto-approve may inject into main's PTY
 *
 * Ground truth: our PTY process IS the interactive main session. While our PTY
 * is running and main has not explicitly ended, any different session_id must
 * be a subagent or sibling-daemon event — foreign, drop it. If our PTY has
 * exited or main emitted SessionEnd, a new session_id represents a genuine
 * Claude restart.
 */

export type SessionEventClass = 'match' | 'foreign' | 'restart';

export interface SessionClassificationInput {
  /** Our currently-tracked main session_id, or null if unlocked. */
  readonly currentLock: string | null;
  /** The session_id from the incoming hook event. */
  readonly incomingSessionId: string;
  /** Whether our own PTY is still running (the main interactive session). */
  readonly mainPtyRunning: boolean;
  /** Whether main explicitly emitted SessionEnd for our lock. */
  readonly mainSessionEnded: boolean;
}

/**
 * Classify an incoming hook event relative to our tracked main session.
 *
 *   - match:   event is from our tracked main (normal processing)
 *   - foreign: event is from a subagent or sibling daemon — drop it to
 *              prevent hijacking our lock
 *   - restart: our main is gone; treat the new session_id as a new main
 */
export function classifySessionEvent(input: SessionClassificationInput): SessionEventClass {
  const { currentLock, incomingSessionId, mainPtyRunning, mainSessionEnded } = input;

  // Unlocked: any event is a candidate for initialization. Caller handles the
  // sibling-in-dir guard separately before locking.
  if (currentLock === null) return 'match';

  if (currentLock === incomingSessionId) return 'match';

  // Different session_id. Our PTY is the ground truth for "main alive":
  // while it's running and main hasn't explicitly ended, this is foreign.
  if (mainPtyRunning && !mainSessionEnded) return 'foreign';

  // PTY exited or SessionEnd fired → our main is gone → treat as restart.
  return 'restart';
}
