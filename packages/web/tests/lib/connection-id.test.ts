/**
 * Tests for splitConnectionId (#435 Phase 1 / P3). Pure function; no mocks.
 * This is the host/port extraction that feeds resolveDaemonPort in the
 * reconnect-escalation path, so its IPv6 handling must be correct.
 *
 * Also covers normalizeConnectionHost and dedupeConnectionUrls (#682): the
 * host-alias normalization that keeps two connect attempts at the same
 * physical daemon (e.g. 'localhost' vs '127.0.0.1') from producing two
 * independent manager entries -- one of which can end up stale/errored and
 * incorrectly drive the global connection banner.
 */

import { describe, expect, test } from 'bun:test';
import {
  childDaemonUrl,
  dedupeConnectionUrls,
  normalizeConnectionHost,
  parseConnectionId,
  splitConnectionId,
} from '../../src/lib/connection-id';
import type { ConnectionId } from '../../src/types';

const cid = (s: string) => s as ConnectionId;

describe('splitConnectionId', () => {
  test('splits host:port', () => {
    expect(splitConnectionId(cid('localhost:18765'))).toEqual({ host: 'localhost', port: 18765 });
  });

  test('splits an IPv4 host:port', () => {
    expect(splitConnectionId(cid('192.168.1.5:18770'))).toEqual({
      host: '192.168.1.5',
      port: 18770,
    });
  });

  test('IPv6-safe: bracketed host keeps its brackets, only the trailing port splits', () => {
    expect(splitConnectionId(cid('[::1]:18765'))).toEqual({ host: '[::1]', port: 18765 });
  });

  test('IPv6-safe: unbracketed literal keeps the full address as host', () => {
    expect(splitConnectionId(cid('::1:18765'))).toEqual({ host: '::1', port: 18765 });
  });

  test('no numeric port suffix yields port null', () => {
    expect(splitConnectionId(cid('localhost'))).toEqual({ host: 'localhost', port: null });
  });

  test('trailing non-numeric suffix is not treated as a port', () => {
    expect(splitConnectionId(cid('localhost:abc'))).toEqual({ host: 'localhost:abc', port: null });
  });
});

describe('normalizeConnectionHost (#682)', () => {
  test('collapses localhost and 127.0.0.1 to the same canonical host', () => {
    expect(normalizeConnectionHost('localhost')).toBe('127.0.0.1');
    expect(normalizeConnectionHost('127.0.0.1')).toBe('127.0.0.1');
  });

  test('collapses IPv6 loopback aliases (bracketed and unbracketed) too', () => {
    expect(normalizeConnectionHost('::1')).toBe('127.0.0.1');
    expect(normalizeConnectionHost('[::1]')).toBe('127.0.0.1');
  });

  test('is case-insensitive for loopback aliases', () => {
    expect(normalizeConnectionHost('LOCALHOST')).toBe('127.0.0.1');
    expect(normalizeConnectionHost('LocalHost')).toBe('127.0.0.1');
  });

  test('lowercases (but otherwise leaves alone) a non-loopback hostname', () => {
    expect(normalizeConnectionHost('MyHost.Local')).toBe('myhost.local');
  });

  test('leaves a LAN IP untouched (already lowercase, not a loopback alias)', () => {
    expect(normalizeConnectionHost('192.168.1.5')).toBe('192.168.1.5');
  });
});

describe('dedupeConnectionUrls (#682)', () => {
  const toKey = parseConnectionId;

  test('collapses alias URLs for the same daemon, keeping the LAST one', () => {
    const result = dedupeConnectionUrls(
      ['ws://localhost:18765/ws', 'ws://127.0.0.1:18765/ws'],
      toKey,
    );
    expect(result).toEqual(['ws://127.0.0.1:18765/ws']);
  });

  test('leaves distinct daemons alone, preserving first-seen order', () => {
    const urls = ['ws://localhost:18765/ws', 'ws://192.168.1.5:18770/ws'];
    expect(dedupeConnectionUrls(urls, toKey)).toEqual(urls);
  });

  test('a later duplicate replaces an earlier one in place (order preserved)', () => {
    const result = dedupeConnectionUrls(
      ['ws://localhost:18765/ws', 'ws://192.168.1.5:18770/ws', 'ws://127.0.0.1:18765/ws'],
      toKey,
    );
    // The localhost/127.0.0.1 pair collapses to one entry that keeps its
    // ORIGINAL position (first), but with the LATEST url string.
    expect(result).toEqual(['ws://127.0.0.1:18765/ws', 'ws://192.168.1.5:18770/ws']);
  });

  test('returns an empty array for empty input', () => {
    expect(dedupeConnectionUrls([], toKey)).toEqual([]);
  });

  test('no-op when there are no duplicates', () => {
    const urls = ['ws://192.168.1.5:18770/ws'];
    expect(dedupeConnectionUrls(urls, toKey)).toEqual(urls);
  });
});

describe('actual direct URL identity and child derivation', () => {
  test('implicit ports follow the actual WS/WSS transport', () => {
    expect(parseConnectionId('wss://example.com/ws')).toBe(cid('example.com:443'));
    expect(parseConnectionId('wss://example.com:443/ws')).toBe(cid('example.com:443'));
    expect(parseConnectionId('ws://example.com/ws')).toBe(cid('example.com:80'));
    expect(parseConnectionId('ws://example.com:80/ws')).toBe(cid('example.com:80'));
    expect(parseConnectionId('wss://example.com:18765/ws')).toBe(cid('example.com:18765'));
    expect(
      dedupeConnectionUrls(
        ['wss://example.com/ws', 'ws://example.com:18765/ws', 'ws://example.com/ws'],
        parseConnectionId,
      ),
    ).toHaveLength(3);
  });

  test('a child retains WSS and the certificate hostname despite bookkeeping aliases', () => {
    expect(parseConnectionId('wss://localhost:18765/ws')).toBe(cid('127.0.0.1:18765'));
    expect(childDaemonUrl('wss://localhost:18765/ws', 18766)).toBe('wss://localhost:18766/ws');
    expect(childDaemonUrl('wss://example.com/ws', 443)).toBe('wss://example.com/ws');
    expect(childDaemonUrl('ws://example.com:18765/ws', 18766)).toBe('ws://example.com:18766/ws');
    expect(childDaemonUrl('wss://[2001:db8::1]:18765/ws', 18766)).toBe(
      'wss://[2001:db8::1]:18766/ws',
    );
  });

  test('child endpoints carry no parent credentials, query, fragment or attachment path', () => {
    expect(
      childDaemonUrl('wss://user:pass@example.com:18765/parent?dir=private#token', 18766),
    ).toBe('wss://example.com:18766/ws');
  });

  test('invalid ports and non-WebSocket parents produce no endpoint', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(childDaemonUrl('wss://example.com/ws', port)).toBeNull();
    for (const parent of ['https://example.com', 'file:///tmp/example', 'broken'])
      expect(childDaemonUrl(parent, 18766)).toBeNull();
  });
});
