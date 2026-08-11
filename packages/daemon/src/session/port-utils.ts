/**
 * TCP port availability utilities.
 *
 * Uses net.createServer bind-probe to determine whether a port is available.
 * This detects ports occupied by non-remi processes (system services, etc.).
 * For remi-to-remi conflicts, the live-sessions file registry is the primary
 * mechanism since Bun's SO_REUSEPORT allows multiple Bun servers on the same port.
 *
 * `bindHost` is REQUIRED on both functions, deliberately. It used to default to
 * `'0.0.0.0'` while every caller went on to listen on `daemon.bind`, and the two
 * agreed only because that config default was also `'0.0.0.0'` -- an invisible
 * coupling between a probe default and a config default in a different file.
 * Setting `bind = "127.0.0.1"` broke it, and the failure is silent in the worst
 * direction: a wildcard probe SUCCEEDS on a port another process already holds
 * on loopback, so the probe reports "free" and the real bind then fails with
 * EADDRINUSE. Measured on darwin 25.6:
 *
 *   held=127.0.0.1  probe=0.0.0.0    -> probe says FREE, loopback bind fails
 *   held=127.0.0.1  probe=127.0.0.1  -> probe says taken (correct)
 *   held=0.0.0.0    probe=127.0.0.1  -> probe says FREE, and a loopback bind
 *                                       really does succeed (BSD lets a
 *                                       specific address coexist with wildcard)
 *
 * The probe is never wrong about its OWN host; it was being asked a different
 * question than the caller needed answered. So there is no safe default here --
 * only "the host you are about to listen on". Making it required means a new
 * call site cannot silently inherit the wrong one (#880).
 */

/**
 * Check if a TCP port is available by attempting to bind a TCP server.
 * Returns true if the port can be bound, false if EADDRINUSE.
 *
 * @param bindHost the host the caller will actually listen on -- see the
 *   module comment for why this must not be guessed.
 */
export function isPortAvailable(port: number, bindHost: string): Promise<boolean> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require for net module
  const net = require('node:net') as any;
  return new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      // Any bind error means the port is not usable (EADDRINUSE, EACCES, etc.)
      resolve(false);
    });
    srv.listen({ port, host: bindHost, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Find an available port in the given range.
 * Combines file-registry filtering (skip known remi sessions) with
 * TCP bind-probe (detect non-remi processes occupying ports).
 * Returns the first available port, or null if all are occupied.
 *
 * @param bindHost the host the caller will actually listen on -- see the
 *   module comment for why this must not be guessed.
 */
export async function findAvailableTcpPort(
  basePort: number,
  range: number,
  knownUsedPorts: Set<number>,
  bindHost: string,
): Promise<number | null> {
  for (let offset = 0; offset < range; offset++) {
    const candidate = basePort + offset;
    if (knownUsedPorts.has(candidate)) continue;
    if (await isPortAvailable(candidate, bindHost)) {
      return candidate;
    }
  }
  return null;
}
