/**
 * QuestionDedup - merges questions arriving from multiple sources.
 *
 * Both the hook bridge (PermissionRequest/Notification) and the PTY
 * OutputProcessor can emit a question for the same prompt. Without
 * dedup the client gets two messages for one prompt, or, conversely,
 * a richer PTY-parsed question is masked by the hook's hardcoded 3-option
 * default (issue #378).
 *
 * Rules (windowMs, default 5s):
 *   - Different prompt fingerprint                       -> emit.
 *   - Same fingerprint, new is richer (more options or
 *     gains allowsFreeText)                              -> emit (upgrade).
 *   - Same fingerprint, new is same/poorer, in window    -> suppress.
 *   - Same fingerprint, new is same/poorer, out of window-> emit.
 *
 * The hook bridge fires first (within ~10ms of Claude's prompt). The
 * OutputProcessor parses terminal text ~50-200ms later. If the hook only
 * had a default 3-option set but the terminal shows numbered options
 * (e.g. 4-choice "which file?"), the PTY emission upgrades the question.
 *
 * Fingerprinting normalizes case + whitespace and truncates to 80 chars
 * so minor terminal redraw differences don't defeat the dedup.
 */

import type { Question } from '@remi/shared';

interface LastEmitted {
  fingerprint: string;
  optionCount: number;
  allowsFreeText: boolean;
  emittedAt: number;
}

export class QuestionDedup {
  private last: LastEmitted | null = null;

  constructor(
    private readonly windowMs: number = 5000,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Returns true if the question should be emitted, false to suppress.
   * On true, internal state is updated so subsequent same-fingerprint
   * lower-rank questions are suppressed within the window.
   */
  shouldEmit(question: Question): boolean {
    const fp = fingerprint(question.text);
    const t = this.clock();
    const last = this.last;

    if (last !== null && t - last.emittedAt < this.windowMs && last.fingerprint === fp) {
      const richer =
        question.options.length > last.optionCount ||
        (question.allowsFreeText && !last.allowsFreeText);
      if (!richer) return false;
    }

    this.last = {
      fingerprint: fp,
      optionCount: question.options.length,
      allowsFreeText: question.allowsFreeText,
      emittedAt: t,
    };
    return true;
  }

  /** Clear state (call on session reset / new prompt cycle). */
  reset(): void {
    this.last = null;
  }
}

function fingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}
