/**
 * Native-shell handoff (#649): the macOS menu-bar app hosts this web UI in a
 * WKWebView and injects `window.__REMI_NATIVE__` (a WKUserScript at document
 * start) carrying the hub WebSocket URL it discovered by port scan. The web
 * app merges that URL into its own restored connections on mount; child
 * session daemons are then found through the normal `daemonPorts` flow.
 *
 * Injected fresh on every load with the CURRENT hub URL, so a moved hub port
 * never leaves stale state behind (unlike seeding localStorage from native,
 * which would couple the native side to web-side dedup/normalization).
 */

export interface RemiNativeHost {
  /** e.g. 'macos-menubar' */
  readonly platform: string;
  /** ws://127.0.0.1:<port> of the discovered hub; null while undiscovered. */
  readonly hubUrl: string | null;
}

declare global {
  interface Window {
    __REMI_NATIVE__?: RemiNativeHost;
  }
}

/**
 * Decide whether the native-provided hub URL needs a fresh connect after the
 * stored connections were restored. Pure; `toConnectionId` is injected the
 * same way dedupeConnectionUrls does it, so host-spelling aliases
 * (localhost vs 127.0.0.1) collapse before comparison.
 */
export function nativeHubUrlToConnect(
  restoredUrls: readonly string[],
  native: RemiNativeHost | undefined,
  toConnectionId: (url: string) => string,
): string | null {
  const hubUrl = native?.hubUrl;
  if (!hubUrl) return null;
  const hubId = toConnectionId(hubUrl);
  for (const url of restoredUrls) {
    if (toConnectionId(url) === hubId) return null;
  }
  return hubUrl;
}
