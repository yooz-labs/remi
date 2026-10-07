import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { DeviceTokenStore } from '../../src/notifications/device-token-store.ts';

/** A registration a minute old: well inside the push lease (#1254), so these
 *  tests exercise merging and tombstones, not expiry. */
const RECENT = Date.now() - 60_000;
const CID = 'conn0000-0000-0000-0000-000000000000';

interface OnDisk {
  tokens: Array<{ token: string; registeredAt?: number; connectionId?: string }>;
  tombstones?: Array<{ token: string; removedAt: number }>;
}

function readDisk(file: string): OnDisk {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OnDisk;
}

function tokensOnDisk(file: string): string[] {
  return readDisk(file).tokens.map((e) => e.token);
}

function tombstonesOnDisk(file: string): string[] {
  return (readDisk(file).tombstones ?? []).map((t) => t.token);
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

  test('actual rotation, pruning, removal and failed persistence never log token or private selectors (#1200)', () => {
    const lines: string[] = [];
    configureLogger({ writeLog: (line) => lines.push(line) });
    const store = new DeviceTokenStore(file);
    const oldToken = '1234567890abcdef'.repeat(4);
    const newToken = 'abcdef1234567890'.repeat(4);
    const privateConnection = 'private-device-connection';
    store.register(oldToken, 'ios', privateConnection);
    store.register(newToken, 'ios', privateConnection);
    store.prune(newToken, 'private-worker-response');
    store.register(oldToken, 'ios', privateConnection);
    store.unregister(oldToken);
    const privatePath = path.join(tmpDir, 'private-token-registry-parent', 'tokens.json');
    new DeviceTokenStore(privatePath).register(newToken, 'ios', privateConnection);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const output = lines.join('\n');
    for (const sensitive of [
      oldToken.slice(0, 20),
      newToken.slice(0, 20),
      privateConnection,
      'private-worker-response',
      'private-token-registry-parent',
    ]) {
      expect(output).not.toContain(sensitive);
    }
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

  test('prune of an unknown token returns false but still tombstones it', () => {
    const s = new DeviceTokenStore(file);
    s.register('live', 'ios', CID);
    expect(s.prune('nope', 'apns-invalid')).toBe(false);
    expect(tokensOnDisk(file)).toEqual(['live']);
    expect(tombstonesOnDisk(file)).toContain('nope');
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

  test('load tolerates an old-format file with no tombstones key (#690)', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [{ token: 'legacy-tok', platform: 'ios', registeredAt: RECENT, connectionId: CID }],
      }),
    );
    const s = new DeviceTokenStore(file);
    s.load();
    expect(s.map.has('legacy-tok')).toBe(true);
  });

  test('persist read-merges a concurrent daemon token instead of clobbering it', () => {
    const a = new DeviceTokenStore(file);
    a.register('tok-a', 'ios', CID);
    // Another daemon appended tok-b to the SAME file out-of-band.
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [
          { token: 'tok-a', platform: 'ios', registeredAt: RECENT, connectionId: CID },
          { token: 'tok-b', platform: 'ios', registeredAt: RECENT, connectionId: 'conn2' },
        ],
      }),
    );
    // a's next write must MERGE tok-b in (adopt it), not overwrite it away.
    a.register('tok-d', 'ios', 'conn3');
    expect(a.map.has('tok-b')).toBe(true);
    expect(new Set(tokensOnDisk(file))).toEqual(new Set(['tok-a', 'tok-b', 'tok-d']));
  });

  test('unregister removes a token and persists the removal (#690)', () => {
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID);
    expect(s.unregister('tok-a')).toBe(true);
    expect(s.map.has('tok-a')).toBe(false);
    expect(tokensOnDisk(file)).toEqual([]);
    expect(tombstonesOnDisk(file)).toContain('tok-a');
  });

  test('unregister of an unknown token returns false but still tombstones it (#690)', () => {
    const s = new DeviceTokenStore(file);
    s.register('live', 'ios', CID);
    expect(s.unregister('nope')).toBe(false);
    expect(tokensOnDisk(file)).toEqual(['live']);
    expect(tombstonesOnDisk(file)).toContain('nope');
  });

  test('re-registering an unregistered token clears the removed mark (#690)', () => {
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID);
    s.unregister('tok-a');
    // Re-register the same token (e.g. the user re-adds the server later).
    // Without clearing the tombstone this token would be blacklisted
    // forever, even though the app explicitly registered it again.
    s.register('tok-a', 'ios', CID);
    expect(s.map.get('tok-a')?.platform).toBe('ios');
    expect(tokensOnDisk(file)).toEqual(['tok-a']);
    expect(tombstonesOnDisk(file)).not.toContain('tok-a');
  });

  // -------------------------------------------------------------------------
  // Multi-daemon scenarios (#690) — a two-instance script exposed the earlier
  // in-memory-only `removed` Set design as broken once more than one daemon
  // shares ~/.remi/device-tokens.json (the real topology: ~5 daemons on one
  // machine). These construct TWO (and a restarted THIRD) store instances
  // against the SAME file to reproduce that topology directly.
  // -------------------------------------------------------------------------

  test('resurrection: a token B still holds locally is NOT written back after A unregisters it', () => {
    const a = new DeviceTokenStore(file);
    a.register('shared-tok', 'ios', 'connA');
    const b = new DeviceTokenStore(file);
    b.load(); // b independently holds shared-tok too (adopted, like a sibling daemon would)

    a.unregister('shared-tok');
    expect(tokensOnDisk(file)).toEqual([]);
    expect(tombstonesOnDisk(file)).toContain('shared-tok');

    // b does something UNRELATED that triggers its own persist(). Under the
    // old in-memory-only design this would write shared-tok right back.
    b.register('other-tok', 'ios', 'connB');
    expect(new Set(tokensOnDisk(file))).toEqual(new Set(['other-tok']));
    expect(b.map.has('shared-tok')).toBe(false);
  });

  test('B-restart: retains the token when only A was removed AND the phone re-registered via B', () => {
    const a = new DeviceTokenStore(file);
    a.register('shared-tok', 'ios', 'connA');
    const b = new DeviceTokenStore(file);
    b.register('shared-tok', 'ios', 'connB'); // same token, phone also connected to b

    // User removes ONLY the server behind daemon a.
    a.unregister('shared-tok');

    // The web client's handleDisconnect re-registers with every OTHER
    // still-connected daemon (b) right after — simulated directly here.
    b.register('shared-tok', 'ios', 'connB');
    expect(tokensOnDisk(file)).toEqual(['shared-tok']);

    // A THIRD daemon on the same machine restarting afterward must see the
    // token still live, not a black hole.
    const c = new DeviceTokenStore(file);
    c.load();
    expect(c.map.has('shared-tok')).toBe(true);
  });

  test('reverse interleaving: a re-register processed BEFORE the unregister commits still loses (why the client ack-gate is needed)', () => {
    // Store-level last-write-wins cannot tell "the re-register happened
    // first" apart from "the unregister happened first" -- it only sees
    // timestamps. handleDisconnect sends the unregister to daemon A and the
    // re-register to sibling B as two independent ws.send()s on SEPARATE
    // connections/processes: there is no happens-before between them. If B
    // commits its re-register BEFORE A commits its tombstone (plausible: the
    // removed daemon is often idle/slow, the kept ones busy), A's
    // later-but-numerically-newer tombstone silently wins and defeats a
    // re-registration the user never asked for. This is exactly why the
    // daemon acks unregister_device_token only AFTER the tombstone commits,
    // and the client awaits that ack before firing the re-register loop —
    // making "tombstone committed" a real happens-before in the common path,
    // with a bounded timeout as the fallback (self-heals on B's next cycle).
    const a = new DeviceTokenStore(file);
    a.register('shared-tok', 'ios', 'connA');
    const b = new DeviceTokenStore(file);
    b.register('shared-tok', 'ios', 'connB');

    // The re-register reaches b and commits FIRST...
    b.register('shared-tok', 'ios', 'connB');
    // ...and only afterward does the removed daemon commit its tombstone.
    a.unregister('shared-tok');

    expect(tokensOnDisk(file)).toEqual([]);
    expect(tombstonesOnDisk(file)).toContain('shared-tok');
    // b's own next push would refresh from disk before deciding whether to
    // push (#690, NotificationDispatcher.computeDelivery) and pick up the
    // same defeat, even though the user never removed b's server.
    b.refreshFromDisk();
    expect(b.map.has('shared-tok')).toBe(false);
  });

  test('machine-fully-removed: tombstone survives B persist, and C refreshFromDisk drops a held copy', () => {
    const a = new DeviceTokenStore(file);
    a.register('shared-tok', 'ios', 'connA');

    // c loads BEFORE the removal, so it independently holds shared-tok too
    // (like a sibling daemon on the same machine that adopted it earlier).
    const c = new DeviceTokenStore(file);
    c.load();
    expect(c.map.has('shared-tok')).toBe(true);

    // User removes EVERY server on the machine (handleDisconnectAll): no
    // re-register follows.
    a.unregister('shared-tok');

    // b's next unrelated persist() must not resurrect it, and the tombstone
    // must be visible on disk afterward.
    const b = new DeviceTokenStore(file);
    b.load();
    b.register('other-tok', 'ios', 'connB');
    expect(tombstonesOnDisk(file)).toContain('shared-tok');
    expect(b.map.has('shared-tok')).toBe(false);

    // c still holds its own earlier in-memory copy; refreshFromDisk (no
    // write) must drop it without needing c's own persist().
    c.refreshFromDisk();
    expect(c.map.has('shared-tok')).toBe(false);
  });

  test('re-register after tombstone survives across a DIFFERENT store instance (#690)', () => {
    const a = new DeviceTokenStore(file);
    a.register('tok-a', 'ios', 'connA');
    a.unregister('tok-a');
    expect(tombstonesOnDisk(file)).toContain('tok-a');

    // A totally different instance (e.g. a fresh daemon the user later
    // reconnects to) registers the SAME token after the tombstone exists.
    const c = new DeviceTokenStore(file);
    c.register('tok-a', 'ios', 'connC');
    expect(tokensOnDisk(file)).toEqual(['tok-a']);
    expect(tombstonesOnDisk(file)).not.toContain('tok-a');

    const d = new DeviceTokenStore(file);
    d.load();
    expect(d.map.has('tok-a')).toBe(true);
  });

  test('same-tick register-then-persist is not defeated by its own stale on-disk tombstone (#690)', () => {
    // Regression guard: unregister() writes a tombstone to disk, then
    // register() for the SAME token runs immediately after (same millisecond
    // in a fast test/process). persist()'s read-merge would otherwise read
    // back that just-written tombstone and hand it to reconcile(), which
    // could re-drop the token it was just told to keep on an exact tie.
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID);
    s.unregister('tok-a');
    s.register('tok-a', 'ios', CID);
    expect(s.map.has('tok-a')).toBe(true);
    expect(tokensOnDisk(file)).toEqual(['tok-a']);
  });

  test('a pruned token is NOT re-adopted from a concurrent daemon stale copy', () => {
    const a = new DeviceTokenStore(file);
    a.register('dead', 'ios', CID);
    a.prune('dead', 'apns-invalid');
    // Another daemon still lists the (now-dead) token because it has not pushed yet.
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [{ token: 'dead', platform: 'ios', registeredAt: RECENT, connectionId: 'conn2' }],
      }),
    );
    // a's next persist read-merge must NOT re-adopt the token it just pruned.
    a.register('fresh', 'ios', 'conn3');
    expect(a.map.has('dead')).toBe(false);
    expect(new Set(tokensOnDisk(file))).toEqual(new Set(['fresh']));
  });

  test('tombstones older than 30 days are garbage-collected on write (#690)', () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [],
        tombstones: [{ token: 'ancient', removedAt: ancient }],
      }),
    );
    const s = new DeviceTokenStore(file);
    s.register('new-token', 'ios', CID);
    expect(tombstonesOnDisk(file)).not.toContain('ancient');
  });

  test('a recent tombstone (under 30 days) survives garbage collection on write (#690)', () => {
    const recent = Date.now() - 5 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [],
        tombstones: [{ token: 'recent-removal', removedAt: recent }],
      }),
    );
    const s = new DeviceTokenStore(file);
    s.register('new-token', 'ios', CID);
    expect(tombstonesOnDisk(file)).toContain('recent-removal');
  });
});

describe('DeviceTokenStore push preferences (#968)', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tokens-prefs-'));
    file = path.join(tmpDir, 'device-tokens.json');
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register without preferences stores the all-on default', () => {
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID);
    expect(s.map.get('tok-a')?.pushPrefs).toEqual({
      questions: true,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: true,
    });
  });

  test('preferences survive a restart via the persisted file', () => {
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID, {
      questions: true,
      turnComplete: false,
      harnessDenied: true,
      turnFailed: true,
    });

    const reloaded = new DeviceTokenStore(file);
    reloaded.load();
    expect(reloaded.map.get('tok-a')?.pushPrefs).toEqual({
      questions: true,
      turnComplete: false,
      harnessDenied: true,
      turnFailed: true,
    });
  });

  test('re-registering the same token replaces its preferences, including widening them', () => {
    // Re-registration IS how the app pushes a toggle change, so a stored value
    // must never survive a newer one -- in either direction.
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID, {
      questions: false,
      turnComplete: false,
      harnessDenied: true,
      turnFailed: true,
    });
    expect(s.map.get('tok-a')?.pushPrefs).toEqual({
      questions: false,
      turnComplete: false,
      harnessDenied: true,
      turnFailed: true,
    });

    s.register('tok-a', 'ios', CID, {
      questions: true,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: true,
    });
    expect(s.map.get('tok-a')?.pushPrefs).toEqual({
      questions: true,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: true,
    });

    const reloaded = new DeviceTokenStore(file);
    reloaded.load();
    expect(reloaded.map.get('tok-a')?.pushPrefs).toEqual({
      questions: true,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: true,
    });
  });

  test('an entry written before #968 loads with no preferences, meaning all-on', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [{ token: 'legacy', platform: 'ios', registeredAt: RECENT, connectionId: CID }],
      }),
    );
    const s = new DeviceTokenStore(file);
    s.load();
    expect(s.map.get('legacy')?.pushPrefs).toBeUndefined();
  });

  test('an entry stored before #1153 (no turnFailed) loads with failed-turn pushes ON', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [
          {
            token: 'pre-1153',
            platform: 'ios',
            registeredAt: RECENT,
            connectionId: CID,
            pushPrefs: { questions: true, turnComplete: false, harnessDenied: false },
          },
        ],
      }),
    );
    const s = new DeviceTokenStore(file);
    s.load();
    expect(s.map.get('pre-1153')?.pushPrefs).toEqual({
      questions: true,
      turnComplete: false,
      harnessDenied: false,
      turnFailed: true,
    });
  });

  test('a turnFailed mute survives a restart (#1153)', () => {
    const s = new DeviceTokenStore(file);
    s.register('tok-a', 'ios', CID, {
      questions: true,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: false,
    });
    const reloaded = new DeviceTokenStore(file);
    reloaded.load();
    expect(reloaded.map.get('tok-a')?.pushPrefs?.turnFailed).toBe(false);
  });

  test('a hand-edited non-boolean preference is normalized on load, not trusted', () => {
    // The file is shared between daemons and editable; `"no"` is truthy, so an
    // implementation that coerced would read this as a mute.
    fs.writeFileSync(
      file,
      JSON.stringify({
        tokens: [
          {
            token: 'edited',
            platform: 'ios',
            registeredAt: RECENT,
            connectionId: CID,
            pushPrefs: { questions: 'no', turnComplete: false },
          },
        ],
      }),
    );
    const s = new DeviceTokenStore(file);
    s.load();
    expect(s.map.get('edited')?.pushPrefs).toEqual({
      questions: true,
      turnComplete: false,
      harnessDenied: true,
      turnFailed: true,
    });
  });
});
