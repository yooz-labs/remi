/**
 * Question Parser - Detects when Claude (or a subprocess it runs) is genuinely
 * waiting for the user to choose or answer, and extracts the options.
 *
 * Detection is gated on REAL signals, never on text shape (epic #415: the PTY
 * answers "is a prompt on screen right now?", not "does this text look like a
 * question?"):
 *
 *  1. Claude's interactive selection box - rendered with a `❯` cursor sitting
 *     on the active numbered option. This single renderer covers yes/no,
 *     permission, AND multi-choice prompts, so it is the primary, highest-
 *     confidence signal.
 *  2. Literal `(y/n)` / `[y/n]` - emitted by SUBPROCESSES Claude runs (git,
 *     npm, shell scripts) that prompt on the PTY. Specific; low false-positive.
 *  3. Explicit free-text waiting markers ("enter your response", "press enter
 *     to continue") - also from subprocesses.
 *
 * Deliberately NOT detected, because these were the false-positive sources the
 * user reported: a plain numbered list Claude prints in its answer (no `❯`
 * cursor on any line), or prose that merely ends in `?`. A list or a sentence
 * is not a prompt.
 */

import { generateId } from '@remi/shared';
import type { Question, QuestionOption } from '@remi/shared';
import { cleanForParsing, splitLines } from './ansi.ts';

/** Pattern types we can detect */
export type QuestionType = 'yes_no' | 'numbered' | 'permission' | 'free_text';

/** Result of parsing attempt */
export interface ParseResult {
  /** Whether a question was detected */
  readonly detected: boolean;

  /** Detected question (if any) */
  readonly question?: Question;

  /** Type of question detected */
  readonly type?: QuestionType;

  /** Confidence level 0-1 */
  readonly confidence: number;
}

/** Patterns for detecting different question types */
const PATTERNS = {
  // Yes/No literals emitted by subprocesses (NOT Claude's own prompts, which
  // render as a selection box - see PROMPT_CHROME).
  yesNo: [
    /\(y\/n\)\s*$/i,
    /\(yes\/no\)\s*$/i,
    /\[y\/n\]\s*$/i,
    /\[yes\/no\]\s*$/i,
    /\?\s*\(y\)\s*$/i,
  ],

  // Numbered option line: "1. Option" or "1) Option". A space after the
  // delimiter is REQUIRED here because this drives `parseNumberedOptions`,
  // which parses clean, space-preserved text (e.g. hook permission_suggestions
  // or inline "(1) Yes (2) No"). The PTY selection-box path uses CHROME_OPTION
  // below, where ANSI stripping has collapsed the spacing.
  numberedOption: /^\s*(\d+)[.)]\s+(.+)$/,

  // Explicit free-text waiting indicators (subprocess prompts).
  waiting: [
    /waiting for input/i,
    /enter your response/i,
    /type your answer/i,
    /press enter to continue/i,
  ],
} as const;

/**
 * Claude Code selection-box chrome: the `❯` cursor sitting on a numbered
 * option. After ANSI stripping the inter-glyph spacing collapses (e.g.
 * "❯1.Yes"), so spaces are optional; `[^\S\n]` keeps the match on a SINGLE
 * line so the empty input box ("❯ ") cannot pair with an unrelated numbered
 * list line below it. This is the discriminator between a real prompt and a
 * list Claude merely printed.
 */
const PROMPT_CHROME = /❯[^\S\n]*\d+[.)]/;

/**
 * A single option line inside a selection box. Tolerates an optional `❯`
 * cursor, optional box borders, and collapsed spacing. Group 1 = cursor (if
 * present), group 2 = number, group 3 = label (trailing border stripped by
 * the caller).
 */
const CHROME_OPTION = /^[\s│|>]*(❯)?[^\S\n]*(\d+)[.)][^\S\n]*(.*)$/;

/**
 * Parse terminal output to detect questions.
 *
 * @param rawOutput - Raw terminal output (may contain ANSI codes)
 * @returns Parse result with detected question
 */
export function parseQuestion(rawOutput: string): ParseResult {
  const text = cleanForParsing(rawOutput);
  const lines = splitLines(text).filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { detected: false, confidence: 0 };
  }

  // 1. Claude's interactive selection box (yes/no, permission, multi-choice).
  const chrome = parseChromePrompt(lines);
  if (chrome) {
    return { detected: true, type: 'numbered', confidence: 0.95, question: chrome };
  }

  // 2. Literal y/n from a subprocess.
  const yesNo = tryParseYesNo(lines);
  if (yesNo?.detected) {
    return yesNo;
  }

  // 3. Explicit free-text waiting marker from a subprocess.
  const waiting = tryParseWaiting(lines);
  if (waiting?.detected) {
    return waiting;
  }

  return { detected: false, confidence: 0 };
}

/**
 * Parse a Claude Code selection box. Returns a Question only when the `❯`
 * cursor is present on one of at least two contiguous, sequentially-numbered
 * option lines. A plain numbered list has no cursor and so returns null.
 */
function parseChromePrompt(lines: readonly string[]): Question | null {
  const options: QuestionOption[] = [];
  let cursorSeen = false;
  let firstOptionIdx = -1;
  let expected = 1;

  for (let i = 0; i < lines.length; i++) {
    const match = CHROME_OPTION.exec(lines[i] ?? '');
    if (!match) {
      // A non-option line ends the contiguous block once we have started.
      if (options.length > 0) break;
      continue;
    }

    const num = Number.parseInt(match[2] ?? '', 10);
    // Options must be sequential starting at 1. A stray "3." in prose before
    // the real block is ignored; a break mid-block ends collection.
    if (num !== expected) {
      if (options.length > 0) break;
      continue;
    }

    if (firstOptionIdx === -1) firstOptionIdx = i;
    if (match[1] === '❯') cursorSeen = true;
    const label = (match[3] ?? '').replace(/[\s│|]+$/, '').trim();
    options.push(
      createOption(label || `Option ${num}`, String(num), options.length === 0, false, false),
    );
    expected++;
  }

  // The cursor is the discriminator: a printed list has no `❯` on any option
  // line. Require it plus at least two options.
  if (!cursorSeen || options.length < 2) {
    return null;
  }

  const questionText = firstOptionIdx > 0 ? extractPromptText(lines.slice(0, firstOptionIdx)) : '';
  return createQuestion(questionText || 'Select an option:', options, true);
}

/**
 * Best-effort prompt text: the nearest preceding line with letters, stripped
 * of box-drawing chrome. The authoritative text/labels are supplied by the
 * matching hook record when one exists (see QuestionPresenceTracker merge).
 */
function extractPromptText(before: readonly string[]): string {
  for (let i = before.length - 1; i >= 0; i--) {
    const t = (before[i] ?? '').replace(/[│|╭╮╰╯─━═]/g, '').trim();
    if (t.length >= 3 && /[A-Za-z]/.test(t)) return t.slice(0, 200);
  }
  return '';
}

/** Try to parse a literal yes/no question (subprocess prompt). */
function tryParseYesNo(lines: readonly string[]): ParseResult | null {
  const lastLine = lines[lines.length - 1]?.trim() ?? '';

  for (const pattern of PATTERNS.yesNo) {
    if (pattern.test(lastLine)) {
      const questionText = extractQuestionText(lines, lastLine);

      return {
        detected: true,
        type: 'yes_no',
        confidence: 0.9,
        question: createQuestion(
          questionText,
          [
            createOption('Yes', 'y', true, true, false),
            createOption('No', 'n', false, false, true),
          ],
          false,
        ),
      };
    }
  }

  return null;
}

/** Try to detect an explicit free-text waiting prompt (subprocess prompt). */
function tryParseWaiting(lines: readonly string[]): ParseResult | null {
  const text = lines.join(' ');

  for (const pattern of PATTERNS.waiting) {
    if (pattern.test(text)) {
      const questionText = lines[lines.length - 1]?.trim() ?? 'Enter your response:';
      return {
        detected: true,
        type: 'free_text',
        confidence: 0.6,
        question: createQuestion(questionText, [], true),
      };
    }
  }

  return null;
}

/** Extract question text from lines */
function extractQuestionText(lines: readonly string[], lastLine: string): string {
  // If last line is just the prompt indicator, use previous lines
  if (lastLine.length < 10) {
    const prevLines = lines.slice(-3, -1);
    const combined = prevLines.join(' ').trim();
    if (combined.length > 0) {
      return combined;
    }
  }

  // Use last line, removing the prompt indicator
  return lastLine
    .replace(/\s*\(y\/n\)\s*$/i, '')
    .replace(/\s*\[y\/n\]\s*$/i, '')
    .replace(/\s*\(yes\/no\)\s*$/i, '')
    .trim();
}

/** Create a Question object */
function createQuestion(
  text: string,
  options: readonly QuestionOption[],
  allowsFreeText: boolean,
): Question {
  return {
    id: generateId(),
    text,
    options,
    allowsFreeText,
    isAnswered: false,
  };
}

/** Create a QuestionOption */
function createOption(
  label: string,
  value: string,
  isRecommended: boolean,
  isYes: boolean,
  isNo: boolean,
): QuestionOption {
  return {
    label,
    value,
    isRecommended,
    isYes,
    isNo,
  };
}

/**
 * Inline numbered option pattern: "(1) Yes (2) Always (3) No"
 * Matches sequences like (N) text within a single line.
 */
const INLINE_NUMBERED = /\((\d+)\)\s+([^(]+)/g;

/**
 * Result of parsing numbered options from plain text.
 */
export interface NumberedParseResult {
  /** The question/prompt text before the options */
  readonly questionText: string;
  /** Parsed options */
  readonly options: readonly QuestionOption[];
}

/**
 * Parse numbered options from plain text (no ANSI stripping).
 *
 * Handles multiple formats:
 * - Line-per-option with dot:    "1. Yes\n2. No"
 * - Line-per-option with paren:  "1) Yes\n2) No"
 * - Inline with parens:          "(1) Yes (2) Always (3) No"
 *
 * Operates on clean, space-preserved text (e.g. option labels carried in a
 * hook's permission_suggestions), NOT on raw PTY output. Returns null if fewer
 * than 2 options are found.
 */
export function parseNumberedOptions(text: string): NumberedParseResult | null {
  if (!text || text.trim().length === 0) {
    return null;
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // First, try line-per-option format: "N. text" or "N) text"
  const lineOptions: QuestionOption[] = [];
  let firstOptionIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    const match = PATTERNS.numberedOption.exec(line);

    if (match) {
      if (firstOptionIndex === -1) {
        firstOptionIndex = i;
      }
      const num = match[1] ?? '';
      const label = match[2]?.trim() ?? '';

      lineOptions.push(createOption(label, num, lineOptions.length === 0, false, false));
    }
  }

  if (lineOptions.length >= 2) {
    let questionText = '';
    if (firstOptionIndex > 0) {
      questionText = lines.slice(0, firstOptionIndex).join(' ').trim();
    }
    return {
      questionText: questionText || 'Select an option:',
      options: lineOptions,
    };
  }

  // Then, try inline format: "(1) Yes (2) Always (3) No"
  const fullText = lines.join(' ');
  const inlineOptions: QuestionOption[] = [];
  let firstMatchStart = -1;

  // Reset lastIndex for global regex
  INLINE_NUMBERED.lastIndex = 0;
  let inlineMatch = INLINE_NUMBERED.exec(fullText);
  while (inlineMatch !== null) {
    if (firstMatchStart === -1) {
      firstMatchStart = inlineMatch.index;
    }
    const num = inlineMatch[1] ?? '';
    const label = inlineMatch[2]?.trim() ?? '';
    inlineOptions.push(createOption(label, num, inlineOptions.length === 0, false, false));
    inlineMatch = INLINE_NUMBERED.exec(fullText);
  }

  if (inlineOptions.length >= 2 && firstMatchStart > 0) {
    const questionText = fullText.slice(0, firstMatchStart).trim();
    return {
      questionText: questionText || 'Select an option:',
      options: inlineOptions,
    };
  }

  if (inlineOptions.length >= 2) {
    return {
      questionText: 'Select an option:',
      options: inlineOptions,
    };
  }

  return null;
}

/**
 * Fast pre-filter: does output plausibly contain a prompt the user must
 * answer? Mirrors the gated signals in `parseQuestion` - selection-box chrome,
 * a literal y/n, or an explicit waiting marker. A bare `?` or a numbered list
 * deliberately does NOT qualify.
 */
export function hasQuestionIndicator(rawOutput: string): boolean {
  const text = cleanForParsing(rawOutput);

  if (PROMPT_CHROME.test(text)) return true;
  if (/\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]/i.test(text)) return true;
  return PATTERNS.waiting.some((pattern) => pattern.test(text));
}
