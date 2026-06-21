import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { DeviceTokenStore } from '../../src/notifications/device-token-store.ts';

const CID = 'conn0000-0000-0000-0000-000000000000';

function tokensOnDisk(file: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    tokens: Array<{ token: string }>;
  };
  return parsed.tokens.map((e) => e.token);
}

describe('DeviceTokenStore (#603 Phase 6)', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tokens-'));
    file = path.join(tmpDir, 'device-tokens.json');
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register stores a token in the map and persists it to disk', () => {
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID);
    expect(s.map.get('tok-a')?.platform).toBe('ios');
    expect(tokensOnDisk(file)).toEqual(['tok-a']);
  });

  test('register: a rotated token from the same connection prunes the old one (#585)', () => {
    const s = new DeviceTokenStore(file);
    s.register('old', 'ios', CID);
    s.register('new', 'ios', CID);
    expect([...s.map.keys()]).toEqual(['new']);
    expect(tokensOnDisk(file)).toEqual(['new']);
  });

  test('register: a different connection keeps its own token (no cross-device prune)', () => {
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID);
    s.register('tok-b', 'ios', 'conn2');
    expect(s.size).toBe(2);
  });

  test('prune removes a dead token and persists the removal', () => {
    const s = new DeviceTokenStore(file);
    s.register('dead', 'ios', CID);
    expect(s.prune('dead', 'apns-invalid')).toBe(true);
    expect(s.map.has('dead')).toBe(false);
    expect(tokensOnDisk(file)).toEqual([]);
  });

  test('prune of an unknown token returns false', () => {
    const s = new DeviceTokenStore(file);
    s.register('live', 'ios', CID);
    expect(s.prune('nope', 'apns-invalid')).toBe(false);
  });

  test('load lets a fresh daemon see a token a prior daemon registered (no black-hole)', () => {
    const a = new DeviceTokenStore(file);
    a.register('tok-a', 'ios', CID);
    const b = new DeviceTokenStore(file); // a brand-new daemon (e.g. a fresh worktree)
    b.load();
    expect(b.map.has('tok-a')).toBe(true);
  });

  test('load tolerates a missing file (starts empty)', () => {
    const s = new DeviceTokenStore(path.join(tmpDir, 'absent.json'));
    s.load();
    expect(s.size).toBe(0);
  });

  test('load tolerates a corrupt file (starts empty, no throw)', () => {
    fs.writeFileSync(file, 'not json{');
    const s = new DeviceTokenStore(file);
    s.load();
    expect(s.size).toBe(0);
  });

  test('persist read-merges a concurrent daemon token instead of clobbering it', () => {
    const a = new DeviceTokenStore(file);
    a.register('tok-a', 'ios', CID);
    // Another daemon appended tok-b to the SAME file out-of-band.
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [
          { token: 'tok-a', platform: 'ios', registeredAt: 1, connectionId: CID },
          { token: 'tok-b', platform: 'ios', registeredAt: 1, connectionId: 'conn2' },
        ],
      }),
    );
    // a's next write must MERGE tok-b in (adopt it), not overwrite it away.
    a.register('tok-d', 'ios', 'conn3');
    expect(a.map.has('tok-b')).toBe(true);
    expect(new Set(tokensOnDisk(file))).toEqual(new Set(['tok-a', 'tok-b', 'tok-d']));
  });

  test('a pruned token is NOT re-adopted from a concurrent daemon stale copy', () => {
    const a = new DeviceTokenStore(file);
    a.register('dead', 'ios', CID);
    a.prune('dead', 'apns-invalid');
    // Another daemon still lists the (now-dead) token because it has not pushed yet.
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [{ token: 'dead', platform: 'ios', registeredAt: 1, connectionId: 'conn2' }],
      }),
    );
    // a's next persist read-merge must NOT re-adopt the token it just pruned.
    a.register('fresh', 'ios', 'conn3');
    expect(a.map.has('dead')).toBe(false);
    expect(new Set(tokensOnDisk(file))).toEqual(new Set(['fresh']));
  });
});
