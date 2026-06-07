/**
 * QuestionDedup - safety net against rapid duplicate emissions.
 *
 * Tracks only the most recently emitted question. When a same-fingerprint
 * question arrives within the dedup window, it is dropped UNLESS it is
 * richer (more options, or gains allowsFreeText) — that is allowed through
 * as an upgrade and replaces the baseline.
 *
 * Tracking is PER-AGENT (keyed by `question.agentId ?? 'main'`): a background
 * subagent's "Allow Bash?" must NOT suppress the main agent's identically-worded
 * prompt (they are two distinct questions the user must answer). Within one
 * agent it is single-slot. Callers (`MessageAPI`) clear the state on every
 * meaningful boundary (status change away from 'waiting', session reset). The
 * window is a safety net against same-tick re-renders, not a long-lived cache.
 *
 * The fingerprint normalizes case + whitespace and truncates to 80 chars,
 * so minor terminal redraw differences don't defeat the dedup. Genuinely
 * distinct prompts that happen to share an 80-char prefix are an accepted
 * collision risk; keeping it short bounds memory and matches real prompts
 * which are usually <80 chars after normalization.
 */

import { MAIN_AGENT_ID, QUESTION_DEDUP_WINDOW_MS, type Question } from '@remi/shared';

interface LastEmitted {
  fingerprint: string;
  optionCount: number;
  allowsFreeText: boolean;
  emittedAt: number;
}

export class QuestionDedup {
  /** Most-recent emission per agent (`agentId ?? 'main'`), so concurrent
   *  prompts from different agents never suppress each other. */
  private readonly last = new Map<string, LastEmitted>();

  constructor(
    private readonly windowMs: number = QUESTION_DEDUP_WINDOW_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Returns true if the question should be emitted, false to suppress.
   * On true, internal state is updated so subsequent same-fingerprint
   * lower-rank questions FROM THE SAME AGENT are suppressed within the window.
   */
  shouldEmit(question: Question): boolean {
    const fp = fingerprint(question.text);
    const t = this.clock();
    const agent = question.agentId ?? MAIN_AGENT_ID;
    const last = this.last.get(agent);

    if (last !== undefined && t - last.emittedAt < this.windowMs && last.fingerprint === fp) {
      const richer =
        question.options.length > last.optionCount ||
        (question.allowsFreeText && !last.allowsFreeText);
      if (!richer) {
        console.debug(
          `[QuestionDedup] Suppressed agent=${agent} (lastOpts=${last.optionCount}, newOpts=${question.options.length}, ageMs=${t - last.emittedAt}): ${question.text.slice(0, 80)}`,
        );
        return false;
      }
    }

    this.last.set(agent, {
      fingerprint: fp,
      optionCount: question.options.length,
      allowsFreeText: question.allowsFreeText,
      emittedAt: t,
    });
    return true;
  }

  /** Clear state for all agents (call on session reset / new prompt cycle). */
  reset(): void {
    this.last.clear();
  }
}

function fingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * True when a parsed question matches the shape of Claude Code's hardcoded
 * 3-option permission prompt (Yes / Yes-always / No). Used to drop redundant
 * PTY-parsed permission emissions when the hook bridge has already produced
 * the same question — text fingerprints differ between the two sources
 * (hook builds "Allow Bash: ls", PTY extracts whatever appears above the
 * numbered list), so structural matching is safer than text dedup alone.
 */
export function looksLikeDefaultPermissionQuestion(question: {
  options: ReadonlyArray<{ label: string }>;
  allowsFreeText: boolean;
}): boolean {
  if (question.allowsFreeText) return false;
  if (question.options.length !== 3) return false;
  const labels = question.options.map((o) => (o.label ?? '').toLowerCase().trim());
  const first = labels[0] ?? '';
  const last = labels[2] ?? '';
  return first.startsWith('yes') && last.startsWith('no');
}
