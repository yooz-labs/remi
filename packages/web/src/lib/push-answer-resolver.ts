/**
 * Helpers for routing a push-notification answer back to the right daemon.
 *
 * When the user taps an "Allow" / "Deny" action on the iOS lock screen,
 * `App.tsx` receives a `push-notification-answer` CustomEvent with the
 * sessionId, questionId, and answer value. The handler then needs to:
 *
 *   1. Locate the session in the in-memory session list to find its
 *      `connectionId` (so the answer goes to the right daemon when the
 *      iOS client is attached to multiple).
 *   2. If a live connection exists, send immediately.
 *   3. Otherwise pick a daemon URL to (re)connect to — preferably the URL
 *      the dead connection had, falling back to the first URL persisted
 *      to localStorage (cold-start path: app was suspended, lock-screen
 *      tap brought it back, no connection map exists yet).
 *   4. Wait briefly for the connection, send.
 *
 * Steps 1-3 are pure data manipulation that this module owns; step 4 is
 * the React/refs layer in App.tsx. Keeping the URL-resolution pure here
 * is the only way to unit-test it — the web package does not currently
 * ship a DOM/component test runner. Issue #278.
 */

interface SessionRef {
  readonly id: string;
  readonly connectionId?: string | null;
}

interface ConnectionRef {
  readonly connectionId: string;
  readonly url: string;
  readonly status:
    | 'connected'
    | 'connecting'
    | 'authenticating'
    | 'reconnecting'
    | 'disconnected'
    | 'error';
}

export interface ResolvedAnswerTarget {
  /**
   * `live` — the connection is up; caller should send `answerMsg` directly
   * via `connectionId`.
   * `reconnect` — caller should `connectDirect(url)` and then poll for the
   * connection becoming `connected` before sending.
   * `pending` — a connect to this URL is already in flight; caller should
   * poll the existing `connectionId` for `connected` then send.
   * `unreachable` — no live connection, no usable URL anywhere; caller
   * should surface a notification telling the user to open the app.
   */
  readonly kind: 'live' | 'reconnect' | 'pending' | 'unreachable';
  readonly connectionId?: string;
  readonly url?: string;
}

/**
 * Look up the answer's session in `sessions`, find its connection in
 * `connections`, and decide what to do. The function does NOT mutate or
 * dispatch anything — it just reports the decision.
 */
export function resolvePushAnswerTarget(input: {
  readonly sessionId: string;
  readonly sessions: readonly SessionRef[];
  readonly connections: readonly ConnectionRef[];
  readonly storedUrls: readonly string[];
}): ResolvedAnswerTarget {
  const { sessionId, sessions, connections, storedUrls } = input;

  const session = sessions.find((s) => s.id === sessionId);
  const connectionId = session?.connectionId ?? undefined;

  // 1. Live connection for this session — send immediately.
  if (connectionId) {
    const conn = connections.find((c) => c.connectionId === connectionId);
    if (conn?.status === 'connected') {
      return { kind: 'live', connectionId, url: conn.url };
    }
    // 2. We know the URL but the connection is down; reconnect.
    if (conn?.url) {
      const inflight = connections.find(
        (c) =>
          c.url === conn.url &&
          (c.status === 'connecting' ||
            c.status === 'authenticating' ||
            c.status === 'reconnecting'),
      );
      if (inflight) {
        return { kind: 'pending', connectionId: inflight.connectionId, url: conn.url };
      }
      return { kind: 'reconnect', url: conn.url };
    }
  }

  // 3. Cold start: no session-bound URL, fall back to localStorage.
  const cold = storedUrls[0];
  if (!cold) return { kind: 'unreachable' };

  const inflight = connections.find(
    (c) =>
      c.url === cold &&
      (c.status === 'connecting' ||
        c.status === 'authenticating' ||
        c.status === 'reconnecting'),
  );
  if (inflight) {
    return { kind: 'pending', connectionId: inflight.connectionId, url: cold };
  }
  return { kind: 'reconnect', url: cold };
}
