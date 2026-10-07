/**
 * Workspaces (#1236, ADR 0036): a session in a new git worktree the hub creates.
 *
 * The native Mac app is sandboxed and never runs git, so a create request names a
 * repository and, optionally, a new branch, and the hub makes the worktree. Every
 * value comes off the wire, so it is checked twice: as plain text before git runs
 * ({@link parseWorkspaceRequest}), then by git itself ({@link prepareWorkspace}).
 *
 * Git runs as an argument vector, never through a shell, with no standard input,
 * no terminal prompt, a time limit, and an environment without remi's secrets or
 * any `GIT_*` variable the hub inherited (a `GIT_DIR` would point every command at
 * another repository). The repository's own hooks still run, as they would for the
 * person at the machine.
 *
 * Owner decisions (#1233): worktrees live in `../remi-worktrees` next to the
 * repository, and nothing deletes one (cleanup is undecided).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionWorkspace } from '@remi/shared';
import { escapeUnsafeText } from '@remi/shared';
import { normalizeProjectPath } from '../cli/path-resolver.ts';
import { withoutRemiSecrets } from '../pty/child-env.ts';

/** A workspace request whose values are plain text, with the repository resolved. */
export interface ParsedWorkspace {
  readonly repository: string;
  readonly worktree?: { readonly branch: string; readonly base?: string };
}

/** What the client is told. Each names nothing the client did not send; the log has the detail. */
const TEXT = {
  invalid: 'Invalid workspace; the request was not started.',
  notFound: 'That repository was not found on the host; the request was not started.',
  notGit: 'That directory is not in a git repository on the host; the request was not started.',
  bare: 'That repository is bare (it has no working tree); the request was not started.',
  noGit: 'git is not available on the host; the request was not started.',
  badBranch: 'That branch name is not valid in git; the request was not started.',
  branchExists: 'That branch already exists in the repository; the request was not started.',
  badBase: 'That base was not found in the repository; the request was not started.',
  targetExists:
    'A directory for that worktree already exists on the host; the request was not started.',
  addFailed: "git could not create the worktree; the host's remi log has the reason.",
} as const;

/** The longest branch or base accepted, in UTF-16 units. */
const MAX_REF_TEXT = 200;
/** How long one git command may run. A checkout of a large repository takes a while. */
const GIT_TIMEOUT_MS = 60_000;
/** How much of git's stderr goes into the log detail. */
const MAX_DETAIL = 500;

/** Any C0 control, DEL or C1 control: none belongs in a path, a branch or a revision. */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** A branch or base as plain text: present, bounded, not a flag, no control character. */
function isRefText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REF_TEXT &&
    !value.startsWith('-') &&
    !hasControl(value)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The workspace a request names, checked as text before anything runs. The repository must be
 * absolute or under `~` (relative to what? the hub's working directory is an accident of how it
 * was started), and a branch may not use `@{`, which `git check-ref-format --branch` would expand
 * to another branch's name.
 */
export function parseWorkspaceRequest(
  input: unknown,
): { ok: true; workspace: ParsedWorkspace } | { ok: false; error: string } {
  const invalid = { ok: false as const, error: TEXT.invalid };
  if (!isRecord(input)) return invalid;
  const { repository, worktree } = input;
  if (typeof repository !== 'string' || hasControl(repository)) return invalid;
  const trimmed = repository.trim();
  if (!(trimmed.startsWith('/') || trimmed === '~' || trimmed.startsWith('~/'))) return invalid;
  const resolved = normalizeProjectPath(trimmed);
  if (worktree === undefined) return { ok: true, workspace: { repository: resolved } };

  if (!isRecord(worktree)) return invalid;
  const { branch, base } = worktree;
  if (!isRefText(branch) || branch.includes('@{')) return invalid;
  if (base !== undefined && !isRefText(base)) return invalid;
  return {
    ok: true,
    workspace: {
      repository: resolved,
      worktree: { branch, ...(base !== undefined && { base }) },
    },
  };
}

/** Where a new worktree goes: `<parent>/remi-worktrees/<name>-<branch>`, every `/` a `-`. */
export function worktreePath(mainWorktree: string, branch: string): string {
  return path.join(
    path.dirname(mainWorktree),
    'remi-worktrees',
    `${path.basename(mainWorktree)}-${branch.replaceAll('/', '-')}`,
  );
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The hub's environment for git: no remi secret, no inherited `GIT_*`, never a prompt. */
function gitEnv(): Record<string, string | undefined> {
  const env = withoutRemiSecrets(process.env);
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

async function runGit(git: string, cwd: string, args: readonly string[]): Promise<GitResult> {
  const proc = Bun.spawn([git, ...args], {
    cwd,
    env: gitEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** git's stderr for the log: escaped, on one line, cut. */
function detailOf(result: GitResult): string {
  const text = escapeUnsafeText(result.stderr.trim()).replaceAll('\n', ' | ');
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)} [cut]` : text;
}

type Prepared =
  | { ok: true; workspace: SessionWorkspace }
  | { ok: false; error: string; detail: string };

/**
 * Resolves the repository to its main worktree and, for a worktree request, makes the worktree
 * on a new branch from the base's commit. Refuses a bare or missing repository, a branch git
 * rejects or that exists, a base that names no commit, and a target directory that exists. On a
 * refusal nothing was created.
 */
export async function prepareWorkspace(parsed: ParsedWorkspace): Promise<Prepared> {
  const shown = escapeUnsafeText(parsed.repository);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(parsed.repository).isDirectory();
  } catch {
    // missing or unreadable: not found
  }
  if (!isDirectory) return { ok: false, error: TEXT.notFound, detail: `no directory ${shown}` };

  const git = Bun.which('git', { PATH: process.env['PATH'] ?? '' });
  if (git === null) return { ok: false, error: TEXT.noGit, detail: 'no git on the PATH' };

  // The first entry of the worktree list is the main worktree, whichever directory was named.
  const list = await runGit(git, parsed.repository, ['worktree', 'list', '--porcelain', '-z']);
  if (list.code !== 0) {
    return { ok: false, error: TEXT.notGit, detail: `${shown}: ${detailOf(list)}` };
  }
  const first = list.stdout.split('\0\0')[0]?.split('\0') ?? [];
  const head = first[0] ?? '';
  if (!head.startsWith('worktree ')) {
    return { ok: false, error: TEXT.notGit, detail: `${shown}: no worktree in git's list` };
  }
  if (first.includes('bare')) {
    return { ok: false, error: TEXT.bare, detail: `${shown} is a bare repository` };
  }
  const main = head.slice('worktree '.length);
  if (parsed.worktree === undefined) {
    return { ok: true, workspace: { repository: main, directory: main } };
  }

  const { branch, base } = parsed.worktree;
  const shownBranch = escapeUnsafeText(branch);
  const checked = await runGit(git, main, ['check-ref-format', '--branch', branch]);
  if (checked.code !== 0 || checked.stdout.trim() !== branch) {
    return {
      ok: false,
      error: TEXT.badBranch,
      detail: `branch ${shownBranch}: ${detailOf(checked)}`,
    };
  }
  const existing = await runGit(git, main, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (existing.code === 0) {
    return {
      ok: false,
      error: TEXT.branchExists,
      detail: `branch ${shownBranch} exists in ${shown}`,
    };
  }
  const revision = base ?? 'HEAD';
  const resolved = await runGit(git, main, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${revision}^{commit}`,
  ]);
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
    return {
      ok: false,
      error: TEXT.badBase,
      detail: `base ${escapeUnsafeText(revision)} names no commit in ${shown}`,
    };
  }

  const target = worktreePath(main, branch);
  let taken = true;
  try {
    fs.lstatSync(target);
  } catch {
    taken = false;
  }
  if (taken) {
    return {
      ok: false,
      error: TEXT.targetExists,
      detail: `${escapeUnsafeText(target)} exists`,
    };
  }

  const added = await runGit(git, main, ['worktree', 'add', '-b', branch, target, commit]);
  if (added.code !== 0) {
    return {
      ok: false,
      error: TEXT.addFailed,
      detail: `git worktree add ${escapeUnsafeText(target)}: ${detailOf(added)}`,
    };
  }
  return {
    ok: true,
    workspace: { repository: main, directory: target, worktree: { branch, base: commit } },
  };
}
