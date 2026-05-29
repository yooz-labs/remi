/**
 * Tests for question parsing.
 *
 * Detection is gated on real signals (epic #415 / epic #435 Phase 1):
 *  - Claude's selection-box chrome (❯ cursor on a numbered option)
 *  - literal (y/n)/[y/n] from subprocesses
 *  - explicit free-text waiting markers
 * A plain numbered list or prose ending in `?` must NOT be detected.
 *
 * Fixtures under parser/fixtures/ are REAL Claude Code 2.1.156 output captured
 * via a PTY (no mocks): the selection box is the trust dialog (same renderer
 * Claude uses for permission and multi-choice prompts); the negatives are a
 * numbered markdown list and a sentence ending in `?` that Claude printed.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasQuestionIndicator,
  parseNumberedOptions,
  parseQuestion,
} from '../src/parser/question-parser.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'parser', 'fixtures', name), 'utf8');

describe('parseQuestion() - selection-box chrome (Claude prompts)', () => {
  test('detects a synthetic permission selection box', () => {
    const input = "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No";
    const result = parseQuestion(input);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('numbered');
    expect(result.question?.options.length).toBe(3);
    expect(result.question?.options[0]?.value).toBe('1');
    expect(result.question?.options[2]?.value).toBe('3');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('detects the real captured selection box (collapsed spacing)', () => {
    const result = parseQuestion(fixture('prompt-selection-box.clean.txt'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('numbered');
    // Trust dialog renders two options: "Yes, I trust this folder" / "No, exit".
    expect(result.question?.options.length).toBeGreaterThanOrEqual(2);
    expect(result.question?.options[0]?.value).toBe('1');
  });

  test('parses N) delimiter inside a box', () => {
    const result = parseQuestion('Pick:\n❯ 1) Alpha\n  2) Beta');
    expect(result.detected).toBe(true);
    expect(result.question?.options.length).toBe(2);
  });

  test('first option is recommended', () => {
    const result = parseQuestion('❯ 1. First\n  2. Second');
    expect(result.question?.options[0]?.isRecommended).toBe(true);
    expect(result.question?.options[1]?.isRecommended).toBe(false);
  });

  test('strips box-drawing borders around option labels', () => {
    const result = parseQuestion('│ ❯ 1. Allow  │\n│   2. Deny   │');
    expect(result.detected).toBe(true);
    expect(result.question?.options.length).toBe(2);
    expect(result.question?.options[0]?.label).toBe('Allow');
    expect(result.question?.options[1]?.label).toBe('Deny');
  });
});

describe('parseQuestion() - literal yes/no (subprocess prompts)', () => {
  test('detects (y/n) pattern', () => {
    const result = parseQuestion('Do you want to continue? (y/n)');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('yes_no');
    expect(result.question?.text).toBe('Do you want to continue?');
    expect(result.question?.options.length).toBe(2);
    expect(result.question?.options[0]?.isYes).toBe(true);
    expect(result.question?.options[1]?.isNo).toBe(true);
  });

  test('detects [y/n] pattern', () => {
    expect(parseQuestion('Proceed with installation? [y/n]').type).toBe('yes_no');
  });

  test('detects (yes/no) pattern', () => {
    expect(parseQuestion('Are you sure? (yes/no)').type).toBe('yes_no');
  });

  test('case insensitive matching', () => {
    expect(parseQuestion('Continue? (Y/N)').type).toBe('yes_no');
  });

  test('handles multiline with y/n at end', () => {
    const result = parseQuestion('This will delete all files.\nAre you sure? (y/n)');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('yes_no');
  });

  test('yes/no has high confidence', () => {
    expect(parseQuestion('Continue? (y/n)').confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('parseQuestion() - explicit free-text waiting (subprocess prompts)', () => {
  test('detects "waiting for input"', () => {
    const result = parseQuestion('Waiting for input...');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('free_text');
  });

  test('detects "enter your response"', () => {
    const result = parseQuestion('Please enter your response:');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('free_text');
  });

  test('free text has lower confidence and empty options', () => {
    const result = parseQuestion('Waiting for input:');
    expect(result.confidence).toBeLessThan(0.7);
    expect(result.question?.options.length).toBe(0);
    expect(result.question?.allowsFreeText).toBe(true);
  });
});

describe('parseQuestion() - NOT a prompt (false-positive guards)', () => {
  test('plain numbered list without cursor is NOT detected', () => {
    const input = 'Here are three frameworks:\n1. React\n2. Vue\n3. Angular';
    expect(parseQuestion(input).detected).toBe(false);
  });

  test('prose ending in a question mark is NOT detected', () => {
    expect(parseQuestion('What is the project name?').detected).toBe(false);
    expect(parseQuestion('Is this a question?').detected).toBe(false);
  });

  test('permission-style prose without a box is NOT detected', () => {
    expect(parseQuestion('Allow file access?').detected).toBe(false);
    expect(parseQuestion('Do you want to install dependencies?').detected).toBe(false);
  });

  test('the empty input box (❯ with no option) is NOT detected', () => {
    expect(parseQuestion('❯ \n────').detected).toBe(false);
  });

  test('a single cursor option (no second option) is NOT detected', () => {
    // Guards the >=2 requirement: a lone "❯ 1. ..." is not a selection prompt.
    expect(parseQuestion('❯ 1. Only one option').detected).toBe(false);
  });

  test('cursor line and a separate list line do NOT combine across lines', () => {
    // The input box "❯ " on one line and a list "1. Foo" elsewhere must not pair.
    expect(parseQuestion('❯ Try "write a test"\n────\n1. Foo\n2. Bar').detected).toBe(false);
  });

  test('plain text / empty / whitespace', () => {
    expect(parseQuestion('This is just regular output.').detected).toBe(false);
    expect(parseQuestion('').detected).toBe(false);
    expect(parseQuestion('   \n   ').detected).toBe(false);
    expect(parseQuestion('Just some output').confidence).toBe(0);
  });

  test('REAL captured numbered list is NOT detected', () => {
    expect(parseQuestion(fixture('numbered-list-not-a-prompt.clean.txt')).detected).toBe(false);
  });

  test('REAL captured prose-ending-in-? is NOT detected', () => {
    expect(parseQuestion(fixture('prose-ending-question.clean.txt')).detected).toBe(false);
  });
});

describe('parseQuestion() - ANSI handling and properties', () => {
  test('strips ANSI codes before parsing y/n', () => {
    const result = parseQuestion('\x1b[1mDo you want to continue?\x1b[0m (y/n)');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('yes_no');
  });

  test('detects a box with ANSI-colored options', () => {
    const input = '\x1b[33mPick:\x1b[0m\n\x1b[36m❯ 1.\x1b[0m First\n  \x1b[32m2.\x1b[0m Second';
    expect(parseQuestion(input).detected).toBe(true);
  });

  test('question has unique id and starts unanswered', () => {
    const a = parseQuestion('Q1? (y/n)');
    const b = parseQuestion('Q2? (y/n)');
    expect(a.question?.id).not.toBe(b.question?.id);
    expect(a.question?.isAnswered).toBe(false);
    expect(a.question?.answer).toBeUndefined();
  });
});

describe('hasQuestionIndicator()', () => {
  test('true for selection-box chrome', () => {
    expect(hasQuestionIndicator('❯ 1. Yes\n  2. No')).toBe(true);
  });

  test('true for (y/n) and [y/n]', () => {
    expect(hasQuestionIndicator('Continue (y/n)')).toBe(true);
    expect(hasQuestionIndicator('Continue [y/n]')).toBe(true);
  });

  test('true for explicit waiting marker', () => {
    expect(hasQuestionIndicator('Waiting for input')).toBe(true);
  });

  test('FALSE for a bare question mark', () => {
    expect(hasQuestionIndicator('What is this?')).toBe(false);
  });

  test('FALSE for a plain numbered list', () => {
    expect(hasQuestionIndicator('1. First\n2. Second')).toBe(false);
    expect(hasQuestionIndicator('1) First\n2) Second')).toBe(false);
  });

  test('FALSE for plain text', () => {
    expect(hasQuestionIndicator('Just some text')).toBe(false);
  });

  test('handles ANSI codes around chrome', () => {
    expect(hasQuestionIndicator('\x1b[36m❯ 1. Yes\x1b[0m\n  2. No')).toBe(true);
  });
});

describe('parseNumberedOptions()', () => {
  test('parses multiline N) format', () => {
    const result = parseNumberedOptions('Question?\n1) Yes\n2) No');
    expect(result).not.toBeNull();
    expect(result?.questionText).toBe('Question?');
    expect(result?.options.length).toBe(2);
    expect(result?.options[0]?.label).toBe('Yes');
    expect(result?.options[0]?.value).toBe('1');
    expect(result?.options[1]?.label).toBe('No');
    expect(result?.options[1]?.value).toBe('2');
  });

  test('parses multiline N. format', () => {
    const result = parseNumberedOptions('Pick one:\n1. Alpha\n2. Beta');
    expect(result).not.toBeNull();
    expect(result?.questionText).toBe('Pick one:');
    expect(result?.options.length).toBe(2);
    expect(result?.options[0]?.label).toBe('Alpha');
    expect(result?.options[1]?.label).toBe('Beta');
  });

  test('parses inline (N) format', () => {
    const result = parseNumberedOptions('Allow? (1) Yes (2) Always (3) No');
    expect(result).not.toBeNull();
    expect(result?.questionText).toBe('Allow?');
    expect(result?.options.length).toBe(3);
    expect(result?.options[0]?.label).toBe('Yes');
    expect(result?.options[1]?.label).toBe('Always');
    expect(result?.options[2]?.label).toBe('No');
  });

  test('returns null for empty string', () => {
    expect(parseNumberedOptions('')).toBeNull();
  });

  test('returns null for text without numbered options', () => {
    expect(parseNumberedOptions('Just some plain text')).toBeNull();
  });

  test('returns null for single option', () => {
    expect(parseNumberedOptions('1) Only one')).toBeNull();
  });

  test('first option is marked recommended', () => {
    const result = parseNumberedOptions('Choose:\n1) A\n2) B');
    expect(result?.options[0]?.isRecommended).toBe(true);
    expect(result?.options[1]?.isRecommended).toBe(false);
  });

  test('handles three options with long labels', () => {
    const msg =
      "Do you want to proceed?\n1) Yes\n2) Yes, and don't ask again for this session\n3) No";
    const result = parseNumberedOptions(msg);
    expect(result).not.toBeNull();
    expect(result?.options.length).toBe(3);
    expect(result?.options[0]?.label).toBe('Yes');
    expect(result?.options[1]?.label).toBe("Yes, and don't ask again for this session");
    expect(result?.options[2]?.label).toBe('No');
  });
});
