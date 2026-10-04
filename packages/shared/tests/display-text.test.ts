import { describe, expect, test } from 'bun:test';
import { escapeUnsafeText } from '../src/display-text.ts';

/** Characters built from code points, so the source never holds a raw bidi or separator character. */
const ch = (...codes: number[]): string => String.fromCharCode(...codes);

/**
 * What the helper must never let through, written as code ranges (a regex literal cannot hold
 * U+2028 and U+2029 without the formatter turning them into line breaks): C0 but tab and newline,
 * DEL and C1, the zero-width and bidi marks, the two line separators, the bidi embeddings and isolates.
 */
const isUnsafeCode = (c: number): boolean =>
  (c <= 0x1f && c !== 0x09 && c !== 0x0a) ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069);
const hasUnsafe = (text: string): boolean => [...text].some((ch) => isUnsafeCode(ch.charCodeAt(0)));

describe('escapeUnsafeText', () => {
  test('ordinary text, tabs, newlines, accents, CJK and emoji are returned unchanged', () => {
    for (const text of ['', 'plain', 'a\tb\nc', 'café 日本語 \u{1f600}', "it's a \\ backslash"]) {
      expect(escapeUnsafeText(text)).toBe(text);
    }
  });

  test('a terminal escape sequence, a clipboard write and a carriage return come out as visible \\uXXXX, never dropped', () => {
    expect(escapeUnsafeText('a\x1b]52;c;QUJD\x07b\x1b[2K\rc')).toBe(
      'a\\u001B]52;c;QUJD\\u0007b\\u001B[2K\\u000Dc',
    );
  });

  test('bidi controls, zero-width marks and the line separators are escaped', () => {
    const raw = `x${ch(0x202e)}y${ch(0x2066)}z${ch(0x200b)}w${ch(0x200f)}${ch(0x2028)}${ch(0x2029)}`;
    expect(escapeUnsafeText(raw)).toBe('x\\u202Ey\\u2066z\\u200Bw\\u200F\\u2028\\u2029');
  });

  test('every character of every unsafe range is escaped, and the two that are kept are kept', () => {
    const all: number[] = [];
    for (let c = 0; c <= 0x9f; c++) all.push(c);
    for (let c = 0x200b; c <= 0x200f; c++) all.push(c);
    for (const c of [0x2028, 0x2029]) all.push(c);
    for (let c = 0x202a; c <= 0x202e; c++) all.push(c);
    for (let c = 0x2066; c <= 0x2069; c++) all.push(c);
    for (const c of all) {
      const out = escapeUnsafeText(`<${String.fromCharCode(c)}>`);
      if (c === 0x09 || c === 0x0a || (c >= 0x20 && c <= 0x7e)) {
        expect(out, `U+${c.toString(16)}`).toBe(`<${String.fromCharCode(c)}>`);
      } else {
        expect(hasUnsafe(out), `U+${c.toString(16)} left in`).toBe(false);
        expect(out, `U+${c.toString(16)}`).toBe(
          `<\\u${c.toString(16).toUpperCase().padStart(4, '0')}>`,
        );
      }
    }
  });

  test('the output never contains an unsafe character, whatever the input', () => {
    const hostile = `e\x1b[31m\x00\x7f${ch(0x9b)}${ch(0x202e)}${ch(0x2069)} ok`;
    expect(hasUnsafe(escapeUnsafeText(hostile))).toBe(false);
  });
});
