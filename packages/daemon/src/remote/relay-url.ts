/** Worker v2 endpoints use an origin or an explicit proxy prefix, never the retired v1 route. */
export const DEFAULT_RELAY_URL = 'wss://remi-signaling.yooz.workers.dev';

/** #1200: push has a signed root route; never infer a proxy mapping from a relay prefix. */
export function relaySecurePushAudience(base: string): string | null {
  // Check the original spelling before URL normalizes dot segments, backslashes,
  // empty queries/fragments or surrounding whitespace into a root URL.
  if (!/^(?:https|wss):\/\/[^\\/?#\s]+\/?$/i.test(base)) return null;
  try {
    const url = new URL(base);
    if (url.username || url.password || !['https:', 'wss:'].includes(url.protocol)) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    url.protocol = 'https:';
    return url.origin;
  } catch {
    return null;
  }
}

export function legacyRelayUrlNotice(base: string): string | null {
  try {
    const url = new URL(base);
    if (url.origin === DEFAULT_RELAY_URL && /^\/connect\/?$/.test(url.pathname))
      return `The official /connect relay endpoint is retired. Set [network] signaling_url = "${DEFAULT_RELAY_URL}" or pass --signaling-url ${DEFAULT_RELAY_URL}; then run remi serve --relay and remi pair --relay.`;
  } catch {
    // Other URL failures remain the transport's responsibility; never echo private URL input.
  }
  return null;
}

export function relayWorkerUrl(
  base: string,
  role: 'host' | 'pipe',
  rid: Uint8Array,
  cid?: string,
): string {
  const url = new URL(base);
  const hex = Array.from(rid, (byte) => byte.toString(16).padStart(2, '0')).join('');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v2/${role}/${hex}${cid ? `/${cid}` : ''}`;
  return url.toString();
}
