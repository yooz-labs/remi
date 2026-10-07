/**
 * Recent repositories (#1236 phase C, ADR 0036): the repositories of the machine's recent
 * sessions, main worktrees only, most recent first, for a client's "new session in repository X".
 * Every repository is real, made with `git init`; paths are compared through `realpathSync`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  recentRepositories,
  recentRepositoriesReport,
  repositoryName,
} from '../../src/workspace/recent.ts';

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function makeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  return fs.realpathSync(repo);
}

/** A session that ran in `projectPath` and ended at `lastAt` (started an hour before). */
const at = (projectPath: string, lastAt: string) => ({
  projectPath,
  startedAt: new Date(Date.parse(lastAt) - 3_600_000).toISOString(),
  exitedAt: lastAt,
});
/** A session still running in `projectPath`, started at `startedAt`. */
const running = (projectPath: string, startedAt: string) => ({
  projectPath,
  startedAt,
  exitedAt: null,
});

/** A `git` on PATH that runs the real one for its first `realCalls` calls, then never answers. */
function stallingGit(root: string, realCalls: number): string {
  const real = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const counter = path.join(root, 'git-calls');
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '${counter}'\nif [ $n -le ${realCalls} ]; then exec '${real}' "$@"; fi\nsleep 30\n`,
  );
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return bin;
}

describe('recentRepositories (#1236 phase C)', () => {
  let root: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-recent-')));
    savedPath = process.env['PATH'];
  });

  afterEach(() => {
    process.env['PATH'] = savedPath ?? '';
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('main worktrees, most recent first, each once, with the time it was last used', async () => {
    const alpha = makeRepo(root, 'alpha');
    const beta = makeRepo(root, 'beta');
    const linked = path.join(root, 'alpha-feature');
    git(alpha, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const result = await recentRepositories([
      at(linked, '2026-10-07T12:00:00.000Z'),
      at(beta, '2026-10-07T11:00:00.000Z'),
      at(path.join(alpha, 'src'), '2026-10-07T10:00:00.000Z'),
      at(alpha, '2026-10-06T09:00:00.000Z'),
    ]);
    expect(result).toEqual([
      { repository: alpha, name: 'alpha', lastUsedAt: '2026-10-07T12:00:00.000Z' },
      { repository: beta, name: 'beta', lastUsedAt: '2026-10-07T11:00:00.000Z' },
    ]);
  });

  test('directories that are gone, outside any repository, or bare are left out', async () => {
    const alpha = makeRepo(root, 'alpha');
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const bare = path.join(root, 'bare.git');
    git(root, 'init', '-q', '--bare', bare);
    const result = await recentRepositories([
      at(path.join(root, 'missing'), '2026-10-07T13:00:00.000Z'),
      at(plain, '2026-10-07T12:00:00.000Z'),
      at(bare, '2026-10-07T11:00:00.000Z'),
      at(alpha, '2026-10-07T10:00:00.000Z'),
    ]);
    expect(result.map((r) => r.repository)).toEqual([alpha]);
  });

  test('a linked worktree of a bare repository is left out, as phase A refuses it', async () => {
    const seed = makeRepo(root, 'seed');
    const bare = path.join(root, 'bare.git');
    git(root, 'clone', '-q', '--bare', seed, bare);
    const linked = path.join(root, 'from-bare');
    git(bare, 'worktree', 'add', '-q', '-b', 'work', linked);
    expect(await recentRepositories([at(linked, '2026-10-07T10:00:00.000Z')])).toEqual([]);
  });

  test('a submodule is a repository of its own', async () => {
    const lib = makeRepo(root, 'lib');
    const sup = makeRepo(root, 'super');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libsub');
    const sub = path.join(sup, 'libsub');
    const result = await recentRepositories([at(sub, '2026-10-07T10:00:00.000Z')]);
    expect(result).toEqual([
      { repository: sub, name: 'libsub', lastUsedAt: '2026-10-07T10:00:00.000Z' },
    ]);
  });

  test('a repository whose path holds a bidi or control character is left out', async () => {
    const odd = makeRepo(root, 'mac‮evil');
    const fine = makeRepo(root, 'fine');
    const result = await recentRepositories([
      at(odd, '2026-10-07T11:00:00.000Z'),
      at(fine, '2026-10-07T10:00:00.000Z'),
    ]);
    expect(result.map((r) => r.repository)).toEqual([fine]);
  });

  test('at most `limit` repositories: above twenty is twenty; absent or anything else is ten', async () => {
    const repos: string[] = [];
    for (let i = 0; i < 25; i++) repos.push(makeRepo(root, `r${String(i).padStart(2, '0')}`));
    const sessions = repos.map((r, i) =>
      at(r, new Date(Date.UTC(2026, 9, 7, 0, 0, 0) - i * 60_000).toISOString()),
    );
    expect(await recentRepositories(sessions, { limit: 3 })).toHaveLength(3);
    expect(await recentRepositories(sessions)).toHaveLength(10);
    expect(await recentRepositories(sessions, { limit: 0 })).toHaveLength(10);
    expect(await recentRepositories(sessions, { limit: 500 })).toHaveLength(20);
    expect(await recentRepositories(sessions, { limit: 2.5 })).toHaveLength(10);
  }, 60000);

  test('a git that never answers ends the walk at the deadline with what it found', async () => {
    const alpha = makeRepo(root, 'alpha');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 30\n');
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
    const started = Date.now();
    const result = await recentRepositories([at(alpha, '2026-10-07T10:00:00.000Z')], {
      timeoutMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toEqual([]);
  }, 20000);

  test('at the deadline the walk returns what it found before git stopped answering', async () => {
    const alpha = makeRepo(root, 'alpha');
    const beta = makeRepo(root, 'beta');
    // A plain repository takes two git calls; the third (beta's first) never answers.
    process.env['PATH'] = `${stallingGit(root, 2)}:${savedPath ?? ''}`;
    const started = Date.now();
    const result = await recentRepositories(
      [at(alpha, '2026-10-07T11:00:00.000Z'), at(beta, '2026-10-07T10:00:00.000Z')],
      { timeoutMs: 1000 },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.map((r) => r.repository)).toEqual([alpha]);
  }, 20000);

  test('ten sessions whose git never answers end at one deadline, not one each', async () => {
    const sessions = [];
    for (let i = 0; i < 10; i++)
      sessions.push(at(makeRepo(root, `r${i}`), '2026-10-07T10:00:00.000Z'));
    process.env['PATH'] = `${stallingGit(root, 0)}:${savedPath ?? ''}`;
    const started = Date.now();
    expect(await recentRepositories(sessions, { timeoutMs: 500 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
  }, 30000);

  test.skipIf(process.getuid?.() === 0)(
    'one directory git cannot run in leaves the other repositories listed',
    async () => {
      const locked = makeRepo(root, 'locked');
      const fine = makeRepo(root, 'fine');
      fs.chmodSync(locked, 0o000);
      try {
        const result = await recentRepositories([
          at(locked, '2026-10-07T11:00:00.000Z'),
          at(fine, '2026-10-07T10:00:00.000Z'),
        ]);
        expect(result.map((r) => r.repository)).toEqual([fine]);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    },
  );

  test('a session path that is a file is left out', async () => {
    const fine = makeRepo(root, 'fine');
    const file = path.join(fine, 'README.md');
    const result = await recentRepositories([
      at(file, '2026-10-07T11:00:00.000Z'),
      at(fine, '2026-10-07T10:00:00.000Z'),
    ]);
    expect(result.map((r) => r.repository)).toEqual([fine]);
  });

  test('the same directory twice is looked up once and listed once, at its latest use', async () => {
    const fine = makeRepo(root, 'fine');
    const other = makeRepo(root, 'other');
    // A counting git: every call is the real one.
    process.env['PATH'] = `${stallingGit(root, 1000)}:${savedPath ?? ''}`;
    expect(
      await recentRepositories(
        [
          at(fine, '2026-10-07T11:00:00.000Z'),
          at(fine, '2026-10-07T10:00:00.000Z'),
          at(other, '2026-10-07T09:00:00.000Z'),
        ],
        { limit: 2 },
      ),
    ).toEqual([
      { repository: fine, name: 'fine', lastUsedAt: '2026-10-07T11:00:00.000Z' },
      { repository: other, name: 'other', lastUsedAt: '2026-10-07T09:00:00.000Z' },
    ]);
    // Two calls for each plain repository; the repeated directory costs none.
    expect(fs.readFileSync(path.join(root, 'git-calls'), 'utf-8').trim()).toBe('4');
  });

  test('a path holding a newline is left out, never cut short into another path', async () => {
    const plainRepo = makeRepo(root, 'proj\nsecond');
    const separate = path.join(root, 'sep\nother');
    fs.mkdirSync(separate);
    git(separate, 'init', '-q', '--separate-git-dir', path.join(root, 'sep.git'));
    const report = await recentRepositoriesReport([
      at(plainRepo, '2026-10-07T11:00:00.000Z'),
      at(separate, '2026-10-07T10:00:00.000Z'),
    ]);
    expect(report.repositories).toEqual([]);
    expect(report.skipped.unsafe).toBe(2);
    expect(report.skipped.unknown).toBe(0);
  });

  test('a machine without git says so in the report', async () => {
    const fine = makeRepo(root, 'fine');
    const empty = path.join(root, 'empty-bin');
    fs.mkdirSync(empty);
    process.env['PATH'] = empty;
    const report = await recentRepositoriesReport([at(fine, '2026-10-07T10:00:00.000Z')]);
    expect(report.repositories).toEqual([]);
    expect(report.noGit).toBe(true);
  });

  test('a lookup cut short by the deadline is reported as the deadline, even on the last session', async () => {
    const alpha = makeRepo(root, 'alpha');
    process.env['PATH'] = `${stallingGit(root, 0)}:${savedPath ?? ''}`;
    const report = await recentRepositoriesReport([at(alpha, '2026-10-07T10:00:00.000Z')], {
      timeoutMs: 300,
    });
    expect(report.timedOut).toBe(true);
  }, 20000);

  test('a repository at the root is named by its path', () => {
    expect(repositoryName('/')).toBe('/');
    expect(repositoryName('/Users/sam/project')).toBe('project');
  });

  test('a running session counts as used now, so it ranks above one that ended earlier', async () => {
    const old = makeRepo(root, 'old');
    const recent = makeRepo(root, 'recent');
    const now = Date.parse('2026-10-07T12:00:00.000Z');
    const result = await recentRepositories(
      [at(recent, '2026-10-07T11:00:00.000Z'), running(old, '2026-10-01T09:00:00.000Z')],
      { now: () => now },
    );
    expect(result).toEqual([
      { repository: old, name: 'old', lastUsedAt: '2026-10-07T12:00:00.000Z' },
      { repository: recent, name: 'recent', lastUsedAt: '2026-10-07T11:00:00.000Z' },
    ]);
  });
});
