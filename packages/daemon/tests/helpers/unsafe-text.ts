/**
 * Does `text` hold a character `escapeUnsafeText` must have escaped? Written out independently of
 * the helper (inclusive code point ranges), so a card test can tell a card that was escaped from
 * one that merely passed through it. The set is the one in ADR 0033's phase 4 amendment, item 3.
 */
const UNSAFE: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

export const isUnsafeCodePoint = (cp: number): boolean =>
  UNSAFE.some(([lo, hi]) => cp >= lo && cp <= hi);

export const hasUnsafeText = (text: string): boolean =>
  [...text].some((c) => isUnsafeCodePoint(c.codePointAt(0) as number));
