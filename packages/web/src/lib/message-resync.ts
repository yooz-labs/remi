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
 * Re-attach `survivors` after a fresh transcript reload. A survivor is
 * dropped instead of re-attached when it turns out to have landed after all
 * -- a reloaded message with matching sender+content (the ack or its note
 * was lost, not the send itself; the daemon's `MessageIdTracker` makes a
 * same-id retry idempotent, but the reloaded transcript's entry ids are
 * generated independently of the client's wire message id, so content is
 * the only correlation available here -- same as the existing optimistic
 * <-> transcript reconciliation in message-dedup.ts). A system note is kept
 * only alongside the send it describes, never on its own.
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

  const landedByContent = (m: UIMessage) =>
    reloaded.some((r) => r.sender === m.sender && r.content === m.content);

  const survivingUserIds = new Set(
    survivors.filter((m) => m.sender === 'user' && !landedByContent(m)).map((m) => m.id),
  );

  const finalSurvivors = survivors.filter((m) => {
    if (m.sender === 'user') return survivingUserIds.has(m.id);
    if (m.relatedMessageId !== undefined) return survivingUserIds.has(m.relatedMessageId);
    return true;
  });

  return [...reloaded, ...finalSurvivors];
}
