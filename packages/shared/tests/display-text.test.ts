import { describe, expect, test } from 'bun:test';
import { escapeUnsafeText } from '../src/display-text.ts';

/** Characters built from code points, so the source never holds a raw bidi or invisible character. */
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

/**
 * The set the helper must escape, written independently of it as inclusive code point ranges (a
 * regex literal cannot hold U+2028 and U+2029 without the formatter turning them into line
 * breaks). It is the list in ADR 0033's phase 4 amendment, item 3.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], // C0 controls, but not tab (09) and newline (0A)
  [0x0b, 0x1f],
  [0x7f, 0x9f], // DEL and the C1 controls
  [0xad, 0xad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, joiners, left-to-right and right-to-left marks
  [0x2028, 0x202e], // line and paragraph separators, bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates, deprecated format characters
  [0xfeff, 0xfeff], // zero-width no-break space, the byte order mark
  [0xe0000, 0xe007f], // the Tags block
];
const isUnsafe = (cp: number): boolean => UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
/** The visible form: `\uXXXX` in the Basic Multilingual Plane, `\u{XXXXX}` above it. */
const visible = (cp: number): string =>
  cp <= 0xffff
    ? `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`
    : `\\u{${cp.toString(16).toUpperCase()}}`;
const hasUnsafe = (text: string): boolean =>
  [...text].some((c) => isUnsafe(c.codePointAt(0) as number));

describe('escapeUnsafeText', () => {
  test('ordinary text, tabs, newlines, accents, CJK and common emoji are returned unchanged', () => {
    const emoji = [
      ch(0x1f600), // a face
      ch(0x1f44d, 0x1f3fd), // a thumbs up with a skin tone modifier
      ch(0x2764, 0xfe0f), // a heart with a variation selector, which emoji need
      ch(0x1f1fa, 0x1f1f8), // a flag, two regional indicators
    ];
    for (const text of [
      '',
      'plain',
      'a\tb\nc',
      'café 日本語',
      "it's a \\ backslash",
      '\\u202E is text, not a character',
      ...emoji,
    ]) {
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

  test('every code point of the Unicode range is escaped exactly when it is in the set, and in the same visible form', () => {
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // a lone surrogate is not a character
      const text = `<${String.fromCodePoint(cp)}>`;
      const out = escapeUnsafeText(text);
      const expected = isUnsafe(cp) ? `<${visible(cp)}>` : text;
      if (out !== expected) expect(out, `U+${cp.toString(16)}`).toBe(expected);
    }
  });

  test('both ends of every range are escaped and the code point on each side is not, except where ranges touch', () => {
    for (const [lo, hi] of UNSAFE_RANGES) {
      for (const cp of [lo, hi]) {
        expect(escapeUnsafeText(ch(cp)), `U+${cp.toString(16)}`).toBe(visible(cp));
      }
      for (const cp of [lo - 1, hi + 1]) {
        if (cp < 0) continue;
        const out = escapeUnsafeText(ch(cp));
        if (isUnsafe(cp)) expect(out).toBe(visible(cp));
        else expect(out, `U+${cp.toString(16)}`).toBe(ch(cp));
      }
    }
  });

  test('the added invisible characters: the Arabic letter mark, the word joiner and invisible operators, the byte order mark, the soft hyphen, the Mongolian vowel separator', () => {
    const raw = `a${ch(0x61c)}b${ch(0x2060)}c${ch(0x2064)}d${ch(0xfeff)}e${ch(0xad)}f${ch(0x180e)}g`;
    expect(escapeUnsafeText(raw)).toBe('a\\u061Cb\\u2060c\\u2064d\\uFEFFe\\u00ADf\\u180Eg');
  });

  test('the Tags block is astral and invisible: it comes out as a visible \\u{XXXXX}, in the middle of a string and at its two ends', () => {
    const tagged = `/home/${ch(0xe0041)}${ch(0xe0042)}user${ch(0xe0000)}${ch(0xe007f)}`;
    expect(escapeUnsafeText(tagged)).toBe('/home/\\u{E0041}\\u{E0042}user\\u{E0000}\\u{E007F}');
    // The code point next to the block is untouched, and a surrogate pair is never split.
    expect(escapeUnsafeText(ch(0xe0080))).toBe(ch(0xe0080));
    expect(escapeUnsafeText(`${ch(0x1f600)}${ch(0xe0041)}${ch(0x1f600)}`)).toBe(
      `${ch(0x1f600)}\\u{E0041}${ch(0x1f600)}`,
    );
  });

  test('a lone surrogate is passed through, and escaping is idempotent', () => {
    const lone = String.fromCharCode(0xd800);
    expect(escapeUnsafeText(`a${lone}b`)).toBe(`a${lone}b`);
    const hostile = `e\x1b[31m\x00\x7f${ch(0x9b, 0x202e, 0x2069, 0xe0041, 0xfeff)} ok`;
    const once = escapeUnsafeText(hostile);
    expect(escapeUnsafeText(once)).toBe(once);
  });

  test('the output never contains a character of the set, whatever the input', () => {
    const hostile = `e\x1b[31m\x00\x7f${ch(0x9b, 0x202e, 0x2069, 0xe0041, 0x61c, 0xfeff)} ok`;
    expect(hasUnsafe(hostile)).toBe(true);
    expect(hasUnsafe(escapeUnsafeText(hostile))).toBe(false);
  });
});
