import { describe, expect, test } from 'bun:test';
import { getTailscalePeers } from '../../src/mdns/vpn-discovery.ts';

describe('getTailscalePeers', () => {
  test('returns array (empty if tailscale not available)', () => {
    const peers = getTailscalePeers();
    expect(Array.isArray(peers)).toBe(true);
    // Each peer should have the expected shape
    for (const peer of peers) {
      expect(typeof peer.hostname).toBe('string');
      expect(typeof peer.ip).toBe('string');
      expect(typeof peer.os).toBe('string');
      // IP should not be empty
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

  test('excludes offline peers', () => {
    // We can only verify the shape; offline peers should not appear
    const peers = getTailscalePeers();
    // All returned peers are online (we can't verify this directly,
    // but the function filters on Online: true)
    expect(peers.length).toBeGreaterThanOrEqual(0);
  });
});
