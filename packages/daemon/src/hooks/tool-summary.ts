/**
 * The short, human-readable description of a tool call (the command for Bash,
 * the path for a Write, and so on), folded into a permission question's text
 * as `Allow <tool>: <detail>`.
 *
 * Its own module since #976, when auto-approve precedent needed an untruncated
 * signature form of the same extraction (`forSignature`, #990). Precedent was
 * deleted with the rest of the auto-approve judgment in #1125 (ADR 0030).
 * Complete display input is retained as question detail when the short summary
 * hides text, so secure push sizing cannot grant an action over unseen meaning (#1200). Hook text
 * is escaped before any summary cut (#1189); a complete detail is escaped too.
 */

import { escapeUnsafeText } from '@remi/shared';

/** Longest summary emitted verbatim, so a lock-screen card or terminal
 *  prompt stays one bounded line. */
export const SUMMARY_MAX = 120;
/** A longer value keeps its first `HEAD_KEEP` and last `TAIL_KEEP` characters
 *  around an explicit marker saying how much is hidden. */
export const HEAD_KEEP = 80;
export const TAIL_KEEP = 30;

/**
 * `value` cut to its first `headEnd` and its last characters from `tailStart`, around the marker
 * that says how many characters are hidden between them. `truncateSummary` calls it with the fixed
 * lengths; the Codex card calls it with the same lengths moved off an escape sequence.
 */
export function cutSummary(value: string, headEnd: number, tailStart: number): string {
  return `${value.slice(0, headEnd)} … [${tailStart - headEnd} chars hidden] … ${value.slice(tailStart)}`;
}

/**
 * Bound a summary without hiding its end. With no judge behind the card
 * (#1125), the human approving it is the only check, and a command's
 * dangerous part is as likely at the end (a trailing `| sh` or a chained
 * delete) as at the start; a plain head cut used to drop exactly that.
 */
export function truncateSummary(value: string): string {
  if (value.length <= SUMMARY_MAX) return value;
  const headEnd = safeBoundary(value, HEAD_KEEP, 'before');
  const tailStart = safeBoundary(value, value.length - TAIL_KEEP, 'after');
  return cutSummary(value, headEnd, tailStart);
}

/** Move a summary cut out of an escape or surrogate pair, preserving the complete display code. */
function safeBoundary(value: string, index: number, side: 'before' | 'after'): number {
  for (const match of value.matchAll(/\\u(?:[0-9A-F]{4}|\{[0-9A-F]+\})/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < index && index < end) return side === 'before' ? start : end;
  }
  if (
    index > 0 &&
    index < value.length &&
    value.charCodeAt(index - 1) >= 0xd800 &&
    value.charCodeAt(index - 1) <= 0xdbff &&
    value.charCodeAt(index) >= 0xdc00 &&
    value.charCodeAt(index) <= 0xdfff
  ) {
    return side === 'before' ? index - 1 : index + 1;
  }
  return index;
}

/**
 * Extract a short summary from tool input for the question prompt.
 *
 * Returns `null` when the tool carries no summarizable argument; the caller
 * then uses the bare tool name. Pure and total: never throws, never guesses.
 */
export function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { readonly complete?: boolean } = {},
): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const lower = toolName.toLowerCase();

  const get = (key: string): unknown => toolInput[key];
  const display = (value: string): string => {
    const escaped = escapeUnsafeText(value);
    return options.complete === true ? escaped : truncateSummary(escaped);
  };

  // Bash: show the command
  if (lower === 'bash' || lower === 'terminal') {
    const cmd = get('command') ?? get('cmd');
    if (typeof cmd === 'string') {
      return display(cmd);
    }
  }

  // Read/Write/Edit: show the file path
  if (lower === 'read' || lower === 'write' || lower === 'edit') {
    const path = get('file_path') ?? get('path');
    if (typeof path === 'string') return display(path);
  }

  // Glob/Grep: show the pattern
  if (lower === 'glob' || lower === 'grep') {
    const pattern = get('pattern') ?? get('glob');
    if (typeof pattern === 'string') return display(pattern);
  }

  // WebFetch: show the URL
  if (lower.includes('fetch') || lower.includes('web')) {
    const url = get('url');
    if (typeof url === 'string') return display(url);
  }

  // Generic: try common field names
  for (const key of ['command', 'file_path', 'path', 'url', 'description']) {
    const val = get(key);
    if (typeof val === 'string' && val.length > 0) {
      return display(val);
    }
  }

  return null;
}
