/**
 * VPN-aware peer discovery for finding remi daemons across VPN networks.
 *
 * Supports Tailscale and WireGuard. Checks if the VPN CLI is available,
 * queries for online peers, and probes each for a running remi daemon on
 * the default port.
 *
 * ZeroTier is not supported because its CLI (`zerotier-cli listpeers -j`)
 * only exposes physical endpoints, not managed VPN IPs. Getting managed IPs
 * requires the ZeroTier Central API or controller access.
 *
 * CLI resolution note: execSync runs under /bin/sh, so shell aliases
 * (zsh/bash/fish) are invisible. Each provider has fallback path detection
 * for common installation locations (e.g. macOS app bundles).
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
  /** Which VPN provider discovered this peer */
  readonly provider: 'tailscale' | 'wireguard';
}

export interface VpnDiscoveryOptions {
  /** Port to probe for remi daemons. Default: 18765 */
  readonly port?: number | undefined;
  /** Timeout per probe in ms. Default: 2000 */
  readonly probeTimeoutMs?: number | undefined;
}

/**
 * Discover remi daemons running on VPN peers across all supported providers.
 *
 * Queries Tailscale and WireGuard, then probes each discovered peer for a
 * running remi daemon.
 */
export async function discoverVpnPeers(
  opts?: VpnDiscoveryOptions,
): Promise<{ peer: VpnPeer; host: string; port: number }[]> {
  const port = opts?.port ?? 18765;
  const probeTimeout = opts?.probeTimeoutMs ?? 2000;

  const peers = getAllVpnPeers();
  if (peers.length === 0) return [];

  const { fetchSessions } = await import('../cli/ls-client.ts');

  const results = await Promise.allSettled(
    peers.map(async (peer) => {
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
 * Collect peers from all supported VPN providers.
 * Deduplicates by IP address (prefers Tailscale > WireGuard).
 */
export function getAllVpnPeers(): VpnPeer[] {
  const tailscale = getTailscalePeers();
  const wireguard = getWireGuardPeers();

  const seen = new Set<string>();
  const result: VpnPeer[] = [];

  for (const peer of [...tailscale, ...wireguard]) {
    if (!seen.has(peer.ip)) {
      seen.add(peer.ip);
      result.push(peer);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI resolution helpers
// ---------------------------------------------------------------------------

/** Exit status 127 from /bin/sh means "command not found". */
const CMD_NOT_FOUND_STATUS = 127;

/**
 * Try to find a CLI command. Checks PATH first via execSync, then falls back
 * to well-known installation paths.
 *
 * Returns the resolved command string or null if not found anywhere.
 */
function findCli(command: string, versionArg: string, fallbackPaths: string[]): string | null {
  try {
    execSync(`${command} ${versionArg}`, { stdio: 'pipe', timeout: 3000 });
    return command;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status != null && status !== CMD_NOT_FOUND_STATUS) {
      // Command exists on PATH but failed (e.g. not logged in); still usable
      return command;
    }
  }

  for (const p of fallbackPaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

/**
 * Run a CLI command and return stdout. Returns null on failure, logging
 * only unexpected errors (not "command not found").
 */
function runCli(command: string, args: string, provider: string): string | null {
  try {
    return execSync(`${command} ${args}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status != null && status !== CMD_NOT_FOUND_STATUS) {
      const msg = err instanceof Error ? err.message : String(err);
      const firstLine = msg.split('\n')[0];
      console.error(`[vpn-discovery] ${provider} query failed: ${firstLine}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tailscale
// ---------------------------------------------------------------------------

function findTailscaleCli(): string | null {
  return findCli('tailscale', 'version', ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
}

export function getTailscalePeers(): VpnPeer[] {
  const cli = findTailscaleCli();
  if (!cli) return [];

  const raw = runCli(cli, 'status --json', 'Tailscale');
  if (!raw) return [];

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
    if (!peer.Online) continue;
    if (peer.OS === 'iOS' || peer.OS === 'android') continue;

    const ipv4 = peer.TailscaleIPs?.find((ip: string) => !ip.includes(':'));
    const ip = ipv4 ?? peer.TailscaleIPs?.[0];
    if (!ip) continue;

    const hostname = peer.DNSName?.split('.')[0] ?? peer.HostName ?? 'unknown';
    peers.push({ hostname, ip, os: peer.OS ?? 'unknown', provider: 'tailscale' });
  }
  return peers;
}

// ---------------------------------------------------------------------------
// WireGuard
// ---------------------------------------------------------------------------

function findWireGuardCli(): string | null {
  return findCli('wg', '--version', ['/usr/local/bin/wg', '/opt/homebrew/bin/wg']);
}

export function getWireGuardPeers(): VpnPeer[] {
  const cli = findWireGuardCli();
  if (!cli) return [];

  const raw = runCli(cli, 'show all dump', 'WireGuard');
  if (!raw) return [];

  // `wg show all dump` output is tab-separated:
  // interface, public-key, preshared-key, endpoint, allowed-ips, latest-handshake, transfer-rx, transfer-tx, persistent-keepalive
  const lines = raw.trim().split('\n');
  const result: VpnPeer[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const fields = line.split('\t');
    // Interface lines have 4-5 fields, peer lines have 8-9
    if (fields.length < 8) continue;

    const allowedIps = fields[4];
    const latestHandshake = fields[5];

    // Skip peers with no recent handshake (0 = never connected)
    if (latestHandshake === '0') continue;

    // Check handshake freshness: skip peers not seen in the last 5 minutes
    const handshakeAge = Date.now() / 1000 - Number(latestHandshake);
    if (handshakeAge > 300) continue;

    // Extract first allowed IP (strip CIDR notation)
    if (!allowedIps) continue;
    const ips = allowedIps.split(',').map((s) => s.trim().split('/')[0]);
    const ipv4 = ips.find((ip) => ip !== undefined && !ip.includes(':'));
    const ip = ipv4 ?? ips[0];
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);

    result.push({ hostname: 'wg-peer', ip, os: 'unknown', provider: 'wireguard' });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
