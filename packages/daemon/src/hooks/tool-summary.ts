/**
 * The short, human-readable description of a tool call (the command for Bash,
 * the path for a Write, and so on), folded into a permission question's text
 * as `Allow <tool>: <detail>`.
 *
 * Its own module since #976, when auto-approve precedent needed an untruncated
 * signature form of the same extraction (`forSignature`, #990). Precedent was
 * deleted with the rest of the auto-approve judgment in #1125 (ADR 0030), so
 * only the DISPLAY form remains.
 */

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
  return cutSummary(value, HEAD_KEEP, value.length - TAIL_KEEP);
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
): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const lower = toolName.toLowerCase();

  const get = (key: string): unknown => toolInput[key];

  // Bash: show the command
  if (lower === 'bash' || lower === 'terminal') {
    const cmd = get('command') ?? get('cmd');
    if (typeof cmd === 'string') {
      return truncateSummary(cmd);
    }
  }

  // Read/Write/Edit: show the file path
  if (lower === 'read' || lower === 'write' || lower === 'edit') {
    const path = get('file_path') ?? get('path');
    if (typeof path === 'string') return path;
  }

  // Glob/Grep: show the pattern
  if (lower === 'glob' || lower === 'grep') {
    const pattern = get('pattern') ?? get('glob');
    if (typeof pattern === 'string') return pattern;
  }

  // WebFetch: show the URL
  if (lower.includes('fetch') || lower.includes('web')) {
    const url = get('url');
    if (typeof url === 'string') return url;
  }

  // Generic: try common field names
  for (const key of ['command', 'file_path', 'path', 'url', 'description']) {
    const val = get(key);
    if (typeof val === 'string' && val.length > 0) {
      return truncateSummary(val);
    }
  }

  return null;
}
