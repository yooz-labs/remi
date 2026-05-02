/**
 * Pre-flight auth probe (#257).
 *
 * Lightweight HTTP GET to /auth-info on the daemon, used by the Connect
 * modal to surface the passphrase prompt INLINE (before opening the
 * WebSocket) when the daemon will require Ed25519 authentication.
 *
 * Without this probe, the user clicks Connect, sees "Connecting..." for a
 * beat, and only then gets asked for a passphrase — making the prompt feel
 * like an afterthought rather than part of the connect flow.
 *
 * The endpoint answers from the same vantage point as the WebSocket upgrade
 * (loopback peers are exempt), so the result is authoritative.
 */

export interface AuthInfo {
  /** True if the daemon will send an auth_challenge to this peer. */
  readonly authRequired: boolean;
  /** Server fingerprint, when the daemon has an identity configured. */
  readonly fingerprint: string | null;
}

/** Default timeout for the auth probe; if the daemon is slow we just open the WS. */
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Convert a ws://host:port/path URL to its http://host:port/auth-info form.
 *
 * Throws if the input cannot be parsed as a valid URL.
 */
export function authInfoUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  let scheme: string;
  if (u.protocol === 'wss:') scheme = 'https:';
  else if (u.protocol === 'ws:') scheme = 'http:';
  else throw new Error(`Unsupported scheme: ${u.protocol}`);
  return `${scheme}//${u.host}/auth-info`;
}

/**
 * Probe the daemon's /auth-info endpoint.
 *
 * Returns null if the probe fails for any reason (network error, timeout,
 * non-200, malformed JSON). Callers should treat null as "unknown" and fall
 * back to opening the WebSocket directly — the existing post-connect auth
 * flow still works, just without the inline modal optimization.
 */
export async function probeAuthInfo(
  wsUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<AuthInfo | null> {
  let httpUrl: string;
  try {
    httpUrl = authInfoUrl(wsUrl);
  } catch {
    return null;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(httpUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<AuthInfo>;
    if (typeof data.authRequired !== 'boolean') return null;
    return {
      authRequired: data.authRequired,
      fingerprint: typeof data.fingerprint === 'string' ? data.fingerprint : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
