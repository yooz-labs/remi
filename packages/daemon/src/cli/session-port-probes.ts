import { findAvailableTcpPort } from '../session/port-utils.ts';

/** Keep the configured hub base out of the daemon's second probe. */
export function probeDaemonSessionPort(
  start: number,
  range: number,
  used: Set<number>,
  host: string,
  base: number,
  serveMode: boolean,
): Promise<number | null> {
  if (!serveMode) used.add(base);
  return findAvailableTcpPort(start, range, used, host);
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
  return findAvailableTcpPort(start, range, used, host);
}
