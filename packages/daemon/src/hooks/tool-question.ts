/**
 * Extract the real user-facing question + options a tool poses in its
 * PermissionRequest, for tools whose escalation is genuinely the user's decision
 * (AskUserQuestion, ExitPlanMode). Without this the `HookEventBridge` falls back
 * to "Allow <tool>" + whatever `optionsFromSuggestions` derives (or the honest
 * Yes/No 2-set, #718), which is wrong for a multi-option plan/design question
 * (#597) — the user sees a generic prompt and the wrong choices on both the
 * in-app card and the lock-screen notification.
 *
 * Since #1127 both tools' prompts are held and answered through the hook
 * (`structured-answers.ts`), never typed: an AskUserQuestion card's picks are
 * numbered by the index an answer names them by (1-based `value`), and an
 * ExitPlanMode card's options are built by meaning. A shape-compatible tool
 * that is not AskUserQuestion (an MCP or custom tool carrying `questions`)
 * keeps the lenient card below and is not held: a pick on it takes the
 * guarded typed path (#1134), which refuses it unless Claude's screen shows
 * the same label at the same number.
 */

import type { QuestionOption, QuestionStep } from '@remi/shared';

import {
  askQuestionSteps,
  cleanText,
  exitPlanModeOptions,
  parseAskUserQuestion,
} from './structured-answers.ts';

export interface ToolQuestion {
  readonly text: string;
  readonly options: QuestionOption[];
  /** #626: 'multi_question' for an AskUserQuestion-shaped tool (structured
   *  sub-questions in `questions`); #1127: 'plan_approval' for ExitPlanMode.
   *  Absent for a plain single prompt. */
  readonly kind?: 'multi_question' | 'plan_approval';
  /** #626: the full sub-question set (header / text / multiSelect / options with
   *  descriptions). `text`/`options` above mirror `questions[0]` for back-compat. */
  readonly questions?: QuestionStep[];
  /** #626: submit-button label for the multi-question form. */
  readonly submitLabel?: string;
  /** #1127: the plan an ExitPlanMode asks to approve, verbatim. */
  readonly detail?: string;
  /** #1127 review S7: an AskUserQuestion that did not parse exactly; no
   *  phone answer can be applied to it (see `Question.terminalOnly`). */
  readonly terminalOnly?: boolean;
}

/**
 * A pick option: 1-based value, never yes/no-shaped.
 * Index 0 is marked recommended only to match the existing option convention
 * (display-only).
 */
function pickOption(label: string, index: number, description?: string): QuestionOption {
  const desc = description ? cleanText(description) : '';
  return {
    label: cleanText(label),
    value: String(index + 1),
    isRecommended: index === 0,
    isYes: false,
    isNo: false,
    ...(desc.length > 0 ? { description: desc } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One option from an AskUserQuestion option entry: a plain string label, or
 *  `{ label, description? }`. Returns null for an unusable entry (#626). */
function optionEntry(entry: unknown): { label: string; description?: string } | null {
  if (typeof entry === 'string' && entry.trim().length > 0) return { label: entry };
  if (isRecord(entry) && typeof entry['label'] === 'string' && entry['label'].trim().length > 0) {
    const rawDesc = entry['description'];
    const description =
      typeof rawDesc === 'string' && rawDesc.trim().length > 0 ? rawDesc : undefined;
    return description ? { label: entry['label'], description } : { label: entry['label'] };
  }
  return null;
}

/** Build one {@link QuestionStep} from a raw AskUserQuestion entry (#626), or
 *  null when it lacks a usable question text + options. Pure + total. */
function buildStep(raw: unknown): QuestionStep | null {
  if (!isRecord(raw)) return null;
  const text = typeof raw['question'] === 'string' ? cleanText(raw['question']) : '';
  const rawOptions = raw['options'];
  if (text.length === 0 || !Array.isArray(rawOptions)) return null;
  const entries = rawOptions
    .map(optionEntry)
    .filter((e): e is { label: string; description?: string } => e !== null);
  if (entries.length === 0) return null;
  const rawHeader = raw['header'];
  const header =
    typeof rawHeader === 'string' && rawHeader.trim().length > 0 ? cleanText(rawHeader) : undefined;
  return {
    ...(header ? { header } : {}),
    text,
    multiSelect: raw['multiSelect'] === true,
    options: entries.map((e, i) => pickOption(e.label, i, e.description)),
  };
}

/**
 * Extract the real question + options for a question-bearing tool, or null when
 * the tool does not carry one (the caller keeps its `permission_suggestions` /
 * default fallback). Pure + total: never throws on a malformed tool_input.
 */
export function extractToolQuestion(
  toolName: string,
  toolInput: Record<string, unknown> | null | undefined,
  opts: { readonly subagent?: boolean } = {},
): ToolQuestion | null {
  if (toolName === 'ExitPlanMode') {
    // #1127: the options are remi's own, by meaning (Claude's dialog list is
    // model-dependent); the plan itself rides as `detail`. A subagent's plan
    // offers an approval that sets no session mode (review S5).
    const plan = isRecord(toolInput) ? toolInput['plan'] : undefined;
    return {
      text: 'Plan ready for review',
      options: exitPlanModeOptions(opts.subagent === true),
      kind: 'plan_approval',
      ...(typeof plan === 'string' && plan.trim().length > 0 ? { detail: plan } : {}),
    };
  }

  // #1127: an AskUserQuestion whose input parses exactly is numbered from
  // that parse, so a card option's index is the index the answer names. One
  // that does not parse exactly gets the lenient card, marked `terminalOnly`
  // (review S7): the gate refuses every phone answer to it.
  if (toolName === 'AskUserQuestion') {
    const parsed = parseAskUserQuestion(toolInput);
    if (parsed !== null) return multiQuestion(askQuestionSteps(parsed));
    const lenient = lenientQuestion(toolInput);
    return lenient === null ? null : { ...lenient, terminalOnly: true };
  }
  return lenientQuestion(toolInput);
}

/**
 * The lenient card for a `questions`-shaped input, or null: an
 * AskUserQuestion that did not parse exactly (marked `terminalOnly` by the
 * caller, since every phone answer to it is refused), and shape-compatible
 * tools (intentional, not name-gated): any tool whose
 * tool_input carries `questions: [{ question, options }]`. This mirrors the
 * `isDesignQuestion` detector (multichoice.ts), which routes the SAME shape
 * to a pushed card, so an MCP/custom tool that mimics AskUserQuestion gets
 * its real options surfaced here too. Malformed entries are dropped, so its
 * option numbers need not match the input's. The shape guards (record with
 * a `question` string + a non-empty `options` array) are tight, so a tool
 * with an unrelated `questions` field returns null and falls through to
 * permission_suggestions.
 *
 * #626: surface the FULL set of sub-questions (header / text / multiSelect /
 * options with descriptions) as `questions`, not just the first. `text`/
 * `options` mirror questions[0] for back-compat (the lock-screen summary).
 */
function lenientQuestion(
  toolInput: Record<string, unknown> | null | undefined,
): ToolQuestion | null {
  if (!isRecord(toolInput)) return null;
  const rawQuestions = toolInput['questions'];
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const steps = rawQuestions.map(buildStep).filter((s): s is QuestionStep => s !== null);
  return steps.length > 0 ? multiQuestion(steps) : null;
}

/** The multi-question card for `steps` (at least one); `text`/`options`
 *  mirror the first step for back-compat. */
function multiQuestion(steps: QuestionStep[]): ToolQuestion {
  const first = steps[0] as QuestionStep;
  return {
    text: first.header ? `${first.header}: ${first.text}` : first.text,
    options: [...first.options],
    kind: 'multi_question',
    questions: steps,
    submitLabel: 'Submit',
  };
}
