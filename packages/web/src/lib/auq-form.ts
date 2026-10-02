/**
 * The AskUserQuestion form's answer, as pure functions (#1127): what the
 * user picked per question, and the free text they typed for a single-select
 * question instead of picking.
 *
 * The daemon refuses an answer that leaves any question unanswered, gives a
 * single-select question more than one answer, or gives free text to a
 * multi-select question (it keeps the prompt waiting). These helpers build
 * only answers it accepts, so Submit is enabled exactly when one would be.
 */

import type { UIQuestionStep } from '@/types';

/** The longest free-text answer the daemon accepts (`FREE_TEXT_MAX` in the
 *  daemon's `structured-answers.ts`); a longer one is refused, not cut. */
export const AUQ_FREE_TEXT_MAX = 2000;

/** One sub-question's answer as sent to the daemon (`AnswerSelection`). */
export interface AuqSelection {
  readonly questionIndex: number;
  readonly optionIndices: number[];
  /** Free text instead of an option, for a single-select question. */
  readonly text?: string;
}

/** The text typed for question `qi`, trimmed, when its step takes text. */
function typedFor(
  step: UIQuestionStep,
  qi: number,
  typed: ReadonlyMap<number, string>,
): string {
  return step.multiSelect ? '' : (typed.get(qi) ?? '').trim();
}

/**
 * Whether every question has an answer the daemon accepts: a single-select
 * question exactly one option or typed text (at most `AUQ_FREE_TEXT_MAX`
 * characters once trimmed), a multi-select one at least one option.
 */
export function auqFormComplete(
  steps: readonly UIQuestionStep[],
  selected: ReadonlyMap<number, ReadonlySet<number>>,
  typed: ReadonlyMap<number, string>,
): boolean {
  return steps.every((step, qi) => {
    const picks = selected.get(qi)?.size ?? 0;
    if (step.multiSelect) return picks > 0;
    const text = typedFor(step, qi, typed);
    if (text.length > AUQ_FREE_TEXT_MAX) return false;
    return (picks === 1 && text.length === 0) || (picks === 0 && text.length > 0);
  });
}

/**
 * The selections to send, one per question in order: typed text (with no
 * option) where a single-select question has text, its picked options
 * (ascending) otherwise.
 */
export function auqFormSelections(
  steps: readonly UIQuestionStep[],
  selected: ReadonlyMap<number, ReadonlySet<number>>,
  typed: ReadonlyMap<number, string>,
): AuqSelection[] {
  return steps.map((step, qi) => {
    const text = typedFor(step, qi, typed);
    if (text.length > 0) return { questionIndex: qi, optionIndices: [], text };
    return {
      questionIndex: qi,
      optionIndices: [...(selected.get(qi) ?? [])].sort((a, b) => a - b),
    };
  });
}
