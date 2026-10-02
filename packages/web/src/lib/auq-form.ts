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
 * The selections to send, one per question in order: exactly what the form
 * holds, its picked options (ascending) and, for a single-select question,
 * its typed text when not blank. Nothing is dropped to make an answer fit:
 * the form never holds a pick and text together (`pickAuqOption`,
 * `typeAuqText`), and if it did the daemon would refuse both, as
 * `auqFormComplete` does (pinned two-sided in `auq-form-conformance`).
 */
export function auqFormSelections(
  steps: readonly UIQuestionStep[],
  selected: ReadonlyMap<number, ReadonlySet<number>>,
  typed: ReadonlyMap<number, string>,
): AuqSelection[] {
  return steps.map((step, qi) => {
    const text = typedFor(step, qi, typed);
    const optionIndices = [...(selected.get(qi) ?? [])].sort((a, b) => a - b);
    return text.length > 0
      ? { questionIndex: qi, optionIndices, text }
      : { questionIndex: qi, optionIndices };
  });
}

/** The form's state: picked options and typed text, per question index. */
export interface AuqFormState {
  readonly selected: ReadonlyMap<number, ReadonlySet<number>>;
  readonly typed: ReadonlyMap<number, string>;
}

/** An empty form. */
export const EMPTY_AUQ_FORM: AuqFormState = { selected: new Map(), typed: new Map() };

/**
 * Tap option `oi` of question `qi`: a multi-select toggles it; a
 * single-select picks it alone and clears any typed text, since a
 * single-select question takes one answer.
 */
export function pickAuqOption(
  state: AuqFormState,
  qi: number,
  oi: number,
  multi: boolean,
): AuqFormState {
  const selected = new Map(state.selected);
  const set = new Set(selected.get(qi) ?? []);
  if (multi) {
    if (set.has(oi)) set.delete(oi);
    else set.add(oi);
  } else {
    set.clear();
    set.add(oi);
  }
  selected.set(qi, set);
  if (multi || !state.typed.has(qi)) return { selected, typed: state.typed };
  const typed = new Map(state.typed);
  typed.delete(qi);
  return { selected, typed };
}

/**
 * Type `text` for question `qi` (a single-select): non-blank text clears the
 * question's pick, since text answers it instead.
 */
export function typeAuqText(state: AuqFormState, qi: number, text: string): AuqFormState {
  const typed = new Map(state.typed).set(qi, text);
  if (text.trim().length === 0 || !state.selected.has(qi)) {
    return { selected: state.selected, typed };
  }
  const selected = new Map(state.selected);
  selected.delete(qi);
  return { selected, typed };
}
