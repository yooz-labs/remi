/**
 * Daemon loopback port range — the single source of truth shared by the daemon
 * (port auto-selection in session-registry-file.ts and config.ts) and the web
 * client (port discovery in port-discovery.ts, connectionId derivation in
 * useConnectionManager.ts).
 *
 * These values were previously duplicated as independent literals in four
 * places; drift between them would silently break discovery. Import from here.
 */

/** Lowest loopback port a daemon binds; siblings take base+1, base+2, … */
export const DAEMON_BASE_PORT = 18765 as const;

/** Number of consecutive ports a daemon may occupy / a client should scan. */
export const DAEMON_PORT_RANGE = 20 as const;
