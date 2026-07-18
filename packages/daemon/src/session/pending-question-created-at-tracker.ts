/**
 * Tracks first-seen timestamps for a session's pending questions (#786/#787).
 *
 * `SessionRegistry`'s `onQuestionsChanged` event fires with the FULL current
 * question set every time ANY question is added, answered, or cleared —
 * and `Question` itself carries no timestamp. Stamping every still-pending
 * question with "now" on every event would misreport how long a question
 * has actually been waiting (every OTHER pending question would appear to
 * have just arrived). This tracker memoizes each question id's first-seen
 * time so the `LiveSessionEntry.pendingQuestions` mirror reports a stable
 * `createdAt`, and prunes ids that are no longer pending so the map cannot
 * grow unbounded across a long session's lifetime.
 *
 * One instance per daemon (one session per daemon), constructed once in
 * cli.ts alongside the SessionRegistry it observes.
 */

import type { Question, UUID } from '@remi/shared';
import { buildPendingQuestionLabel } from './pending-question-label.ts';
import type { PendingQuestionEntry } from './session-registry-file.ts';

export class PendingQuestionCreatedAtTracker {
  private readonly firstSeen = new Map<UUID, string>();

  /** Injectable clock so tests can assert exact `createdAt` values. */
  constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  /**
   * Recompute the registry-file entries for the current question set.
   * Prunes ids no longer present in `questions` and assigns a fresh
   * `createdAt` only to ids seen for the first time.
   */
  sync(questions: readonly Question[]): PendingQuestionEntry[] {
    const liveIds = new Set(questions.map((q) => q.id));
    for (const id of this.firstSeen.keys()) {
      if (!liveIds.has(id)) this.firstSeen.delete(id);
    }
    return questions.map((q) => {
      let createdAt = this.firstSeen.get(q.id);
      if (createdAt === undefined) {
        createdAt = this.nowIso();
        this.firstSeen.set(q.id, createdAt);
      }
      return { id: q.id, label: buildPendingQuestionLabel(q), createdAt };
    });
  }
}
