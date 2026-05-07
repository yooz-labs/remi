/**
 * Tests for peer-address loopback detection.
 */

import { describe, expect, test } from 'bun:test';
import { isLoopbackAddress, shouldSkipAuthForPeer } from '../src/server/peer-helpers.ts';

describe('isLoopbackAddress', () => {
  test('returns false for null/undefined/empty', () => {
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress('   ')).toBe(false);
  });

  describe('IPv4', () => {
    test('classic 127.0.0.1', () => {
      expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    });

    test('any address in 127.0.0.0/8', () => {
      expect(isLoopbackAddress('127.0.0.0')).toBe(true);
      expect(isLoopbackAddress('127.255.255.254')).toBe(true);
      expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    });

    test('LAN addresses are not loopback', () => {
      expect(isLoopbackAddress('192.168.1.5')).toBe(false);
      expect(isLoopbackAddress('10.0.0.1')).toBe(false);
      expect(isLoopbackAddress('169.254.1.1')).toBe(false);
      expect(isLoopbackAddress('172.16.0.1')).toBe(false);
    });

    test('public addresses are not loopback', () => {
      expect(isLoopbackAddress('8.8.8.8')).toBe(false);
      expect(isLoopbackAddress('1.1.1.1')).toBe(false);
    });

    test('rejects malformed IPv4', () => {
      expect(isLoopbackAddress('127.0.0')).toBe(false);
      expect(isLoopbackAddress('127.0.0.1.1')).toBe(false);
      expect(isLoopbackAddress('127.0.0.999')).toBe(false);
      expect(isLoopbackAddress('127.x.0.1')).toBe(false);
    });
  });

  describe('IPv6', () => {
    test('plain ::1', () => {
      expect(isLoopbackAddress('::1')).toBe(true);
    });

    test('bracketed [::1]', () => {
      expect(isLoopbackAddress('[::1]')).toBe(true);
    });

    test('with zone identifier', () => {
      expect(isLoopbackAddress('::1%lo0')).toBe(true);
      expect(isLoopbackAddress('[::1%lo0]')).toBe(true);
    });

    test('IPv4-mapped loopback ::ffff:127.0.0.1', () => {
      expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
      expect(isLoopbackAddress('[::ffff:127.0.0.1]')).toBe(true);
    });

    test('non-loopback IPv6', () => {
      expect(isLoopbackAddress('::')).toBe(false);
      expect(isLoopbackAddress('fe80::1')).toBe(false);
      expect(isLoopbackAddress('2001:db8::1')).toBe(false);
      expect(isLoopbackAddress('::ffff:192.168.1.1')).toBe(false);
    });
  });

  describe('hostname literal', () => {
    test('localhost matches', () => {
      expect(isLoopbackAddress('localhost')).toBe(true);
      expect(isLoopbackAddress('LOCALHOST')).toBe(true);
      expect(isLoopbackAddress('  localhost  ')).toBe(true);
    });

    test('non-localhost hostnames do not match', () => {
      expect(isLoopbackAddress('example.com')).toBe(false);
      expect(isLoopbackAddress('localhost.attacker.com')).toBe(false);
      expect(isLoopbackAddress('mylocalhost')).toBe(false);
    });
  });
});

describe('shouldSkipAuthForPeer (#257 + positive control)', () => {
  test('skips auth for loopback peers when authenticator is configured', () => {
    expect(shouldSkipAuthForPeer(true, '127.0.0.1')).toBe(true);
    expect(shouldSkipAuthForPeer(true, '::1')).toBe(true);
    expect(shouldSkipAuthForPeer(true, 'localhost')).toBe(true);
  });

  test('does NOT skip auth for non-loopback peers (positive control)', () => {
    // Without this regression test, a "skip everyone" bug — i.e. someone
    // simplifying the gate to `if (authenticator) skip` — would not fail.
    expect(shouldSkipAuthForPeer(true, '192.168.1.5')).toBe(false);
    expect(shouldSkipAuthForPeer(true, '10.0.0.1')).toBe(false);
    expect(shouldSkipAuthForPeer(true, '203.0.113.5')).toBe(false);
    expect(shouldSkipAuthForPeer(true, '2001:db8::1')).toBe(false);
    expect(shouldSkipAuthForPeer(true, 'example.com')).toBe(false);
  });

  test('returns false when no authenticator is configured (bypass is moot)', () => {
    expect(shouldSkipAuthForPeer(false, '127.0.0.1')).toBe(false);
    expect(shouldSkipAuthForPeer(false, '192.168.1.5')).toBe(false);
  });

  test('returns false on null/undefined peer (defensive)', () => {
    expect(shouldSkipAuthForPeer(true, null)).toBe(false);
    expect(shouldSkipAuthForPeer(true, undefined)).toBe(false);
  });
});
