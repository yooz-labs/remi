/**
 * Helpers for the client's pending-question collection (#437).
 *
 * Questions are keyed by `${sessionId}#${agentId}` so a main-agent prompt and a
 * concurrent subagent prompt (#419) coexist in one map instead of overwriting
 * each other, while a hook+PTY double-emit for ONE prompt (same agent) still
 * collapses via the richer-wins guard. Pure functions, unit-tested directly.
 */

import { MAIN_AGENT_ID } from '@remi/shared';
import type { AgentStatus, UIQuestion } from '@/types';

/** Composite map key: a session's prompt, scoped to its agent (main default). */
export function questionKey(sessionId: string, agentId?: string | undefined): string {
  return `${sessionId}#${agentId ?? MAIN_AGENT_ID}`;
}

/** All pending questions belonging to a session, in insertion order. */
export function getSessionQuestions(
  questions: ReadonlyMap<string, UIQuestion>,
  sessionId: string,
): UIQuestion[] {
  const out: UIQuestion[] = [];
  for (const q of questions.values()) {
    if (q.sessionId === sessionId) out.push(q);
  }
  return out;
}

/** Whether a session has any pending question. */
export function hasSessionQuestion(
  questions: ReadonlyMap<string, UIQuestion>,
  sessionId: string,
): boolean {
  for (const q of questions.values()) {
    if (q.sessionId === sessionId) return true;
  }
  return false;
}

/**
 * Return a map with all of a session's questions removed. Returns the SAME
 * reference when nothing matched, so callers keep React's no-op-update
 * optimization (`setQuestions(prev => clearSessionQuestions(prev, id))`).
 */
export function clearSessionQuestions(
  questions: Map<string, UIQuestion>,
  sessionId: string,
): Map<string, UIQuestion> {
  const keys: string[] = [];
  for (const [key, q] of questions) {
    if (q.sessionId === sessionId) keys.push(key);
  }
  if (keys.length === 0) return questions;
  const next = new Map(questions);
  for (const key of keys) next.delete(key);
  return next;
}

/**
 * Return a map with the single question matching (sessionId, questionId) removed
 * (#585, P7). Used by the `question_resolved` broadcast handler: the message
 * carries no agentId, so the entry is located by its question `id` within the
 * session rather than by composite key. Returns the SAME reference when nothing
 * matched, so callers keep React's no-op-update optimization. Idempotent — a
 * client that already dropped the card simply gets the same map back.
 */
export function removeQuestionById(
  questions: Map<string, UIQuestion>,
  sessionId: string,
  questionId: string,
): Map<string, UIQuestion> {
  let foundKey: string | undefined;
  for (const [key, q] of questions) {
    if (q.sessionId === sessionId && q.id === questionId) {
      foundKey = key;
      break;
    }
  }
  if (foundKey === undefined) return questions;
  const next = new Map(questions);
  next.delete(foundKey);
  return next;
}

/**
 * Whether a `session_update` status means the MAIN agent's prompt resolved and
 * its pending card should be cleared.
 *
 * 'waiting' is the blocked state (the prompt is open), so it never clears.
 * 'evaluating' and 'approved' are TRANSIENT auto-approve broadcasts (#576) that
 * must NOT clear a pending card: a second permission's onEvalStart
 * ('evaluating') would otherwise delete the first card the user is still
 * looking at, and a Part-B early-push question the gate later auto-approves
 * ('approved') would vanish silently. The card clears on the next real hook
 * status ('thinking'/'executing'/'idle'/'starting') or when answered.
 */
export function statusClearsMainQuestion(status: AgentStatus): boolean {
  return status !== 'waiting' && status !== 'evaluating' && status !== 'approved';
}
