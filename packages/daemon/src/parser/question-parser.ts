/**
 * Question Parser - Detects and parses questions from Claude Code output.
 *
 * Claude Code can ask questions in several formats:
 * 1. Yes/No questions: "Do you want to proceed? (y/n)"
 * 2. Numbered options: "1. Option A\n2. Option B\n..."
 * 3. Free text prompts: Waiting for user input
 * 4. Permission requests: "Allow X?" with yes/no
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
  // Yes/No patterns
  yesNo: [
    /\(y\/n\)\s*$/i,
    /\(yes\/no\)\s*$/i,
    /\[y\/n\]\s*$/i,
    /\[yes\/no\]\s*$/i,
    /\?\s*\(y\)\s*$/i,
  ],

  // Permission patterns (Claude Code specific)
  permission: [
    /allow\s+\w+.*\?\s*$/i,
    /permit\s+\w+.*\?\s*$/i,
    /do you want to\s+\w+.*\?\s*$/i,
    /should i\s+\w+.*\?\s*$/i,
    /proceed with\s+\w+.*\?\s*$/i,
  ],

  // Numbered option patterns
  numberedOption: /^\s*(\d+)\.\s+(.+)$/,

  // Option with marker (arrow, bullet)
  markedOption: /^\s*[►▸•●]\s+(.+)$/,

  // Question ending
  questionEnding: /\?\s*$/,

  // Waiting indicators
  waiting: [
    /waiting for input/i,
    /enter your response/i,
    /type your answer/i,
    /press enter to continue/i,
  ],
} as const;

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

  // Try different parsers in order of specificity
  const parsers: Array<() => ParseResult | null> = [
    () => tryParseYesNo(lines),
    () => tryParsePermission(lines),
    () => tryParseNumbered(lines),
    () => tryParseFreeText(lines),
  ];

  for (const parser of parsers) {
    const result = parser();
    if (result?.detected) {
      return result;
    }
  }

  return { detected: false, confidence: 0 };
}

/** Try to parse a yes/no question */
function tryParseYesNo(lines: readonly string[]): ParseResult | null {
  const lastLine = lines[lines.length - 1]?.trim() ?? '';

  for (const pattern of PATTERNS.yesNo) {
    if (pattern.test(lastLine)) {
      // Extract question text
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

/** Try to parse a permission question */
function tryParsePermission(lines: readonly string[]): ParseResult | null {
  const lastLine = lines[lines.length - 1]?.trim() ?? '';

  for (const pattern of PATTERNS.permission) {
    if (pattern.test(lastLine)) {
      const questionText = extractQuestionText(lines, lastLine);

      return {
        detected: true,
        type: 'permission',
        confidence: 0.85,
        question: createQuestion(
          questionText,
          [
            createOption('Allow', 'yes', true, true, false),
            createOption('Deny', 'no', false, false, true),
          ],
          false,
        ),
      };
    }
  }

  return null;
}

/** Try to parse numbered options */
function tryParseNumbered(lines: readonly string[]): ParseResult | null {
  const options: QuestionOption[] = [];
  let questionText = '';
  let firstOptionIndex = -1;

  // Find numbered options
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const match = PATTERNS.numberedOption.exec(line);

    if (match) {
      if (firstOptionIndex === -1) {
        firstOptionIndex = i;
      }

      const num = match[1]!;
      const label = match[2]!.trim();

      options.push(
        createOption(
          label,
          num,
          options.length === 0, // First option is recommended
          false,
          false,
        ),
      );
    }
  }

  // Need at least 2 options
  if (options.length < 2 || firstOptionIndex === -1) {
    return null;
  }

  // Question text is everything before the options
  if (firstOptionIndex > 0) {
    questionText = lines.slice(0, firstOptionIndex).join(' ').trim();
  } else {
    questionText = 'Select an option:';
  }

  return {
    detected: true,
    type: 'numbered',
    confidence: 0.8,
    question: createQuestion(questionText, options, true),
  };
}

/** Try to detect a free text prompt */
function tryParseFreeText(lines: readonly string[]): ParseResult | null {
  const text = lines.join(' ');

  // Check for waiting indicators
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

  // Check for question ending in last line without options
  const lastLine = lines[lines.length - 1]?.trim() ?? '';
  if (PATTERNS.questionEnding.test(lastLine)) {
    // Only if there are no numbered options nearby
    const hasOptions = lines.some((l) => PATTERNS.numberedOption.test(l));
    if (!hasOptions) {
      return {
        detected: true,
        type: 'free_text',
        confidence: 0.5,
        question: createQuestion(lastLine, [], true),
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
 * Check if output likely contains a question.
 * Faster than full parsing for filtering.
 */
export function hasQuestionIndicator(rawOutput: string): boolean {
  const text = cleanForParsing(rawOutput);

  // Quick checks
  if (text.includes('?')) return true;
  if (text.includes('(y/n)')) return true;
  if (text.includes('[y/n]')) return true;

  // Check for numbered options
  const lines = splitLines(text);
  let numberedCount = 0;
  for (const line of lines) {
    if (PATTERNS.numberedOption.test(line)) {
      numberedCount++;
      if (numberedCount >= 2) return true;
    }
  }

  return false;
}
