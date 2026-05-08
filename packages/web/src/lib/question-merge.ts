/**
 * Client-side richer-wins guard for question rendering (#396; backstory
 * in #378).
 *
 * The daemon emits two questions for the same prompt cycle:
 * `HookEventBridge` (synchronous on `PermissionRequest`, often with the
 * default Yes / Yes-always / No 3-set when `permission_suggestions` is
 * undefined) and the PTY parser (terminal-extracted, frequently richer
 * with full-sentence options for plan-mode prompts). The two emissions
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
 * Detects the daemon's hardcoded fallback labels. Strict literal match
 * (lowercased + trimmed) against `DEFAULT_PERMISSION_LABELS`; a richer
 * custom 3-set like Edit's "Yes, and don't ask again this session" /
 * "No, and tell Claude what to do differently" is intentionally NOT
 * classified as the bland default.
 */
function isDefaultThreeSetShape(question: UIQuestion): boolean {
  const opts = question.structuredOptions;
  if (!opts || opts.length !== 3) return false;
  const labels = opts.map((o) => (o.label ?? '').toLowerCase().trim());
  const expected = DEFAULT_PERMISSION_LABELS.map((l) => l.toLowerCase());
  return labels[0] === expected[0] && labels[1] === expected[1] && labels[2] === expected[2];
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
  // Replay-after-answer: a `replay_batch` re-feed of the original
  // question carries the same id. Keep the answered state intact so
  // the user is not re-prompted for a question they already resolved.
  if (existing.answeredWith && existing.id === incoming.id) {
    logSuppression('replay-of-answered', existing, incoming);
    return true;
  }

  // Different question id with an answered existing: a genuinely new
  // prompt is arriving (the answer ack will demote `answeredWith`
  // shortly). Let the new one through.
  if (existing.answeredWith) return false;

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
  const existingIsDefault = isDefaultThreeSetShape(existing);
  const incomingIsDefault = isDefaultThreeSetShape(incoming);

  // The daemon's hardcoded Yes / Yes-always / No is the bland fallback
  // shape; it must never replace a non-default question regardless of
  // option count (#407). The previous rule "more options = richer" let
  // the 3-set replace a 2-option Yes/No emitted by the PTY parser, so
  // the user saw three options for what they expected to be a yes/no.
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
