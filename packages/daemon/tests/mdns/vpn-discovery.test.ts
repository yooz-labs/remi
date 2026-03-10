import { describe, expect, test } from 'bun:test';
import {
  getAllVpnPeers,
  getTailscalePeers,
  getWireGuardPeers,
  getZeroTierPeers,
} from '../../src/mdns/vpn-discovery.ts';

describe('getTailscalePeers', () => {
  test('returns array (empty if tailscale not available)', () => {
    const peers = getTailscalePeers();
    expect(Array.isArray(peers)).toBe(true);
    for (const peer of peers) {
      expect(typeof peer.hostname).toBe('string');
      expect(typeof peer.ip).toBe('string');
      expect(typeof peer.os).toBe('string');
      expect(peer.provider).toBe('tailscale');
      expect(peer.ip.length).toBeGreaterThan(0);
    }
  });

  test('filters out mobile devices', () => {
    const peers = getTailscalePeers();
    for (const peer of peers) {
      expect(peer.os).not.toBe('iOS');
      expect(peer.os).not.toBe('android');
    }
  });
});

describe('getZeroTierPeers', () => {
  test('returns array (empty if zerotier not available)', () => {
    const peers = getZeroTierPeers();
    expect(Array.isArray(peers)).toBe(true);
    for (const peer of peers) {
      expect(typeof peer.hostname).toBe('string');
      expect(typeof peer.ip).toBe('string');
      expect(peer.provider).toBe('zerotier');
      expect(peer.ip.length).toBeGreaterThan(0);
    }
  });
});

describe('getWireGuardPeers', () => {
  test('returns array (empty if wireguard not available)', () => {
    const peers = getWireGuardPeers();
    expect(Array.isArray(peers)).toBe(true);
    for (const peer of peers) {
      expect(typeof peer.hostname).toBe('string');
      expect(typeof peer.ip).toBe('string');
      expect(peer.provider).toBe('wireguard');
      expect(peer.ip.length).toBeGreaterThan(0);
    }
  });
});

describe('getAllVpnPeers', () => {
  test('returns combined peers from all providers', () => {
    const peers = getAllVpnPeers();
    expect(Array.isArray(peers)).toBe(true);
    for (const peer of peers) {
      expect(['tailscale', 'zerotier', 'wireguard']).toContain(peer.provider);
    }
  });

  test('deduplicates by IP', () => {
    const peers = getAllVpnPeers();
    const ips = peers.map((p) => p.ip);
    expect(new Set(ips).size).toBe(ips.length);
  });
});
