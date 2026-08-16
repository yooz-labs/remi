/**
 * The short, human-readable description of a tool call — `rm -rf ./build` for
 * a Bash command, `/etc/hosts` for a Write, and so on.
 *
 * ## Two forms, one function (#990)
 *
 * `summarizeToolInput` produces two shapes from the exact same extraction
 * logic, selected by `opts.forSignature`:
 *
 *   - DISPLAY (default; `forSignature` absent/false): truncates a long value
 *     to `SUMMARY_MAX` (120) characters, for a lock-screen card or terminal
 *     prompt that must stay one bounded line.
 *   - SIGNATURE (`forSignature: true`): the value verbatim, at any length —
 *     never truncated. `precedent.ts`'s `signatureForOperation` is the ONLY
 *     caller that passes this. See its doc, and "Truncation" below, for why an
 *     exact-match authorization signature must never be the truncated form:
 *     two DIFFERENT commands sharing their first 117 characters used to
 *     collapse to one signature, so approving one silently authorized the
 *     other (#990).
 *
 * Only the branches that ever call `truncate` (Bash's `command`/`cmd`, and the
 * generic last-resort loop) can differ between the two forms, and only in
 * LENGTH — the extraction logic itself (which field wins, which tool matches
 * which branch) never forks on `forSignature`. Read/Write/Edit's `file_path`,
 * Glob/Grep's `pattern`, and the fetch/web `url` were already untruncated at
 * any length, so `forSignature` changes nothing for them.
 *
 * ## Why this is its own module (#976)
 *
 * It was a private method on `HookEventBridge`, with exactly one caller:
 * `buildPermissionQuestion`, which folds it into `Question.text` as
 * `Allow <tool>: <detail>`. That was fine while nothing else needed it.
 *
 * Precedent (`auto-approve/precedent.ts`) changed that: it needs to CONSULT
 * from a raw `(toolName, toolInput)` at decision time, before any question
 * exists, and (as of #990) also needs the RECORD side to derive from the exact
 * same untruncated call rather than re-deriving anything from `Question.text`.
 * Both sides now call `signatureForOperation`, which calls this function with
 * `{ forSignature: true }` — one function, all callers, no drift possible.
 * (Before #990, the record side reached this function's output by PARSING
 * `Question.text` — a second, truncated derivation of the same value. That was
 * the specific defect this module exists to rule out; see precedent.ts's
 * module doc, "Truncation", for the full incident.)
 *
 * ## Truncation: load-bearing for DISPLAY, no longer for authorization
 *
 * The 120-character cap below is unchanged and still exists for DISPLAY. Before
 * #990, precedent's signature bottomed out in this SAME truncated value, which
 * made the cap load-bearing for authorization too, in a way its original
 * author never considered: two DIFFERENT commands sharing their first 117
 * characters produced the IDENTICAL summary, so approving one would
 * exact-match the other. `precedent.ts` refused any truncated signature
 * outright for that reason (`isTruncatedSignature`), calibrated against the
 * exact shape produced here — 117 kept characters plus a 3-character marker —
 * but that refusal meant every >120-character command was simply uncovered by
 * precedent at all (#989's interim mitigation; #990 is the real fix).
 *
 * As of #990, `signatureForOperation` calls this function with
 * `forSignature: true`, so the signature never truncates and `precedent.ts`'s
 * own truncation refusal should no longer fire on the ordinary record/consult
 * path — it remains only as a defense-in-depth backstop on the query side (see
 * `isTruncatedSignature`'s doc there). **Changing `SUMMARY_MAX` /
 * `TRUNCATED_KEEP` below now only affects DISPLAY text, not authorization** —
 * the privilege-escalation coupling this doc used to warn about is gone,
 * because the signature path no longer calls `truncate` at all.
 */

/** Longest summary emitted verbatim. Beyond this the value is truncated to
 *  `TRUNCATED_KEEP` characters plus `...`. See the module doc: precedent's
 *  truncation refusal is calibrated against exactly this shape. */
const SUMMARY_MAX = 120;
const TRUNCATED_KEEP = 117;

function truncate(value: string): string {
  return value.length > SUMMARY_MAX ? `${value.slice(0, TRUNCATED_KEEP)}...` : value;
}

/** Options for {@link summarizeToolInput}. */
export interface SummarizeToolInputOptions {
  /**
   * `true` for the precedent SIGNATURE form: the value is returned verbatim,
   * never truncated, regardless of length. `false`/absent (the default) is
   * the DISPLAY form used for question text — see the module doc, "Two
   * forms, one function". Only `precedent.ts`'s `signatureForOperation`
   * should ever pass `true`; every other caller wants the display form.
   */
  readonly forSignature?: boolean;
}

/**
 * Extract a short summary from tool input for the question prompt.
 *
 * Returns `null` when the tool carries no summarizable argument — the caller
 * then uses the bare tool name. Pure and total: never throws, never guesses.
 *
 * See the module doc ("Two forms, one function") for `opts.forSignature`.
 */
export function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts?: SummarizeToolInputOptions,
): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const lower = toolName.toLowerCase();
  const forSignature = opts?.forSignature ?? false;

  const get = (key: string): unknown => toolInput[key];
  // DISPLAY truncates to SUMMARY_MAX; SIGNATURE never does. Every branch that
  // can produce an unbounded-length value routes it through this instead of
  // calling `truncate` directly, so there is exactly one place the two forms
  // are allowed to diverge.
  const cap = (value: string): string => (forSignature ? value : truncate(value));

  // Bash: show the command
  if (lower === 'bash' || lower === 'terminal') {
    const cmd = get('command') ?? get('cmd');
    if (typeof cmd === 'string') {
      return cap(cmd);
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
      return cap(val);
    }
  }

  return null;
}
