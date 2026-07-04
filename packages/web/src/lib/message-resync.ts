/**
 * Preserve client-only messages across a transcript resync (#687).
 *
 * `clearSessionForRebind` (App.tsx) wipes a session's messages whenever its
 * Claude binding rotates -- live `/clear` or `/resume` (`session_rotated`),
 * or a reconnect that discovers the daemon rebuilt the session against a new
 * Claude process (`hello_ack` + `bindingRotated`, see session-binding.ts).
 * The wipe exists so the freshly (re)loaded transcript repopulates from a
 * known-clean slate instead of mixing in stale history from the old Claude
 * session. That reload is authoritative for anything Claude actually saw --
 * but a message the user typed while disconnected never reached Claude at
 * all, so it has no transcript entry to be repopulated by. Wiping
 * unconditionally is what #687 reports: a 'failed' bubble (and its "Failed
 * to send" note) vanish with no trace and nothing left to retry.
 *
 * `selectResyncSurvivors` identifies exactly those never-confirmed messages
 * so the caller can hold onto them instead of discarding them; the caller
 * (App.tsx) stashes them in a ref for the duration of the resync, then calls
 * `mergeResyncSurvivors` once the fresh reload has landed, re-attaching
 * whichever survivors didn't turn out to have landed after all.
 */

import type { UIMessage } from '../types';

/**
 * A user message counts as "unconfirmed" if the daemon hasn't acked it yet
 * ('sending', or 'sent' -- #663's post-send/pre-ack state) or the
 * ack-timeout/immediate-send-failure path gave up on it ('failed'). A
 * 'delivered' or 'read' message already has a daemon ack; if a rotation
 * invalidates it, it legitimately belongs to the OLD conversation like any
 * other pre-rotation history, not to otherwise-unrecoverable user intent.
 */
function isUnconfirmedUserMessage(m: UIMessage): boolean {
  return m.sender === 'user' && (m.state === 'sending' || m.state === 'sent' || m.state === 'failed');
}

/**
 * Messages belonging to `sessionId` that must survive a resync wipe:
 * unconfirmed user sends, plus any system note attached to one via
 * `relatedMessageId` (e.g. the "Failed to send message" bubble `handleSend`
 * adds alongside a synchronous send failure). Order is preserved from
 * `messages`. Returns an empty array when the session has nothing
 * unconfirmed -- the common case, where the resync wipe is safe as-is.
 */
export function selectResyncSurvivors(
  messages: readonly UIMessage[],
  sessionId: string,
): readonly UIMessage[] {
  const sessionMessages = messages.filter((m) => m.sessionId === sessionId);
  const unconfirmedIds = new Set(
    sessionMessages.filter(isUnconfirmedUserMessage).map((m) => m.id),
  );
  if (unconfirmedIds.size === 0) return [];
  return sessionMessages.filter(
    (m) =>
      unconfirmedIds.has(m.id) ||
      (m.relatedMessageId !== undefined && unconfirmedIds.has(m.relatedMessageId)),
  );
}

/**
 * Allowance for client/server clock drift when deciding whether a reloaded
 * entry is recent enough to be a candidate match for a survivor's send (see
 * `mergeResyncSurvivors`). The daemon is reached over a local network, so
 * drift should be minor, but isn't assumed to be exactly zero.
 *
 * Known tradeoff: `survivor.timestamp` is the CLIENT's clock (set at
 * `handleSend`); the reloaded entry's `timestamp` is the DAEMON's clock (from
 * Claude Code's JSONL `createdAt`). These are two different machines' clocks,
 * not just network latency -- a remote setup (phone over Wi-Fi/cellular to a
 * dev machine, rather than same-machine/LAN) can plausibly drift past 5s.
 * If it does, a genuinely-landed send gets wrongly rejected as a candidate
 * match and is re-appended as a survivor alongside its own transcript twin:
 * a non-destructive duplicate bubble (the failed-looking bubble plus its
 * landed copy), not data loss. That's the accepted failure mode here --
 * strictly better than the pre-fix behavior of silently dropping the
 * message entirely.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5000;

/**
 * Indices into `reloaded` that are content-eligible matches for `survivor`:
 * same sender+content, AND timestamped at or after the survivor's own send
 * (minus clock-skew tolerance). The timestamp floor is what excludes
 * unrelated, already-landed history that merely happens to share the same
 * text (e.g. the user replied "ok" three times earlier in the conversation,
 * long before this survivor's own, unrelated "ok" was typed) -- a plain
 * content match with no time bound would misclassify that old, unrelated
 * send as "this one landed" and drop it.
 */
function candidateLandedIndices(survivor: UIMessage, reloaded: readonly UIMessage[]): number[] {
  const cutoff = Date.parse(survivor.timestamp) - CLOCK_SKEW_TOLERANCE_MS;
  const indices: number[] = [];
  reloaded.forEach((r, i) => {
    if (r.sender === survivor.sender && r.content === survivor.content) {
      const rTime = Date.parse(r.timestamp);
      // An unparseable timestamp can't be confirmed as at-or-after the
      // survivor's send; treat it as not a match rather than risk a false
      // positive (losing genuine user intent is worse than a rare
      // stray duplicate).
      if (!Number.isNaN(rTime) && rTime >= cutoff) indices.push(i);
    }
  });
  return indices;
}

/**
 * Re-attach `survivors` after a fresh transcript reload. A survivor is
 * dropped instead of re-attached when it turns out to have landed after all
 * -- a reloaded message with matching sender+content and a plausible
 * timestamp (the ack or its note was lost, not the send itself; the
 * daemon's `MessageIdTracker` makes a same-id retry idempotent, but the
 * reloaded transcript's entry ids are generated independently of the
 * client's wire message id, so content is the only correlation available
 * here -- same as the existing optimistic <-> transcript reconciliation in
 * message-dedup.ts). A system note is kept only alongside the send it
 * describes, never on its own.
 *
 * Claim discipline: each reloaded entry can satisfy at most one survivor
 * (first-come, in `survivors` order). Without this, two distinct sends with
 * identical content -- one landed, one genuinely failed (e.g. the user typed
 * "continue" twice) -- would BOTH match the single reloaded entry and both
 * get dropped, reproducing the #687 bug class via duplicate content instead
 * of via a resync wipe.
 *
 * Ordering: survivors are appended after `reloaded` -- they are
 * chronologically the newest thing that happened before the resync. If
 * `reloaded` itself contains something even newer (e.g. a live rotation
 * racing fresh Claude output), a plain append is accepted rather than
 * attempting timestamp-perfect interleaving.
 */
export function mergeResyncSurvivors(
  reloaded: readonly UIMessage[],
  survivors: readonly UIMessage[],
): readonly UIMessage[] {
  if (survivors.length === 0) return reloaded;

  const claimedReloadedIndices = new Set<number>();
  const survivingUserIds = new Set<UIMessage['id']>();

  for (const m of survivors) {
    if (m.sender !== 'user') continue;
    const candidates = candidateLandedIndices(m, reloaded).filter(
      (i) => !claimedReloadedIndices.has(i),
    );
    if (candidates.length > 0) {
      claimedReloadedIndices.add(candidates[0]);
    } else {
      survivingUserIds.add(m.id);
    }
  }

  const finalSurvivors = survivors.filter((m) => {
    if (m.sender === 'user') return survivingUserIds.has(m.id);
    if (m.relatedMessageId !== undefined) return survivingUserIds.has(m.relatedMessageId);
    return true;
  });

  return [...reloaded, ...finalSurvivors];
}
