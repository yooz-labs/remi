/**
 * Pure helpers for useConnectionManager.
 *
 * Extracted into a separate module so tests can exercise them without
 * pulling in React, the WebSocket client, or identity-store side effects.
 */

/**
 * Collect all connections that are currently waiting on a passphrase so a
 * single unlock can satisfy them at once (#257).
 *
 * Without this, the UI would re-prompt for every sibling daemon port (e.g.
 * after restoring auto-connections from localStorage on launch) even though
 * the same identity unlocks all of them.
 */
export function collectPendingChallengeConnections<
  T extends { pendingChallenge: unknown; needsPassphrase: boolean },
>(connections: Iterable<T>): T[] {
  const out: T[] = [];
  for (const c of connections) {
    if (c.pendingChallenge) out.push(c);
  }
  return out;
}
