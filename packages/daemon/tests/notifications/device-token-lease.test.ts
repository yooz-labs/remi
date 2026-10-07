/**
 * The push lease (#1254) and preferences across sibling daemons (#1258), on
 * the real `DeviceTokenStore` over real files.
 *
 * Owner decision (2026-10-06): a phone's push registration lives while the
 * phone keeps connecting, ends at once on the explicit disconnect signal
 * (`unregister`), and otherwise expires a set time after the phone was last
 * seen (`[notifications] push_lease_hours`, default 24).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { DeviceTokenStore } from '../../src/notifications/device-token-store.ts';

const HOUR = 60 * 60 * 1000;
const LEASE = 24 * HOUR;

let dir: string;
let file: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remi-token-lease-'));
  file = join(dir, 'device-tokens.json');
  logs = [];
  configureLogger({ writeLog: (line) => logs.push(line) });
});
afterEach(() => {
  __resetLoggerForTests();
  rmSync(dir, { recursive: true, force: true });
});

function seed(tokens: object[]): void {
  writeFileSync(file, JSON.stringify({ tokens, tombstones: [] }));
}
const entry = (token: string, registeredAt: number, extra: object = {}) => ({
  token,
  platform: 'ios',
  registeredAt,
  connectionId: 'c0000000-0000-0000-0000-000000000000',
  ...extra,
});
const onDisk = (): Array<Record<string, unknown>> =>
  (JSON.parse(readFileSync(file, 'utf8')) as { tokens: Array<Record<string, unknown>> }).tokens;

describe('the push lease (#1254)', () => {
  test('a token whose phone was not seen within the lease is dropped, and the drop is logged', () => {
    seed([entry('stale', Date.now() - 25 * HOUR), entry('fresh', Date.now() - HOUR)]);
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();

    expect([...store.map.keys()]).toEqual(['fresh']);
    expect(logs.some((l) => l.includes('lease') && l.includes('stale'.slice(0, 5)))).toBe(true);
  });

  test('the phone being seen after it registered keeps an old registration alive', () => {
    seed([entry('old', Date.now() - 48 * HOUR, { lastSeenAt: Date.now() - HOUR })]);
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();

    expect(store.map.has('old')).toBe(true);
  });

  test('a registration marks the phone seen now', () => {
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();
    const before = Date.now();
    store.register('t1', 'ios', 'c1');

    expect(store.map.get('t1')?.lastSeenAt).toBeGreaterThanOrEqual(before);
  });

  test('touching a token renews its lease and persists it, so a sibling sees it', () => {
    seed([entry('near', Date.now() - 23 * HOUR)]);
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();
    const before = Date.now();

    store.touch(['near', 'unknown-token']);

    expect(store.map.get('near')?.lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(onDisk().find((t) => t['token'] === 'near')?.['lastSeenAt']).toBeGreaterThanOrEqual(
      before,
    );
    // A token the store does not hold is not invented.
    expect(store.map.has('unknown-token')).toBe(false);
  });

  test('a lease of 0 never expires', () => {
    seed([entry('ancient', Date.now() - 400 * 24 * HOUR)]);
    const store = new DeviceTokenStore(file, { leaseMs: 0 });
    store.load();

    expect(store.map.has('ancient')).toBe(true);
  });

  test('the default lease is 24 hours', () => {
    seed([entry('day-old', Date.now() - 25 * HOUR), entry('hour-old', Date.now() - HOUR)]);
    const store = new DeviceTokenStore(file);
    store.load();

    expect([...store.map.keys()]).toEqual(['hour-old']);
  });

  test('an expired token stays out after a refresh, even if a stale sibling wrote it back', () => {
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();
    seed([entry('stale', Date.now() - 30 * HOUR)]);

    store.refreshFromDisk();

    expect(store.map.has('stale')).toBe(false);
  });

  test('the store file is readable by its owner only', () => {
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();
    store.register('t1', 'ios', 'c1');

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('sibling daemons share the newest registration and the latest sighting (#1258, #1254)', () => {
  test("a sibling's newer registration wins, with its preferences", () => {
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();
    store.register('t1', 'ios', 'c1');
    const mine = store.map.get('t1')?.registeredAt ?? 0;
    // A sibling daemon re-registered the same token later, with the phone's new preferences.
    seed([
      entry('t1', mine + 1000, {
        connectionId: 'c2',
        lastSeenAt: mine + 1000,
        pushPrefs: { questions: true, turnComplete: false, harnessDenied: true, turnFailed: true },
      }),
    ]);

    store.refreshFromDisk();

    expect(store.map.get('t1')?.pushPrefs?.turnComplete).toBe(false);
    expect(store.map.get('t1')?.connectionId).toBe('c2');
  });

  test("a sibling's later sighting of the same registration is kept, not overwritten", () => {
    const store = new DeviceTokenStore(file, { leaseMs: LEASE });
    store.load();
    store.register('t1', 'ios', 'c1');
    const registeredAt = store.map.get('t1')?.registeredAt ?? 0;
    const seenLater = registeredAt + 5000;
    seed([entry('t1', registeredAt, { connectionId: 'c1', lastSeenAt: seenLater })]);

    store.refreshFromDisk();
    store.register('t2', 'ios', 'c9'); // any write: must not put back the older sighting

    expect(store.map.get('t1')?.lastSeenAt).toBe(seenLater);
    expect(onDisk().find((t) => t['token'] === 't1')?.['lastSeenAt']).toBe(seenLater);
  });
});
