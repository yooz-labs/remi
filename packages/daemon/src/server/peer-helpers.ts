/**
 * Peer-address helpers for the WebSocket server.
 *
 * Used to decide whether an inbound connection is from the local machine,
 * which lets us safely skip auth challenges for loopback peers even when
 * the daemon is bound to 0.0.0.0 with auth otherwise enabled.
 */

/**
 * Return true if `host` is a loopback (this-machine) address.
 *
 * Recognizes:
 *   - IPv4 loopback: anything in 127.0.0.0/8 (covers 127.0.0.1, 127.0.0.2, ...)
 *   - IPv6 loopback: ::1 (with or without zone, with or without brackets)
 *   - IPv4-mapped IPv6 loopback: ::ffff:127.0.0.1 (and bracketed forms)
 *   - The hostname literal "localhost"
 *
 * Returns false for null/undefined and for any non-loopback IP.
 */
export function isLoopbackAddress(host: string | null | undefined): boolean {
  if (!host) return false;

  // Strip brackets for IPv6 addresses (e.g. "[::1]" -> "::1")
  let h = host.trim();
  if (h.startsWith('[') && h.includes(']')) {
    h = h.slice(1, h.indexOf(']'));
  }
  // Strip IPv6 zone suffix (e.g. "fe80::1%en0" -> "fe80::1")
  const zoneIdx = h.indexOf('%');
  if (zoneIdx >= 0) h = h.slice(0, zoneIdx);

  // Lowercase for hostname comparisons; IPs are case-insensitive too
  const lower = h.toLowerCase();

  if (lower === 'localhost') return true;
  if (lower === '::1') return true;

  // IPv4-mapped IPv6 loopback (e.g. "::ffff:127.0.0.1")
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    return isIPv4Loopback(v4);
  }

  return isIPv4Loopback(lower);
}

/** True for any address in 127.0.0.0/8. */
function isIPv4Loopback(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const first = Number.parseInt(parts[0] ?? '', 10);
  if (Number.isNaN(first) || first !== 127) return false;
  // Validate the rest are 0-255 numerals
  for (let i = 1; i < 4; i++) {
    const part = parts[i] ?? '';
    if (!/^\d+$/.test(part)) return false;
    const n = Number.parseInt(part, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return false;
  }
  return true;
}
