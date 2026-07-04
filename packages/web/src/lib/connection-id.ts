/**
 * connectionId helpers.
 *
 * A connectionId is the `host:port` string identifying a daemon connection.
 * These are pure functions kept out of the React hook so they can be unit
 * tested without pulling in React or the WebSocket client.
 */

import type { ConnectionId } from '@/types';

/**
 * Split a `host:port` connectionId into parts. IPv6-safe: the host capture is
 * greedy so `[::1]:18765` yields host `[::1]` and `::1:18765` yields host
 * `::1`; only the final `:<digits>` group is treated as the port. Returns
 * `port: null` when no numeric port suffix is present.
 */
export function splitConnectionId(connectionId: ConnectionId): {
  host: string;
  port: number | null;
} {
  const raw = connectionId as string;
  const match = /^(.*):(\d+)$/.exec(raw);
  if (!match) return { host: raw, port: null };
  const port = Number.parseInt(match[2] ?? '', 10);
  return { host: match[1] ?? raw, port: Number.isNaN(port) ? null : port };
}

/**
 * Loopback host aliases that address the SAME daemon (#682). Without
 * normalization, a `localhost` URL persisted from an earlier connect and a
 * `127.0.0.1` URL typed later into the Connect modal produce two independent
 * manager entries for one physical daemon; a stale/errored one can then end
 * up driving the global error banner even while the other is healthy and
 * attached. Collapsing every alias to one canonical form makes `parseConnectionId`
 * return the identical `ConnectionId` for all of them, so `connectDirect`'s
 * Map (keyed by `ConnectionId`) can never hold two entries for the same daemon.
 */
const LOOPBACK_HOST_ALIASES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CANONICAL_LOOPBACK_HOST = '127.0.0.1';

/**
 * Normalize a hostname for connectionId purposes: lowercase (hostnames are
 * case-insensitive) and collapse loopback aliases to one canonical form. Only
 * affects the bookkeeping key -- the actual WebSocket URL used for the
 * transport is untouched, so this doesn't change which address is dialed.
 */
export function normalizeConnectionHost(host: string): string {
  const lower = host.toLowerCase();
  return LOOPBACK_HOST_ALIASES.has(lower) ? CANONICAL_LOOPBACK_HOST : lower;
}

/**
 * Reconcile a persisted list of connection URLs (`remi-connections`) to one
 * entry per normalized endpoint (#682). Two URL strings that normalize to the
 * same connectionId -- e.g. a `localhost` URL saved in an earlier session
 * alongside a `127.0.0.1` URL typed later -- must not both be retried on
 * every launch; the LAST occurrence wins, since it reflects the most recent
 * explicit connect. `toConnectionId` is injected (rather than imported)
 * so this stays a leaf-level pure function with no dependency on the
 * connection-manager hook.
 */
export function dedupeConnectionUrls(
  urls: readonly string[],
  toConnectionId: (url: string) => string,
): string[] {
  const byKey = new Map<string, string>();
  for (const url of urls) {
    byKey.set(toConnectionId(url), url);
  }
  return [...byKey.values()];
}
