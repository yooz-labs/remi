import { describe, expect, test } from 'bun:test';
import {
  evictPhantomSessions,
  MIN_EVICT_AGE_MS,
  shouldEvictCachedSession,
  STALE_EVICT_AGE_MS,
} from '../../src/lib/session-eviction';

const NOW = Date.parse('2026-06-18T00:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const session = (id: string, lastActiveAt: string, connectionId = 'conn-A') => ({
  id,
  lastActiveAt,
  connectionId,
});

const ctx = (knownIds: string[], connectionAuthoritative = 'conn-A') => ({
  knownIds: new Set(knownIds),
  connectionAuthoritative,
});

describe('shouldEvictCachedSession (#577 Fix A)', () => {
  test('evicts a stale + unknown session on the authoritative connection', () => {
    // 20 days old, not in the daemon's known set, same connection -> phantom.
    expect(
      shouldEvictCachedSession(session('b7f8d9af', ago(20 * DAY)), ctx(['live-1']), NOW),
    ).toBe(true);
  });

  test('keeps a session the daemon still knows, however old', () => {
    expect(
      shouldEvictCachedSession(session('known', ago(100 * DAY)), ctx(['known']), NOW),
    ).toBe(false);
  });

  test('keeps a recent unknown session (minimum-age guard)', () => {
    // Daemon restarted and acked before re-listing; the session is only 2h old,
    // well under the minimum-age floor -> never evict.
    expect(
      shouldEvictCachedSession(session('fresh', ago(2 * 60 * 60 * 1000)), ctx([]), NOW),
    ).toBe(false);
  });

  test('keeps an unknown session that is between min-age and the staleness threshold', () => {
    // 3 days old: past the 1-day floor but well under the 14-day staleness
    // threshold. A daemon that hasn't re-listed must not lose it.
    expect(shouldEvictCachedSession(session('mid', ago(3 * DAY)), ctx([]), NOW)).toBe(false);
  });

  test('does not evict a session belonging to a different connection', () => {
    // Stale + unknown, but it lives on conn-B; conn-A's list says nothing about it.
    expect(
      shouldEvictCachedSession(
        session('other', ago(30 * DAY), 'conn-B'),
        ctx([], 'conn-A'),
        NOW,
      ),
    ).toBe(false);
  });

  test('keeps a session with an unparsable timestamp (conservative)', () => {
    expect(shouldEvictCachedSession(session('bad', 'not-a-date'), ctx([]), NOW)).toBe(false);
  });

  test('boundary: exactly at the staleness threshold evicts', () => {
    expect(
      shouldEvictCachedSession(session('edge', ago(STALE_EVICT_AGE_MS)), ctx([]), NOW),
    ).toBe(true);
  });

  test('boundary: one ms under the staleness threshold is kept', () => {
    expect(
      shouldEvictCachedSession(session('edge', ago(STALE_EVICT_AGE_MS - 1)), ctx([]), NOW),
    ).toBe(false);
  });

  test('minimum-age floor is below the staleness threshold (sanity)', () => {
    expect(MIN_EVICT_AGE_MS).toBeLessThan(STALE_EVICT_AGE_MS);
  });
});

describe('evictPhantomSessions', () => {
  test('returns only the sessions to keep', () => {
    const sessions = [
      session('phantom', ago(30 * DAY)), // stale + unknown -> evict
      session('known', ago(30 * DAY)), // unknown-age but known -> keep
      session('fresh', ago(60 * 60 * 1000)), // recent -> keep
      session('other-conn', ago(30 * DAY), 'conn-B'), // other connection -> keep
    ];
    const kept = evictPhantomSessions(sessions, ctx(['known'], 'conn-A'), NOW);
    expect(kept.map((s) => s.id).sort()).toEqual(['fresh', 'known', 'other-conn']);
  });

  test('returns the list unchanged when nothing is evictable', () => {
    const sessions = [session('a', ago(60 * 60 * 1000)), session('b', ago(2 * DAY))];
    const kept = evictPhantomSessions(sessions, ctx(['a', 'b']), NOW);
    expect(kept).toHaveLength(2);
  });
});
