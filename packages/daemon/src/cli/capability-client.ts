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
 * Undefined is not a failure. A daemon on another machine has a different
 * token and would reject this one anyway; those connections authenticate with
 * Ed25519. Sending nothing is also correct against a daemon old enough not to
 * know the header, which ignores it.
 */
export function capabilityWsOptions(): { headers: Record<string, string> } | undefined {
  const token = readCapabilityToken();
  if (token === null) return undefined;
  return { headers: { [CAPABILITY_HEADER]: token } };
}
