/**
 * #753: re-send the authoritative pending questions to a freshly attached
 * (or promoted / resume-attached) connection, as LIVE `question` messages,
 * right after the replay batch.
 *
 * Replayed history cannot be trusted for pendingness: `question_resolved` is
 * broadcast-only and never recorded into `messageHistory`, so an
 * already-answered question replays indistinguishably from a pending one.
 * The registry's `currentQuestions` (returned by every successful
 * `attachConnection`) is the source of truth. Clients dedupe by
 * `question.id`; the terminal attach client banners the held ones (the class
 * that never renders on the PTY).
 *
 * Shared by every attach surface (#760 review finding 2): the hello attach
 * path (connection-events), the resume-request attach path
 * (resume-session-events), and FIFO queue promotion (cli.ts
 * onConnectionPromoted). A send failure is the caller's transport's problem;
 * this helper only reports how many were attempted.
 */

import { createQuestion } from '@remi/shared';
import type { ProtocolMessage, Question, UUID } from '@remi/shared';

export function resendPendingQuestions(
  send: (message: ProtocolMessage) => void,
  sessionId: UUID,
  pendingQuestions: readonly Question[],
  claudeSessionId?: UUID,
): number {
  for (const question of pendingQuestions) {
    send(createQuestion(question, sessionId, claudeSessionId));
  }
  return pendingQuestions.length;
}
