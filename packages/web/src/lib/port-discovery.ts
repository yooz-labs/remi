/**
 * Daemon port discovery (#393).
 *
 * When the Connect modal is given a hostname without an explicit port, the
 * legacy code defaulted to 18765 and gave up if nothing answered. That fails
 * the common case where a user closed the daemon on 18765 but a sibling on
 * 18766/18767 is still serving; the daemon already advertises its real port
 * over mDNS and replies with sibling ports on `SessionListResponse`, but only
 * AFTER the first WebSocket handshake succeeds.
 *
 * This module races HTTP `/auth-info` probes (rather than full WebSocket
 * upgrades) across the daemon port range and resolves to the first responder.
 * Probes are cheap, parallel, and avoid dragging auth state through 20
 * concurrent WS handshakes that all but one would tear back down.
 *
 * Port range matches `DaemonConfig` defaults; values are pinned to
 * `DEFAULT_BASE_PORT` and `DEFAULT_PORT_RANGE` below.
 */

import { DAEMON_BASE_PORT, DAEMON_PORT_RANGE } from '@remi/shared';
import { authInfoUrl } from './auth-probe';

/** Daemon base port — single source of truth in `@remi/shared/daemon-ports`. */
export const DEFAULT_BASE_PORT = DAEMON_BASE_PORT;

/** Daemon port range — single source of truth in `@remi/shared/daemon-ports`. */
export const DEFAULT_PORT_RANGE = DAEMON_PORT_RANGE;

/**
 * Per-port probe timeout in milliseconds.
 *
 * Budget: a healthy LAN daemon answers `/auth-info` in single-digit ms; an
 * unreachable host returns ECONNREFUSED in microseconds. The interesting
 * case is a host that ACCEPTs the TCP connection but never responds (broken
 * proxy, half-dead daemon). 1500 ms gives enough slack for slow VPN paths
 * while keeping the worst-case scan under ~2 s before the modal surfaces an
 * error.
 */
const PROBE_TIMEOUT_MS = 1500;

/** Bracket a bare IPv6 literal so URL parsers accept it. */
function bracketHost(hostname: string): string {
  if (hostname.includes(':') && !hostname.startsWith('[')) {
    return `[${hostname}]`;
  }
  return hostname;
}

/**
 * Probe one (host, port) pair via /auth-info. Resolves to the port number on
 * success, or `null` on any failure (including abort).
 */
async function probePort(
  hostname: string,
  port: number,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<number | null> {
  if (outerSignal.aborted) return null;

  const wsUrl = `ws://${bracketHost(hostname)}:${port}/ws`;
  let httpUrl: string;
  try {
    httpUrl = authInfoUrl(wsUrl);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const res = await fetch(httpUrl, { signal: controller.signal });
    return res.ok ? port : null;
  } catch {
    // Failure modes collapse to null: connection refused, timeout, outer
    // abort, mixed-content / CORS rejection. The caller only needs to know
    // whether *any* port answered. Distinguishing the cause for better UX
    // is tracked separately; see #393 review thread.
    return null;
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Discover the first daemon port responding on `hostname` within the given
 * range. Returns `null` on any of: no port answered before the per-probe
 * timeout, `portRange <= 0`, or the outer `signal` already aborted at call.
 *
 * Implementation: fans out fetches in parallel and resolves the moment the
 * first probe succeeds, aborting the rest. Sequential ordering is NOT
 * preserved; if 18765 and 18766 both answer, whichever wins the network race
 * wins. This is intentional, since the daemon hands back sibling ports after
 * the first hello — picking either one converges the same way.
 */
export async function discoverDaemonPort(
  hostname: string,
  options: {
    basePort?: number;
    portRange?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<number | null> {
  const basePort = options.basePort ?? DEFAULT_BASE_PORT;
  const portRange = options.portRange ?? DEFAULT_PORT_RANGE;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (portRange <= 0) return null;

  const winner = new AbortController();
  // Track the listener so the success path can detach it; without this, a
  // long-lived caller that reuses one signal across many discover calls
  // accumulates listeners until the signal eventually aborts.
  let outerAbortListener: (() => void) | null = null;
  if (options.signal) {
    if (options.signal.aborted) return null;
    outerAbortListener = () => winner.abort();
    options.signal.addEventListener('abort', outerAbortListener, { once: true });
  }

  const ports: number[] = [];
  for (let i = 0; i < portRange; i++) ports.push(basePort + i);

  // Hand-rolled rather than `Promise.any`: we want to resolve `null` when
  // every probe fails, but `Promise.any` would *reject* with AggregateError
  // in that case. Inverting the success/failure shape of `probePort` to
  // make `Promise.any` work is uglier than the explicit counter below.
  return new Promise<number | null>((resolve) => {
    let pending = ports.length;
    let resolved = false;
    const finish = (port: number | null) => {
      if (resolved) return;
      resolved = true;
      winner.abort();
      if (outerAbortListener && options.signal) {
        options.signal.removeEventListener('abort', outerAbortListener);
      }
      resolve(port);
    };
    for (const port of ports) {
      // probePort is reject-proof: every error path returns `null`. So we
      // only handle the fulfilled branch and rely on the counter to bottom
      // out on `null` if no probe wins.
      probePort(hostname, port, timeoutMs, winner.signal).then((result) => {
        if (result !== null) {
          finish(result);
          return;
        }
        if (--pending === 0) finish(null);
      });
    }
  });
}

/**
 * Resolve the live daemon port for a host. Tries `hintPort` first (the last
 * known good port — the common case after a transient disconnect), then falls
 * back to a full range scan via `discoverDaemonPort`. Returns null if nothing
 * answers.
 *
 * This is the single entry point every connection-establishment path (manual
 * connect, restore from localStorage, reconnect escalation) should use, so a
 * daemon that closed on its old port or moved to a sibling heals instead of
 * dead-ending on a frozen URL.
 */
export async function resolveDaemonPort(
  hostname: string,
  hintPort?: number | null,
  options: {
    basePort?: number;
    portRange?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<number | null> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  if (options.signal?.aborted) return null;

  if (typeof hintPort === 'number' && Number.isInteger(hintPort) && hintPort >= 1 && hintPort <= 65535) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const hit = await probePort(hostname, hintPort, timeoutMs, controller.signal);
      if (hit !== null) return hit;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  return discoverDaemonPort(hostname, {
    basePort: options.basePort,
    portRange: options.portRange,
    timeoutMs,
    signal: options.signal,
  });
}

/** Parsed user input from the Connect modal host field. */
export type ParsedHost =
  | { kind: 'wsurl'; url: string }
  | { kind: 'host'; hostname: string; explicitPort: number | null };

/**
 * Parse the Connect modal's host input.
 *
 * Bare IPv6 literals (multiple colons, no brackets) are treated as having
 * no explicit port: without brackets we can't tell which colon delimits the
 * port. Users can write `[::1]:18770` to force one.
 */
export function parseHostInput(input: string): ParsedHost {
  const trimmed = input.trim();
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return { kind: 'wsurl', url: trimmed };
  }

  // Bracketed IPv6 with optional port: [::1] or [::1]:18770
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing > 0) {
      const hostname = trimmed.slice(1, closing);
      const rest = trimmed.slice(closing + 1);
      let explicitPort: number | null = null;
      if (rest.startsWith(':')) {
        const parsed = Number.parseInt(rest.slice(1), 10);
        if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          explicitPort = parsed;
        }
      }
      return { kind: 'host', hostname, explicitPort };
    }
  }

  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount > 1) {
    return { kind: 'host', hostname: trimmed, explicitPort: null };
  }

  const parts = trimmed.split(':');
  const hostname = parts[0] ?? '';
  let explicitPort: number | null = null;
  if (parts.length > 1 && parts[1]) {
    const parsed = Number.parseInt(parts[1], 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
      explicitPort = parsed;
    }
  }
  return { kind: 'host', hostname, explicitPort };
}

/** Build the canonical `ws://host:port/ws` URL for a parsed host + chosen port. */
export function buildWsUrl(parsed: ParsedHost, port: number): string {
  if (parsed.kind === 'wsurl') return parsed.url;
  return `ws://${bracketHost(parsed.hostname)}:${port}/ws`;
}
