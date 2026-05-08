/**
 * Client-side richer-wins guard for question rendering (#396).
 *
 * The daemon emits questions from two sources for the same prompt cycle:
 * `HookEventBridge` (synchronous on `PermissionRequest`, often with the
 * default Yes / Yes-always / No 3-set when `permission_suggestions` is
 * undefined) and the PTY parser (terminal-extracted, frequently richer
 * with full-sentence options for plan-mode prompts and tools that
 * present numbered choices). The two emissions arrive on the wire as
 * separate `question` messages with different ids; the consumer in
 * `App.tsx` keys its question map by sessionId, so the second arrival
 * overwrites the first regardless of richness.
 *
 * Daemon-side dedup is the wrong place to fix this: making it more
 * aggressive would silently drop a second legitimate `PermissionRequest`
 * fired in the same waiting status window (e.g. parallel tool calls in
 * one agent turn). The fix lives at the rendering boundary instead:
 * keep the richer pending question on screen and ignore subsequent
 * poorer emissions for the same session within a short window.
 *
 * Stale-question guard: if the existing question's timestamp is older
 * than the freshness window, allow replacement. A user who left the app
 * yesterday and reconnects today should see the latest prompt, not a
 * cached richer one. Aligned with the daemon's `QuestionDedup` 5 s
 * window so the two layers agree on what counts as "the same prompt
 * instance".
 */

import type { UIQuestion } from '@/types';

/** How long a pending question is considered fresh enough to defend. */
export const QUESTION_FRESHNESS_MS = 5000;

/**
 * Returns true when the question matches the daemon's hardcoded fallback
 * "Yes / Yes, always / No" 3-option set (literal labels in
 * `DEFAULT_PERMISSION_OPTIONS` at `hook-event-bridge.ts`). Distinct from
 * the daemon-side `looksLikeDefaultPermissionQuestion`, which uses a
 * loose startsWith check to drop PTY re-emissions of the SAME terminal
 * prompt; here we want a strict match so a richer custom 3-set with
 * sentence labels (e.g. Edit's "Yes, and don't ask again this session"
 * and "No, and tell Claude what to do differently") is NOT classified
 * as the poor default.
 */
function isDefaultThreeSetShape(question: UIQuestion): boolean {
  const opts = question.structuredOptions;
  if (!opts || opts.length !== 3) return false;
  const labels = opts.map((o) => (o.label ?? '').toLowerCase().trim());
  return labels[0] === 'yes' && labels[1] === 'yes, always' && labels[2] === 'no';
}

/** Number of structured options on a question, treating absent as zero. */
function optionCount(question: UIQuestion): number {
  return question.structuredOptions?.length ?? 0;
}

/**
 * Decide whether to keep an existing pending question instead of replacing
 * it with a newly-arrived one. Returns `true` to keep `existing`.
 *
 * - Already answered: don't keep; treat the incoming as a fresh prompt.
 * - Existing is stale (older than the freshness window): don't keep.
 * - Existing has strictly more options than incoming: keep.
 * - Equal option count, incoming is the default 3-set shape and existing
 *   is not: keep (covers the cross-fingerprint hook overwrite race).
 * - Otherwise: don't keep (let the new question replace).
 */
export function shouldKeepExisting(
  existing: UIQuestion,
  incoming: UIQuestion,
  options: { freshnessMs?: number; now?: () => number } = {},
): boolean {
  if (existing.answeredWith) return false;

  const freshnessMs = options.freshnessMs ?? QUESTION_FRESHNESS_MS;
  const clock = options.now ?? Date.now;
  const existingMs = Date.parse(existing.timestamp);
  if (Number.isFinite(existingMs) && clock() - existingMs >= freshnessMs) {
    return false;
  }

  const existingCount = optionCount(existing);
  const incomingCount = optionCount(incoming);

  if (existingCount > incomingCount) return true;
  if (
    existingCount === incomingCount &&
    isDefaultThreeSetShape(incoming) &&
    !isDefaultThreeSetShape(existing)
  ) {
    return true;
  }
  return false;
}
