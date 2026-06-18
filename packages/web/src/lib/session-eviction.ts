/**
 * Phantom-session eviction (#577, Fix A — the primary fix for the recurring
 * "Transcript for session <id> not found").
 *
 * The bug: the iOS/web client caches sessions in its in-memory list (rehydrated
 * across reconnects). When a session dies and the daemon purges it from
 * sessions.json (100-entry cap / 7-day TTL), the daemon stops listing it — but
 * the client keeps the dead remi UUID and re-requests its transcript on every
 * reconnect, producing NOT_FOUND each time (the `b7f8d9af` loop).
 *
 * The fix evicts a cached session ONLY when it is, conservatively, both:
 *   1. unknown to the daemon that owns it (absent from that connection's fresh
 *      session_list_response / hello_ack), AND
 *   2. stale — its lastActivity is older than STALE_EVICT_AGE_MS (~14 days).
 *
 * Two guards keep eviction from ever wiping a still-valid session:
 *   - Per-connection scoping: a session is only a candidate when we have just
 *     heard the AUTHORITATIVE list for ITS OWN connection. A session belonging
 *     to connection B is never evicted because connection A's list omits it
 *     (multi-daemon), and a session whose connection has not (re)listed this
 *     cycle is never touched.
 *   - Minimum-age guard: a freshly restarted daemon may reconnect and ack
 *     before it has re-listed older sessions. The staleness threshold means a
 *     recent session is never a candidate; the minimum-age guard makes that
 *     explicit and independent of the staleness window so a session younger
 *     than MIN_EVICT_AGE_MS is always kept even if STALE_EVICT_AGE_MS were
 *     set incorrectly.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A cached session is only evictable once its lastActivity is older than this. */
export const STALE_EVICT_AGE_MS = 14 * DAY_MS;
/** Hard floor: never evict anything more recent than this, regardless of config. */
export const MIN_EVICT_AGE_MS = 1 * DAY_MS;

export interface EvictableSession {
  readonly id: string;
  /** ISO timestamp of the session's last activity. */
  readonly lastActiveAt: string;
  /** The connection (daemon) this cached session belongs to. */
  readonly connectionId: string;
}

export interface EvictionContext {
  /** Session ids the daemon for `connectionAuthoritative` just reported as known. */
  readonly knownIds: ReadonlySet<string>;
  /**
   * The connection whose authoritative list we just received. Only sessions on
   * THIS connection are eviction candidates this cycle; sessions on other
   * connections are out of scope (their daemon has not spoken).
   */
  readonly connectionAuthoritative: string;
}

/**
 * Decide whether a single cached session should be evicted from the client's
 * list. Pure — no clock, no storage, no React. `now` is injected so callers
 * (and tests) control the staleness comparison.
 *
 * Returns true ONLY when the session belongs to the connection that just
 * listed, is absent from that daemon's known set, and is both older than the
 * staleness threshold and older than the minimum-age floor.
 */
export function shouldEvictCachedSession(
  cached: EvictableSession,
  ctx: EvictionContext,
  now: number,
): boolean {
  // Scope: only act on the connection that just gave us an authoritative list.
  if (cached.connectionId !== ctx.connectionAuthoritative) return false;
  // Known to the daemon -> definitely keep.
  if (ctx.knownIds.has(cached.id)) return false;

  const last = new Date(cached.lastActiveAt).getTime();
  // Unparsable timestamp: keep it (conservative — never evict on bad data).
  if (Number.isNaN(last)) return false;

  const age = now - last;
  // Minimum-age floor: a fresh/recent session is never evicted, even if the
  // daemon just restarted and has not re-listed it yet.
  if (age < MIN_EVICT_AGE_MS) return false;
  // Staleness threshold: only long-dead unknown sessions are evicted.
  return age >= STALE_EVICT_AGE_MS;
}

/**
 * Apply {@link shouldEvictCachedSession} across a list, returning the sessions
 * to KEEP. Convenience wrapper so callers express the filter once.
 */
export function evictPhantomSessions<T extends EvictableSession>(
  sessions: readonly T[],
  ctx: EvictionContext,
  now: number,
): T[] {
  return sessions.filter((s) => !shouldEvictCachedSession(s, ctx, now));
}
