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

import type { QuestionOption } from '@remi/shared';

export interface ToolQuestion {
  readonly text: string;
  readonly options: QuestionOption[];
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
function pickOption(label: string, index: number): QuestionOption {
  return {
    label: cleanText(label),
    value: String(index + 1),
    isRecommended: index === 0,
    isYes: false,
    isNo: false,
  };
}

/**
 * ExitPlanMode's choices are NOT in tool_input (only the `plan` markdown is) —
 * they are Claude Code's built-in plan-approval options. Kept in the SAME order
 * Claude renders so a pick's submitted digit lands on the intended choice. If
 * Claude changes this set, the labels (display) drift but the positional digit
 * still maps; update here when that happens.
 */
const EXIT_PLAN_MODE_OPTIONS: readonly string[] = [
  'Yes, and auto-accept edits',
  'Yes, and manually approve edits',
  'No, keep planning',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** One option label from an AskUserQuestion option entry (a string, or `{label}`). */
function optionLabel(entry: unknown): string | null {
  if (typeof entry === 'string' && entry.trim().length > 0) return entry;
  if (isRecord(entry) && typeof entry['label'] === 'string' && entry['label'].trim().length > 0) {
    return entry['label'];
  }
  return null;
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

  // AskUserQuestion (and shape-compatible tools): `tool_input.questions[]`, each
  // with a `question` string + `options` (strings or `{label}`). Remi answers one
  // prompt at a time, so surface the FIRST question; a multi-question call still
  // shows the first correctly and the rest fall to Claude's native prompt on
  // release. A `header` (short topic) prefixes the question when present.
  if (!isRecord(toolInput)) return null;
  const questions = toolInput['questions'];
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first = questions[0];
  if (!isRecord(first)) return null;
  const qText = typeof first['question'] === 'string' ? cleanText(first['question']) : '';
  const rawOptions = first['options'];
  if (qText.length === 0 || !Array.isArray(rawOptions)) return null;
  const labels = rawOptions.map(optionLabel).filter((l): l is string => l !== null);
  if (labels.length === 0) return null;
  const header = typeof first['header'] === 'string' ? cleanText(first['header']) : '';
  return {
    text: header ? `${header}: ${qText}` : qText,
    options: labels.map((label, i) => pickOption(label, i)),
  };
}
