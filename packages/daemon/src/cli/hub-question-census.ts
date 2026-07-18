/**
 * Aggregates live-sessions registry entries into the hub's pending-question
 * census (#786/#787): the data behind `HubStatusMessage.pendingQuestions` /
 * `.questions`. Pure over the entries `SessionRegistryFile#listLive()`
 * already returns for the plain session count — no extra fs reads.
 */

import type { HubPendingQuestion } from '@remi/shared';
import type { LiveSessionEntry } from '../session/session-registry-file.ts';

export interface HubQuestionCensus {
  /** Live child session daemon count (same value `getSessions` used to return). */
  readonly sessions: number;
  /** Every pending question across every live session, flattened. */
  readonly questions: readonly HubPendingQuestion[];
}

/** Flatten each entry's `pendingQuestions` into the wire-shaped census list. */
export function buildHubQuestionCensus(entries: readonly LiveSessionEntry[]): HubQuestionCensus {
  const questions: HubPendingQuestion[] = [];
  for (const entry of entries) {
    for (const q of entry.pendingQuestions ?? []) {
      questions.push({
        id: q.id,
        sessionId: entry.sessionId,
        sessionName: entry.name,
        label: q.label,
        createdAt: q.createdAt,
      });
    }
  }
  return { sessions: entries.length, questions };
}
