/**
 * Outstanding-send tracking for the client-side ack timeout + retry state
 * machine (#663).
 *
 * Background: the daemon has always sent an `ack` for every `user_input`
 * it receives (`packages/daemon/src/server/connection.ts`, `sendAck`), but
 * the web client never handled it -- `sending -> sent` was purely
 * optimistic and never advanced to `delivered`. Combined with #662 (a
 * queued/read-only connection can silently drop input), a message could
 * look "sent" forever with no way to tell it never landed.
 *
 * This module is the pure bookkeeping half of the fix: given a message id
 * handed to `sendInput`, track it here; when an `ack` arrives, match it;
 * when no `ack` arrives within `ACK_TIMEOUT_MS`, resend once (same message
 * id -- the daemon's `MessageIdTracker` dedups a resend that already
 * landed, so this is safe even if only the ack was lost, not the input);
 * a second timeout gives up and reports 'failed'. All state transitions
 * are pure functions over a plain Map so they're unit-testable without a
 * WebSocket, a timer, or React -- the caller (App.tsx) owns the ref, the
 * `setInterval` sweep, and turning outcomes into UI state changes.
 *
 * Deliberately NOT covered here (out of scope for #663): 'read' receipts,
 * and an offline outbox for sends attempted while fully disconnected (the
 * issue calls that out as an optional follow-up).
 */

/** No `ack` within this long after a send (or a retry) times it out. */
export const ACK_TIMEOUT_MS = 5000;

/** A `user_input` sent to the daemon, awaiting its `ack`. */
export interface PendingSend {
  readonly messageId: string;
  readonly connectionId: string;
  readonly sessionId: string;
  /** Wire content, exactly as sent -- resent verbatim on retry. */
  readonly content: string;
  readonly claudeSessionId?: string;
  /** When this attempt (the original send, or the one retry) went out. */
  readonly sentAt: number;
  /** 0 = original send, 1 = the one automatic retry already attempted. */
  readonly retryCount: number;
}

export type PendingSendMap = ReadonlyMap<string, PendingSend>;

/** Empty map, for initializing the ref. */
export const EMPTY_PENDING_SENDS: PendingSendMap = new Map();

/** Start tracking a freshly-sent `user_input`. Returns a new map (does not mutate `pending`). */
export function trackSend(
  pending: PendingSendMap,
  entry: Omit<PendingSend, 'retryCount'>,
): PendingSendMap {
  const next = new Map(pending);
  next.set(entry.messageId, { ...entry, retryCount: 0 });
  return next;
}

export interface AcknowledgeResult {
  readonly pending: PendingSendMap;
  /** False for an ack that doesn't match anything outstanding: a message
   *  type we don't track (only `user_input` sends are tracked), or one
   *  that already timed out to 'failed' (and was removed) before this ack
   *  arrived. Callers should no-op the UI in that case. */
  readonly matched: boolean;
}

/** An `ack` arrived for `messageId`. Stops tracking it. */
export function acknowledgeSend(pending: PendingSendMap, messageId: string): AcknowledgeResult {
  if (!pending.has(messageId)) {
    return { pending, matched: false };
  }
  const next = new Map(pending);
  next.delete(messageId);
  return { pending: next, matched: true };
}

/**
 * The daemon explicitly REJECTED `messageId` (#681, e.g. a `NOT_ACTIVE_CONNECTION`
 * error naming this id): the send is authoritatively dead, not merely
 * unacknowledged. Stops tracking it so a later `acknowledgeSend` (a stale ack
 * that was already in flight) or `sweepTimeouts` retry/failure for the same id
 * is a no-op instead of re-animating it -- the caller marks the message
 * bubble 'failed' directly and that must WIN over anything the pending-map
 * bookkeeping does afterward, including a bubble already at 'delivered' from
 * an earlier ack. Idempotent: rejecting an id that isn't (or is no longer)
 * tracked is a no-op, since by the time this fires the ack has usually
 * already removed it from `pending`.
 */
export function rejectSend(pending: PendingSendMap, messageId: string): PendingSendMap {
  if (!pending.has(messageId)) {
    return pending;
  }
  const next = new Map(pending);
  next.delete(messageId);
  return next;
}

export type TimeoutOutcome =
  /** First timeout: resend `entry` (same messageId) and keep waiting. */
  | { readonly kind: 'retry'; readonly entry: PendingSend }
  /** Second timeout (already retried once): give up. */
  | { readonly kind: 'failed'; readonly entry: PendingSend };

export interface SweepResult {
  readonly pending: PendingSendMap;
  readonly outcomes: readonly TimeoutOutcome[];
}

/**
 * Find sends that have been outstanding longer than `timeoutMs` and advance
 * them. Pure -- `now` is injected so callers (and tests) control time.
 */
export function sweepTimeouts(
  pending: PendingSendMap,
  now: number,
  timeoutMs: number = ACK_TIMEOUT_MS,
): SweepResult {
  const next = new Map(pending);
  const outcomes: TimeoutOutcome[] = [];

  for (const [id, entry] of pending) {
    if (now - entry.sentAt < timeoutMs) continue;

    if (entry.retryCount === 0) {
      const retried: PendingSend = { ...entry, sentAt: now, retryCount: entry.retryCount + 1 };
      next.set(id, retried);
      outcomes.push({ kind: 'retry', entry: retried });
    } else {
      next.delete(id);
      outcomes.push({ kind: 'failed', entry });
    }
  }

  return { pending: next, outcomes };
}
