/**
 * The two text helpers of the Codex adapter (#1180 review): what Codex chose is made safe before
 * it reaches a push or a chat tool entry. `escapeUnsafeText` (`@remi/shared`, Phase 4) is the
 * set of characters; these decide how it is applied.
 */
import { describe, expect, test } from 'bun:test';
import { boundedEscape, pushProse } from '../../../src/harness/codex/safe-text.ts';

describe('boundedEscape', () => {
  test('text with nothing to escape and nothing to cut is returned as it is', () => {
    expect(boundedEscape('plain text', 40)).toBe('plain text');
    expect(boundedEscape('', 40)).toBe('');
    expect(boundedEscape('tab\there\nnewline', 40)).toBe('tab\there\nnewline');
  });

  test('every character of the shared set is written out as visible text', () => {
    expect(boundedEscape('a\u001bb\u0007c\u202ed\u2066e\u200bf', 100)).toBe(
      'a\\u001Bb\\u0007c\\u202Ed\\u2066e\\u200Bf',
    );
    expect(boundedEscape('\u{e0041}', 100)).toBe('\\u{E0041}');
  });

  test('the bound is on what the text becomes: the result is never longer than max', () => {
    for (const max of [1, 2, 5, 7, 10, 40, 140]) {
      const text = 'ab\u202ecd\u001b'.repeat(50);
      expect(boundedEscape(text, max).length, `max ${max}`).toBeLessThanOrEqual(max);
    }
  });

  test('a cut ends with an ellipsis and keeps room for it', () => {
    expect(boundedEscape('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(boundedEscape('x'.repeat(11), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  test('text that fits exactly is not cut', () => {
    expect(boundedEscape('x'.repeat(10), 10)).toBe('x'.repeat(10));
    expect(boundedEscape(`${'x'.repeat(4)}\u202e`, 10)).toBe(`${'x'.repeat(4)}\\u202E`);
  });

  test('a cut never lands inside an escape: a character whose escape does not fit is left out whole', () => {
    // 8 letters, then an escape of 6 (ending at 14). With room for the ellipsis the text may take
    // 9 characters, so the escape is left out whole, never cut to a fragment such as `\u20`.
    const text = `${'x'.repeat(8)}\u202etail`;
    expect(boundedEscape(text, 10)).toBe(`${'x'.repeat(8)}…`);
    expect(boundedEscape(text, 10)).not.toContain('\\');
  });

  test('characters outside the Basic Multilingual Plane count by what they take, and are not split', () => {
    expect(boundedEscape('\u{1f600}'.repeat(10), 7)).toBe('\u{1f600}\u{1f600}\u{1f600}…');
    expect(boundedEscape('\u{1f600}'.repeat(3), 6)).toBe('\u{1f600}\u{1f600}\u{1f600}');
  });

  test('a bound that leaves no room is empty', () => {
    expect(boundedEscape('abc', 0)).toBe('');
    expect(boundedEscape('abc', -3)).toBe('');
  });
});

describe('pushProse', () => {
  const REMOVED = [
    '\u0000',
    '\u0007',
    '\u001b',
    '\u007f',
    '\u0085',
    '\u009f',
    '\u00ad',
    '\u061c',
    '\u200b',
    '\u200c',
    '\u200e',
    '\u200f',
    '\u2028',
    '\u2029',
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2060',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
    '\u206f',
    '\ufeff',
    '\u{e0001}',
    '\u{e007f}',
  ];

  test.each(REMOVED)('U+%s is removed', (ch) => {
    expect(pushProse(`a${ch}b`)).toBe('ab');
  });

  test('a zero-width joiner is kept, alone and inside an emoji sequence', () => {
    expect(pushProse('a\u200db')).toBe('a\u200db');
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    expect(pushProse(`${family}!`)).toBe(`${family}!`);
  });

  test('text with nothing unsafe is unchanged: tabs, newlines, accents, CJK, variation selectors', () => {
    const text = 'Fertig:\t日本語 café\nline 2 ❤️ \u{1f600}';
    expect(pushProse(text)).toBe(text);
  });

  test('only a bounded prefix is read: a push shows 200 characters, so a huge answer is not scanned whole', () => {
    expect(pushProse('a'.repeat(100_000)).length).toBeLessThanOrEqual(4000);
    expect(pushProse(`${'a'.repeat(10)}\u202e`)).toBe('a'.repeat(10));
  });
});
