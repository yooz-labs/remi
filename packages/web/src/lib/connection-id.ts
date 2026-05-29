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
