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
import { recentRepositories } from '../../src/workspace/recent.ts';

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

/** A session record the way the store keeps one: where it ran, and when it started. */
const at = (projectPath: string, startedAt: string) => ({ projectPath, startedAt });

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

  test('at most `limit` repositories, and a limit out of range falls back to ten, never more than twenty', async () => {
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
});
