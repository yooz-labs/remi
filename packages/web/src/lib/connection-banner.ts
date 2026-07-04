/**
 * Pure helper for scoping the in-chat connection-error banner to the
 * connection actually serving the active session (#682).
 *
 * Before this fix, the banner was derived globally: `connections.find(c =>
 * c.status === 'error')`, regardless of which connection the current chat
 * uses. With more than one daemon connection tracked (a stale/duplicate
 * entry, or a genuinely separate second daemon), an unrelated errored
 * connection could pin a "Connection error" banner and disable the chat
 * input even while the session on screen was fully attached and healthy.
 */

/** Minimal shape this helper needs from a connection entry. */
export interface BannerConnectionLike {
  readonly connectionId: string;
  readonly status: string;
  readonly error: string | null;
}

/**
 * Derive the connection-error banner text for the chat view. Scoped to the
 * connection serving `activeConnectionId` (the active session's own
 * connection) so a healthy attached daemon is never shadowed by a DIFFERENT
 * daemon's error. Falls back to a global scan across all connections only
 * when there is no active session to scope to (nothing session-specific to
 * show yet).
 */
export function deriveConnectionBannerError<C extends BannerConnectionLike>(
  connections: readonly C[],
  activeConnectionId: string | null,
): string | null {
  if (activeConnectionId != null) {
    const active = connections.find((c) => c.connectionId === activeConnectionId);
    // No entry for the active session's connection, or it isn't errored:
    // there is nothing session-specific to surface. Deliberately does NOT
    // fall back to a global scan here -- a sibling daemon's error must never
    // bleed into a session it doesn't serve.
    if (!active || active.status !== 'error') return null;
    return active.error ?? `Connection error: ${active.connectionId}`;
  }

  const errored = connections.find((c) => c.status === 'error');
  if (!errored) return null;
  return errored.error ?? `Connection error: ${errored.connectionId}`;
}
