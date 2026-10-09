/**
 * The workspace a session runs in (#1236 phase B, ADR 0036): what git says about the session's
 * directory, and the cache the session list reads it from without waiting on git.
 *
 * Every repository is real, made with `git init` in a temporary directory. Paths are compared
 * through `realpathSync`: macOS's temporary directory is a symlink, and git reports real paths.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceCache, describeWorkspace, readWorkspace } from '../../src/workspace/describe.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(root: string, name = 'project'): string {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  return fs.realpathSync(repo);
}

describe('describeWorkspace: what git says about a session directory (#1236 phase B)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-describe-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the main worktree, on its branch', async () => {
    const repo = makeRepo(root);
    expect(await describeWorkspace(repo)).toEqual({
      repository: repo,
      directory: repo,
      branch: 'main',
    });
  });

  test('a directory inside it names the worktree it is in', async () => {
    const repo = makeRepo(root);
    expect(await describeWorkspace(path.join(repo, 'src'))).toEqual({
      repository: repo,
      directory: repo,
      branch: 'main',
    });
  });

  test('a linked worktree names its main repository and its own branch', async () => {
    const repo = makeRepo(root);
    const linked = path.join(root, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', linked);
    expect(await describeWorkspace(linked)).toEqual({
      repository: repo,
      directory: fs.realpathSync(linked),
      branch: 'feature/x',
    });
  });

  test('a detached HEAD has no branch', async () => {
    const repo = makeRepo(root);
    git(repo, 'checkout', '-q', '--detach');
    expect(await describeWorkspace(repo)).toEqual({
      repository: repo,
      directory: repo,
      branch: null,
    });
  });

  test('a repository with no commit yet still names its branch', async () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'trunk');
    const real = fs.realpathSync(empty);
    expect(await describeWorkspace(real)).toEqual({
      repository: real,
      directory: real,
      branch: 'trunk',
    });
  });

  test('a directory outside any repository, or one that does not exist, has no workspace', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await describeWorkspace(plain)).toBeNull();
    expect(await describeWorkspace(path.join(root, 'missing'))).toBeNull();
  });

  test('a worktree whose path holds a control character is not described', async () => {
    const odd = makeRepo(root, 'new\nline');
    expect(await describeWorkspace(odd)).toBeNull();
    // Not described is an answer, not "git could not answer": nothing is kept or logged as unknown.
    expect(await readWorkspace(odd)).toBeNull();
  });
});

describe('describeWorkspace: repository shapes and names (#1276 review)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-describe-shapes-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a branch that shares its name with a tag is named as the branch, not heads/<name>', async () => {
    const repo = makeRepo(root);
    git(repo, 'checkout', '-q', '-b', 'tagged');
    git(repo, 'tag', 'tagged');
    expect((await describeWorkspace(repo))?.branch).toBe('tagged');
  });

  test('a submodule is its own repository, not its git directory under the superproject', async () => {
    const lib = makeRepo(root, 'lib');
    const sup = makeRepo(root, 'super');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libsub');
    const sub = path.join(sup, 'libsub');
    const described = await describeWorkspace(sub);
    expect(described?.repository).toBe(sub);
    expect(described?.directory).toBe(sub);
  });

  test('a checkout with a separate git directory is its own repository', async () => {
    const sep = path.join(root, 'sep');
    const gitdir = path.join(root, 'sep.gitdir');
    fs.mkdirSync(sep);
    git(root, 'init', '-q', '-b', 'main', `--separate-git-dir=${gitdir}`, sep);
    const described = await describeWorkspace(sep);
    expect(described).toEqual({
      repository: fs.realpathSync(sep),
      directory: fs.realpathSync(sep),
      branch: 'main',
    });
  });

  test('a linked worktree of a bare repository names the bare repository', async () => {
    const seed = makeRepo(root, 'seed');
    const bare = path.join(root, 'bare.git');
    git(root, 'clone', '-q', '--bare', seed, bare);
    const linked = path.join(root, 'from-bare');
    git(bare, 'worktree', 'add', '-q', '-b', 'work', linked);
    expect(await describeWorkspace(linked)).toEqual({
      repository: fs.realpathSync(bare),
      directory: fs.realpathSync(linked),
      branch: 'work',
    });
  });

  test('a path that ends in a space keeps it', async () => {
    const repo = makeRepo(root, 'trailing ');
    expect(await describeWorkspace(repo)).toEqual({
      repository: repo,
      directory: repo,
      branch: 'main',
    });
  });

  test('a branch with a bidi or invisible character is not described: it would reach clients as text', async () => {
    const repo = makeRepo(root);
    git(repo, 'checkout', '-q', '-b', 'fix/a‮cod.exe');
    expect(await describeWorkspace(repo)).toBeNull();
  });

  test('a session directory inside .git has no workspace', async () => {
    const repo = makeRepo(root);
    expect(await describeWorkspace(path.join(repo, '.git'))).toBeNull();
  });
});

describe('WorkspaceCache keeps the last answer when git cannot answer (#1276 review)', () => {
  let root: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-wscache-hang-')));
    savedPath = process.env['PATH'];
  });

  afterEach(() => {
    process.env['PATH'] = savedPath ?? '';
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a read that times out keeps the previous workspace, and says why once', async () => {
    const repo = makeRepo(root);
    let clock = 1_000_000;
    const logged: string[] = [];
    const cache = new WorkspaceCache({
      ttlMs: 10_000,
      now: () => clock,
      timeoutMs: 500,
      log: (line) => logged.push(line),
    });
    cache.get(repo);
    await cache.settled(repo);
    expect(cache.get(repo)?.branch).toBe('main');
    // A git that never answers stands first on the PATH.
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 30\n');
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
    for (let i = 0; i < 2; i++) {
      clock += 11_000;
      cache.get(repo);
      await cache.settled(repo);
      expect(cache.get(repo)).toEqual({ repository: repo, directory: repo, branch: 'main' });
    }
    expect(logged.filter((l) => l.includes('timed out'))).toHaveLength(1);
  }, 20000);
});

describe('WorkspaceCache: the session list never waits on git (#1236 phase B)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-wscache-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the first read has nothing and starts git; once it answers, reads return it', async () => {
    const repo = makeRepo(root);
    const cache = new WorkspaceCache();
    expect(cache.get(repo)).toBeUndefined();
    await cache.settled(repo);
    expect(cache.get(repo)).toEqual({ repository: repo, directory: repo, branch: 'main' });
  });

  test('a branch switch shows once the entry is older than its lifetime', async () => {
    const repo = makeRepo(root);
    let clock = 1_000_000;
    const cache = new WorkspaceCache({ ttlMs: 10_000, now: () => clock });
    cache.get(repo);
    await cache.settled(repo);
    git(repo, 'checkout', '-q', '-b', 'other');
    // Still fresh: the old answer, and no new read.
    clock += 5_000;
    expect(cache.get(repo)?.branch).toBe('main');
    await cache.settled(repo);
    expect(cache.get(repo)?.branch).toBe('main');
    // Stale: the old answer once more, and a new read behind it.
    clock += 6_000;
    expect(cache.get(repo)?.branch).toBe('main');
    await cache.settled(repo);
    expect(cache.get(repo)?.branch).toBe('other');
  });

  test('a directory outside any repository reads as none, and stays none', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const cache = new WorkspaceCache();
    cache.get(plain);
    await cache.settled(plain);
    expect(cache.get(plain)).toBeUndefined();
  });

  test('reads while git runs start one read, not one per call', async () => {
    const repo = makeRepo(root);
    const cache = new WorkspaceCache();
    for (let i = 0; i < 5; i++) cache.get(repo);
    expect(cache.readsStarted()).toBe(1);
    expect(cache.inFlight()).toBe(1);
    await cache.settled(repo);
    expect(cache.inFlight()).toBe(0);
    // Fresh now: more reads cost nothing.
    for (let i = 0; i < 5; i++) cache.get(repo);
    expect(cache.readsStarted()).toBe(1);
  });
});
