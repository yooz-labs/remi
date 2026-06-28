/**
 * Pure helpers for answering Claude Code's interactive AskUserQuestion TUI (#627).
 *
 * There is no hook-response channel for AskUserQuestion, so a remote answer must
 * be injected as terminal keystrokes. The interaction model (captured live, see
 * `.context/auq-tui-interaction-model.md` + fixtures in tests/fixtures/auq/):
 *
 *   - A tabbed form: one tab per sub-question, plus a Submit/review tab when there
 *     is more than one question or any multi-select.
 *   - Cursor starts on the first option of a tab; ↑/↓ move one option.
 *   - single-select: Enter chooses the cursor option AND auto-advances to the next
 *     tab (or submits if it's a lone single-select).
 *   - multi-select: Space toggles the cursor option (no advance); Tab/→ leaves.
 *   - review tab: "● <question> → <labels>" + "❯ 1. Submit answers  2. Cancel";
 *     Enter on "Submit answers" submits.
 *
 * This module is PURE: it plans keystrokes from the (already known) question
 * structure + target answer, and parses the review screen for verification. The
 * impure runner (sending keys, awaiting closure) lives elsewhere and only submits
 * once the parsed review matches the target — never guessing.
 */

/** Raw byte sequences for the keys the AskUserQuestion TUI consumes. */
export const AUQ_KEYS = {
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  TAB: '\t',
  ENTER: '\r',
  SPACE: ' ',
  ESC: '\x1b',
} as const;

/** What the driver needs to know about one sub-question to plan its keystrokes. */
export interface AuqQuestionSpec {
  readonly multiSelect: boolean;
  /** Number of pickable options (excludes the TUI's trailing "Type something"). */
  readonly optionCount: number;
}

/**
 * Plan the keystrokes to answer ONE sub-question, assuming the option cursor is on
 * the first option (the invariant when a tab opens). `targetIndices` are 0-based
 * option indices.
 *   - single-select: exactly one target -> `↓×i` then `Enter` (selects + advances).
 *   - multi-select: toggle each target with `Space` (ascending, moving the cursor
 *     with `↓`), then `Tab` to advance toward the next tab / review.
 * Throws on an out-of-range or (for single-select) non-singular target so the
 * caller escalates rather than sending nonsense.
 */
export function planQuestionKeys(
  spec: AuqQuestionSpec,
  targetIndices: readonly number[],
): string[] {
  for (const i of targetIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= spec.optionCount) {
      throw new Error(`AUQ target index ${i} out of range [0, ${spec.optionCount})`);
    }
  }
  if (!spec.multiSelect) {
    if (targetIndices.length !== 1) {
      throw new Error(`single-select needs exactly one target, got ${targetIndices.length}`);
    }
    const i = targetIndices[0] as number;
    return [...Array(i).fill(AUQ_KEYS.DOWN), AUQ_KEYS.ENTER];
  }
  if (targetIndices.length === 0) {
    throw new Error('multi-select needs at least one target');
  }
  const sorted = [...new Set(targetIndices)].sort((a, b) => a - b);
  const keys: string[] = [];
  let cursor = 0;
  for (const idx of sorted) {
    for (let d = 0; d < idx - cursor; d++) keys.push(AUQ_KEYS.DOWN);
    keys.push(AUQ_KEYS.SPACE);
    cursor = idx;
  }
  // Leave the multi-select tab toward the next tab / the review screen. Tab is the
  // footer-advertised navigation key; if it fails to advance, the runner's closure
  // + review verification degrades to escalate (never a wrong submit).
  keys.push(AUQ_KEYS.TAB);
  return keys;
}

/**
 * Plan the full keystroke sequence to answer every sub-question in order.
 * `targets[k]` are the 0-based option indices chosen for question k. Does NOT
 * include the final submit Enter — the runner sends that only after verifying the
 * review screen.
 */
export function planAnswerKeys(
  questions: readonly AuqQuestionSpec[],
  targets: readonly (readonly number[])[],
): string[] {
  if (questions.length !== targets.length) {
    throw new Error(`questions/targets length mismatch: ${questions.length} vs ${targets.length}`);
  }
  const keys: string[] = [];
  for (let k = 0; k < questions.length; k++) {
    keys.push(...planQuestionKeys(questions[k] as AuqQuestionSpec, targets[k] as number[]));
  }
  return keys;
}

/** Strip ANSI/control bytes to the visible text (for parsing rendered frames). */
function visible(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\r/g, '');
}

/** The PTY marker printed once the tool has accepted the answer (closed). */
export function isAuqClosed(frameText: string): boolean {
  return visible(frameText).includes("User answered Claude's questions");
}

/** True when the rendered frame is the review/submit screen. */
export function isReviewScreen(frameText: string): boolean {
  const v = visible(frameText);
  return v.includes('Submit answers') || v.includes('Review your answers');
}

/** One parsed review line: a question and the chosen option label(s). */
export interface ReviewAnswer {
  readonly question: string;
  readonly labels: readonly string[];
}

/**
 * Parse the review screen's "● <question> → <label>[, <label>…]" lines. Returns []
 * when none are found (caller treats as "cannot verify" -> escalate). Tolerant of
 * the run-together rendering: splits on the "●" bullet and the "→" arrow.
 */
export function parseReviewAnswers(frameText: string): ReviewAnswer[] {
  const v = visible(frameText);
  const out: ReviewAnswer[] = [];
  // Each answer starts at a "●" bullet and ends at the next "●" or known trailers.
  for (const chunk of v.split('●').slice(1)) {
    const arrow = chunk.indexOf('→');
    if (arrow < 0) continue;
    const question = chunk.slice(0, arrow).trim();
    // The label list runs until the next UI element (submit prompt / separators).
    let rest = chunk.slice(arrow + 1);
    rest = rest.split(/Ready to submit|❯|─{3,}|Submit answers/)[0] ?? rest;
    const labels = rest
      .split(',')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (question.length > 0 && labels.length > 0) out.push({ question, labels });
  }
  return out;
}

/**
 * Lowercase, collapse whitespace to single spaces, and canonicalize comma spacing
 * ("a , b" / "a,b" -> "a,b"). Keeps internal spaces (so "foo bar" stays distinct
 * from "foobar") while absorbing terminal line-wrap / run-together artifacts.
 */
function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .trim();
}

/**
 * Whether one review answer shows exactly the expected option label(s) — ROBUST TO
 * LABELS THAT CONTAIN COMMAS (#654), without ever accepting a different option.
 *
 * `parseReviewAnswers` splits the rendered label region on commas to separate
 * multiple selected labels, but a comma is ambiguous: an option label can itself
 * contain one (e.g. "Sidecar first, channels.tsv fallback"), which the splitter
 * shatters into phantom parts. Rather than compare comma-split sets (which then
 * miscounts), we re-join BOTH the parsed parts and the expected labels with a
 * single canonical comma and compare the normalized strings exactly. The label is
 * restored, and a different option — even one whose whitespace-stripped text would
 * overlap — does not match, so the runner never submits a wrong answer.
 *
 * Order-sensitive by design: the daemon toggles options in ascending index order
 * and the TUI renders them the same way, so the expected order always equals the
 * rendered order; a genuine reorder escalates (fail-safe) rather than submitting
 * the wrong answer.
 */
function reviewLabelsMatch(parsedParts: readonly string[], expected: readonly string[]): boolean {
  if (expected.length === 0) return false;
  const want = expected.map(normalizeLabel);
  if (want.some((l) => l.length === 0)) return false;
  const region = parsedParts.map(normalizeLabel).filter((l) => l.length > 0);
  return region.join(',') === want.join(',');
}

/**
 * Verify the parsed review matches the expected per-question label sets (the labels
 * of the chosen options). Order of QUESTIONS must match; labels within a question
 * are matched exactly after normalization (see `reviewLabelsMatch`). Any
 * length/label mismatch -> false -> the runner escalates instead of submitting.
 * `expectedLabels[k]` is the label(s) chosen for question k.
 */
export function reviewMatchesTarget(
  parsed: readonly ReviewAnswer[],
  expectedLabels: readonly (readonly string[])[],
): boolean {
  if (parsed.length !== expectedLabels.length) return false;
  return parsed.every((ans, k) => reviewLabelsMatch(ans.labels, expectedLabels[k] ?? []));
}
