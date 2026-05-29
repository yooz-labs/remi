/**
 * Helpers for the client's pending-question collection (#437).
 *
 * Questions are keyed by `${sessionId}#${agentId}` so a main-agent prompt and a
 * concurrent subagent prompt (#419) coexist in one map instead of overwriting
 * each other, while a hook+PTY double-emit for ONE prompt (same agent) still
 * collapses via the richer-wins guard. Pure functions, unit-tested directly.
 */

import type { UIQuestion } from '@/types';

/** Composite map key: a session's prompt, scoped to its agent ('main' default). */
export function questionKey(sessionId: string, agentId?: string | undefined): string {
  return `${sessionId}#${agentId ?? 'main'}`;
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
