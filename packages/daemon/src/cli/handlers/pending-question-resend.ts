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
 * path (connection-events) and the resume-request attach path
 * (resume-session-events). A send failure is the caller's transport's
 * problem; this helper only reports how many were attempted.
 *
 * #808: the re-send above is purely ADDITIVE — it says what IS live and can
 * never retract a card the client is already showing. The negative half is a
 * `question_snapshot` carrying the same authoritative id set, sent here so
 * both attach surfaces get it.
 *
 * This closes a hole in #798. That change broadcasts `question_snapshot` from
 * `onQuestionsChanged` and its comment says the point is to resync "a client
 * that reconnects into a quiet session" — but a quiet session is precisely one
 * where nothing changes, so no broadcast ever fires and the client's
 * `reconcileLiveQuestions` never runs. A phantom card therefore survived
 * reconnect indefinitely (issue #808 shapes 2 and 3): `question_resolved` is
 * broadcast-only and never replayed, so a resolve missed while disconnected is
 * lost forever, with nothing afterwards to correct the client.
 *
 * The EMPTY case is the one that matters most and the one the additive path
 * structurally cannot express: zero pending questions sends a snapshot with an
 * empty id set, which is exactly what tells a client holding a stale card to
 * drop it. So the snapshot is sent unconditionally, not only when there is
 * something to list.
 *
 * Safe against the "never clear on an ambiguous signal" invariant (#668/#652):
 * this is not an inference from a status change or a screen scrape. It is the
 * registry's own `currentQuestions`, read at attach time and shipped verbatim
 * — the most authoritative statement of pendingness the daemon can make.
 */

import { createQuestion, createQuestionSnapshot } from '@remi/shared';
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
  // Sent AFTER the live questions so the client has already registered them
  // and cannot prune one it is about to be told about in the same batch.
  send(
    createQuestionSnapshot(
      sessionId,
      pendingQuestions.map((q) => q.id),
    ),
  );
  return pendingQuestions.length;
}
