/**
 * Text that a peer controls, made safe to show (epic #1175, phase 4 #1178).
 *
 * A Codex approval card carries the command Codex asks to run, and the text of a file change, an
 * MCP prompt or a question: all of it is chosen by whatever drives the app-server, not by the
 * person who reads it. Shown raw it can act on the reader's surfaces:
 * - a terminal escape sequence in the attach client's banner runs on the user's terminal (an OSC
 *   52 writes the clipboard, a report query such as `ESC [ 6 n` is answered with bytes the attach
 *   client forwards as keystrokes into the agent's terminal, `ESC [ 2 K` and a carriage return
 *   overwrite the line the banner sits on);
 * - a bidi override or isolate reorders a command on screen so what is read is not what is run;
 * - an invisible character hides one, so two strings that read the same are not the same.
 *
 * {@link escapeUnsafeText} rewrites each such character as visible text (never dropped, so the
 * person sees that something was there): `\uXXXX` for a character in the Basic Multilingual
 * Plane, `\u{XXXXX}` above it (the Tags block). Everything else, newlines, tabs and common emoji
 * included, is left byte for byte. The text it writes contains none of the characters it escapes,
 * so escaping twice gives what escaping once does.
 *
 * The set (listed once, here and in ADR 0033's phase 4 amendment; the test spells it out again):
 * C0 controls but tab and newline; U+007F to U+009F; U+00AD; U+061C; U+180E; U+200B to U+200F;
 * U+2028 to U+202E; U+2060 to U+206F; U+FEFF; U+E0000 to U+E007F.
 * It is not every invisible character: variation selectors (emoji need U+FE0F), the combining
 * grapheme joiner and the Hangul filler letters are shown as they are.
 *
 * Written as code ranges, not a regex: a regex literal cannot hold U+2028 and U+2029, and a lint
 * rule would flag the control characters.
 */

/** Is this code point one that is escaped? See the set in the file's header. */
function isUnsafeCodePoint(c: number): boolean {
  return (
    (c <= 0x1f && c !== 0x09 && c !== 0x0a) ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xad ||
    c === 0x061c ||
    c === 0x180e ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f) ||
    c === 0xfeff ||
    (c >= 0xe0000 && c <= 0xe007f)
  );
}

/** `\uXXXX` (four uppercase hex digits) in the Basic Multilingual Plane, `\u{XXXXX}` above it. */
function visible(c: number): string {
  const hex = c.toString(16).toUpperCase();
  return c <= 0xffff ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
}

/** `text` with every character of the set written out as visible text. */
export function escapeUnsafeText(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; ) {
    const c = text.codePointAt(i) as number;
    const width = c > 0xffff ? 2 : 1;
    if (isUnsafeCodePoint(c)) {
      out += text.slice(from, i) + visible(c);
      from = i + width;
    }
    i += width;
  }
  return from === 0 ? text : out + text.slice(from);
}
