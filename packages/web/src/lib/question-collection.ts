/**
 * Helpers for the client's pending-question collection (#437).
 *
 * Questions are keyed by `${sessionId}#${agentId}` so a main-agent prompt and a
 * concurrent subagent prompt (#419) coexist in one map instead of overwriting
 * each other, while a hook+PTY double-emit for ONE prompt (same agent) still
 * collapses via the richer-wins guard. Pure functions, unit-tested directly.
 */

import { MAIN_AGENT_ID } from '@remi/shared';
import type { AgentStatus, UIQuestion, UIQuestionResolvedReason } from '@/types';

/**
 * How long an answered/resolved card lingers (collapsed) before it is removed
 * (#652). Long enough to read the confirmation, short enough not to clutter.
 */
export const RESOLVED_TRACE_LINGER_MS = 1500;

/**
 * A just-arrived main-agent card younger than this is protected from a
 * `session_update` status-clear (#652). The status fallback exists to drop a
 * card the agent has moved past, but a status update arriving in the same burst
 * as a fresh prompt must NOT wipe it before the user can act; the precise
 * `question_resolved` path (or a later status) clears it once it ages out.
 */
export const STATUS_CLEAR_FRESHNESS_MS = 2000;

/** Options for the freshness-gated status clear; mirrors `ShouldKeepExistingOptions`. */
export interface StatusClearOptions {
  readonly now?: () => number;
  readonly freshnessMs?: number;
}

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

/**
 * Remove the entry at `key` ONLY if it still holds question `id` (#652).
 *
 * The post-answer cleanup timer captures the slot key when the user answers,
 * but a newer prompt can take that same `sessionId#agentId` slot before the
 * timer fires (back-to-back auto-approve escalations). Deleting by key alone
 * then wipes the NEW card; the daemon re-emits and it "reappears". Verifying the
 * id makes the timer a no-op once the slot has been reused. Returns the SAME
 * reference when nothing was removed so React skips the re-render.
 */
export function removeQuestionByKeyIfId(
  questions: Map<string, UIQuestion>,
  key: string,
  id: string,
): Map<string, UIQuestion> {
  const existing = questions.get(key);
  if (!existing || existing.id !== id) return questions;
  const next = new Map(questions);
  next.delete(key);
  return next;
}

/**
 * Apply a `session_update` status to the MAIN-agent card, clearing it only when
 * the status resolves the prompt AND the card is not freshly arrived (#652).
 *
 * Composes `statusClearsMainQuestion` (status semantics) with a freshness gate
 * so a status update racing a just-shown prompt cannot wipe it. A card with a
 * malformed timestamp fails open to clearing, matching the rest of the UI's
 * "never pin on bad data" stance. Returns the SAME reference when nothing
 * changed.
 */
export function clearMainQuestionOnStatus(
  questions: Map<string, UIQuestion>,
  sessionId: string,
  status: AgentStatus,
  options: StatusClearOptions = {},
): Map<string, UIQuestion> {
  if (!statusClearsMainQuestion(status)) return questions;
  const key = questionKey(sessionId);
  const existing = questions.get(key);
  if (!existing) return questions;
  const freshnessMs = options.freshnessMs ?? STATUS_CLEAR_FRESHNESS_MS;
  const clock = options.now ?? Date.now;
  const ageMs = clock() - Date.parse(existing.timestamp);
  // Only clear when we can PROVE the card is old enough. An unknown age
  // (malformed timestamp => NaN) or a future-dated card (daemon clock ahead of
  // the client => negative age) is treated as fresh and protected: the precise
  // `question_resolved` broadcast is the guaranteed cleaner, so erring toward
  // keeping an actionable card is the safe failure direction here.
  if (!Number.isFinite(ageMs) || ageMs < freshnessMs) return questions;
  const next = new Map(questions);
  next.delete(key);
  return next;
}

/** Result of applying a `question_resolved` broadcast to the card collection. */
export interface QuestionResolution {
  readonly questions: Map<string, UIQuestion>;
  /** True => the caller flipped a card to a trace and must fade-remove it later. */
  readonly fade: boolean;
}

/**
 * Apply a `question_resolved` broadcast to the card matching (sessionId,
 * questionId), located by `id` because the message carries no agentId (#652).
 * The card always ends up resolved; HOW depends on who acted:
 *
 * - Answered LOCALLY (`answeredWith`) or already traced (duplicate broadcast):
 *   left untouched — those own their own removal timer. `fade: false`.
 * - SUBMITTING (#627 AUQ / cancel): the "Answering…" card has no self-removal
 *   timer and relies on this broadcast to clear; the user acted in-app, so it is
 *   removed outright rather than shown an "elsewhere" trace. `fade: false`.
 * - Otherwise PENDING (the user did NOT act here — lock screen / terminal /
 *   auto): flipped to a brief trace the caller fades after the linger window.
 *   `fade: true`.
 * - Absent: no-op (same reference). `fade: false`.
 */
export function resolveQuestionCard(
  questions: Map<string, UIQuestion>,
  sessionId: string,
  questionId: string,
  reason: UIQuestionResolvedReason,
): QuestionResolution {
  for (const [key, q] of questions) {
    if (q.sessionId !== sessionId || q.id !== questionId) continue;
    if (q.answeredWith != null || q.resolvedReason != null) {
      return { questions, fade: false };
    }
    if (q.submitting) {
      const next = new Map(questions);
      next.delete(key);
      return { questions: next, fade: false };
    }
    const next = new Map(questions);
    next.set(key, { ...q, resolvedReason: reason });
    return { questions: next, fade: true };
  }
  return { questions, fade: false };
}

/** Whether a card is still awaiting the user (drives the session's pending badge). */
export function isQuestionPending(q: UIQuestion): boolean {
  return q.answeredWith == null && q.resolvedReason == null;
}
