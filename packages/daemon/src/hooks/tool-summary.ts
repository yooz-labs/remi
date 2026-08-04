/**
 * The short, human-readable description of a tool call — `rm -rf ./build` for
 * a Bash command, `/etc/hosts` for a Write, and so on.
 *
 * ## Why this is its own module (#976)
 *
 * It was a private method on `HookEventBridge`, with exactly one caller:
 * `buildPermissionQuestion`, which folds it into `Question.text` as
 * `Allow <tool>: <detail>`. That was fine while nothing else needed it.
 *
 * Precedent (`auto-approve/precedent.ts`) changed that. Precedent RECORDS from
 * the answered `Question.text` — so its signature is this function's output,
 * reached by parsing — and now needs to CONSULT from a raw
 * `(toolName, toolInput)` at decision time, before any question exists. Those
 * two signatures must be byte-identical or an exact match silently never
 * fires, and the failure is invisible: precedent simply never matches, which
 * looks exactly like "the user has not approved this before."
 *
 * A second implementation on the consult side is the specific defect this
 * module's own area has produced five times over — two pieces of code deriving
 * the same judgement independently and drifting the first time one changes.
 * One function, two callers, no drift possible.
 *
 * ## Truncation is load-bearing, not cosmetic
 *
 * The 120-character cap exists for the question text, but precedent depends on
 * it in a way the cap's original author never considered: two DIFFERENT
 * commands sharing their first 117 characters produce the IDENTICAL summary,
 * so approving one would exact-match the other. `precedent.ts` refuses any
 * truncated signature outright for that reason (`isTruncatedSignature`), and
 * that refusal is calibrated against the exact shape produced here — 117 kept
 * characters plus a 3-character marker. **Changing either number without
 * updating `TRUNCATED_DETAIL_LENGTH` there reopens a privilege-escalation
 * hole**, not merely a display glitch.
 */

/** Longest summary emitted verbatim. Beyond this the value is truncated to
 *  `TRUNCATED_KEEP` characters plus `...`. See the module doc: precedent's
 *  truncation refusal is calibrated against exactly this shape. */
const SUMMARY_MAX = 120;
const TRUNCATED_KEEP = 117;

function truncate(value: string): string {
  return value.length > SUMMARY_MAX ? `${value.slice(0, TRUNCATED_KEEP)}...` : value;
}

/**
 * Extract a short summary from tool input for the question prompt.
 *
 * Returns `null` when the tool carries no summarizable argument — the caller
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
