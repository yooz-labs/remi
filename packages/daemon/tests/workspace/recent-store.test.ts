/** Repository history (#1284): real git repositories, restricted files and competing processes. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { withInterprocessFileLockAsync } from '../../src/storage/interprocess-file-lock.ts';
import { RecentRepositoryStore } from '../../src/workspace/recent-store.ts';
import { recentRepositories } from '../../src/workspace/recent.ts';

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...args], {
    cwd,
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

describe('RecentRepositoryStore (#1284)', () => {
  let root: string;
  let file: string;
  let store: RecentRepositoryStore;
  let logged: string[];
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-recent-store-')));
    file = path.join(root, 'home', 'recent-repositories.json');
    store = new RecentRepositoryStore(file);
    logged = [];
    configureLogger({ writeLog: (line) => logged.push(line) });
  });
  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function repo(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
    return dir;
  }

  test('a directory inside a linked worktree remembers the main repository after removal', async () => {
    const main = repo('main');
    const linked = path.join(root, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'topic', linked);
    fs.mkdirSync(path.join(linked, 'src'));
    await store.remember(path.join(linked, 'src'));
    git(main, 'worktree', 'remove', '--force', linked);
    expect(store.list().map((r) => r.repository)).toEqual([main]);
    expect(
      (await recentRepositories([], { remembered: store.list() })).map((r) => r.repository),
    ).toEqual([main]);
  });

  test('writes an owner-only file and directory containing only repository and lastUsedAt', async () => {
    const main = repo('main');
    await store.remember(main);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const records = new RecentRepositoryStore(file).list();
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual(['lastUsedAt', 'repository']);
    expect(records[0]?.repository).toBe(main);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['recent-repositories.json']);
  });

  test('keeps the newest 20 repositories, updates repeated use and has no age expiry', async () => {
    const first = repo('r0');
    await store.remember(first, first);
    fs.writeFileSync(
      file,
      JSON.stringify([{ repository: first, lastUsedAt: '2020-01-01T00:00:00.000Z' }]),
    );
    expect(store.list()[0]?.repository).toBe(first);
    for (let i = 1; i < 20; i++) {
      const dir = repo(`r${i}`);
      await store.remember(dir, dir);
    }
    await store.remember(first, first);
    const last = repo('r20');
    await store.remember(last, last);
    const records = store.list();
    expect(records).toHaveLength(20);
    expect(new Set(records.map((r) => r.repository)).size).toBe(20);
    expect(records.map((r) => r.repository)).toContain(first);
    expect(records.map((r) => r.repository)).not.toContain(path.join(root, 'r1'));
    expect(records[0]?.repository).toBe(last);
    expect(records.find((r) => r.repository === first)?.lastUsedAt).not.toBe(
      '2020-01-01T00:00:00.000Z',
    );
  }, 30000);

  test('missing history is empty without a diagnostic', () => {
    expect(store.list()).toEqual([]);
    expect(logged).toEqual([]);
  });

  test('damaged or invalid history is ignored with a content-free diagnostic, then a start repairs it', async () => {
    const main = repo('main');
    fs.mkdirSync(path.dirname(file));
    for (const value of [
      '{ private-file-contents',
      JSON.stringify([{ repository: main, lastUsedAt: 'not-a-time' }]),
      JSON.stringify([{ repository: 'relative', lastUsedAt: new Date().toISOString() }]),
      JSON.stringify([{ repository: `${main}\u202e`, lastUsedAt: new Date().toISOString() }]),
      JSON.stringify([
        { repository: main, lastUsedAt: new Date().toISOString(), sessionId: 'private-session' },
      ]),
      JSON.stringify(
        Array.from({ length: 21 }, () => ({
          repository: main,
          lastUsedAt: new Date().toISOString(),
        })),
      ),
    ]) {
      fs.writeFileSync(file, value);
      expect(store.list()).toEqual([]);
    }
    expect(logged).toHaveLength(6);
    expect(logged.every((line) => line.includes('ignoring the file'))).toBe(true);
    expect(logged.join('\n')).not.toContain(root);
    expect(logged.join('\n')).not.toContain('private-');
    await store.remember(main);
    expect(store.list().map((r) => r.repository)).toEqual([main]);
  });

  test('outside a repository or in a bare repository adds no history', async () => {
    await store.remember(root);
    const bare = path.join(root, 'bare');
    git(root, 'init', '-q', '--bare', bare);
    await store.remember(bare);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('history and sessions merge by latest use, still excluding gone main repositories', async () => {
    const main = repo('main');
    const other = repo('other');
    const sessions = [{ projectPath: main, exitedAt: '2026-10-01T00:00:00.000Z' }];
    const remembered = [
      { repository: main, lastUsedAt: '2026-10-02T00:00:00.000Z' },
      { repository: other, lastUsedAt: '2026-10-03T00:00:00.000Z' },
      { repository: path.join(root, 'gone'), lastUsedAt: '2026-10-04T00:00:00.000Z' },
    ];
    const result = await recentRepositories(sessions, { remembered });
    expect(result.map((r) => r.repository)).toEqual([other, main]);
    expect(result[1]?.lastUsedAt).toBe(remembered[0]?.lastUsedAt);
    const newerSession = [{ projectPath: main, exitedAt: '2026-10-05T00:00:00.000Z' }];
    expect((await recentRepositories(newerSession, { remembered }))[0]?.lastUsedAt).toBe(
      newerSession[0]?.exitedAt,
    );
  });

  test('competing processes preserve all repositories in one atomic history', async () => {
    const repos = Array.from({ length: 6 }, (_, i) => repo(`r${i}`));
    const module = path.resolve(import.meta.dir, '../../src/workspace/recent-store.ts');
    const code = `import { RecentRepositoryStore } from ${JSON.stringify(module)}; await new RecentRepositoryStore(process.argv[1]).remember(process.argv[2], process.argv[2]);`;
    const children = repos.map((repository) =>
      Bun.spawn([process.execPath, '--eval', code, file, repository], {
        env: { PATH: process.env['PATH'] ?? '', HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    try {
      for (const child of children) {
        expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      }
      expect(
        store
          .list()
          .map((r) => r.repository)
          .sort(),
      ).toEqual(repos.sort());
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.all(children.map((child) => child.exited));
    }
  }, 30000);

  test('waiting for a busy owner yields to timers, then writes when it releases', async () => {
    const main = repo('main');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        version: 1,
        ownerId: 'held',
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: Date.now(),
      }),
    );
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
      fs.unlinkSync(`${file}.lock`);
    }, 100);
    try {
      await store.remember(main, main);
      expect(ticked).toBe(true);
      expect(store.list()).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  });

  test('a dead stale owner is recovered, while unknown ownership stays untouched', async () => {
    const main = repo('main');
    fs.mkdirSync(path.dirname(file));
    const child = Bun.spawn([process.execPath, '--eval', ''], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await child.exited;
    fs.writeFileSync(
      `${file}.lock`,
      JSON.stringify({
        version: 1,
        ownerId: 'stale',
        pid: child.pid,
        host: os.hostname(),
        acquiredAt: Date.now() - 60000,
      }),
    );
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(`${file}.lock`, old, old);
    await store.remember(main, main);
    expect(store.list()).toHaveLength(1);
    fs.writeFileSync(`${file}.lock`, 'unknown-owner');
    await expect(store.remember(main, main)).rejects.toThrow('not valid JSON');
    expect(fs.readFileSync(`${file}.lock`, 'utf-8')).toBe('unknown-owner');
  });

  test('an asynchronous transaction releases ownership when its write throws', async () => {
    await expect(
      withInterprocessFileLockAsync(file, () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(await withInterprocessFileLockAsync(file, () => 'next writer')).toBe('next writer');
  });

  test('a live writer times out within the bound while the event loop stays responsive', async () => {
    const main = repo('main');
    fs.mkdirSync(path.dirname(file));
    const owner = JSON.stringify({
      version: 1,
      ownerId: 'live',
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: Date.now(),
    });
    fs.writeFileSync(`${file}.lock`, owner);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 50);
    const started = performance.now();
    try {
      await expect(store.remember(main, main)).rejects.toThrow('timed out');
      expect(performance.now() - started).toBeLessThan(3000);
      expect(ticks).toBeGreaterThan(5);
      expect(fs.readFileSync(`${file}.lock`, 'utf-8')).toBe(owner);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
