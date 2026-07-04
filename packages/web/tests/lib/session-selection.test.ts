/**
 * Tests for the active-session selection rules (#688). Pure functions; no
 * mocks. These guarantee the safety property the bug report was about: an
 * explicit user selection must never be silently swapped for a different
 * live session by a background event, and the only automatic transitions
 * allowed are "clear to null" (the active session vanished) and "land here
 * because nothing was selected" (never overriding an existing pick).
 */

import { describe, expect, test } from 'bun:test';
import { autoSelectIfNone, evictIfActive, evictManyIfActive } from '../../src/lib/session-selection';

describe('autoSelectIfNone', () => {
  test('initial auto-select: lands on the candidate when nothing is selected', () => {
    expect(autoSelectIfNone(null, 'session-a')).toBe('session-a');
  });

  test('does not override an explicit selection with a different candidate', () => {
    // The user is looking at session-a (e.g. a stale-transcript redirect
    // arrives for a different, unrelated request) -- must stay put.
    expect(autoSelectIfNone('session-a', 'session-b')).toBe('session-a');
  });

  test('is a no-op when the candidate equals the current selection', () => {
    expect(autoSelectIfNone('session-a', 'session-a')).toBe('session-a');
  });
});

describe('evictIfActive', () => {
  test('selected session vanishes: clears to null, never switches to another', () => {
    expect(evictIfActive('session-a', 'session-a')).toBeNull();
  });

  test('list refresh keeps explicit selection: a different session evicted is a no-op', () => {
    expect(evictIfActive('session-a', 'session-b')).toBe('session-a');
  });

  test('no-op when nothing is selected', () => {
    expect(evictIfActive(null, 'session-a')).toBeNull();
  });
});

describe('evictManyIfActive', () => {
  test('clears when the active session is in the evicted batch', () => {
    expect(evictManyIfActive('session-a', new Set(['session-a', 'session-c']))).toBeNull();
  });

  test('multi-daemon aggregation update: keeps the active session when only other daemons phantom-evict', () => {
    // conn-B and conn-C both reported phantom sessions this cycle; the
    // user's active session belongs to conn-A and was not touched.
    expect(evictManyIfActive('session-a', new Set(['session-b', 'session-c']))).toBe('session-a');
  });

  test('no-op on an empty eviction set', () => {
    expect(evictManyIfActive('session-a', new Set())).toBe('session-a');
  });

  test('no-op when nothing is selected and the set is non-empty', () => {
    expect(evictManyIfActive(null, new Set(['session-a']))).toBeNull();
  });
});

describe('reconnect churn ordering (#688 scenario)', () => {
  test('explicit selection survives a reconnect-resession churn, then a real eviction clears it', () => {
    // 1. User explicitly selects session-a (modeled directly -- selection
    //    itself is not gated, only automatic overrides are).
    let active: string | null = 'session-a';

    // 2. Reconnect churn: connection's hello_ack now reports session-b for
    //    the same connection slot. Old behavior silently followed; #688
    //    requires this to never move `active` to a DIFFERENT id -- eviction
    //    only fires if session-a itself is what disappeared, which it did
    //    (a resession drops the old session from the client's list), so it
    //    clears to null rather than jumping to session-b.
    active = evictIfActive(active, 'session-a');
    expect(active).toBeNull();

    // 3. A stray session_list_response arrives next; with nothing selected,
    //    it must not resurrect a stale pick on its own (evictManyIfActive is
    //    a pure no-op on null).
    active = evictManyIfActive(active, new Set(['session-b']));
    expect(active).toBeNull();

    // 4. A stale-transcript redirect now offers session-c. Since nothing is
    //    selected, this is the one case allowed to land automatically.
    active = autoSelectIfNone(active, 'session-c');
    expect(active).toBe('session-c');

    // 5. Further churn for an unrelated session must not move it again.
    active = autoSelectIfNone(active, 'session-d');
    expect(active).toBe('session-c');
  });

  test('a session unrelated to the active one vanishing during churn never steals focus', () => {
    let active: string | null = 'session-a';
    // Several unrelated sessions evicted across a multi-daemon aggregation
    // refresh while the user keeps looking at session-a.
    active = evictManyIfActive(active, new Set(['session-x']));
    active = evictIfActive(active, 'session-y');
    active = autoSelectIfNone(active, 'session-z');
    expect(active).toBe('session-a');
  });
});
