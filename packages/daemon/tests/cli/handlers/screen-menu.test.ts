import { describe, expect, test } from 'bun:test';
import type { QuestionOption } from '@remi/shared';
import { isNumberedMenu } from '../../../src/cli/handlers/screen-menu.ts';

const opt = (value: string, label = value): QuestionOption => ({
  value,
  label,
  isRecommended: false,
  isYes: false,
  isNo: false,
});

describe('isNumberedMenu (#1140)', () => {
  test('a Claude selection box (screen numbering) is a numbered menu', () => {
    expect(isNumberedMenu([opt('1', 'Yes'), opt('2', 'Yes, and always'), opt('3', 'No')])).toBe(
      true,
    );
    expect(isNumberedMenu([opt('1'), opt('2'), opt('10')])).toBe(true);
  });

  test('a (y/n) prompt, an empty list and nothing observed are not', () => {
    expect(isNumberedMenu([opt('y', 'Yes'), opt('n', 'No')])).toBe(false);
    expect(isNumberedMenu([])).toBe(false);
    expect(isNumberedMenu(null)).toBe(false);
    expect(isNumberedMenu(undefined)).toBe(false);
  });

  test('every value must be numeric: one lettered option makes it not a numbered menu', () => {
    expect(isNumberedMenu([opt('1'), opt('y')])).toBe(false);
    expect(isNumberedMenu([opt('1.'), opt('2')])).toBe(false);
    expect(isNumberedMenu([opt(''), opt('2')])).toBe(false);
  });
});
