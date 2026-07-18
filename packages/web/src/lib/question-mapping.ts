/**
 * Maps a wire `Question` (daemon) to the client's `UIQuestion` shape.
 *
 * Extracted from App.tsx's `question` message handler (#718 review) so the
 * mapping — in particular, faithfully carrying `optionsAreFallback` — is
 * unit-testable independent of the WebSocket/React plumbing. Pure function,
 * no side effects.
 */

import type { Question, Timestamp, UUID } from '@remi/shared';
import type { UIQuestion, UIQuestionOption } from '@/types';

/**
 * Classify the UI question type from its option shape.
 * yes_no ONLY for exactly 2 options with clear yes+no; multi_option for 3+
 * options (even if they include yes/no); numbered for options without
 * yes/no semantics; free_text when there are no options at all.
 */
function classifyQuestionType(options: Question['options']): UIQuestion['type'] {
  if (options.length === 0) return 'free_text';
  if (options.length === 2) {
    const hasYes = options.some((o) => o.isYes);
    const hasNo = options.some((o) => o.isNo);
    return hasYes && hasNo ? 'yes_no' : 'multi_option';
  }
  // 3+ options: always show all of them.
  const hasYesNo = options.some((o) => o.isYes || o.isNo);
  return hasYesNo ? 'multi_option' : 'numbered';
}

function toUIQuestionOption(o: Question['options'][number]): UIQuestionOption {
  return {
    label: o.label,
    value: o.value,
    isYes: o.isYes || undefined,
    isNo: o.isNo || undefined,
    isRecommended: o.isRecommended || undefined,
    description: o.description || undefined,
  };
}

/**
 * Map a daemon `Question` to a `UIQuestion`. `sessionId` is passed in
 * separately (from the enclosing `QuestionMessage`) since the caller is
 * responsible for the "sessionId is mandatory" guard (#437) before calling
 * this — a malformed message with no sessionId is dropped upstream, never
 * reaching this pure mapping.
 *
 * `wireTimestamp` (#798 part 4) should be the enclosing `QuestionMessage`'s own
 * `timestamp` when the caller has one — preferred over local receipt time so a
 * card born from a delayed/replayed message shows its true age instead of
 * always reading "Just now". Falls back to the current time when omitted or
 * malformed (e.g. a caller with no wire message to hand, or a bad timestamp).
 */
export function mapQuestionToUIQuestion(
  q: Question,
  sessionId: UUID,
  wireTimestamp?: Timestamp,
): UIQuestion {
  const structuredOptions = q.options.map(toUIQuestionOption);

  // #626: carry the full AskUserQuestion structure (headers, per-option
  // descriptions, multiSelect) so the card can render it properly.
  const uiQuestions: UIQuestion['questions'] = q.questions?.map((step) => ({
    ...(step.header ? { header: step.header } : {}),
    text: step.text,
    multiSelect: step.multiSelect,
    options: step.options.map(toUIQuestionOption),
  }));

  const timestamp =
    wireTimestamp !== undefined && Number.isFinite(Date.parse(wireTimestamp))
      ? wireTimestamp
      : new Date().toISOString();

  return {
    id: q.id,
    sessionId,
    type: classifyQuestionType(q.options),
    prompt: q.text,
    options: q.options.length > 0 ? q.options.map((o) => o.label) : undefined,
    structuredOptions: structuredOptions.length > 0 ? structuredOptions : undefined,
    timestamp,
    agentId: q.agentId,
    ...(q.kind ? { kind: q.kind } : {}),
    ...(uiQuestions && uiQuestions.length > 0 ? { questions: uiQuestions } : {}),
    ...(q.submitLabel ? { submitLabel: q.submitLabel } : {}),
    // #718 review: carry an explicit `false` too, not just `true` — a naive
    // `q.optionsAreFallback ? {...} : {}` collapses `false` (set by the PTY
    // parser on a genuine y/n prompt) to `undefined`, which the question-merge
    // guard treats as "no signal, fall back to label matching" instead of
    // "authoritatively NOT the fallback" — misclassifying a real Yes/No
    // question as the bland default (#407 class regression).
    ...(q.optionsAreFallback !== undefined
      ? { optionsAreFallback: q.optionsAreFallback }
      : {}),
  };
}
