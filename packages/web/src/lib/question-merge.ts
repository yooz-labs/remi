/**
 * Client-side richer-wins guard for question rendering (#396; backstory
 * in #378).
 *
 * The daemon emits two questions for the same prompt cycle:
 * `HookEventBridge` (synchronous on `PermissionRequest`, falling back to the
 * default Yes / No 2-set when `permission_suggestions` has no usable entry,
 * #718) and the PTY parser (terminal-extracted, frequently richer with
 * full-sentence options for plan-mode prompts). The two emissions
 * arrive on the wire as separate `question` messages with different ids;
 * the consumer in `App.tsx` keys its question map by sessionId, so the
 * second arrival otherwise overwrites the first regardless of richness.
 *
 * The fix lives at the rendering boundary instead of the daemon-side
 * dedup: keep the richer pending question on screen and ignore poorer
 * emissions for the same session within the freshness window. Daemon
 * dedup remains as the safety net for genuinely-distinct prompts that
 * cross a status transition.
 *
 * Replay-after-answer guard: if the existing question was already
 * answered AND the incoming arrival has the same id (a `replay_batch`
 * re-feed of the same wire message), keep the existing one so the
 * `answeredWith` state is not silently wiped and the user is not
 * re-prompted for a question they already resolved.
 *
 * Stale guard: if existing was emitted longer ago than the freshness
 * window, fall back to last-wins so a reconnect after lunch shows the
 * latest prompt rather than a cached richer one. The window is imported
 * from `@remi/shared` so daemon and client always agree on what counts
 * as "the same prompt instance".
 */

import { QUESTION_DEDUP_WINDOW_MS, DEFAULT_PERMISSION_LABELS } from '@remi/shared';
import type { UIQuestion } from '@/types';

/** Re-export so consumers can mirror the freshness contract. */
export const QUESTION_FRESHNESS_MS = QUESTION_DEDUP_WINDOW_MS;

export interface ShouldKeepExistingOptions {
  readonly freshnessMs?: number;
  readonly now?: () => number;
}

/**
 * Detects the daemon's hardcoded fallback (#718: the honest Yes/No 2-set
 * substituted when `permission_suggestions` has no usable entry).
 *
 * Primary signal: `question.optionsAreFallback`, threaded verbatim from the
 * wire `Question` (App.tsx). This is authoritative — trust it whenever the
 * daemon set it either way. Shrinking the fallback to a plain 2-option
 * Yes/No (from the old, distinctively-shaped 3-set) means a genuine
 * suggestion-free PTY prompt that happens to render as "Yes"/"No" is now
 * label-identical to the fallback, so label matching alone can no longer
 * tell them apart; the explicit flag is what removes that ambiguity.
 *
 * The label match below only runs when the flag is entirely absent (a
 * question from before this field existed, e.g. a stale cached replay) and
 * is inherently approximate for exactly the reason above — a real 2-option
 * Yes/No question with no flag at all collides with it by coincidence. That
 * residual imprecision is accepted as a legacy-compatibility fallback, not a
 * design goal.
 */
function isDefaultFallbackShape(question: UIQuestion): boolean {
  if (question.optionsAreFallback !== undefined) return question.optionsAreFallback;
  const opts = question.structuredOptions;
  if (!opts || opts.length !== DEFAULT_PERMISSION_LABELS.length) return false;
  const labels = opts.map((o) => (o.label ?? '').toLowerCase().trim());
  const expected = DEFAULT_PERMISSION_LABELS.map((l) => l.toLowerCase());
  return labels.every((label, i) => label === expected[i]);
}

function optionCount(question: UIQuestion): number {
  return question.structuredOptions?.length ?? 0;
}

type Decision =
  | 'replay-of-answered'
  | 'richer-count'
  | 'richer-shape'
  | 'answered'
  | 'stale'
  | 'malformed-timestamp'
  | 'incoming-richer-count'
  | 'incoming-equal-or-poorer';

function logSuppression(decision: Decision, existing: UIQuestion, incoming: UIQuestion): void {
  console.debug(
    `[question-merge] ${decision} (existing.id=${existing.id} ${optionCount(existing)}opts, incoming.id=${incoming.id} ${optionCount(incoming)}opts, session=${existing.sessionId})`,
  );
}

/**
 * Decide whether to keep the existing pending question. `true` means the
 * incoming arrival is dropped at the render boundary; `false` means
 * replace as usual.
 */
export function shouldKeepExisting(
  existing: UIQuestion,
  incoming: UIQuestion,
  options: ShouldKeepExistingOptions = {},
): boolean {
  // A resolved card is either answered locally (`answeredWith`) or flipped to a
  // short-lived "resolved elsewhere" trace (`resolvedReason`, #652). Both are
  // terminal states and must be handled symmetrically below.
  const existingResolved = existing.answeredWith != null || existing.resolvedReason != null;

  // Replay-after-resolve: a `replay_batch` re-feed of the original question
  // carries the same id. Keep the resolved state intact so the user is not
  // re-prompted for a question they already resolved.
  if (existingResolved && existing.id === incoming.id) {
    logSuppression('replay-of-answered', existing, incoming);
    return true;
  }

  // Different id with a resolved existing: a genuinely new prompt is arriving
  // (the trace fades / the answer ack clears shortly). Let the new one through
  // rather than let a stale trace suppress a live question.
  if (existingResolved) return false;

  const freshnessMs = options.freshnessMs ?? QUESTION_FRESHNESS_MS;
  const clock = options.now ?? Date.now;
  const existingMs = Date.parse(existing.timestamp);
  if (!Number.isFinite(existingMs)) {
    // Fail-closed: a corrupted/legacy timestamp must not pin the UI.
    logSuppression('malformed-timestamp', existing, incoming);
    return false;
  }
  // Clamp negative ages (clock skew where existing is in the future)
  // to zero so the defense window applies normally rather than stretching
  // forever via the negative-ageMs side path.
  const age = Math.max(0, clock() - existingMs);
  if (age >= freshnessMs) {
    logSuppression('stale', existing, incoming);
    return false;
  }

  const existingCount = optionCount(existing);
  const incomingCount = optionCount(incoming);
  const existingIsDefault = isDefaultFallbackShape(existing);
  const incomingIsDefault = isDefaultFallbackShape(incoming);

  // The daemon's hardcoded Yes / No is the bland fallback shape; it must
  // never replace a non-default question regardless of option count (#407).
  // The previous rule "more options = richer" let a fabricated 3-set replace
  // a 2-option Yes/No emitted by the PTY parser, so the user saw three
  // options for what they expected to be a yes/no (#718 removed the
  // fabricated 3-set entirely, but the same overwrite risk applies to the
  // honest 2-set fallback vs. a richer PTY-parsed set).
  if (incomingIsDefault && !existingIsDefault) {
    logSuppression('richer-shape', existing, incoming);
    return true;
  }
  if (!incomingIsDefault && existingIsDefault) {
    logSuppression('incoming-richer-count', existing, incoming);
    return false;
  }

  // Same shape class on both sides: rank by option count, then fall
  // through to "replace" so the most recent same-rank emission wins.
  if (existingCount > incomingCount) {
    logSuppression('richer-count', existing, incoming);
    return true;
  }
  logSuppression(
    incomingCount > existingCount ? 'incoming-richer-count' : 'incoming-equal-or-poorer',
    existing,
    incoming,
  );
  return false;
}
