/**
 * The older-daemon gate (#1165 D, epic #1175, phase 2 #1176): version order,
 * the recycled-pid rule, and `findLegacyWriters` over the real readers (a
 * `SessionRegistryFile` on a temp directory and `readStatusFiles` over real
 * status files) with real child processes for the pids, so a live pid, a dead
 * one and a recycled one are what they say. Nothing here replaces the logic
 * under test; the injected probes are used only to simulate a probe that
 * fails.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IDENTITY_SHIM_MIN_VERSION,
  compareRemiVersion,
  findLegacyWriters,
  parsePsStartTime,
  readStatusFiles,
} from '../../src/session/legacy-writers.ts';
import { isProcessAlive } from '../../src/session/process-alive.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

describe('compareRemiVersion', () => {
  test('the shim minimum is the first develop version that carries the shim', () => {
    expect(IDENTITY_SHIM_MIN_VERSION).toBe('0.7.16-dev.7');
  });

  test('equal versions are 0', () => {
    expect(compareRemiVersion('0.7.16-dev.7', '0.7.16-dev.7')).toBe(0);
    expect(compareRemiVersion('0.7.16', '0.7.16')).toBe(0);
  });

  test('around the shim minimum: dev.6 is older, dev.7 is it, dev.8 is newer', () => {
    expect(compareRemiVersion('0.7.16-dev.6', IDENTITY_SHIM_MIN_VERSION)).toBeLessThan(0);
    expect(compareRemiVersion('0.7.16-dev.7', IDENTITY_SHIM_MIN_VERSION)).toBe(0);
    expect(compareRemiVersion('0.7.16-dev.8', IDENTITY_SHIM_MIN_VERSION)).toBeGreaterThan(0);
  });

  test('major, minor and patch order before anything else, and the sign flips with the arguments', () => {
    const ordered = ['0.7.15', '0.7.16-dev.1', '0.7.16', '0.7.17-dev.1', '0.8.0-dev.1', '1.0.0'];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(
          Math.sign(compareRemiVersion(ordered[i] as string, ordered[j] as string) as number),
        ).toBe(Math.sign(i - j));
      }
    }
  });

  test('numbers compare as numbers, not text', () => {
    expect(compareRemiVersion('0.7.16-dev.10', '0.7.16-dev.9')).toBeGreaterThan(0);
    expect(compareRemiVersion('0.7.100', '0.7.16')).toBeGreaterThan(0);
    expect(compareRemiVersion('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  test('a release is newer than any dev build of the same X.Y.Z', () => {
    expect(compareRemiVersion('0.7.16', '0.7.16-dev.99')).toBeGreaterThan(0);
    expect(compareRemiVersion('0.7.16-dev.99', '0.7.16')).toBeLessThan(0);
    expect(compareRemiVersion('0.7.16', IDENTITY_SHIM_MIN_VERSION)).toBeGreaterThan(0);
  });

  test('an unparsable version has no order: null, in either argument position', () => {
    const unparsable = [
      '',
      'garbage',
      '0.7',
      '0.7.16.1',
      'v0.7.16',
      '0.7.16-dev',
      '0.7.16-dev.',
      '0.7.16-rc.1',
      '0.7.16-p292.1',
      '0.7.16-p1182.1',
      '0.7.16-dev.7-extra',
      ' 0.7.16',
      '0.7.-1',
      '99999999999999999999.0.0',
    ];
    for (const version of unparsable) {
      expect(compareRemiVersion(version, IDENTITY_SHIM_MIN_VERSION), version).toBeNull();
      expect(compareRemiVersion(IDENTITY_SHIM_MIN_VERSION, version), version).toBeNull();
    }
  });
});

describe('parsePsStartTime', () => {
  test('reads the lstart shape macOS and Linux print, as UTC', () => {
    const date = parsePsStartTime('Sat Oct  3 13:50:12 2026');
    expect(date).toEqual(new Date('2026-10-03T13:50:12Z'));
  });

  test('a two-digit day, surrounding whitespace and a trailing newline', () => {
    expect(parsePsStartTime('  Tue Sep 29 17:22:13 2026\n')).toEqual(
      new Date('2026-09-29T17:22:13Z'),
    );
    expect(parsePsStartTime('Mon Jan  1 00:00:00 2029')).toEqual(new Date('2029-01-01T00:00:00Z'));
  });

  test('anything else is null', () => {
    for (const bad of [
      '',
      '\n',
      'garbage',
      '13:50:12',
      '2026-10-03T13:50:12Z',
      'Sat Foo  3 13:50:12 2026',
      'Sat Oct  3 13:50 2026',
      'Sat Oct  3 13:50:12',
      'Sat Oct 33 13:50:12 2026 extra',
    ]) {
      expect(parsePsStartTime(bad), bad).toBeNull();
    }
  });
});

describe('findLegacyWriters', () => {
  let dir: string;
  let remiDir: string;
  let registry: SessionRegistryFile;
  let children: Array<ReturnType<typeof Bun.spawn>>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-legacy-writers-'));
    remiDir = path.join(dir, '.remi');
    fs.mkdirSync(remiDir, { recursive: true });
    registry = new SessionRegistryFile(path.join(remiDir, 'live-sessions'));
    children = [];
  });

  afterEach(() => {
    for (const child of children) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real process that stays alive until the test ends; `sleep` only, on a system PATH. */
  function livePid(): number {
    const child = Bun.spawn(['/bin/sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    children.push(child);
    return child.pid;
  }

  /** The pid of a real process that has already exited. */
  async function deadPid(): Promise<number> {
    const child = Bun.spawn(['/usr/bin/true'], { stdout: 'ignore', stderr: 'ignore' });
    await child.exited;
    expect(isProcessAlive(child.pid)).toBe(false);
    return child.pid;
  }

  function registerLive(pid: number, version?: string, startedAt = new Date().toISOString()) {
    const sessionId = crypto.randomUUID();
    registry.register({
      sessionId,
      pid,
      wsPort: 19999,
      hookPort: 19998,
      projectPath: dir,
      name: `s-${pid}`,
      startedAt,
      ...(version !== undefined && { version }),
    });
    return path.join(registry.dirPath, `${sessionId}.json`);
  }

  function writeStatus(name: string, body: unknown, mtimeMs?: number): string {
    const file = path.join(remiDir, name);
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  function find(selfPid = process.pid) {
    return findLegacyWriters({
      liveSessions: registry,
      statusFiles: () => readStatusFiles(remiDir),
      selfPid,
    });
  }

  const MINUTE = 60_000;

  test('nothing registered and no status files: no legacy writers', () => {
    expect(find()).toEqual([]);
  });

  test('a live-sessions entry with no version is a legacy writer, naming its file', () => {
    const pid = livePid();
    const file = registerLive(pid);

    expect(find()).toEqual([
      { source: 'live-session', pid, version: undefined, file, pidIdentity: 'verified' },
    ]);
  });

  test('a live-sessions entry older than the shim minimum is a legacy writer, one at or past it is not', () => {
    const oldPid = livePid();
    registerLive(oldPid, '0.7.15');
    registerLive(livePid(), '0.7.16-dev.6');
    registerLive(livePid(), '0.7.16-dev.7');
    registerLive(livePid(), '0.7.16-dev.8');
    registerLive(livePid(), '0.7.16');
    registerLive(livePid(), '0.8.0-dev.1');

    const found = find();

    expect(found.map((w) => w.version).sort()).toEqual(['0.7.15', '0.7.16-dev.6']);
    expect(found.find((w) => w.pid === oldPid)?.source).toBe('live-session');
  });

  test('an unparsable version is old, never new: a seam-era dev.6 and a PR-stamped build are refused', () => {
    const pid = livePid();
    registerLive(pid, '0.7.16-p1182.1');
    registerLive(livePid(), '0.7.16-dev.6');

    const found = find();

    expect(found).toHaveLength(2);
    expect(found.find((w) => w.pid === pid)?.version).toBe('0.7.16-p1182.1');
  });

  test('the hub status file is a legacy writer when its version is old or absent', () => {
    const pid = livePid();
    const file = writeStatus('daemon-status.json', { pid, mode: 'hub', version: '0.7.14' });

    expect(find()).toEqual([
      { source: 'hub', pid, version: '0.7.14', file, pidIdentity: 'verified' },
    ]);

    writeStatus('daemon-status.json', { pid, mode: 'hub' });
    expect(find()).toEqual([
      { source: 'hub', pid, version: undefined, file, pidIdentity: 'verified' },
    ]);
  });

  test('a session daemon status file is read as a session daemon', () => {
    const pid = livePid();
    const file = writeStatus('status-19921.json', { pid, version: '0.7.10' });

    expect(find()).toEqual([
      { source: 'session-daemon', pid, version: '0.7.10', file, pidIdentity: 'verified' },
    ]);
  });

  test('a status file at or past the shim minimum is not a legacy writer', () => {
    writeStatus('daemon-status.json', { pid: livePid(), version: '0.7.16-dev.7' });
    writeStatus('status-19921.json', { pid: livePid(), version: '1.0.0' });

    expect(find()).toEqual([]);
  });

  test('a dead pid is ignored, whatever its version', async () => {
    writeStatus('daemon-status.json', { pid: await deadPid(), version: '0.1.0' });
    writeStatus('status-19921.json', { pid: await deadPid() });

    expect(find()).toEqual([]);
  });

  test('a status file with no pid, a non-numeric pid or a non-positive pid is ignored', () => {
    writeStatus('daemon-status.json', { version: '0.1.0' });
    writeStatus('status-19921.json', { pid: 'abc', version: '0.1.0' });
    writeStatus('status-19922.json', { pid: 0, version: '0.1.0' });
    writeStatus('status-19923.json', { pid: -5, version: '0.1.0' });
    writeStatus('status-19924.json', { pid: 1.5, version: '0.1.0' });

    expect(find()).toEqual([]);
  });

  test('a pid that is not a positive integer is ignored even when the probe would say alive', () => {
    const found = findLegacyWriters({
      liveSessions: registry,
      statusFiles: () => [
        { file: 'status-19921.json', pid: 0 },
        { file: 'status-19922.json', pid: -5 },
        { file: 'status-19923.json', pid: 1.5 },
        { file: 'status-19924.json', pid: Number.NaN },
        { file: 'status-19925.json' },
      ],
      selfPid: process.pid,
      isAlive: () => true,
    });

    expect(found).toEqual([]);
  });

  test('the caller own pid is excluded, from every source', () => {
    registerLive(process.pid, '0.1.0');
    writeStatus('daemon-status.json', { pid: process.pid, version: '0.1.0' });
    writeStatus('status-19921.json', { pid: process.pid });

    expect(find()).toEqual([]);
    // The same entries are legacy writers to any other caller.
    expect(find(process.pid + 1).length).toBe(1);
  });

  describe('ownVersion: a record of the same build is the same shim (#1204 round 2, P1)', () => {
    // A PR-stamped build (`bump-version.sh set 0.7.16-p1204.1`) does not parse, so without this its
    // own sessions, wrappers and hub would each read as an older remi to the next Codex create.
    const OWN = '0.7.16-p1204.1';
    const gate = (ownVersion?: string) =>
      findLegacyWriters({
        liveSessions: registry,
        statusFiles: () => readStatusFiles(remiDir),
        selfPid: process.pid,
        ...(ownVersion !== undefined && { ownVersion }),
      });

    test('a sibling with the SAME unparsable version is not a writer, from every source', () => {
      registerLive(livePid(), OWN);
      writeStatus('daemon-status.json', { pid: livePid(), mode: 'hub', version: OWN });
      writeStatus('status-19921.json', { pid: livePid(), version: OWN });
      expect(gate(OWN)).toEqual([]);
      // Without the option the same records are what they were: unparsable, so older.
      expect(gate()).toHaveLength(3);
    });

    test('a sibling of ANOTHER unparsable version is still a writer', () => {
      const pid = livePid();
      registerLive(pid, '0.7.16-p9999.1');
      registerLive(livePid(), OWN);
      expect(gate(OWN).map((w) => w.pid)).toEqual([pid]);
    });

    test('a lower parsable version is still a writer, and so is no version at all', () => {
      const old = livePid();
      const none = livePid();
      registerLive(old, '0.7.15');
      registerLive(none);
      registerLive(livePid(), OWN);
      expect(
        gate(OWN)
          .map((w) => w.pid)
          .sort(),
      ).toEqual([old, none].sort());
    });

    test('the version must be equal as a string: a prefix, an extension or a different case is another build', () => {
      const prefix = livePid();
      const cased = livePid();
      const longer = livePid();
      registerLive(prefix, '0.7.16-p1204');
      registerLive(cased, '0.7.16-P1204.1');
      registerLive(longer, `${OWN}0`);
      expect(
        gate(OWN)
          .map((w) => w.pid)
          .sort(),
      ).toEqual([prefix, cased, longer].sort());
    });

    test('the pid and recycled-pid rules still apply to a same-version record: it is simply skipped first', async () => {
      writeStatus('status-19921.json', { pid: await deadPid(), version: OWN });
      expect(gate(OWN)).toEqual([]);
    });
  });

  test('a process named by several records is reported once, by the first that passes', () => {
    const pid = livePid();
    const file = registerLive(pid, '0.7.0');
    writeStatus('status-19921.json', { pid, version: '0.7.0' });

    expect(find()).toEqual([
      { source: 'live-session', pid, version: '0.7.0', file, pidIdentity: 'verified' },
    ]);
  });

  test('every kind at once, and a malformed status file does not hide the others', () => {
    const live = livePid();
    const hub = livePid();
    const daemon = livePid();
    registerLive(live);
    writeStatus('daemon-status.json', { pid: hub, version: '0.7.1' });
    writeStatus('status-19921.json', { pid: daemon, version: '0.7.2' });
    writeStatus('status-19922.json', '{ not json');

    const found = find();

    expect(found.map((w) => w.source).sort()).toEqual(['hub', 'live-session', 'session-daemon']);
    expect(found.map((w) => w.pid).sort()).toEqual([live, hub, daemon].sort());
  });

  describe('a recycled pid (a record older than the process now holding the pid)', () => {
    test('a stale status file naming a live, unrelated process is ignored', () => {
      const before = Date.now();
      const pid = livePid();
      writeStatus('status-19921.json', { pid, version: '0.7.0' }, before - 5 * MINUTE);
      writeStatus('daemon-status.json', { pid, mode: 'hub' }, before - 5 * MINUTE);

      expect(find()).toEqual([]);
    });

    test('a status file written after the process started is kept, verified', () => {
      const pid = livePid();
      const file = writeStatus('status-19921.json', { pid, version: '0.7.0' });

      expect(find()).toEqual([
        { source: 'session-daemon', pid, version: '0.7.0', file, pidIdentity: 'verified' },
      ]);
    });

    test('a live-sessions entry that started before the process now holding the pid is ignored', () => {
      const before = Date.now();
      registerLive(livePid(), '0.7.0', new Date(before - 5 * MINUTE).toISOString());

      expect(find()).toEqual([]);
    });

    test('a live-sessions entry that started after the process did is kept', () => {
      const pid = livePid();
      const file = registerLive(pid, '0.7.0', new Date().toISOString());

      expect(find()).toEqual([
        { source: 'live-session', pid, version: '0.7.0', file, pidIdentity: 'verified' },
      ]);
    });

    test('a pid named first as new and then by a stale legacy file is not a legacy writer', () => {
      const before = Date.now();
      const pid = livePid();
      registerLive(pid, '0.7.16');
      writeStatus('status-19921.json', { pid, version: '0.7.0' }, before - 5 * MINUTE);

      expect(find()).toEqual([]);
    });

    test('a pid named first as new and then by a fresh legacy file of the same process is reported legacy', () => {
      const pid = livePid();
      registerLive(pid, '0.7.16');
      const file = writeStatus('status-19921.json', { pid, version: '0.7.0' });

      expect(find()).toEqual([
        { source: 'session-daemon', pid, version: '0.7.0', file, pidIdentity: 'verified' },
      ]);
    });

    test('a stale record does not hide a fresh one for the same pid', () => {
      const before = Date.now();
      const pid = livePid();
      registerLive(pid, '0.6.0', new Date(before - 5 * MINUTE).toISOString());
      const file = writeStatus('status-19921.json', { pid, version: '0.7.0' });

      expect(find()).toEqual([
        { source: 'session-daemon', pid, version: '0.7.0', file, pidIdentity: 'verified' },
      ]);
    });

    test('when the process start time cannot be determined the writer is kept and says so', () => {
      const before = Date.now();
      const pid = livePid();
      const file = writeStatus('status-19921.json', { pid, version: '0.7.0' }, before - 5 * MINUTE);

      const found = findLegacyWriters({
        liveSessions: registry,
        statusFiles: () => readStatusFiles(remiDir),
        selfPid: process.pid,
        processStartTime: () => null,
      });

      expect(found).toEqual([
        { source: 'session-daemon', pid, version: '0.7.0', file, pidIdentity: 'unverified' },
      ]);
    });

    test('when the record has no time the writer is kept and says so', () => {
      const pid = livePid();

      const found = findLegacyWriters({
        liveSessions: registry,
        statusFiles: () => [
          { file: path.join(remiDir, 'status-19921.json'), pid, version: '0.7.0' },
        ],
        selfPid: process.pid,
      });

      expect(found).toEqual([
        {
          source: 'session-daemon',
          pid,
          version: '0.7.0',
          file: path.join(remiDir, 'status-19921.json'),
          pidIdentity: 'unverified',
        },
      ]);
    });

    test('an entry with an unreadable startedAt has no time, so it is kept unverified', () => {
      const pid = livePid();
      const file = registerLive(pid, '0.7.0', 'not-a-date');

      expect(find()).toEqual([
        { source: 'live-session', pid, version: '0.7.0', file, pidIdentity: 'unverified' },
      ]);
    });
  });

  test('it is not read-only: a dead live-sessions entry is deleted by the listing', async () => {
    const file = registerLive(await deadPid(), '0.7.0');
    expect(fs.existsSync(file)).toBe(true);

    expect(find()).toEqual([]);

    expect(fs.existsSync(file)).toBe(false);
  });

  test('the liveness probe is the injected one when given', () => {
    const pid = livePid();
    registerLive(pid, '0.7.0');
    const probed: number[] = [];

    const found = findLegacyWriters({
      liveSessions: registry,
      statusFiles: () => [],
      selfPid: process.pid,
      isAlive: (p) => {
        probed.push(p);
        return false;
      },
    });

    expect(found).toEqual([]);
    expect(probed).toEqual([pid]);
  });

  test('a pid that already passes the version check is not probed', () => {
    registerLive(livePid(), '0.7.16');
    const probed: number[] = [];

    findLegacyWriters({
      liveSessions: registry,
      statusFiles: () => [],
      selfPid: process.pid,
      isAlive: (p) => {
        probed.push(p);
        return true;
      },
    });

    expect(probed).toEqual([]);
  });
});

describe('readStatusFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-status-files-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing directory is an empty list', () => {
    expect(readStatusFiles(path.join(dir, 'absent'))).toEqual([]);
  });

  test('reads the hub file and every per-port file, and nothing else in the directory', () => {
    fs.writeFileSync(
      path.join(dir, 'daemon-status.json'),
      JSON.stringify({ pid: 11, version: '1.2.3' }),
    );
    fs.writeFileSync(path.join(dir, 'status-19921.json'), JSON.stringify({ pid: 22 }));
    fs.writeFileSync(path.join(dir, 'status-abc.json'), JSON.stringify({ pid: 33 }));
    fs.writeFileSync(path.join(dir, 'status-19922.json.tmp'), JSON.stringify({ pid: 44 }));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ pid: 55 }));
    fs.writeFileSync(path.join(dir, 'remi.log'), 'x');

    const entries = readStatusFiles(dir);

    expect(entries.map((e) => path.basename(e.file))).toEqual([
      'daemon-status.json',
      'status-19921.json',
    ]);
    expect(entries[0]).toMatchObject({ pid: 11, version: '1.2.3' });
    expect(entries[1]?.pid).toBe(22);
    expect(entries[1]?.version).toBeUndefined();
  });

  test('each file carries its modification time', () => {
    const file = path.join(dir, 'status-19921.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 22 }));
    const when = Date.now() - 3 * 60_000;
    fs.utimesSync(file, when / 1000, when / 1000);

    const entry = readStatusFiles(dir)[0];

    expect(Math.abs((entry?.recordedAtMs ?? 0) - when)).toBeLessThan(1000);
  });

  test('an unreadable or non-object file carries no pid and no version', () => {
    fs.writeFileSync(path.join(dir, 'status-19921.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'status-19922.json'), '"a string"');
    fs.writeFileSync(path.join(dir, 'status-19923.json'), 'null');
    fs.writeFileSync(path.join(dir, 'status-19924.json'), JSON.stringify({ pid: '7', version: 5 }));

    for (const entry of readStatusFiles(dir)) {
      expect(entry.pid, entry.file).toBeUndefined();
      expect(entry.version, entry.file).toBeUndefined();
    }
    expect(readStatusFiles(dir)).toHaveLength(4);
  });
});
