/**
 * Extract the real user-facing question + options a tool poses in its
 * PermissionRequest, for tools whose escalation is genuinely the user's decision
 * (AskUserQuestion, ExitPlanMode). Without this the `HookEventBridge` falls back
 * to "Allow <tool>" + the default Yes / Yes, always / No, which is wrong for a
 * multi-option plan/design question (#597) — the user sees a generic prompt and
 * the wrong choices on both the in-app card and the lock-screen notification.
 *
 * The options are PICKS: `value` is the 1-based index and `isYes`/`isNo` are
 * always false. That routes a user's answer through the daemon's release-hook +
 * submit-digit path (a binary allow/deny response cannot express "pick option 2"),
 * so the ORDER here MUST match the order the tool passes — which is the order
 * Claude renders in its native numbered prompt once the held hook is released.
 */

import type { QuestionOption, QuestionStep } from '@remi/shared';

export interface ToolQuestion {
  readonly text: string;
  readonly options: QuestionOption[];
  /** #626: 'multi_question' for an AskUserQuestion-shaped tool (structured
   *  sub-questions in `questions`). Absent for a plain single prompt. */
  readonly kind?: 'multi_question';
  /** #626: the full sub-question set (header / text / multiSelect / options with
   *  descriptions). `text`/`options` above mirror `questions[0]` for back-compat. */
  readonly questions?: QuestionStep[];
  /** #626: submit-button label for the multi-question form. */
  readonly submitLabel?: string;
}

/**
 * Collapse runs of whitespace (newlines, the column padding a PTY leaves behind)
 * to single spaces and trim — WITHOUT removing the single spaces between words.
 * tool_input text is already clean, but normalising here keeps a multi-line
 * `question` from rendering as separate lines in the notification body.
 */
function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A pick option: 1-based value, never yes/no-shaped so the answer path releases
 * the held hook and submits the digit rather than resolving a binary allow/deny.
 * Index 0 is marked recommended only to match the existing option convention
 * (display-only; it does not change which digit is submitted).
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

/**
 * ExitPlanMode's choices are NOT in tool_input (only the `plan` markdown is) —
 * they are Claude Code's built-in plan-approval options. Kept in the SAME order
 * Claude renders, because a pick's submitted digit lands on whatever Claude has
 * at that position once the held hook releases — a wrong order is a silent
 * wrong-pick. This order matches the maintainer's live observation 2026-06-19
 * ("1 = auto mode, 2 = manual mode"). Reverify on each Claude Code release and
 * update if it drifts — tracked in #598.
 */
const EXIT_PLAN_MODE_OPTIONS: readonly string[] = [
  'Yes, and auto-accept edits',
  'Yes, and manually approve edits',
  'No, keep planning',
];

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
): ToolQuestion | null {
  if (toolName === 'ExitPlanMode') {
    return {
      text: 'Plan ready for review. How do you want to proceed?',
      options: EXIT_PLAN_MODE_OPTIONS.map((label, i) => pickOption(label, i)),
    };
  }

  // AskUserQuestion AND shape-compatible tools (intentional, not name-gated): any
  // tool whose tool_input carries `questions: [{ question, options }]`. This
  // mirrors the auto-approve `isDesignQuestion` detector (multichoice.ts), which
  // routes the SAME shape to always-escalate — so an MCP/custom tool that mimics
  // AskUserQuestion gets its real options surfaced here too, consistently. The
  // shape guards (record with a `question` string + a non-empty `options` array)
  // are tight, so a tool with an unrelated `questions` field returns null and
  // falls through to permission_suggestions.
  //
  // #626: surface the FULL set of sub-questions (header / text / multiSelect /
  // options with descriptions) as `questions`, not just the first. `text`/
  // `options` mirror questions[0] for back-compat: the lock-screen summary and
  // the first-question answer path (digit submit) still read the flat fields.
  if (!isRecord(toolInput)) return null;
  const rawQuestions = toolInput['questions'];
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const steps = rawQuestions.map(buildStep).filter((s): s is QuestionStep => s !== null);
  const first = steps[0];
  if (!first) return null;
  return {
    text: first.header ? `${first.header}: ${first.text}` : first.text,
    options: [...first.options],
    kind: 'multi_question',
    questions: steps,
    submitLabel: 'Submit',
  };
}
