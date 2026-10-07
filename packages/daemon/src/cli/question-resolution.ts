/**
 * The one way a card is resolved (#1235, ADR 0038): every path that dismisses a card on the clients
 * and the lock screen goes through {@link createQuestionResolver}. It sends `question_resolved` and
 * the quiet APNS dismissal once per card, so the first resolution wins: a later one for the same
 * card (an ElicitationResult after the phone answered it, a render that supersedes an answered card)
 * cannot contradict the `resolvedBy` the clients already have. A card that is live again (re-added
 * under the same id) can be resolved again.
 */

import { createQuestionResolved, errorToString } from '@remi/shared';
import type { QuestionResolvedMessage, ResolvedBy, UUID } from '@remi/shared';

/** How many resolved card ids are remembered; the oldest is forgotten first. */
const REMEMBERED = 1024;

export interface QuestionResolverDeps {
  readonly broadcast: (message: QuestionResolvedMessage) => void;
  /** The quiet lock-screen dismissal (apns-collapse-id = the question id). */
  readonly dismissPush: (sessionId: UUID, questionId: UUID) => void;
  readonly logError: (line: string) => void;
}

export interface QuestionResolver {
  /** Resolve a card on every client; false when it was already resolved (nothing is sent). */
  resolve(
    sessionId: UUID,
    questionId: UUID,
    reason: 'answered' | 'cancelled',
    resolvedBy?: ResolvedBy,
  ): boolean;
  /** These cards are live (the registry holds them): a later resolution of one is sent. */
  noteLive(questionIds: readonly UUID[]): void;
}

export function createQuestionResolver(deps: QuestionResolverDeps): QuestionResolver {
  const resolved = new Set<UUID>();
  return {
    resolve(sessionId, questionId, reason, resolvedBy) {
      if (resolved.has(questionId)) return false;
      resolved.add(questionId);
      if (resolved.size > REMEMBERED) {
        const oldest = resolved.values().next().value;
        if (oldest !== undefined) resolved.delete(oldest);
      }
      // Each step is guarded on its own: a failure in one never blocks the other.
      try {
        deps.broadcast(createQuestionResolved(sessionId, questionId, reason, resolvedBy));
      } catch (err) {
        deps.logError(
          `[QuestionResolved] broadcast failed for ${questionId}: ${errorToString(err)}`,
        );
      }
      try {
        deps.dismissPush(sessionId, questionId);
      } catch (err) {
        deps.logError(
          `[QuestionResolved] APNS dismissal failed for ${questionId}: ${errorToString(err)}`,
        );
      }
      return true;
    },
    noteLive(questionIds) {
      for (const id of questionIds) resolved.delete(id);
    },
  };
}

/**
 * What a session's close says about its cards (#1235): the agent's process exiting is the
 * harness; remi closing the session (a Stop, a failed resume, the orphan timeout) names no cause.
 */
export function causeOfSessionClose(
  reason: 'timeout' | 'pty_exit' | 'forced',
): ResolvedBy | undefined {
  return reason === 'pty_exit' ? 'harness' : undefined;
}
