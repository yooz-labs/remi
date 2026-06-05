/**
 * Push-trigger dedup for question notifications (#409).
 *
 * The PTY parser and HookEventBridge both emit a `question` for the
 * same prompt cycle (different ids, different fingerprints, both pass
 * `QuestionDedup`'s text-based gate). Each one then fires an APNS
 * push from `message-api-setup.ts#onQuestion`, so the user sees two
 * lock-screen notifications per prompt.
 *
 * Mirrors the shape-aware client-side richer-wins guard in
 * `packages/web/src/lib/question-merge.ts`. Within
 * `QUESTION_DEDUP_WINDOW_MS`:
 *
 *   - new is default-3-set AND last was non-default → suppress
 *   - new is non-default AND last was default → fire (upgrade)
 *   - new has strictly more options than last → fire (upgrade)
 *   - otherwise → suppress
 *
 * Beyond the window: always fire. Reset on every meaningful status
 * boundary (status leaves 'waiting' / session reset) to mirror
 * `QuestionDedup`'s lifecycle.
 */

import { QUESTION_DEDUP_WINDOW_MS } from '@remi/shared';
import { looksLikeDefaultPermissionQuestion } from '../api/question-dedup.ts';

interface LastPush {
  emittedAt: number;
  optionCount: number;
  isDefaultShape: boolean;
}

export interface PushDedupQuestion {
  readonly options: ReadonlyArray<{ label: string }>;
  readonly allowsFreeText: boolean;
}

export class PushDedup {
  private last: LastPush | null = null;

  constructor(
    private readonly windowMs: number = QUESTION_DEDUP_WINDOW_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Returns true if the push should fire, false to suppress. On true,
   * the internal baseline updates so subsequent equal-or-poorer pushes
   * within the window are dropped.
   */
  shouldPush(question: PushDedupQuestion): boolean {
    const t = this.clock();
    const incomingIsDefault = looksLikeDefaultPermissionQuestion(question);
    const incomingCount = question.options.length;

    if (this.last !== null && t - this.last.emittedAt < this.windowMs) {
      // Default-3-set is the bland fallback shape; never let it
      // upgrade or duplicate a push that already covers the prompt
      // with a richer shape.
      if (incomingIsDefault && !this.last.isDefaultShape) return false;
      // Same direction the other way: the daemon's first push for
      // this prompt was the bland default and the PTY now surfaced a
      // richer shape → upgrade the lock-screen options.
      if (!incomingIsDefault && this.last.isDefaultShape) {
        this.last = { emittedAt: t, optionCount: incomingCount, isDefaultShape: false };
        return true;
      }
      // Same shape class: only allow strictly more options (upgrade).
      if (incomingCount <= this.last.optionCount) return false;
    }

    this.last = {
      emittedAt: t,
      optionCount: incomingCount,
      isDefaultShape: incomingIsDefault,
    };
    return true;
  }

  /** Clear baseline (call on status change away from 'waiting'). */
  reset(): void {
    this.last = null;
  }
}
