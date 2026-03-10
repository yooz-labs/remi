/**
 * VPN-aware peer discovery for finding remi daemons across VPN networks.
 *
 * Supports Tailscale (and extensible to ZeroTier, etc.). Checks if the
 * VPN CLI is available, queries for online peers, and probes each for
 * a running remi daemon on the default port.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

export interface VpnPeer {
  /** Hostname of the peer machine */
  readonly hostname: string;
  /** VPN IP address (IPv4 preferred) */
  readonly ip: string;
  /** OS of the peer (e.g., "macOS", "linux") */
  readonly os: string;
}

export interface VpnDiscoveryOptions {
  /** Port to probe for remi daemons. Default: 18765 */
  readonly port?: number | undefined;
  /** Timeout per probe in ms. Default: 2000 */
  readonly probeTimeoutMs?: number | undefined;
}

/**
 * Discover remi daemons running on VPN peers.
 *
 * Returns peers that responded to a remi session list request.
 * Currently supports Tailscale; extensible to other VPN providers.
 */
export async function discoverVpnPeers(
  opts?: VpnDiscoveryOptions,
): Promise<{ peer: VpnPeer; host: string; port: number }[]> {
  const port = opts?.port ?? 18765;
  const probeTimeout = opts?.probeTimeoutMs ?? 2000;

  const peers = getTailscalePeers();
  if (peers.length === 0) return [];

  const { fetchSessions } = await import('../cli/ls-client.ts');

  const results = await Promise.allSettled(
    peers.map(async (peer) => {
      // Quick probe: try to fetch sessions from this peer
      await fetchSessions(peer.ip, port, probeTimeout);
      return { peer, host: peer.ip, port };
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<{ peer: VpnPeer; host: string; port: number }> =>
        r.status === 'fulfilled',
    )
    .map((r) => r.value);
}

/**
 * Resolve the Tailscale CLI path. On macOS the CLI is often bundled inside
 * the app at /Applications/Tailscale.app/Contents/MacOS/Tailscale and not
 * on PATH (shell aliases in zsh/bash/fish are invisible to execSync which
 * runs under /bin/sh).
 */
function findTailscaleCli(): string | null {
  // Check PATH first
  try {
    execSync('tailscale version', { stdio: 'pipe', timeout: 3000 });
    return 'tailscale';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Found on PATH but errored; still usable
      return 'tailscale';
    }
  }

  // macOS app bundle location
  const macOsPath = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (fs.existsSync(macOsPath)) return macOsPath;

  return null;
}

/**
 * Get online Tailscale peers, filtering out mobile devices.
 * Returns empty array if Tailscale CLI is not available.
 */
export function getTailscalePeers(): VpnPeer[] {
  const cli = findTailscaleCli();
  if (!cli) return [];

  try {
    const raw = execSync(`${cli} status --json`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let status: TailscaleStatus;
    try {
      status = JSON.parse(raw) as TailscaleStatus;
    } catch {
      console.error(
        '[vpn-discovery] Tailscale returned invalid JSON; check `tailscale status --json`',
      );
      return [];
    }
    if (!status.Peer) return [];

    const peers: VpnPeer[] = [];
    for (const peer of Object.values(status.Peer)) {
      // Skip offline peers and mobile devices
      if (!peer.Online) continue;
      if (peer.OS === 'iOS' || peer.OS === 'android') continue;

      // Prefer IPv4 address
      const ipv4 = peer.TailscaleIPs?.find((ip: string) => !ip.includes(':'));
      const ip = ipv4 ?? peer.TailscaleIPs?.[0];
      if (!ip) continue;

      // Clean hostname: Tailscale sometimes uses "localhost" for mobile,
      // and may include special characters in hostnames like "Yahya's MCM"
      const hostname = peer.DNSName?.split('.')[0] ?? peer.HostName ?? 'unknown';

      peers.push({ hostname, ip, os: peer.OS ?? 'unknown' });
    }
    return peers;
  } catch (err) {
    // ENOENT = tailscale not installed; other errors worth logging
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[vpn-discovery] Tailscale query failed: ${msg}`);
    }
    return [];
  }
}

// Minimal Tailscale status JSON types
interface TailscalePeerInfo {
  readonly HostName?: string;
  readonly DNSName?: string;
  readonly OS?: string;
  readonly Online?: boolean;
  readonly TailscaleIPs?: string[];
}

interface TailscaleStatus {
  readonly Peer?: Record<string, TailscalePeerInfo>;
}
