/** Worker v2 endpoints use an origin or an explicit proxy prefix, never the retired v1 route. */
export const DEFAULT_RELAY_URL = 'wss://remi-signaling.yooz.workers.dev';

export function legacyRelayUrlNotice(base: string): string | null {
  try {
    const url = new URL(base);
    if (url.origin === DEFAULT_RELAY_URL && /^\/connect\/?$/.test(url.pathname))
      return `The official /connect relay endpoint is retired. Set [network] signaling_url = "${DEFAULT_RELAY_URL}" or pass --signaling-url ${DEFAULT_RELAY_URL}; then run remi serve --relay and remi pair.`;
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
