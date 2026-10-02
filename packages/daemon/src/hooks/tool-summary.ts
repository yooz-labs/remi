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

/** Longest summary emitted verbatim. Beyond this the value is truncated to
 *  `TRUNCATED_KEEP` characters plus `...`, so a lock-screen card or terminal
 *  prompt stays one bounded line. */
const SUMMARY_MAX = 120;
const TRUNCATED_KEEP = 117;

function truncate(value: string): string {
  return value.length > SUMMARY_MAX ? `${value.slice(0, TRUNCATED_KEEP)}...` : value;
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
      return truncate(cmd);
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
      return truncate(val);
    }
  }

  return null;
}
