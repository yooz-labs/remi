/**
 * The remaining Codex display helpers. `escapeUnsafeText`, `boundedEscape` and `pushProse` live in
 * `@remi/shared` so Claude and Codex use the same display rules. These helpers decide how the
 * shared set is applied to local Codex card fields.
 *
 * - {@link firstCodePoints} and {@link hasVisibleText}: a cut that never splits a character, and
 *   the question whether a text made safe has anything left to show.
 */

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
