/**
 * Workspaces (#1236, ADR 0036): what a create request may ask of git, and the
 * worktree the hub makes for it.
 *
 * Every repository here is real, made with `git init` in a temporary directory,
 * and every check reads the result back from git or the file system. Paths are
 * compared through `realpathSync`: macOS's temporary directory is a symlink, and
 * git reports real paths.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseWorkspaceRequest,
  prepareWorkspace,
  worktreePath,
} from '../../src/workspace/worktree.ts';

/** Runs git for a test's own setup, failing loudly. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    {
      cwd,
      encoding: 'utf-8',
    },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one commit on `main`, at `<root>/<name>`. */
function makeRepo(root: string, name = 'project'): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export {};\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  return fs.realpathSync(repo);
}

const real = (p: string) => fs.realpathSync(p);

function parsed(input: unknown) {
  const result = parseWorkspaceRequest(input);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.workspace;
}

function refused(input: unknown): string {
  const result = parseWorkspaceRequest(input);
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.workspace)}`);
  return result.error;
}

describe('parseWorkspaceRequest: the values off the wire, before git runs (#1236)', () => {
  test('a repository alone, absolute or under ~, is accepted and resolved', () => {
    expect(parsed({ repository: '/Users/someone/project' })).toEqual({
      repository: '/Users/someone/project',
    });
    expect(parsed({ repository: '~/project' }).repository).toBe(path.join(os.homedir(), 'project'));
    expect(parsed({ repository: '/a/b/../c/' }).repository).toBe('/a/c');
  });

  test('a worktree names a branch and optionally a base', () => {
    expect(parsed({ repository: '/r', worktree: { branch: 'feature/x' } })).toEqual({
      repository: '/r',
      worktree: { branch: 'feature/x' },
    });
    expect(parsed({ repository: '/r', worktree: { branch: 'b', base: 'v1.0' } })).toEqual({
      repository: '/r',
      worktree: { branch: 'b', base: 'v1.0' },
    });
  });

  test('anything that is not a workspace object is refused', () => {
    for (const input of [null, 'repo', 5, [], ['/r'], true]) {
      expect(refused(input)).toContain('Invalid workspace');
    }
  });

  test('a repository that is missing, not text, relative, a flag or holds a control character is refused', () => {
    for (const repository of [
      undefined,
      '',
      '   ',
      7,
      null,
      ['/r'],
      'project',
      './project',
      '../project',
      '-c',
      '--upload-pack=x',
      '/r\u0000x',
      '/r\nx',
      '/r\u001b[2K',
      '/r\u009bx',
    ]) {
      expect(refused({ repository }), JSON.stringify(repository)).toContain('Invalid workspace');
    }
  });

  test('a worktree that is not an object, or whose branch or base is not plain text, is refused', () => {
    for (const worktree of [
      null,
      'b',
      [],
      {},
      { branch: '' },
      { branch: 7 },
      { branch: '-b' },
      { branch: '--orphan' },
      { branch: 'a\nb' },
      { branch: 'a\u0000' },
      { branch: 'x'.repeat(201) },
      { branch: '@{-1}' },
      { branch: 'a@{u}' },
      { branch: 'b', base: 7 },
      { branch: 'b', base: '' },
      { branch: 'b', base: '-x' },
      { branch: 'b', base: '--all' },
      { branch: 'b', base: 'main\n' },
      { branch: 'b', base: 'y'.repeat(201) },
    ]) {
      expect(refused({ repository: '/r', worktree }), JSON.stringify(worktree)).toContain(
        'Invalid workspace',
      );
    }
  });

  test('a branch of exactly 200 characters is accepted', () => {
    expect(parsed({ repository: '/r', worktree: { branch: 'x'.repeat(200) } }).worktree).toEqual({
      branch: 'x'.repeat(200),
    });
  });
});

describe('worktreePath: the layout next to the repository (#1236, owner decision #1233)', () => {
  test('<parent>/remi-worktrees/<name>-<branch>, with every / in the branch a -', () => {
    expect(worktreePath('/x/project', 'fix')).toBe('/x/remi-worktrees/project-fix');
    expect(worktreePath('/x/project', 'feature/a/b')).toBe('/x/remi-worktrees/project-feature-a-b');
  });
});

describe('prepareWorkspace against real repositories (#1236)', () => {
  let root: string;
  let savedGitDir: string | undefined;

  beforeEach(() => {
    root = real(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-workspace-')));
    savedGitDir = process.env['GIT_DIR'];
  });

  afterEach(() => {
    if (savedGitDir === undefined) Reflect.deleteProperty(process.env, 'GIT_DIR');
    else process.env['GIT_DIR'] = savedGitDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function ok(input: unknown) {
    const result = await prepareWorkspace(parsed(input));
    if (!result.ok) throw new Error(`refused: ${result.error} (${result.detail})`);
    return result.workspace;
  }

  async function no(input: unknown): Promise<string> {
    const result = await prepareWorkspace(parsed(input));
    if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.workspace)}`);
    return result.error;
  }

  test('without a worktree, the session starts in the main worktree', async () => {
    const repo = makeRepo(root);
    expect(await ok({ repository: repo })).toEqual({ repository: repo, directory: repo });
  });

  test('a directory inside the repository names the repository', async () => {
    const repo = makeRepo(root);
    expect(await ok({ repository: path.join(repo, 'src') })).toEqual({
      repository: repo,
      directory: repo,
    });
  });

  test('a new worktree on a new branch, from HEAD, next to the repository', async () => {
    const repo = makeRepo(root);
    const head = git(repo, 'rev-parse', 'HEAD');
    const workspace = await ok({ repository: repo, worktree: { branch: 'feature/login' } });
    const expected = path.join(root, 'remi-worktrees', 'project-feature-login');
    expect(workspace).toEqual({
      repository: repo,
      directory: expected,
      worktree: { branch: 'feature/login', base: head },
    });
    expect(git(expected, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login');
    expect(git(expected, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(expected, 'README.md'), 'utf-8')).toBe('hello\n');
    // The main worktree is untouched.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  test('a base names the commit the worktree starts from, and the response records it', async () => {
    const repo = makeRepo(root);
    const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'tag', 'v1');
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    git(repo, 'commit', '-q', '-am', 'second');
    for (const [branch, base] of [
      ['from-tag', 'v1'],
      ['from-sha', first],
      ['from-short-sha', first.slice(0, 8)],
      ['from-rev', 'HEAD~1'],
    ] as const) {
      const workspace = await ok({ repository: repo, worktree: { branch, base } });
      expect(workspace.worktree, base).toEqual({ branch, base: first });
      expect(git(workspace.directory, 'rev-parse', 'HEAD'), base).toBe(first);
    }
  });

  test('a base that names no commit is refused, and nothing is created', async () => {
    const repo = makeRepo(root);
    for (const base of ['no-such-ref', 'HEAD~5', 'v9', 'main:README.md']) {
      expect(await no({ repository: repo, worktree: { branch: 'b', base } }), base).toContain(
        'That base was not found',
      );
    }
    expect(fs.existsSync(path.join(root, 'remi-worktrees'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'b')).toBe('');
  });

  test('a branch name git refuses is refused, and nothing is created', async () => {
    const repo = makeRepo(root);
    for (const branch of ['a..b', 'a b', 'x.lock', 'ends/', 'a~1', 'a:b', 'a?b', 'HEAD']) {
      expect(await no({ repository: repo, worktree: { branch } }), branch).toContain(
        'That branch name is not valid',
      );
    }
    expect(fs.existsSync(path.join(root, 'remi-worktrees'))).toBe(false);
  });

  test('a branch that already exists is refused: phase A makes new branches only', async () => {
    const repo = makeRepo(root);
    git(repo, 'branch', 'taken');
    expect(await no({ repository: repo, worktree: { branch: 'taken' } })).toContain(
      'That branch already exists',
    );
    expect(await no({ repository: repo, worktree: { branch: 'main' } })).toContain(
      'That branch already exists',
    );
    expect(fs.existsSync(path.join(root, 'remi-worktrees'))).toBe(false);
  });

  test('a target directory that already exists is refused, and no branch is created', async () => {
    const repo = makeRepo(root);
    const target = path.join(root, 'remi-worktrees', 'project-busy');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'mine\n');
    expect(await no({ repository: repo, worktree: { branch: 'busy' } })).toContain(
      'already exists on the host',
    );
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('mine\n');
    expect(git(repo, 'branch', '--list', 'busy')).toBe('');
  });

  test('a repository named through one of its linked worktrees still gets its worktree next to the main one', async () => {
    const repo = makeRepo(root);
    const first = await ok({ repository: repo, worktree: { branch: 'one' } });
    const second = await ok({ repository: first.directory, worktree: { branch: 'two' } });
    expect(second.repository).toBe(repo);
    expect(second.directory).toBe(path.join(root, 'remi-worktrees', 'project-two'));
    // Without a worktree, a linked worktree names the main one too.
    expect(await ok({ repository: first.directory })).toEqual({
      repository: repo,
      directory: repo,
    });
  });

  test('a path that is not a directory is refused as not found', async () => {
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    for (const repository of [path.join(root, 'missing'), file]) {
      expect(await no({ repository })).toContain('That repository was not found');
    }
  });

  test('a directory outside any repository is refused', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await no({ repository: plain })).toContain('not in a git repository');
  });

  test('a bare repository is refused: it has no worktree to start in', async () => {
    const bare = path.join(root, 'bare.git');
    git(root, 'init', '-q', '--bare', bare);
    expect(await no({ repository: bare })).toContain('bare');
    expect(await no({ repository: bare, worktree: { branch: 'b' } })).toContain('bare');
  });

  test('a repository with no commit has no base to start a worktree from', async () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'main');
    expect(await no({ repository: empty, worktree: { branch: 'b' } })).toContain(
      'That base was not found',
    );
    // A session in it needs no commit.
    expect(await ok({ repository: empty })).toEqual({
      repository: real(empty),
      directory: real(empty),
    });
  });

  test("the hub's own GIT_DIR does not redirect git to another repository", async () => {
    const repo = makeRepo(root, 'wanted');
    const other = makeRepo(root, 'other');
    process.env['GIT_DIR'] = path.join(other, '.git');
    const workspace = await ok({ repository: repo, worktree: { branch: 'b' } });
    expect(workspace.repository).toBe(repo);
    expect(workspace.directory).toBe(path.join(root, 'remi-worktrees', 'wanted-b'));
    Reflect.deleteProperty(process.env, 'GIT_DIR');
    expect(git(other, 'branch', '--list', 'b')).toBe('');
    expect(git(repo, 'branch', '--list', 'b')).toContain('b');
  });

  test('a refusal says nothing the client did not send; the detail is for the log', async () => {
    const repo = makeRepo(root);
    git(repo, 'branch', 'taken');
    const result = await prepareWorkspace(
      parsed({ repository: repo, worktree: { branch: 'taken' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(root);
    expect(result.detail).toContain('taken');
  });
});
