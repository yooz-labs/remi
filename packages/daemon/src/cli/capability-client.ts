/**
 * Capability header for CLI WebSocket clients (#869).
 *
 * Every `remi` subcommand that opens a WebSocket to a daemon goes through
 * here, so that when the loopback auth exemption is retired the CLI keeps
 * working without a per-command change.
 *
 * Read at call time rather than cached at import: `remi` processes are
 * short-lived, and a cached token would survive a rotation (deleting the file)
 * within a long-running `remi attach`.
 */

import { CAPABILITY_HEADER, readCapabilityToken } from '../auth/capability-token.ts';

/**
 * WebSocket options carrying the local capability token, or undefined when
 * there is no token to send.
 *
 * The paired target helper calls this only for a canonical local target and
 * supplies the same home as the endpoint record. Remote targets receive no
 * local capability. Undefined lets a legacy local daemon use identity auth.
 */
export function capabilityWsOptions(
  tokenPath?: string,
): { headers: Record<string, string> } | undefined {
  const token = readCapabilityToken(tokenPath);
  if (token === null) return undefined;
  return { headers: { [CAPABILITY_HEADER]: token } };
}
