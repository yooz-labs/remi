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
  collectPendingChallengeConnections,
  DEVICE_ID_STORAGE_KEY,
  getOrCreateDeviceId,
  type KeyValueStorage,
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
