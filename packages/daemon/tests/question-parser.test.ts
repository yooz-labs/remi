/**
 * Tests for question parsing.
 */

import { describe, expect, test } from 'bun:test';
import { parseQuestion, hasQuestionIndicator } from '../src/parser/question-parser.ts';

describe('parseQuestion()', () => {
  describe('Yes/No questions', () => {
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
      const result = parseQuestion('Proceed with installation? [y/n]');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('yes_no');
    });

    test('detects (yes/no) pattern', () => {
      const result = parseQuestion('Are you sure? (yes/no)');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('yes_no');
    });

    test('case insensitive matching', () => {
      const result = parseQuestion('Continue? (Y/N)');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('yes_no');
    });

    test('handles multiline with y/n at end', () => {
      const result = parseQuestion('This will delete all files.\nAre you sure? (y/n)');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('yes_no');
    });
  });

  describe('Permission questions', () => {
    test('detects "Allow X?" pattern', () => {
      const result = parseQuestion('Allow file access?');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('permission');
      expect(result.question?.options[0]?.label).toBe('Allow');
      expect(result.question?.options[1]?.label).toBe('Deny');
    });

    test('detects "Do you want to X?" pattern', () => {
      const result = parseQuestion('Do you want to install dependencies?');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('permission');
    });

    test('detects "Should I X?" pattern', () => {
      const result = parseQuestion('Should I create a backup?');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('permission');
    });

    test('detects "Proceed with X?" pattern', () => {
      const result = parseQuestion('Proceed with deletion?');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('permission');
    });
  });

  describe('Numbered options', () => {
    test('detects numbered list', () => {
      const input = `Select a framework:
1. React
2. Vue
3. Angular`;
      const result = parseQuestion(input);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('numbered');
      expect(result.question?.options.length).toBe(3);
      expect(result.question?.options[0]?.label).toBe('React');
      expect(result.question?.options[1]?.label).toBe('Vue');
      expect(result.question?.options[2]?.label).toBe('Angular');
    });

    test('first option is recommended', () => {
      const input = `1. First option
2. Second option`;
      const result = parseQuestion(input);
      expect(result.question?.options[0]?.isRecommended).toBe(true);
      expect(result.question?.options[1]?.isRecommended).toBe(false);
    });

    test('option values are the numbers', () => {
      const input = `1. Option A
2. Option B`;
      const result = parseQuestion(input);
      expect(result.question?.options[0]?.value).toBe('1');
      expect(result.question?.options[1]?.value).toBe('2');
    });

    test('extracts question text before options', () => {
      const input = `Which database do you prefer?
1. PostgreSQL
2. MySQL`;
      const result = parseQuestion(input);
      expect(result.question?.text).toBe('Which database do you prefer?');
    });

    test('allows free text with numbered options', () => {
      const input = `1. Option 1
2. Option 2`;
      const result = parseQuestion(input);
      expect(result.question?.allowsFreeText).toBe(true);
    });

    test('requires at least 2 options', () => {
      const input = '1. Only one option';
      const result = parseQuestion(input);
      expect(result.detected).toBe(false);
    });
  });

  describe('Free text prompts', () => {
    test('detects "waiting for input" pattern', () => {
      const result = parseQuestion('Waiting for input...');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('free_text');
    });

    test('detects "enter your response" pattern', () => {
      const result = parseQuestion('Please enter your response:');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('free_text');
    });

    test('detects generic question ending', () => {
      const result = parseQuestion('What is the project name?');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('free_text');
    });

    test('allows free text', () => {
      const result = parseQuestion('Enter your response:');
      expect(result.question?.allowsFreeText).toBe(true);
    });

    test('has empty options for free text', () => {
      const result = parseQuestion('What is your API key?');
      expect(result.question?.options.length).toBe(0);
    });
  });

  describe('No question detected', () => {
    test('returns false for plain text', () => {
      const result = parseQuestion('This is just regular output.');
      expect(result.detected).toBe(false);
    });

    test('returns false for empty string', () => {
      const result = parseQuestion('');
      expect(result.detected).toBe(false);
    });

    test('returns false for whitespace only', () => {
      const result = parseQuestion('   \n   \n   ');
      expect(result.detected).toBe(false);
    });

    test('returns low confidence for no detection', () => {
      const result = parseQuestion('Just some output');
      expect(result.confidence).toBe(0);
    });
  });

  describe('ANSI code handling', () => {
    test('strips ANSI codes before parsing', () => {
      const result = parseQuestion('\x1b[1mDo you want to continue?\x1b[0m (y/n)');
      expect(result.detected).toBe(true);
      expect(result.type).toBe('yes_no');
    });

    test('handles colored numbered options', () => {
      const input = `\x1b[33mSelect:\x1b[0m
\x1b[32m1.\x1b[0m First
\x1b[32m2.\x1b[0m Second`;
      const result = parseQuestion(input);
      expect(result.detected).toBe(true);
      expect(result.type).toBe('numbered');
    });
  });

  describe('Question properties', () => {
    test('question has unique ID', () => {
      const result1 = parseQuestion('Question 1? (y/n)');
      const result2 = parseQuestion('Question 2? (y/n)');
      expect(result1.question?.id).not.toBe(result2.question?.id);
    });

    test('question starts as not answered', () => {
      const result = parseQuestion('Continue? (y/n)');
      expect(result.question?.isAnswered).toBe(false);
    });

    test('question has no answer initially', () => {
      const result = parseQuestion('Continue? (y/n)');
      expect(result.question?.answer).toBeUndefined();
    });
  });

  describe('Confidence levels', () => {
    test('yes/no has high confidence', () => {
      const result = parseQuestion('Continue? (y/n)');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    test('permission has good confidence', () => {
      const result = parseQuestion('Allow access?');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test('numbered has moderate confidence', () => {
      const result = parseQuestion('1. A\n2. B');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    test('free text has lower confidence', () => {
      const result = parseQuestion('What is your name?');
      expect(result.confidence).toBeLessThan(0.7);
    });
  });
});

describe('hasQuestionIndicator()', () => {
  test('returns true for question mark', () => {
    expect(hasQuestionIndicator('What is this?')).toBe(true);
  });

  test('returns true for (y/n)', () => {
    expect(hasQuestionIndicator('Continue (y/n)')).toBe(true);
  });

  test('returns true for [y/n]', () => {
    expect(hasQuestionIndicator('Continue [y/n]')).toBe(true);
  });

  test('returns true for numbered options', () => {
    expect(hasQuestionIndicator('1. First\n2. Second')).toBe(true);
  });

  test('returns false for plain text', () => {
    expect(hasQuestionIndicator('Just some text')).toBe(false);
  });

  test('returns false for single numbered item', () => {
    expect(hasQuestionIndicator('1. Just one item')).toBe(false);
  });

  test('handles ANSI codes', () => {
    expect(hasQuestionIndicator('\x1b[31mQuestion?\x1b[0m')).toBe(true);
  });
});
