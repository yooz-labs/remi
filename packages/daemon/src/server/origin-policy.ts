/**
 * Origin policy for the daemon's HTTP/WebSocket surface (#535).
 *
 * The daemon binds a loopback (and often LAN) port and answers permission
 * prompts. Before this module, the WebSocket upgrade accepted any `Origin` and
 * the HTTP endpoints answered with `Access-Control-Allow-Origin: *`, so a page
 * the user merely VISITED could open `ws://127.0.0.1:<port>/ws` or POST
 * `/answer` and approve a permission on their machine. The browser's own
 * same-origin policy does not help here: WebSocket upgrades are not subject to
 * it, and a wildcard CORS header waives it for the HTTP paths.
 *
 * The defense is the `Origin` header itself. A browser always sets it and a
 * page cannot forge it, so an allowlist cleanly separates remi's own clients
 * from every other site. Non-browser clients (the CLI, the iOS and macOS apps,
 * anything using fetch/WebSocket outside a page) send no `Origin` at all.
 *
 * ## What is allowed
 *
 * - **No `Origin` header** — a native client. Allowed: this check exists to
 *   stop pages, and a local process that wants to impersonate a client can
 *   simply omit the header. Locking that door needs a per-connection
 *   capability token, which is deliberately not this change (see #535).
 * - **`capacitor://localhost` / `ionic://localhost`** — the iOS app's WebView.
 * - **`http(s)://localhost[:port]`, `http(s)://127.0.0.1[:port]`, `[::1]`** —
 *   the Vite dev server and the Android WebView.
 * - **`https://remi.yooz.live`** — the hosted web client.
 * - Anything in `allowed_origins` from config.
 *
 * ## What is rejected
 *
 * Every other origin, including the literal string `null`, which is what a
 * sandboxed iframe or a `file://` page sends. Treating `"null"` as "no origin"
 * would hand the bypass to exactly the contexts most likely to be hostile.
 */

/** The hosted web client. Exact match only. */
export const HOSTED_WEB_ORIGIN = 'https://remi.yooz.live';

/** Origins allowed with no configuration. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  HOSTED_WEB_ORIGIN,
  // Capacitor's iOS WebView. `ionic://` is the older scheme, still emitted by
  // some Capacitor versions.
  'capacitor://localhost',
  'ionic://localhost',
];

/** Hostnames that mean "this machine" for the loopback shape rule. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * True for a loopback origin on any port: the Vite dev server
 * (`http://localhost:5173`) and Capacitor's Android WebView (`http://localhost`).
 *
 * A page served from the user's own machine is not the drive-by case this
 * guards against; a hostile LOCAL process is, and that is the capability-token
 * half of #535.
 */
function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Decide whether a request carrying this `Origin` may talk to the daemon.
 *
 * @param origin The raw `Origin` header, or null/undefined when absent.
 * @param extraAllowed Additional exact origins from config.
 */
export function isAllowedOrigin(
  origin: string | null | undefined,
  extraAllowed: readonly string[] = [],
): boolean {
  // Absent header: a native client, not a page. See the module comment.
  if (origin === null || origin === undefined || origin === '') return true;
  // A sandboxed iframe or file:// page sends the literal string "null". That is
  // an opaque origin, not an absent one, and it must not inherit the native
  // client's pass.
  if (origin === 'null') return false;

  if (DEFAULT_ALLOWED_ORIGINS.includes(origin)) return true;
  if (extraAllowed.includes(origin)) return true;
  return isLoopbackOrigin(origin);
}

/**
 * CORS headers to answer a request with.
 *
 * Echoes the caller's own origin rather than `*`, so a response is only ever
 * readable by an origin that passed `isAllowedOrigin`. Callers must reject
 * disallowed origins BEFORE calling this; it deliberately has no wildcard to
 * fall back to.
 *
 * A request with no `Origin` gets no CORS header at all, which is correct: it
 * is not a browser and has no same-origin policy to waive.
 */
export function corsHeadersForOrigin(origin: string | null | undefined): Record<string, string> {
  if (origin === null || origin === undefined || origin === '') return {};
  return {
    'Access-Control-Allow-Origin': origin,
    // The allowlist is per-origin, so caches must not serve one origin's
    // response to another.
    Vary: 'Origin',
  };
}

/**
 * The message logged (once per distinct origin) when a request is refused, and
 * shown to whoever has to fix it. It names the config key, because the only
 * legitimate way to hit this is a self-hosted web client the daemon has never
 * heard of, and a bare "403" would send that user hunting.
 */
export function rejectionNotice(origin: string): string {
  return [
    `Refused a request from origin ${origin}: not in the allow-list (#535).`,
    'If this is your own remi web client, add it to ~/.remi/config.toml:',
    '  [daemon]',
    `  allowed_origins = ["${origin}"]`,
  ].join('\n');
}
