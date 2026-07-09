/**
 * #752: short-TTL memory of successfully-applied answers, keyed by questionId.
 *
 * Every lock-screen tap fires two-to-three independent deliveries of the same
 * (sessionId, questionId, answer): the native Swift POST (RemiAnswerRelay),
 * Capacitor's JS path (live WebSocket or `relayAnswerDirect` POST), and — for
 * relay-connected daemons — a signaling-Worker-forwarded copy. The first copy
 * to arrive resolves the question and synchronously removes it from the
 * registry, so the loser deterministically saw `active === null`, got 'stale'
 * (HTTP 409 / STALE_ANSWER), and both client layers translated that into an
 * "Answer not delivered" notification — a false negative on essentially every
 * tap where the app process was alive.
 *
 * This cache lets the answer core tell a same-value duplicate of a SUCCESSFUL
 * answer ("report 'delivered'; the tap worked") apart from a genuinely
 * unknown/expired/conflicting one (still 'stale'). Only successful
 * applications are recorded — a throwing PTY submit or a cancel is not an
 * applied answer, and a conflicting late answer (different value, e.g. "No"
 * tapped on a second device after "Yes" already won) must keep failing loudly.
 *
 * TTL covers the observed redelivery window (signaling-relay copies have been
 * seen re-forwarded on WebSocket reconnect minutes after the original); a
 * same-value duplicate is honest to acknowledge no matter how late, so the
 * bound exists for memory, not correctness. Insertion order doubles as the
 * eviction order (Map preserves it; entries are never re-inserted).
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 500;

/** Canonical cache key for an answer payload: the raw answer string, or a
 *  stable serialization of structured AskUserQuestion selections (#627),
 *  which carry the answer in `extra.selections` instead of `answer`. */
export function answerCacheKey(
  answer: string,
  selections?: readonly { questionIndex: number; optionIndices: readonly number[] }[],
): string {
  if (selections && selections.length > 0) {
    return `auq:${JSON.stringify(selections.map((s) => [s.questionIndex, [...s.optionIndices].sort((a, b) => a - b)]))}`;
  }
  return answer;
}

export class ResolvedAnswerCache {
  private readonly entries = new Map<string, { keys: ReadonlySet<string>; atMs: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly nowMs: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; nowMs?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  /**
   * Record a successfully-applied answer for `questionId` under EVERY key the
   * same logical decision can arrive as. The channels are not byte-identical:
   * an in-app tap sends the option VALUE ("1") while a push action sends the
   * LABEL ("Yes") — both resolve to the same option when applied
   * (`resolveOption` matches either field), so the dedup must accept either
   * spelling too. Callers pass the raw answer plus the resolved option's
   * value/label (review #759 finding 1); the question is gone by the time a
   * duplicate arrives, so the equivalence must be captured at record time.
   */
  record(questionId: string, keys: readonly string[]): void {
    this.prune();
    const set = new Set(keys.filter((k) => k.length > 0));
    if (set.size === 0) return;
    // Delete-then-set keeps insertion order meaningful for eviction even if a
    // question were somehow re-recorded.
    this.entries.delete(questionId);
    this.entries.set(questionId, { keys: set, atMs: this.nowMs() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** True iff `questionId` was resolved with this answer (under any recorded
   *  spelling) within the TTL — i.e. the incoming answer is a duplicate
   *  delivery of a success. */
  matches(questionId: string, key: string): boolean {
    const entry = this.entries.get(questionId);
    if (!entry) return false;
    if (this.nowMs() - entry.atMs > this.ttlMs) {
      this.entries.delete(questionId);
      return false;
    }
    return entry.keys.has(key);
  }

  private prune(): void {
    const now = this.nowMs();
    for (const [id, entry] of this.entries) {
      if (now - entry.atMs > this.ttlMs) this.entries.delete(id);
    }
  }

  /** Test-only: current entry count. */
  sizeForTest(): number {
    return this.entries.size;
  }
}
