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
import { WorkspaceCache, describeWorkspace } from '../../src/workspace/describe.ts';

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
  });
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
