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
 * - a zero-width character hides one.
 *
 * {@link escapeUnsafeText} rewrites each such character as a visible `\uXXXX` (never dropped, so
 * the person sees that something was there) and leaves everything else, newlines and tabs
 * included, byte for byte.
 *
 * Written as code ranges, not a regex: a regex literal cannot hold U+2028 and U+2029, and a lint
 * rule would flag the control characters.
 */

/** The code units that are escaped: C0 but tab and newline, DEL and C1, zero-width and bidi marks, the line separators, bidi embeddings and isolates. */
function isUnsafeCodeUnit(c: number): boolean {
  return (
    (c <= 0x1f && c !== 0x09 && c !== 0x0a) ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

/** `text` with every unsafe character written out as `\uXXXX` (four uppercase hex digits). */
export function escapeUnsafeText(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!isUnsafeCodeUnit(c)) continue;
    out += `${text.slice(from, i)}\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}
