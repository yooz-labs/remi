/**
 * How the Codex adapter makes what Codex chose safe before it reaches a push or a chat tool entry
 * (#1180 review). `escapeUnsafeText` (`@remi/shared`, Phase 4) is the SET of characters: control
 * characters but tab and newline, the C1 controls, the invisible and the bidirectional ones. These
 * helpers decide how that set is applied.
 *
 * - {@link boundedEscape}: for text a person must be able to read as it is, with the character
 *   written out (`\u202E`), never dropped. Used for a failure's details and code.
 * - {@link firstCodePoints} and {@link hasVisibleText}: a cut that never splits a character, and
 *   the question whether a text made safe has anything left to show.
 * - {@link pushProse}: for the model's own prose in a notification, where the characters are
 *   removed instead, except the zero-width joiner, which an emoji sequence needs.
 */

import { escapeUnsafeText } from '@remi/shared';

const ZERO_WIDTH_JOINER = '\u200d';
const ELLIPSIS = '\u2026';
/** A push body shows 200 characters; prose beyond this many raw characters is never read. */
const PROSE_SCAN_MAX = 4000;

/**
 * `text` with every character of the shared set written out as visible text, and at most `max`
 * characters long AFTER that (UTF-16 code units, as the cuts further on count). Each code point
 * is escaped on its own and the cut falls between code points, never inside an escape, so no
 * `\u20` fragment is left; a cut ends with an ellipsis, which the bound includes.
 */
export function boundedEscape(text: string, max: number): string {
  if (max <= 0) return '';
  // One more code point than max tells a text that fits from one that does not: an escape is
  // never shorter than the character it stands for. Read lazily: a failure message may be as
  // large as a frame, and only the head of it is ever used.
  const pieces: string[] = [];
  let total = 0;
  for (const ch of text) {
    const piece = escapeUnsafeText(ch);
    pieces.push(piece);
    total += piece.length;
    if (pieces.length > max) break;
  }
  if (pieces.length <= max && total <= max) return pieces.join('');
  let out = '';
  for (const piece of pieces) {
    if (out.length + piece.length > max - 1) break;
    out += piece;
  }
  return out + ELLIPSIS;
}

/**
 * The first `n` code points of `text`, whole: a surrogate pair is never split, as a cut by UTF-16
 * units would split one that straddles the bound. Reads no more than `n` code points.
 */
export function firstCodePoints(text: string, n: number): string {
  if (n <= 0) return '';
  let out = '';
  let count = 0;
  for (const ch of text) {
    out += ch;
    count += 1;
    if (count >= n) break;
  }
  return out;
}

/** Is there anything in `text` to see: a character that is neither whitespace nor a zero-width joiner? */
export function hasVisibleText(text: string): boolean {
  return /[^\s\u200d]/u.test(text);
}

/**
 * The model's prose for a notification: every character `escapeUnsafeText` would write out is
 * REMOVED instead (a push has no use for an escape sequence, a bell or a bidi override), except the
 * zero-width joiner, so an emoji sequence such as a family survives. Only the first
 * {@link PROSE_SCAN_MAX} characters are read.
 */
export function pushProse(text: string): string {
  let out = '';
  for (const ch of text.slice(0, PROSE_SCAN_MAX)) {
    if (ch === ZERO_WIDTH_JOINER || escapeUnsafeText(ch) === ch) out += ch;
  }
  return out;
}
