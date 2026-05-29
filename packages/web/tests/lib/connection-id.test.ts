/**
 * Tests for splitConnectionId (#435 Phase 1 / P3). Pure function; no mocks.
 * This is the host/port extraction that feeds resolveDaemonPort in the
 * reconnect-escalation path, so its IPv6 handling must be correct.
 */

import { describe, expect, test } from 'bun:test';
import { splitConnectionId } from '../../src/lib/connection-id';
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
