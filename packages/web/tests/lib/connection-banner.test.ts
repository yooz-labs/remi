/**
 * Tests for deriveConnectionBannerError (#682). Pure function; no mocks.
 *
 * Before this fix, the in-chat error banner was derived globally
 * (`connections.find(c => c.status === 'error')`), so an unrelated errored
 * or duplicate manager entry could pin a "Connection error" banner even
 * while the connection actually serving the active session was healthy and
 * attached. This scopes the banner to the active session's own connection.
 */

import { describe, expect, test } from 'bun:test';
import {
  type BannerConnectionLike,
  deriveConnectionBannerError,
} from '../../src/lib/connection-banner';

function conn(
  connectionId: string,
  status: string,
  error: string | null = null,
): BannerConnectionLike {
  return { connectionId, status, error };
}

describe('deriveConnectionBannerError (#682)', () => {
  test('active session healthy + a DIFFERENT connection errored -> no banner', () => {
    const connections = [conn('healthy:1', 'connected'), conn('stale:2', 'error')];
    expect(deriveConnectionBannerError(connections, 'healthy:1')).toBeNull();
  });

  test('active session itself errored -> banner with its own error message', () => {
    const connections = [conn('bad:1', 'error', 'boom')];
    expect(deriveConnectionBannerError(connections, 'bad:1')).toBe('boom');
  });

  test('active session errored with no explicit error message -> fallback text', () => {
    const connections = [conn('bad:1', 'error')];
    expect(deriveConnectionBannerError(connections, 'bad:1')).toBe('Connection error: bad:1');
  });

  test('no active session (null) falls back to a global scan', () => {
    const connections = [conn('a:1', 'connected'), conn('b:2', 'error', 'daemon unreachable')];
    expect(deriveConnectionBannerError(connections, null)).toBe('daemon unreachable');
  });

  test('no active session and nothing errored -> null', () => {
    const connections = [conn('a:1', 'connected'), conn('b:2', 'connecting')];
    expect(deriveConnectionBannerError(connections, null)).toBeNull();
  });

  test('active connectionId has no matching entry -> null, not a global fallback', () => {
    // A sibling daemon erroring must never bleed into a session whose own
    // connection entry is simply missing/gone.
    const connections = [conn('other:1', 'error')];
    expect(deriveConnectionBannerError(connections, 'missing:9')).toBeNull();
  });

  test('multiple errored siblings are all ignored when the active connection is healthy', () => {
    const connections = [
      conn('healthy:1', 'connected'),
      conn('stale:2', 'error'),
      conn('stale:3', 'error'),
    ];
    expect(deriveConnectionBannerError(connections, 'healthy:1')).toBeNull();
  });

  test('empty connections list -> null regardless of activeConnectionId', () => {
    expect(deriveConnectionBannerError([], 'anything:1')).toBeNull();
    expect(deriveConnectionBannerError([], null)).toBeNull();
  });
});
