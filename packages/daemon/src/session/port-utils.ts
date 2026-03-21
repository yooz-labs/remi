/**
 * TCP port availability utilities.
 *
 * Uses net.createServer bind-probe to determine whether a port is available.
 * This detects ports occupied by non-remi processes (system services, etc.).
 * For remi-to-remi conflicts, the live-sessions file registry is the primary
 * mechanism since Bun's SO_REUSEPORT allows multiple Bun servers on the same port.
 */

/**
 * Check if a TCP port is available by attempting to bind a TCP server.
 * Returns true if the port can be bound, false if EADDRINUSE.
 */
export function isPortAvailable(port: number, hostname = '0.0.0.0'): Promise<boolean> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require for net module
  const net = require('node:net') as any;
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      // Any bind error means the port is not usable (EADDRINUSE, EACCES, etc.)
      resolve(false);
    });
    srv.listen({ port, host: hostname, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Find an available port in the given range.
 * Combines file-registry filtering (skip known remi sessions) with
 * TCP bind-probe (detect non-remi processes occupying ports).
 * Returns the first available port, or null if all are occupied.
 */
export async function findAvailableTcpPort(
  basePort: number,
  range: number,
  knownUsedPorts: Set<number> = new Set(),
  hostname = '0.0.0.0',
): Promise<number | null> {
  for (let offset = 0; offset < range; offset++) {
    const candidate = basePort + offset;
    if (knownUsedPorts.has(candidate)) continue;
    if (await isPortAvailable(candidate, hostname)) {
      return candidate;
    }
  }
  return null;
}
