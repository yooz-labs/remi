/**
 * What a headless Codex child printed before the session named a thread, kept for the one log
 * line a startup failure gets (LV-4: Codex 0.160.0 exits 2 on a flag error, and its message went
 * nowhere, so a log held only `exited with code 2`).
 *
 * This is the ONE exception to the rule that remi's log carries no cwd, no prompt and no full
 * thread id, so it is bounded and redacted:
 * - the first and last 1024 characters are kept, with the count of what lies between (the error
 *   is at the end of a Codex that painted a screen first), so memory is bounded;
 * - a UUID-shaped token is cut to its last eight characters (`shortThreadId`, the convention
 *   everywhere else), and the session's directories and the home directory become `<cwd>` and
 *   `~`;
 * - the text goes through `escapeUnsafeText` (a terminal sequence or a bidi override in it cannot
 *   act on the reader's screen), line ends are written out so it stays one log line, and the
 *   result is capped at 4096 characters (escaping can make control characters six times longer);
 * - no cut falls inside a surrogate pair.
 *
 * What it may still hold: anything else Codex printed, such as a config excerpt, a URL or a
 * prompt it echoed, and a path or id that straddles a cut can appear as a fragment. The captured
 * copy is only logged, never sent to a client: an attached client reads the same bytes as raw PTY
 * frames, by design, which this file does not touch.
 */

import * as os from 'node:os';
import { escapeUnsafeText } from '@remi/shared';
import { shortThreadId } from './thread-id.ts';

/** How much of each end is kept. */
export const STARTUP_PIECE_CHARS = 1024;
/** The cap on the logged text, after escaping. */
export const STARTUP_LINE_CHARS = 4096;

const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** The first `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
function firstUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/** The last `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
function lastUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.length - max;
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}

/** The home directory as the process knows it: `$HOME` (which may differ from the passwd entry) and `os.homedir()`. */
function homeDirectories(): string[] {
  return [process.env['HOME'], os.homedir()].filter((h): h is string => typeof h === 'string');
}

/** Each of `paths` (not `/`, which would be everywhere) replaced by `label`, the longest first. */
function replacePaths(text: string, paths: readonly string[], label: string): string {
  let out = text;
  for (const path of [...new Set(paths)]
    .filter((p) => p.length > 1)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(path).join(label);
  }
  return out;
}

export class StartupOutput {
  private head = '';
  private headDone = false;
  private tail = '';
  private seen = 0;

  /** Add what the child printed; only the two ends are kept. */
  push(text: string): void {
    this.seen += text.length;
    let rest = text;
    if (!this.headDone) {
      const part = firstUnits(rest, STARTUP_PIECE_CHARS - this.head.length);
      this.head += part;
      rest = rest.slice(part.length);
      // A cut, or a full head: what comes next belongs after the tail, not in the head.
      if (rest !== '' || this.head.length === STARTUP_PIECE_CHARS) this.headDone = true;
    }
    if (rest !== '') this.tail = lastUnits(this.tail + rest, STARTUP_PIECE_CHARS);
  }

  isEmpty(): boolean {
    return this.seen === 0;
  }

  clear(): void {
    this.head = '';
    this.headDone = false;
    this.tail = '';
    this.seen = 0;
  }

  /**
   * The text to log: the two ends and the count between them, redacted for `directories` (the
   * session's, which become `<cwd>`), escaped, on one line, and capped.
   */
  line(directories: readonly string[]): string {
    const omitted = this.seen - this.head.length - this.tail.length;
    const kept = this.head + (omitted > 0 ? `[${omitted} characters omitted]` : '') + this.tail;
    const redacted = replacePaths(
      replacePaths(kept, directories, '<cwd>'),
      homeDirectories(),
      '~',
    ).replace(UUID_SHAPED, (id) => shortThreadId(id));
    const escaped = escapeUnsafeText(redacted).replaceAll('\n', '\\n');
    return escaped.length <= STARTUP_LINE_CHARS
      ? escaped
      : `${firstUnits(escaped, STARTUP_LINE_CHARS)}[cut]`;
  }
}
