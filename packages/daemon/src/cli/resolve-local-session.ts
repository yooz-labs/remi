/**
 * Shared helper for `remi kill` and `remi detach`: given a session name (or
 * id) on localhost without an explicit port, probe every known local daemon
 * port to find which one owns the session.
 *
 * Returns one of:
 *   - `{ status: 'resolved', port, target }` — found a session; use these.
 *   - `{ status: 'no-ports' }` — neither the live registry nor the default
 *     port range had any ports to probe; caller should fall through to the
 *     original target.
 *   - `{ status: 'no-daemons', probedCount }` — probed ports but no daemons
 *     responded; caller should print the "Cannot reach any" error and exit 1.
 *   - `{ status: 'unresolved' }` — daemons responded but no session matched
 *     the target; caller should fall through to the original target.
 */

import type { PortQueryResult, ResolvedSession } from './session-resolver.ts';

export type LocalSessionResolution =
  | { readonly status: 'resolved'; readonly port: number; readonly target: string }
  | { readonly status: 'no-ports' }
  | { readonly status: 'no-daemons'; readonly probedCount: number }
  | { readonly status: 'unresolved' };

export interface ResolveLocalSessionDeps {
  readonly getLivePorts: () => number[];
  readonly queryMultiplePorts: (args: {
    host: string;
    ports: number[];
    timeoutMs: number;
    logLabel: string;
  }) => Promise<readonly PortQueryResult[]>;
  readonly resolveSession: (
    results: readonly PortQueryResult[],
    target: string,
  ) => ResolvedSession | null;
  readonly getDefaultPortRange: () => number[];
}

export interface ResolveLocalSessionArgs {
  readonly target: string;
  /** Label for query-multi-port log output (e.g. 'kill', 'detach'). */
  readonly logLabel: string;
  /** How long to wait for each port query. Default 5000 ms. */
  readonly timeoutMs?: number;
}

export async function resolveLocalSession(
  args: ResolveLocalSessionArgs,
  deps: ResolveLocalSessionDeps,
): Promise<LocalSessionResolution> {
  let allPorts = deps.getLivePorts();

  // Fallback: probe default port range when registry is empty (matches ls behavior).
  if (allPorts.length === 0) {
    allPorts = deps.getDefaultPortRange();
  }

  if (allPorts.length === 0) {
    return { status: 'no-ports' };
  }

  const results = await deps.queryMultiplePorts({
    host: 'localhost',
    ports: allPorts,
    timeoutMs: args.timeoutMs ?? 5000,
    logLabel: args.logLabel,
  });

  if (results.length === 0) {
    return { status: 'no-daemons', probedCount: allPorts.length };
  }

  const match = deps.resolveSession(results, args.target);
  if (match) {
    // Use session ID directly to avoid TOCTOU race
    return { status: 'resolved', port: match.port, target: match.session.sessionId };
  }

  return { status: 'unresolved' };
}
