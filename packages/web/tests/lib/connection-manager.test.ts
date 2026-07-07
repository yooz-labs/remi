/**
 * Unit tests for connection-manager helpers.
 *
 * These cover the silent multi-connection identity reuse path (#257):
 * after a single passphrase unlock, every connection that was waiting on an
 * auth challenge must be signed in one batch — no second prompt for sibling
 * daemon ports.
 */

import { describe, expect, test } from 'bun:test';
import {
  allocateStaggerSlot,
  collectPendingChallengeConnections,
  DEVICE_ID_STORAGE_KEY,
  type ForceReconnectCandidate,
  getOrCreateDeviceId,
  isConnectionReplaceable,
  type KeyValueStorage,
  planForceReconnect,
} from '../../src/hooks/connection-manager-helpers';

/** In-memory Storage-compatible fake so tests don't need a browser DOM. */
function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

type FakeConn = {
  id: string;
  pendingChallenge: { challenge: string } | null;
  needsPassphrase: boolean;
};

function mkConn(id: string, pending: boolean): FakeConn {
  return {
    id,
    pendingChallenge: pending ? { challenge: `c-${id}` } : null,
    needsPassphrase: pending,
  };
}

describe('collectPendingChallengeConnections', () => {
  test('returns only connections with a pending challenge', () => {
    const conns: FakeConn[] = [mkConn('a', true), mkConn('b', false), mkConn('c', true)];
    const result = collectPendingChallengeConnections(conns);
    expect(result.map((c) => c.id)).toEqual(['a', 'c']);
  });

  test('returns empty list when no connections are pending', () => {
    const conns: FakeConn[] = [mkConn('a', false), mkConn('b', false)];
    expect(collectPendingChallengeConnections(conns)).toEqual([]);
  });

  test('returns empty list for empty input', () => {
    expect(collectPendingChallengeConnections([])).toEqual([]);
  });

  test('handles a single pending connection', () => {
    const conns: FakeConn[] = [mkConn('only', true)];
    expect(collectPendingChallengeConnections(conns).map((c) => c.id)).toEqual(['only']);
  });

  test('preserves iteration order from the input iterable', () => {
    // The Map values iterator order is insertion order, which matches what
    // useConnectionManager relies on. This guards against accidentally
    // sorting/filtering in a way that drops siblings.
    const map = new Map<string, FakeConn>();
    map.set('first', mkConn('first', true));
    map.set('second', mkConn('second', false));
    map.set('third', mkConn('third', true));
    map.set('fourth', mkConn('fourth', true));
    const result = collectPendingChallengeConnections(map.values());
    expect(result.map((c) => c.id)).toEqual(['first', 'third', 'fourth']);
  });
});

describe('getOrCreateDeviceId (#662)', () => {
  test('generates and persists a new id when none is stored', () => {
    const storage = fakeStorage();
    const id = getOrCreateDeviceId(storage);

    expect(id.length).toBeGreaterThan(0);
    expect(storage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(id);
  });

  test('returns the SAME id on repeated calls (persists across restarts)', () => {
    const storage = fakeStorage();
    const first = getOrCreateDeviceId(storage);
    const second = getOrCreateDeviceId(storage);

    expect(second).toBe(first);
  });

  test('reuses an existing stored id rather than generating a new one', () => {
    const storage = fakeStorage({ [DEVICE_ID_STORAGE_KEY]: 'existing-device-id' });
    const id = getOrCreateDeviceId(storage);

    expect(id).toBe('existing-device-id');
  });

  test('two independent storages get different generated ids', () => {
    const idA = getOrCreateDeviceId(fakeStorage());
    const idB = getOrCreateDeviceId(fakeStorage());

    expect(idA).not.toBe(idB);
  });
});

/**
 * Coverage for the reconnect-stampede fix (#664): on app resume / network
 * change, `app-force-reconnect` used to unconditionally force-close every
 * connected/authenticating connection at once -- with ~5 daemons that meant
 * a guaranteed simultaneous visible reconnect cycle on every foreground.
 * `planForceReconnect` decides per-connection whether a reconnect is even
 * needed, and staggers the ones that are.
 */
describe('planForceReconnect (#664)', () => {
  const candidate = (
    connectionId: string,
    isOpen: boolean,
    isHealthy: boolean,
  ): ForceReconnectCandidate => ({ connectionId, isOpen, isHealthy });

  test('leaves a healthy, open connection alone entirely', () => {
    const plan = planForceReconnect([candidate('a', true, true)], {
      staggerStepMs: 300,
      staggerJitterMs: 2000,
    });

    expect(plan).toEqual([{ connectionId: 'a', shouldReconnect: false, delayMs: 0 }]);
  });

  test('reconnects a not-open connection immediately, no stagger', () => {
    const plan = planForceReconnect([candidate('a', false, false)], {
      staggerStepMs: 300,
      staggerJitterMs: 2000,
    });

    expect(plan).toEqual([{ connectionId: 'a', shouldReconnect: true, delayMs: 0 }]);
  });

  test('reconnects an open-but-unhealthy connection with a staggered delay', () => {
    const plan = planForceReconnect([candidate('a', true, false)], {
      staggerStepMs: 300,
      staggerJitterMs: 2000,
      random: () => 0.5,
    });

    expect(plan).toEqual([{ connectionId: 'a', shouldReconnect: true, delayMs: 1000 }]);
  });

  test('staggers multiple open-but-unhealthy connections across their index', () => {
    const plan = planForceReconnect(
      [
        candidate('a', true, false),
        candidate('b', true, false),
        candidate('c', true, false),
      ],
      { staggerStepMs: 300, staggerJitterMs: 2000, random: () => 0 },
    );

    expect(plan.map((d) => d.delayMs)).toEqual([0, 300, 600]);
  });

  test('a healthy connection does not consume a stagger index (sibling unhealthy ones stay unaffected)', () => {
    const plan = planForceReconnect(
      [
        candidate('healthy', true, true),
        candidate('stale-1', true, false),
        candidate('stale-2', true, false),
      ],
      { staggerStepMs: 300, staggerJitterMs: 0, random: () => 0 },
    );

    expect(plan).toEqual([
      { connectionId: 'healthy', shouldReconnect: false, delayMs: 0 },
      { connectionId: 'stale-1', shouldReconnect: true, delayMs: 0 },
      { connectionId: 'stale-2', shouldReconnect: true, delayMs: 300 },
    ]);
  });

  test('mixes immediate (dead) and staggered (uncertain) reconnects in one sweep', () => {
    const plan = planForceReconnect(
      [
        candidate('healthy', true, true),
        candidate('dead', false, false),
        candidate('uncertain', true, false),
      ],
      { staggerStepMs: 300, staggerJitterMs: 0, random: () => 0 },
    );

    expect(plan).toEqual([
      { connectionId: 'healthy', shouldReconnect: false, delayMs: 0 },
      { connectionId: 'dead', shouldReconnect: true, delayMs: 0 },
      { connectionId: 'uncertain', shouldReconnect: true, delayMs: 0 },
    ]);
  });

  test('empty input produces an empty plan', () => {
    expect(planForceReconnect([], { staggerStepMs: 300, staggerJitterMs: 2000 })).toEqual([]);
  });

  test('defaults to Math.random when no random fn is injected (delay stays within bounds)', () => {
    const plan = planForceReconnect([candidate('a', true, false)], {
      staggerStepMs: 300,
      staggerJitterMs: 2000,
    });

    expect(plan[0]?.shouldReconnect).toBe(true);
    expect(plan[0]?.delayMs).toBeGreaterThanOrEqual(0);
    expect(plan[0]?.delayMs).toBeLessThan(2000);
  });
});

/**
 * Coverage for the #685 PR review finding: the first version of this fix
 * assigned each connection's heartbeat-reconnect stagger offset from a
 * monotonically-growing counter, clamped at a ceiling once it got too
 * large. In a long-lived session that repeatedly tears down and recreates
 * a still-unreachable connection (the real trigger: `App.tsx`'s
 * `session_list_response` handler re-calls `connectDirect` for every
 * sibling daemon port on every reconnect / app resume), that counter
 * quickly passes the ceiling, and every connection created after that point
 * -- including ones still live -- gets the SAME clamped offset, silently
 * reintroducing the exact clustering bug #685 fixes. `allocateStaggerSlot`
 * reuses the smallest FREE slot instead, so live connections' offsets stay
 * distinct no matter how many connect/disconnect cycles have happened.
 */
describe('allocateStaggerSlot (#685 review: bounded, collision-free per-connection offsets)', () => {
  test('returns 0 for the first connection', () => {
    expect(allocateStaggerSlot(new Set())).toBe(0);
  });

  test('returns the smallest slot not already in use', () => {
    expect(allocateStaggerSlot(new Set([0, 1, 2]))).toBe(3);
    expect(allocateStaggerSlot(new Set([0, 2]))).toBe(1);
    expect(allocateStaggerSlot(new Set([1, 2]))).toBe(0);
  });

  test('reuses a freed slot instead of growing past the live connection count', () => {
    const used = new Set<number>();
    const a = allocateStaggerSlot(used);
    used.add(a);
    const b = allocateStaggerSlot(used);
    used.add(b);
    const c = allocateStaggerSlot(used);
    used.add(c);
    expect([a, b, c]).toEqual([0, 1, 2]);

    used.delete(b); // b disconnects, freeing slot 1
    const d = allocateStaggerSlot(used);
    expect(d).toBe(1); // reused, not grown to 3
  });

  test('a connection stuck reconnecting and repeatedly recreated never collides with live siblings, even after many cycles', () => {
    // Models the real trigger directly: B..E are stable/live connections;
    // A is 'unreachable' and gets torn down + recreated on every
    // session_list_response cycle. A monotonic ever-growing counter would
    // eventually assign A the SAME clamped offset as a stable sibling; slot
    // reuse must not, no matter how many cycles pass.
    const used = new Set<number>();
    const slotOf = new Map<string, number>();

    const connect = (id: string) => {
      const slot = allocateStaggerSlot(used);
      used.add(slot);
      slotOf.set(id, slot);
    };
    const disconnect = (id: string) => {
      const slot = slotOf.get(id);
      if (slot !== undefined) used.delete(slot);
      slotOf.delete(id);
    };

    connect('B');
    connect('C');
    connect('D');
    connect('E');

    for (let cycle = 0; cycle < 15; cycle++) {
      connect('A');
      const liveSlots = Array.from(slotOf.values());
      // Every currently-live connection must hold a DISTINCT slot -- this
      // must hold on every single cycle, including well past the old
      // design's 10-slot clamp ceiling.
      expect(new Set(liveSlots).size).toBe(liveSlots.length);
      disconnect('A'); // 'unreachable' again; torn down before the next cycle
    }
  });

  test('slots return to 0 once every connection has disconnected', () => {
    const used = new Set<number>([0, 1, 2]);
    used.clear();
    expect(allocateStaggerSlot(used)).toBe(0);
  });
});

/**
 * Coverage for #682: `connectDirect` must supersede a stale/errored manager
 * entry when a fresh connect attempt targets the same connectionId (e.g. the
 * same daemon reached through a different host alias that
 * `normalizeConnectionHost` collapses to one key), but must never interrupt
 * an entry that's already live.
 */
describe('isConnectionReplaceable (#682)', () => {
  test('an errored entry is replaceable (superseded by a fresh connect)', () => {
    expect(isConnectionReplaceable('error')).toBe(true);
  });

  test('a disconnected entry is replaceable', () => {
    expect(isConnectionReplaceable('disconnected')).toBe(true);
  });

  test('an unreachable entry is replaceable', () => {
    expect(isConnectionReplaceable('unreachable')).toBe(true);
  });

  test('a connected entry is NOT replaceable', () => {
    expect(isConnectionReplaceable('connected')).toBe(false);
  });

  test('a connecting entry is NOT replaceable', () => {
    expect(isConnectionReplaceable('connecting')).toBe(false);
  });

  test('an authenticating entry is NOT replaceable', () => {
    expect(isConnectionReplaceable('authenticating')).toBe(false);
  });

  test('a reconnecting entry is NOT replaceable', () => {
    expect(isConnectionReplaceable('reconnecting')).toBe(false);
  });
});
