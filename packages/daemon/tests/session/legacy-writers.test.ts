/**
 * The older-daemon gate (#1165 D, epic #1175, phase 2 #1176): version order,
 * and `findLegacyWriters` over the real readers (a `SessionRegistryFile` on a
 * temp directory and `readStatusFiles` over real status files) with real
 * child processes for the pids, so a live pid and a dead one are what they
 * say. Nothing here replaces the logic under test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IDENTITY_SHIM_MIN_VERSION,
  compareRemiVersion,
  findLegacyWriters,
  readStatusFiles,
} from '../../src/session/legacy-writers.ts';
import { isProcessAlive } from '../../src/session/process-alive.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

describe('compareRemiVersion', () => {
  test('the shim minimum is the first dev build that carries the shim', () => {
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
        expect(Math.sign(compareRemiVersion(ordered[i] as string, ordered[j] as string))).toBe(
          Math.sign(i - j),
        );
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

  test('an unparsable version is -1, on either side', () => {
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
      '0.7.16-dev.7-extra',
      ' 0.7.16',
      '0.7.-1',
      '99999999999999999999.0.0',
    ];
    for (const version of unparsable) {
      expect(compareRemiVersion(version, IDENTITY_SHIM_MIN_VERSION), version).toBe(-1);
      expect(compareRemiVersion(IDENTITY_SHIM_MIN_VERSION, version), version).toBe(-1);
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

  /** A real process that stays alive until the test ends. */
  function livePid(): number {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    children.push(child);
    return child.pid;
  }

  /** The pid of a real process that has already exited. */
  async function deadPid(): Promise<number> {
    const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await child.exited;
    expect(isProcessAlive(child.pid)).toBe(false);
    return child.pid;
  }

  function registerLive(pid: number, version?: string): void {
    registry.register({
      sessionId: crypto.randomUUID(),
      pid,
      wsPort: 19999,
      hookPort: 19998,
      projectPath: dir,
      name: `s-${pid}`,
      startedAt: new Date().toISOString(),
      ...(version !== undefined && { version }),
    });
  }

  function writeStatus(name: string, body: unknown): void {
    fs.writeFileSync(
      path.join(remiDir, name),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }

  function find(selfPid = process.pid) {
    return findLegacyWriters({
      liveSessions: registry,
      statusFiles: () => readStatusFiles(remiDir),
      selfPid,
    });
  }

  test('nothing registered and no status files: no legacy writers', () => {
    expect(find()).toEqual([]);
  });

  test('a live-sessions entry with no version is a legacy writer', () => {
    const pid = livePid();
    registerLive(pid);

    expect(find()).toEqual([{ source: 'live-session', pid, version: undefined }]);
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

  test('an unparsable version is old, never new', () => {
    const pid = livePid();
    registerLive(pid, '0.7.17-p292.1');

    expect(find()).toEqual([{ source: 'live-session', pid, version: '0.7.17-p292.1' }]);
  });

  test('the hub status file is a legacy writer when its version is old or absent', () => {
    const pid = livePid();
    writeStatus('daemon-status.json', { pid, mode: 'hub', version: '0.7.14' });

    expect(find()).toEqual([{ source: 'hub', pid, version: '0.7.14' }]);

    writeStatus('daemon-status.json', { pid, mode: 'hub' });
    expect(find()).toEqual([{ source: 'hub', pid, version: undefined }]);
  });

  test('a session daemon status file is read as a session daemon', () => {
    const pid = livePid();
    writeStatus('status-19921.json', { pid, version: '0.7.10' });

    expect(find()).toEqual([{ source: 'session-daemon', pid, version: '0.7.10' }]);
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

  test('a process named by several places is reported once, by the first', () => {
    const pid = livePid();
    registerLive(pid, '0.7.0');
    writeStatus('status-19921.json', { pid, version: '0.7.0' });

    expect(find()).toEqual([{ source: 'live-session', pid, version: '0.7.0' }]);
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
