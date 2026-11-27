import { findAvailableTcpPort } from '../session/port-utils.ts';

/**
 * The end (exclusive) of a session's port window. A session that starts inside the hub's
 * window [base, base + range) stays inside it, so reserving the base never pushes a session
 * past the documented range (for the default base, 18765 to 18784); a start outside that
 * window keeps its own range, as before (#1823).
 */
export function sessionPortWindowEnd(start: number, range: number, base: number): number {
  return start >= base && start < base + range ? base + range : start + range;
}

/** Keep the configured hub base out of the daemon's second probe. */
export function probeDaemonSessionPort(
  start: number,
  range: number,
  used: Set<number>,
  host: string,
  base: number,
  serveMode: boolean,
): Promise<number | null> {
  if (serveMode) return findAvailableTcpPort(start, range, used, host);
  used.add(base);
  return findAvailableTcpPort(start, sessionPortWindowEnd(start, range, base) - start, used, host);
}

/** Keep the configured hub base out of the wrapper's second probe. */
export function probeWrapperSessionPort(
  start: number,
  range: number,
  used: Set<number>,
  host: string,
  base: number,
): Promise<number | null> {
  used.add(base);
  return findAvailableTcpPort(start, sessionPortWindowEnd(start, range, base) - start, used, host);
}
