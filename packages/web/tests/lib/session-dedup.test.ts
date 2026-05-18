/**
 * Tests for cross-connection session dedup (#430). The whole point of
 * this layer is that two daemons reporting the same Claude sessionId
 * must NOT collapse into one row — that was the cross-daemon answer
 * routing bug from #427.
 */

import { describe, expect, test } from 'bun:test';
import { compositeKey, dedupSessions } from '../../src/lib/session-dedup';
import type { ConnectionId, UISession } from '../../src/types';

function makeSession(overrides: Partial<UISession>): UISession {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'test',
    connectionId: 'localhost:18766' as ConnectionId,
    createdAt: '2026-05-17T00:00:00Z',
    lastActiveAt: '2026-05-17T00:00:00Z',
    status: 'idle',
    connectionStatus: 'connected',
    unreadCount: 0,
    source: 'daemon',
    ...overrides,
  };
}

describe('compositeKey', () => {
  test('uses connectionId|claudeSessionId when both present', () => {
    const key = compositeKey(
      makeSession({
        connectionId: 'host:18766' as ConnectionId,
        claudeSessionId: 'aaaa-bbbb',
      }),
    );
    expect(key).toBe('host:18766|aaaa-bbbb');
  });

  test('falls back to connectionId|id when claudeSessionId is absent', () => {
    const key = compositeKey(
      makeSession({
        id: 'remi-session-1',
        connectionId: 'host:18766' as ConnectionId,
      }),
    );
    expect(key).toBe('host:18766|remi-session-1');
  });
});

describe('dedupSessions (the core safety invariant of #430)', () => {
  test('two daemons reporting same sessionId + different claudeSessionId stay separate', () => {
    // The exact bug case. Pre-#430 these collapsed into one row.
    const a = makeSession({
      id: 'same-claude-id',
      connectionId: 'host:18766' as ConnectionId,
      claudeSessionId: 'daemon-a-binding',
    });
    const b = makeSession({
      id: 'same-claude-id',
      connectionId: 'host:18767' as ConnectionId,
      claudeSessionId: 'daemon-b-binding',
    });

    const result = dedupSessions([a, b]);

    expect(result).toHaveLength(2);
    expect(result[0]?.connectionId).toBe('host:18766');
    expect(result[1]?.connectionId).toBe('host:18767');
  });

  test('same daemon reporting the same binding twice collapses to one row', () => {
    const a = makeSession({
      id: 'same-id',
      connectionId: 'host:18766' as ConnectionId,
      claudeSessionId: 'same-binding',
    });
    const b = makeSession({
      id: 'same-id',
      connectionId: 'host:18766' as ConnectionId,
      claudeSessionId: 'same-binding',
    });

    const result = dedupSessions([a, b]);

    expect(result).toHaveLength(1);
  });

  test('daemon-sourced wins over transcript-sourced on the same composite key', () => {
    const transcript = makeSession({
      id: 'shared',
      connectionId: 'host:18766' as ConnectionId,
      claudeSessionId: 'same-binding',
      source: 'transcript',
    });
    const daemon = makeSession({
      id: 'shared',
      connectionId: 'host:18766' as ConnectionId,
      claudeSessionId: 'same-binding',
      source: 'daemon',
    });

    const result = dedupSessions([transcript, daemon]);

    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('daemon');
  });

  test('pre-#429 daemons (no claudeSessionId) still degrade gracefully', () => {
    // Two entries from the same daemon with the same remi id collapse;
    // entries from DIFFERENT daemons with the same remi id stay separate.
    // (Different from pre-#430 behavior in the multi-daemon case, but
    // that case was never correct.)
    const sameDaemon1 = makeSession({
      id: 'same-id',
      connectionId: 'host:18766' as ConnectionId,
    });
    const sameDaemon2 = makeSession({
      id: 'same-id',
      connectionId: 'host:18766' as ConnectionId,
    });
    const otherDaemon = makeSession({
      id: 'same-id',
      connectionId: 'host:18767' as ConnectionId,
    });

    const result = dedupSessions([sameDaemon1, sameDaemon2, otherDaemon]);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.connectionId).sort()).toEqual([
      'host:18766',
      'host:18767',
    ]);
  });
});
