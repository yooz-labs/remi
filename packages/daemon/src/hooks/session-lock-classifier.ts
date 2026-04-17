/**
 * Classifies hook events by session_id relative to our tracked main session.
 *
 * Role in the filtering pipeline: subagent/team events actually SHARE the main
 * session_id and are filtered upstream by the `agent_id` check in cli.ts (see
 * `isSubagentEvent`). This classifier handles the remaining cases where
 * session_id differs from our lock:
 *
 *   - Sibling Remi daemon in the same directory: its Claude fires hooks to us
 *     via shared .claude/settings.local.json, with a different session_id.
 *     Foreign — drop it.
 *   - Genuine Claude restart inside our PTY: Claude exits and a new Claude
 *     starts (e.g. user runs /clear or /compact, or Claude crashed and the
 *     user relaunched).
 *
 * Ground truth: our PTY process IS the interactive main session. While our PTY
 * is running and main has not explicitly ended, a different session_id is a
 * foreign event. If our PTY has exited or main emitted SessionEnd, a new
 * session_id represents a genuine restart.
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
