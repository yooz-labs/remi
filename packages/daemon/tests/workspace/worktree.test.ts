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
  refusalForWorktreeList,
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

  test('a worktree made from a submodule lands next to the submodule, never inside .git (#1276 review)', async () => {
    const lib = makeRepo(root, 'lib');
    const sup = makeRepo(root, 'super');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libsub');
    const sub = path.join(sup, 'libsub');
    const workspace = await ok({ repository: sub, worktree: { branch: 'feat' } });
    expect(workspace.repository).toBe(sub);
    expect(workspace.directory).toBe(path.join(sup, 'remi-worktrees', 'libsub-feat'));
    expect(workspace.directory).not.toContain(`${path.sep}.git${path.sep}`);
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

  /** A hook in `repo`, executable, whose body is `script`. */
  function hook(repo: string, name: string, script: string): void {
    const file = path.join(repo, '.git', 'hooks', name);
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
    fs.chmodSync(file, 0o755);
  }

  test('two requests whose branches map to one directory, at once: one intact worktree, one refusal (#1270 review)', async () => {
    const repo = makeRepo(root);
    for (let i = 0; i < 10; i++) {
      const a = `c${i}/b`;
      const b = `c${i}-b`;
      const [first, second] = await Promise.all([
        prepareWorkspace(parsed({ repository: repo, worktree: { branch: a } })),
        prepareWorkspace(parsed({ repository: repo, worktree: { branch: b } })),
      ]);
      const won = [first, second].filter((r) => r.ok);
      const lost = [first, second].filter((r) => !r.ok);
      expect(won.length, `round ${i}`).toBe(1);
      expect(lost.length, `round ${i}`).toBe(1);
      const winner = won[0] as Extract<typeof first, { ok: true }>;
      const loser = lost[0] as Extract<typeof first, { ok: false }>;
      expect(loser.error, `round ${i}`).toContain('already exists on the host');
      const branch = winner.workspace.worktree?.branch as string;
      expect(
        git(winner.workspace.directory, 'rev-parse', '--abbrev-ref', 'HEAD'),
        `round ${i}`,
      ).toBe(branch);
      // The loser made no branch.
      const other = branch === a ? b : a;
      expect(git(repo, 'branch', '--list', other), `round ${i}`).toBe('');
    }
  }, 60000);

  test('three requests for one branch, at once: exactly one wins', async () => {
    const repo = makeRepo(root);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        prepareWorkspace(parsed({ repository: repo, worktree: { branch: 'same' } })),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const dir = path.join(root, 'remi-worktrees', 'project-same');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('same');
  });

  test('the time limit holds even when a hook outlives git: the call returns, and the hook is ended', async () => {
    const repo = makeRepo(root);
    const pidFile = path.join(root, 'hook.pid');
    hook(repo, 'post-checkout', `echo $$ > '${pidFile}'; sleep 30`);
    const started = Date.now();
    const result = await prepareWorkspace(
      parsed({ repository: repo, worktree: { branch: 'slow' } }),
      {
        timeoutMs: 3000,
      },
    );
    expect(Date.now() - started).toBeLessThan(10000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('took too long');
    expect(result.detail).toContain('timed out');
    // The hook ran in git's process group, which was ended: after the grace period it is gone.
    const hookPid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    await Bun.sleep(2500);
    expect(() => process.kill(hookPid, 0)).toThrow();
  }, 20000);

  test('a hook that fails after the worktree is made: the worktree is used, with a notice', async () => {
    const repo = makeRepo(root);
    hook(repo, 'post-checkout', 'echo "hook says no" >&2; exit 1');
    const result = await prepareWorkspace(
      parsed({ repository: repo, worktree: { branch: 'hooked' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dir = path.join(root, 'remi-worktrees', 'project-hooked');
    expect(result.workspace.directory).toBe(dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('hooked');
    expect(result.notice).toContain('hook');
    expect(result.notice).not.toContain(root);
    expect(result.detail).toContain('hook says no');
  });

  test('a name too long for a directory is refused before git runs: no branch is made', async () => {
    const repo = makeRepo(root, 'r'.repeat(60));
    const branch = 'b'.repeat(200);
    expect(await no({ repository: repo, worktree: { branch } })).toContain('too long');
    expect(git(repo, 'branch', '--list', branch)).toBe('');
  });

  test('a failed add that made nothing: the empty claim is removed, and no branch stays', async () => {
    const repo = makeRepo(root);
    // A stale ref lock makes git fail before it creates anything.
    fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'locked.lock'), '');
    const result = await prepareWorkspace(
      parsed({ repository: repo, worktree: { branch: 'locked' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "git could not create the worktree; the host's remi log has the reason.",
    );
    expect(result.detail).toContain('removed the empty claim');
    expect(fs.existsSync(path.join(root, 'remi-worktrees', 'project-locked'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'locked')).toBe('');
  });

  test('a failed add that made the branch: the refusal says the branch stays', async () => {
    const repo = makeRepo(root);
    // git makes the branch first, then fails to record the worktree.
    const meta = path.join(repo, '.git', 'worktrees');
    fs.mkdirSync(meta);
    fs.chmodSync(meta, 0o500);
    try {
      const result = await prepareWorkspace(
        parsed({ repository: repo, worktree: { branch: 'kept' } }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('the branch it made stays');
      expect(result.detail).toContain('the branch kept stays');
      expect(git(repo, 'branch', '--list', 'kept')).toContain('kept');
      expect(fs.existsSync(path.join(root, 'remi-worktrees', 'project-kept'))).toBe(false);
    } finally {
      fs.chmodSync(meta, 0o700);
    }
  });

  test('a branch that is a prefix of an existing one, or the other way round, is refused by name', async () => {
    const repo = makeRepo(root);
    git(repo, 'branch', 'feature');
    git(repo, 'branch', 'fix/deep');
    expect(await no({ repository: repo, worktree: { branch: 'feature/login' } })).toContain(
      'conflicts with an existing branch',
    );
    expect(await no({ repository: repo, worktree: { branch: 'fix' } })).toContain(
      'conflicts with an existing branch',
    );
    expect(fs.existsSync(path.join(root, 'remi-worktrees'))).toBe(false);
  });

  test('a branch or base with a bidi or invisible character is refused as text', () => {
    for (const worktree of [{ branch: 'x‮y' }, { branch: 'a​b' }, { branch: 'b', base: 'main⁦' }]) {
      expect(refused({ repository: '/r', worktree }), JSON.stringify(worktree)).toContain(
        'Invalid workspace',
      );
    }
  });

  test('a lone surrogate passes the text check and git refuses it', async () => {
    const repo = makeRepo(root);
    expect(await no({ repository: repo, worktree: { branch: 'a\ud800b' } })).toContain(
      'That branch name is not valid',
    );
  });

  test('a main worktree whose path holds a control character is refused, even when named through a linked worktree', async () => {
    const odd = makeRepo(root, 'new\nline');
    const linked = path.join(root, 'linked');
    git(odd, 'worktree', 'add', '-q', '-b', 'linked', linked);
    expect(await no({ repository: real(linked) })).toContain('cannot be used');
    expect(await no({ repository: real(linked), worktree: { branch: 'b' } })).toContain(
      'cannot be used',
    );
  });

  test('a detached HEAD is a base like any other commit', async () => {
    const repo = makeRepo(root);
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '--detach');
    const workspace = await ok({ repository: repo, worktree: { branch: 'from-detached' } });
    expect(workspace.worktree).toEqual({ branch: 'from-detached', base: head });
  });

  test("remi's secrets never reach git or its hooks", async () => {
    const repo = makeRepo(root);
    const envFile = path.join(root, 'hook-env.txt');
    hook(repo, 'post-checkout', `env > '${envFile}'`);
    const saved = process.env['REMI_PASSPHRASE'];
    process.env['REMI_PASSPHRASE'] = 'secret-test-value';
    try {
      await ok({ repository: repo, worktree: { branch: 'env' } });
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'REMI_PASSPHRASE');
      else process.env['REMI_PASSPHRASE'] = saved;
    }
    const env = fs.readFileSync(envFile, 'utf-8');
    expect(env).not.toContain('secret-test-value');
    expect(env).toContain('GIT_TERMINAL_PROMPT=0');
  });

  test("the repository's fsmonitor command does not run", async () => {
    const repo = makeRepo(root);
    const marker = path.join(root, 'fsmonitor-ran');
    const script = path.join(root, 'fsmonitor.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(script, 0o755);
    git(repo, 'config', 'core.fsmonitor', script);
    await ok({ repository: repo, worktree: { branch: 'monitored' } });
    expect(fs.existsSync(marker)).toBe(false);
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

describe('refusalForWorktreeList: what a failed worktree list means (#1270 review)', () => {
  const result = (code: number, stderr: string, timedOut = false) => ({
    code,
    stdout: '',
    stderr,
    timedOut,
  });

  test('git older than 2.36 (no -z) is named as too old, not as "not a repository"', () => {
    expect(refusalForWorktreeList(result(129, "error: unknown switch `z'"))).toContain('too old');
  });

  test('a repository git does not trust is named as such', () => {
    expect(
      refusalForWorktreeList(
        result(128, "fatal: detected dubious ownership in repository at '/x'"),
      ),
    ).toContain('does not trust');
  });

  test('a timeout says the request took too long', () => {
    expect(refusalForWorktreeList(result(-1, 'timed out', true))).toContain('took too long');
  });

  test('anything else is "not in a git repository"', () => {
    expect(refusalForWorktreeList(result(128, 'fatal: not a git repository'))).toContain(
      'not in a git repository',
    );
  });
});
