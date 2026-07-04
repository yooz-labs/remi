/**
 * Pure decision helpers for which session is "active" -- the one whose chat
 * is on screen and whose input box is live (#688).
 *
 * The safety property this file exists to guarantee: with multiple live
 * daemons/sessions aggregated into one client, a user's explicit choice of
 * session must never be silently swapped for a DIFFERENT live session by a
 * background event (`session_list_response` merge, `hello_ack` reconnect, a
 * stale-transcript redirect, mDNS aggregation refresh). Only two kinds of
 * automatic transition are allowed:
 *   - clearing to `null` when the active session itself becomes invalid
 *     (evicted / no longer known), so the UI falls back to the session list
 *     instead of sitting on a ghost id or jumping to whatever else is live;
 *   - landing on a specific session when NOTHING is currently selected
 *     (fresh connect / stale-transcript redirect with no chat open) -- never
 *     overriding an existing selection.
 * An explicit user tap, notification-tap, or resume result is the only
 * thing that may move the active session to a specific, different id; those
 * call sites set it directly and do not need a helper here.
 */

export type SessionId = string;

/**
 * The active session no longer exists under its owning connection (phantom
 * eviction, or a `hello_ack` reporting a different session for the same
 * connection). Falls back to `null` ONLY when `evictedId` is the currently
 * active session; a no-op otherwise -- some OTHER session vanishing must
 * never disturb what the user is looking at.
 */
export function evictIfActive<T extends SessionId>(current: T | null, evictedId: T): T | null {
  return current === evictedId ? null : current;
}

/**
 * Same as {@link evictIfActive} for a batch of ids (a multi-daemon phantom
 * sweep evaluated in one `session_list_response`).
 */
export function evictManyIfActive<T extends SessionId>(
  current: T | null,
  evictedIds: ReadonlySet<T>,
): T | null {
  return current !== null && evictedIds.has(current) ? null : current;
}

/**
 * An automatic follow/restore candidate (a stale-transcript NOT_FOUND
 * redirect, startup restoration of the last-used session). Takes effect
 * ONLY when nothing is currently selected; once a session is active --
 * explicitly picked, or itself auto-selected -- no later candidate may
 * override it. Eviction is the only way back to `null`.
 */
export function autoSelectIfNone<T extends SessionId>(current: T | null, candidateId: T): T | null {
  return current === null ? candidateId : current;
}
