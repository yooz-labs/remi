/**
 * Daemon port discovery (#393).
 *
 * When the Connect modal is given a hostname without an explicit port, the
 * legacy code defaulted to 18765 and gave up if nothing answered. That fails
 * the common case where a user closed the daemon on 18765 but a sibling on
 * 18766/18767 is still serving — the daemon already advertises its real port
 * over mDNS and replies with sibling ports on `SessionListResponse`, but only
 * AFTER the first WebSocket handshake succeeds.
 *
 * This module probes the daemon port range in parallel via the cheap
 * `/auth-info` HTTP endpoint and returns the first responder. It does NOT
 * race WebSockets (20 concurrent WS handshakes are heavier than 20 fetches,
 * and the upgrade path drags auth state along).
 *
 * The default range matches `DaemonConfig` defaults (`base_port=18765`,
 * `port_range=20`).
 */

import { authInfoUrl } from './auth-probe';

/** Default base port — must match `DaemonConfig.base_port` in the daemon config. */
export const DEFAULT_BASE_PORT = 18765;

/** Default port range — must match `DaemonConfig.port_range`. */
export const DEFAULT_PORT_RANGE = 20;

/** Per-port probe timeout. Keep short so the whole scan fails fast on bad hosts. */
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
    // Three failure modes collapse to null: connection refused, timeout,
    // and outer abort. The caller only cares whether *any* port answered.
    return null;
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Discover the first daemon port responding on `hostname` within the given
 * range. Returns `null` if no port answers before the per-probe timeout.
 *
 * Implementation: fans out fetches in parallel and resolves the moment the
 * first probe succeeds, aborting the rest. Sequential ordering is NOT
 * preserved — if both 18765 and 18766 answer, whichever wins the network
 * race wins. This is intentional; the daemon hands back sibling ports after
 * the first hello, so picking either one converges the same way.
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
  if (options.signal) {
    if (options.signal.aborted) return null;
    options.signal.addEventListener('abort', () => winner.abort(), { once: true });
  }

  const ports: number[] = [];
  for (let i = 0; i < portRange; i++) ports.push(basePort + i);

  return new Promise<number | null>((resolve) => {
    let pending = ports.length;
    let resolved = false;
    const finish = (port: number | null) => {
      if (resolved) return;
      resolved = true;
      winner.abort();
      resolve(port);
    };
    for (const port of ports) {
      probePort(hostname, port, timeoutMs, winner.signal).then(
        (result) => {
          if (result !== null) {
            finish(result);
            return;
          }
          if (--pending === 0) finish(null);
        },
        () => {
          if (--pending === 0) finish(null);
        },
      );
    }
  });
}

/** Parsed user input from the Connect modal host field. */
export type ParsedHost =
  | { kind: 'wsurl'; url: string }
  | { kind: 'host'; hostname: string; explicitPort: number | null };

/**
 * Parse the Connect modal's host input.
 *
 * - `ws://...` / `wss://...`: pass through verbatim (backward compat).
 * - `host:port`: explicit port, scan skipped.
 * - `host`: explicit port is null; caller should run port discovery.
 * - IPv6 literals are tolerated either bare (`::1`) or bracketed (`[::1]`).
 *   When bare, multiple colons are treated as the address with no port.
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
    // Bare IPv6 literal — no way to distinguish a trailing port without
    // brackets, so we don't try. User can supply [::1]:18770 to force one.
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
