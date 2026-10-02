/**
 * Structured hook answers for AskUserQuestion and ExitPlanMode (#1127, ADR
 * 0031 amendment).
 *
 * Both tools reach remi as a `PermissionRequest` that is held like a binary
 * prompt (#1126): Claude's own dialog renders during the hold, and a phone
 * answer becomes the hook response. Neither can be answered with a bare
 * `allow`; Claude needs the tool's input back with the answer in it. Verified
 * live on Claude Code 2.1.287 (#1126 spike, E3 and E4):
 *
 *   - AskUserQuestion: `{behavior: "allow", updatedInput: {questions: <echo>,
 *     answers: {"<question text>": "<label>"}}}`. A multi-select answer is its
 *     labels joined with ", " as one string; free text (not a label) is
 *     accepted as the answer.
 *   - ExitPlanMode: `{behavior: "allow", updatedInput: {plan, planFilePath}
 *     <echo>, updatedPermissions: [{type: "setMode", mode, destination:
 *     "session"}]}` approves the plan and sets the mode; an `allow` without
 *     `updatedInput` is silently ignored (the dialog stays). `{behavior:
 *     "deny", message}` keeps Claude in plan mode, and it revises and asks
 *     again.
 *
 * Everything here is pure, so the mapping can be tested without a gate. The
 * gate (`AutoApproveGate.answerHeld`) calls it with the tool input it stashed
 * when the hold began; nothing in an answer is trusted (the protocol does not
 * validate `selections`), and every answer the user did not fully give is
 * refused, never completed with a guess.
 */

import type { QuestionOption, QuestionStep } from '@remi/shared';

import type { PermissionDecision } from './hook-server.ts';

/**
 * Collapse runs of whitespace (newlines, the column padding a PTY leaves
 * behind) to single spaces and trim, keeping the single spaces between
 * words. Display only: an answer is always built from the raw tool input,
 * never from a cleaned label.
 */
export function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Longest free-text answer passed to Claude. A phone keyboard can paste a
 *  novel; Claude reads this as the user's answer, so it is bounded. */
export const FREE_TEXT_MAX = 2000;

/** One AskUserQuestion option exactly as Claude sent it. */
export interface AskOptionSpec {
  /** The raw label: what an answer must carry, byte for byte. */
  readonly label: string;
  readonly description: string | undefined;
}

/** One AskUserQuestion question exactly as Claude sent it. */
export interface AskQuestionSpec {
  /** The raw question text: the key of its entry in `answers`. */
  readonly question: string;
  readonly header: string | undefined;
  readonly multiSelect: boolean;
  readonly options: readonly AskOptionSpec[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** One option entry: a `{label, description?}` object (what Claude sends) or
 *  a bare label string. Null for anything else. */
function parseOption(entry: unknown): AskOptionSpec | null {
  if (nonEmptyString(entry)) return { label: entry, description: undefined };
  if (!isRecord(entry) || !nonEmptyString(entry['label'])) return null;
  const description = entry['description'];
  return {
    label: entry['label'],
    description: nonEmptyString(description) ? description : undefined,
  };
}

/**
 * The AskUserQuestion input as answerable questions, or null when any part
 * of it cannot be answered exactly: no `questions` array, a question with no
 * text or no options, an unusable option, a non-boolean `multiSelect`, two
 * questions with the same text (one `answers` key could not tell them apart),
 * or two options of one question with the same label.
 *
 * Strict on purpose: the card's options are numbered from this list, and an
 * answer names options by index, so a single dropped entry would shift every
 * index after it onto a different label. Claude validates the tool input
 * before it asks, so a real call parses; a null here means "answer in the
 * terminal".
 */
export function parseAskUserQuestion(toolInput: unknown): readonly AskQuestionSpec[] | null {
  if (!isRecord(toolInput)) return null;
  const raw = toolInput['questions'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestionSpec[] = [];
  const texts = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || !nonEmptyString(entry['question'])) return null;
    const multiSelect = entry['multiSelect'];
    if (multiSelect !== undefined && typeof multiSelect !== 'boolean') return null;
    const rawOptions = entry['options'];
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null;
    const options: AskOptionSpec[] = [];
    const labels = new Set<string>();
    for (const rawOption of rawOptions) {
      const option = parseOption(rawOption);
      if (option === null || labels.has(option.label)) return null;
      labels.add(option.label);
      options.push(option);
    }
    const question = entry['question'];
    if (texts.has(question)) return null;
    texts.add(question);
    const header = entry['header'];
    questions.push({
      question,
      header: nonEmptyString(header) ? header : undefined,
      multiSelect: multiSelect === true,
      options,
    });
  }
  return questions;
}

/**
 * A card pick for option `index` of an AskUserQuestion question. `value` is
 * the 1-based index; `isYes`/`isNo` are always false (a pick, not a
 * permission). Index 0 is marked recommended only to match the existing
 * option convention (display only).
 */
function pickOption(option: AskOptionSpec, index: number): QuestionOption {
  const description = option.description ? cleanText(option.description) : '';
  return {
    label: cleanText(option.label),
    value: String(index + 1),
    isRecommended: index === 0,
    isYes: false,
    isNo: false,
    ...(description.length > 0 ? { description } : {}),
  };
}

/** The card's sub-questions for a parsed AskUserQuestion, one per question,
 *  each option at the index an answer names it by. */
export function askQuestionSteps(questions: readonly AskQuestionSpec[]): QuestionStep[] {
  return questions.map((q) => ({
    ...(q.header ? { header: cleanText(q.header) } : {}),
    text: cleanText(q.question),
    multiSelect: q.multiSelect,
    options: q.options.map(pickOption),
  }));
}

/** Why an AskUserQuestion answer was refused. The hold stays; nothing is
 *  sent to Claude. */
export type AskRefusal =
  | 'unanswerable-input'
  | 'malformed-selections'
  | 'unknown-question'
  | 'duplicate-question'
  | 'unanswered-question'
  | 'bad-option-index'
  | 'single-select-needs-one-answer'
  | 'multi-select-needs-a-label';

/** An AskUserQuestion answer mapped to its hook response, or refused. */
export type AskAnswerResult =
  | { readonly ok: true; readonly decision: PermissionDecision }
  | { readonly ok: false; readonly reason: AskRefusal };

function refuse(reason: AskRefusal): AskAnswerResult {
  return { ok: false, reason };
}

/** The option indices of one selection: distinct integers, in range, sorted
 *  as the dialog lists them. Null when any entry is not such an index. */
function optionIndices(raw: unknown, optionCount: number): number[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  for (const i of raw) {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= optionCount) return null;
    if (seen.has(i)) return null;
    seen.add(i);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Map the phone's answer to an AskUserQuestion to its hook response:
 * `{behavior: "allow", updatedInput: {...toolInput, answers}}`, where
 * `toolInput` (and so `questions`) is echoed unchanged and `answers` maps
 * each raw question text to its answer.
 *
 * Every question must be answered exactly once, and an answer must be one
 * the user gave in full:
 *   - single-select: exactly one option, or free text instead (never both);
 *   - multi-select: one or more options, their raw labels joined with ", " in
 *     the dialog's order. Free text is not offered for a multi-select here:
 *     only labels were verified for it (#1126 spike E3).
 * Anything else is refused, and the caller keeps the hold: a partial answer
 * is never completed with a guess.
 */
export function askUserQuestionDecision(
  toolInput: Readonly<Record<string, unknown>>,
  selections: unknown,
): AskAnswerResult {
  const questions = parseAskUserQuestion(toolInput);
  if (questions === null) return refuse('unanswerable-input');
  if (!Array.isArray(selections) || selections.length === 0) {
    return refuse('malformed-selections');
  }
  // A prototype-free map: a question whose text is `__proto__` (or any other
  // Object.prototype name) must become an own key like every other, never
  // the object's prototype.
  const answers: Record<string, string> = Object.create(null);
  const answered = new Set<number>();
  for (const entry of selections as readonly unknown[]) {
    // One sub-question's answer as the phone sent it (`AnswerSelection`),
    // not yet trusted.
    if (!isRecord(entry)) return refuse('malformed-selections');
    const questionIndex = entry['questionIndex'];
    const text = entry['text'];
    if (
      typeof questionIndex !== 'number' ||
      !Number.isInteger(questionIndex) ||
      questionIndex < 0 ||
      questionIndex >= questions.length
    ) {
      return refuse('unknown-question');
    }
    if (answered.has(questionIndex)) return refuse('duplicate-question');
    answered.add(questionIndex);
    const question = questions[questionIndex] as AskQuestionSpec;
    const indices = optionIndices(entry['optionIndices'], question.options.length);
    if (indices === null) return refuse('bad-option-index');
    if (text !== undefined && typeof text !== 'string') return refuse('malformed-selections');
    const freeText = typeof text === 'string' ? text.trim().slice(0, FREE_TEXT_MAX) : '';
    const labels = indices.map((i) => (question.options[i] as AskOptionSpec).label);
    if (question.multiSelect) {
      if (labels.length === 0 || freeText.length > 0) return refuse('multi-select-needs-a-label');
      answers[question.question] = labels.join(', ');
    } else {
      const given = labels.length + (freeText.length > 0 ? 1 : 0);
      if (given !== 1) return refuse('single-select-needs-one-answer');
      answers[question.question] = labels[0] ?? freeText;
    }
  }
  if (answered.size !== questions.length) return refuse('unanswered-question');
  return { ok: true, decision: { behavior: 'allow', updatedInput: { ...toolInput, answers } } };
}

/**
 * The option index a card pick names for a one-question AskUserQuestion
 * (the lock screen and Telegram send a single option, not `selections`), or
 * null when the pick is not exactly one of that question's options. Both the
 * value (its 1-based index) and the displayed label must agree with the
 * parsed input, so a card that does not match the input answers nothing.
 */
export function askOptionIndex(
  questions: readonly AskQuestionSpec[],
  option: QuestionOption,
): number | null {
  const only = questions.length === 1 ? questions[0] : undefined;
  if (only === undefined || only.multiSelect) return null;
  const index = Number(option.value) - 1;
  const spec = Number.isInteger(index) ? only.options[index] : undefined;
  if (spec === undefined) return null;
  return cleanText(spec.label) === option.label ? index : null;
}

/** The message Claude receives when the user dismisses an AskUserQuestion
 *  from the phone (Cancel): a deny, so its dialog closes and Claude reads why. */
export const ASK_DISMISSED_MESSAGE = 'The user dismissed the question.';

// ---------------------------------------------------------------------------
// ExitPlanMode
// ---------------------------------------------------------------------------

/** What a plan card's option does. */
type PlanChoice =
  | { readonly kind: 'approve'; readonly mode: 'acceptEdits' | 'default' }
  | { readonly kind: 'keep-planning' };

interface PlanOptionDef {
  readonly label: string;
  readonly value: string;
  readonly choice: PlanChoice;
}

/**
 * The plan card's options, built by meaning (#1127 lead decision), never
 * copied from Claude's dialog, whose list is model-dependent ("Yes, and use
 * auto mode" appears only when auto mode is available). `auto` is not
 * offered: its availability is not knowable from the hook payload; the
 * terminal dialog still offers it.
 */
const PLAN_OPTIONS: readonly PlanOptionDef[] = [
  {
    label: 'Approve, auto-accept edits',
    value: '1',
    choice: { kind: 'approve', mode: 'acceptEdits' },
  },
  {
    label: 'Approve, approve edits manually',
    value: '2',
    choice: { kind: 'approve', mode: 'default' },
  },
  { label: 'Keep planning', value: '3', choice: { kind: 'keep-planning' } },
];

/** The deny message when the user keeps planning without saying why. */
export const KEEP_PLANNING_MESSAGE = 'Keep planning.';

/**
 * The plan card's options. Both approvals are `isYes` (they change the
 * session's permission mode, so no lock-screen category offers them: the
 * push sends a plan card with none); "Keep planning" is the `isNo`.
 */
export function exitPlanModeOptions(): QuestionOption[] {
  return PLAN_OPTIONS.map((o, i) => ({
    label: o.label,
    value: o.value,
    isRecommended: i === 0,
    isYes: o.choice.kind === 'approve',
    isNo: o.choice.kind === 'keep-planning',
  }));
}

/** Trim and bound a user's message to Claude; empty means none. */
function boundedMessage(message: string | undefined): string {
  return typeof message === 'string' ? message.trim().slice(0, FREE_TEXT_MAX) : '';
}

/**
 * Map a plan card's option to its hook response, or null when the option is
 * not one of the plan card's own (label and value must both match):
 *   - an approval: `allow` + `updatedInput` (the tool input echoed
 *     unchanged: `plan` and `planFilePath`) + a `setMode` to the option's
 *     mode, always with `destination: "session"`;
 *   - "Keep planning": `deny` with the user's message, or "Keep planning.".
 */
export function exitPlanModeDecision(
  toolInput: Readonly<Record<string, unknown>>,
  option: QuestionOption,
  message?: string,
): PermissionDecision | null {
  const def = PLAN_OPTIONS.find((o) => o.label === option.label && o.value === option.value);
  if (def === undefined) return null;
  if (def.choice.kind === 'keep-planning') return keepPlanningDecision(message);
  return {
    behavior: 'allow',
    updatedInput: { ...toolInput },
    updatedPermissions: [{ type: 'setMode', mode: def.choice.mode, destination: 'session' }],
  };
}

/** The "Keep planning" response: a deny Claude reads as the reason, so it
 *  stays in plan mode, revises, and asks again. Also what Cancel sends. */
export function keepPlanningDecision(message?: string): PermissionDecision {
  const text = boundedMessage(message);
  return { behavior: 'deny', message: text.length > 0 ? text : KEEP_PLANNING_MESSAGE };
}
