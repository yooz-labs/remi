/**
 * The vocabulary of answering a prompt a harness is holding open (epic #1161,
 * phase 3 #1164): what an answer from the phone looks like when it reaches the
 * harness (`HeldAnswer`), and what the harness did with it
 * (`HeldAnswerOutcome`, including a final `authority-refused`). Both are
 * shaped by the card's own options and the answer path, not by a Claude type,
 * so the chat handlers can import them without importing `auto-approve/`; the
 * Claude's permission gate and Codex's decision channel both consume this
 * vocabulary. The optional synchronous commit callback guards their exact
 * effects without holding an authorization lock during notifications (#1201).
 */

import type { AnswerSelection, QuestionOption } from '@remi/shared';

/**
 * Whether this harness can still accept an answer to the current card (#1200).
 * A held hook supplies its captured absolute deadline; a harness that owns an
 * untimed current request supplies `current-prompt`. Delivery never extends a
 * hold, and `closed` must never fall back to a different answer path.
 */
export type AnswerValidity =
  | { readonly kind: 'deadline'; readonly expiresAtMs: number }
  | { readonly kind: 'current-prompt' }
  | { readonly kind: 'closed' };

/** A synchronous final authority check around the exact answer effect (#1201).
 * The caller awaits a returned promise only after this callback has released
 * its authorization lock. Refusal must not consume a live card or hold. */
export type AnswerCommitResult<T> =
  | { readonly kind: 'committed'; readonly value: T }
  | { readonly kind: 'refused' };
export type AnswerCommit = <T>(effect: () => T) => AnswerCommitResult<T>;

export function applyAnswerCommit<T>(
  effect: () => T,
  commit?: AnswerCommit,
): AnswerCommitResult<T> {
  return commit ? commit(effect) : { kind: 'committed', value: effect() };
}

/**
 * A phone answer to a held prompt (#1126), as the answer path received it.
 * `option` is one of the card's own options; `message` is the optional text
 * a "No" (or "Keep planning") carries, which Claude receives as the denied
 * tool's result. `cancel` is the card's universal Cancel (Esc) action, which
 * on a held card is a "No". `selections` is a structured AskUserQuestion
 * answer (#1127), not yet validated.
 */
export type HeldAnswer =
  | { readonly kind: 'option'; readonly option: QuestionOption; readonly message?: string }
  | { readonly kind: 'cancel' }
  /** Free text, or an answer matching none of the card's options. Only a
   *  one-question, single-select AskUserQuestion takes it (as that
   *  question's answer, #1127); any other live hold refuses it. */
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'selections'; readonly selections: readonly AnswerSelection[] }
  /** A plain answer that is one option's value and a different option's
   *  label (#1127 review S1): never resolved to either, so a live hold
   *  refuses it. */
  | { readonly kind: 'ambiguous' };

/**
 * What `answerHeld` did with a phone answer (#1126):
 *   - `resolved`: the hook answered with the user's choice.
 *   - `refused`: the hold is live but the answer is not one its card offers
 *     (an unknown option, a standing grant whose suggestion is gone); nothing
 *     changed, the card and the hold stay.
 *   - `closed`: a binary prompt this gate held whose hold has ended (answered
 *     in the terminal, released at the deadline, aborted). Its answer belongs
 *     to the terminal now; nothing may be typed for it.
 *   - `unknown`: not a prompt this gate held (a hook-less prompt, a
 *     multi-choice permission); the caller's own path applies.
 *   - `authority-refused`: the final commit refused; the live hold and card
 *     remain, and no hook response, socket result or PTY input was accepted.
 */
export type HeldAnswerOutcome = 'resolved' | 'refused' | 'closed' | 'unknown' | 'authority-refused';
