/**
 * Workspaces (#1236, ADR 0036): a session in a new git worktree the hub creates.
 *
 * The native Mac app is sandboxed and never runs git, so a create request names a
 * repository and, optionally, a new branch, and the hub makes the worktree. Every
 * value comes off the wire, so it is checked twice: as plain text before git runs
 * ({@link parseWorkspaceRequest}), then by git itself ({@link prepareWorkspace}).
 *
 * Git runs as an argument vector, never through a shell, in a process group of its
 * own, with no standard input, no terminal prompt, `core.fsmonitor` off, and an
 * environment without remi's secrets or any `GIT_*` variable the hub inherited (a
 * `GIT_DIR` would point every command at another repository). One deadline covers
 * the whole preparation: when it passes, the group (git and its hooks and filters,
 * which hold the pipes open) is ended and the request refused. The repository's own
 * hooks and filter drivers still run, as they would for the person at the machine.
 *
 * The target directory is claimed with an exclusive `mkdir` before git runs, so two
 * requests whose branches map to one directory (`a/b`, `a-b`) cannot both reach
 * `git worktree add`: git's cleanup after a failed add would remove the other's
 * worktree.
 *
 * Owner decisions (#1233): worktrees live in `../remi-worktrees` next to the
 * repository, and nothing deletes one (cleanup is undecided). The one directory this
 * module removes is its own empty claim, when git made nothing in it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionWorkspace } from '@remi/shared';
import { errorToString, escapeUnsafeText } from '@remi/shared';
import { normalizeProjectPath } from '../cli/path-resolver.ts';
import { type GitResult, detailOf, findGit, hasControl, resolveRepository, runGit } from './git.ts';

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
  notTrusted:
    'git does not trust that repository on the host (it may belong to another user); the request was not started.',
  tooOld: 'git on the host is too old (remi needs git 2.36 or later); the request was not started.',
  unusablePath:
    "That repository's location on the host cannot be used for a session; the request was not started.",
  bare: 'That repository is bare (it has no working tree); the request was not started.',
  noGit: 'git is not available on the host; the request was not started.',
  badBranch: 'That branch name is not valid in git; the request was not started.',
  branchExists: 'That branch already exists in the repository; the request was not started.',
  branchConflict:
    'That branch name conflicts with an existing branch (one would be a folder of the other); the request was not started.',
  nameTooLong:
    'That branch name is too long for a directory on the host; the request was not started.',
  badBase: 'That base was not found in the repository; the request was not started.',
  targetExists:
    'A directory for that worktree already exists on the host; the request was not started.',
  timedOut:
    "git took too long on the host; the request was not started. The host's remi log says what it left.",
  addFailed: "git could not create the worktree; the host's remi log has the reason.",
  addFailedBranchKept:
    "git could not create the worktree, and the branch it made stays in the repository; the host's remi log has the reason.",
  hookNotice:
    "The worktree was made, but git reported an error after making it, most likely from a hook or filter in the repository; the host's remi log has it.",
} as const;

/** The longest branch or base accepted, in UTF-16 units. */
const MAX_REF_TEXT = 200;
/** How long the whole preparation may take. A checkout of a large repository takes a while. */
const DEFAULT_DEADLINE_MS = 60_000;
/** How long the checks after a failed `git worktree add` may take, on their own deadline. */
const INSPECT_MS = 10_000;

/**
 * A branch or base as plain text: present, bounded, not a flag, no control character, and nothing
 * `escapeUnsafeText` would write out (a bidi or invisible character would reach a client in
 * `workspace.directory` and in the branch name).
 */
function isRefText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REF_TEXT &&
    !value.startsWith('-') &&
    !hasControl(value) &&
    escapeUnsafeText(value) === value
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

/**
 * What a failed `git worktree list` means for the client: a timeout; git older than 2.36, which
 * has no `-z` and exits with its usage code, 129; a repository git refuses to read as another
 * user's (`safe.directory`); otherwise, not a repository.
 */
export function refusalForWorktreeList(result: GitResult): string {
  if (result.timedOut) return TEXT.timedOut;
  if (result.code === 129) return TEXT.tooOld;
  if (result.stderr.includes('dubious ownership')) return TEXT.notTrusted;
  return TEXT.notGit;
}

type Prepared =
  | {
      ok: true;
      workspace: SessionWorkspace;
      /** For the client: what a success does not say (a hook failed after the worktree was made). */
      notice?: string;
      /** For the log, with `notice`. */
      detail?: string;
    }
  | { ok: false; error: string; detail: string };

/**
 * Resolves the repository to its main worktree and, for a worktree request, makes the worktree
 * on a new branch from the base's commit. Refuses a bare or missing repository, a branch git
 * rejects, that exists or that conflicts with one, a base that names no commit, and a target that
 * exists or whose name is too long, all before anything is created. Past that, a failed
 * `git worktree add` is checked: a complete worktree on the branch is used, with a notice (a hook
 * failed after making it); otherwise the refusal says whether the branch stays, and the log says
 * what git left.
 */
export async function prepareWorkspace(
  parsed: ParsedWorkspace,
  options: { timeoutMs?: number } = {},
): Promise<Prepared> {
  const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_DEADLINE_MS);
  const shown = escapeUnsafeText(parsed.repository);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(parsed.repository).isDirectory();
  } catch {
    // missing or unreadable: not found
  }
  if (!isDirectory) return { ok: false, error: TEXT.notFound, detail: `no directory ${shown}` };

  const git = findGit();
  if (git === null) return { ok: false, error: TEXT.noGit, detail: 'no git on the PATH' };

  // The repository's main worktree, whichever directory was named (#1276 review: a submodule or a
  // separate git directory is its own repository; only a linked worktree reads the worktree list).
  const lookup = await resolveRepository(git, parsed.repository, deadlineAt);
  if (lookup.kind === 'unknown') {
    return {
      ok: false,
      error: refusalForWorktreeList(lookup.result),
      detail: `${shown}: ${detailOf(lookup.result)}`,
    };
  }
  if (lookup.kind === 'none') {
    return { ok: false, error: TEXT.notGit, detail: `${shown} is in no worktree of a repository` };
  }
  if (lookup.kind === 'bare' || lookup.mainIsBare) {
    return { ok: false, error: TEXT.bare, detail: `${shown} belongs to a bare repository` };
  }
  const main = lookup.repository;
  // The path becomes the child's `--dir` and reaches clients: fail closed, as for a requested one.
  if (hasControl(main)) {
    return {
      ok: false,
      error: TEXT.unusablePath,
      detail: `the main worktree of ${shown} is ${escapeUnsafeText(main)}, which holds a control character`,
    };
  }
  if (parsed.worktree === undefined) {
    return { ok: true, workspace: { repository: main, directory: main } };
  }

  const { branch, base } = parsed.worktree;
  const shownBranch = escapeUnsafeText(branch);
  const checked = await runGit(git, main, ['check-ref-format', '--branch', branch], deadlineAt);
  if (checked.timedOut) return { ok: false, error: TEXT.timedOut, detail: detailOf(checked) };
  if (checked.code !== 0 || checked.stdout.trim() !== branch) {
    return {
      ok: false,
      error: TEXT.badBranch,
      detail: `branch ${shownBranch}: ${detailOf(checked)}`,
    };
  }

  // Every local branch, once: the same name exists, or one would be a folder of the other
  // (`feature` and `feature/login`), which git refuses only after it has started.
  const branches = await runGit(
    git,
    main,
    ['for-each-ref', '--format=%(refname)', 'refs/heads/'],
    deadlineAt,
  );
  if (branches.timedOut) return { ok: false, error: TEXT.timedOut, detail: detailOf(branches) };
  const names = branches.stdout
    .split('\n')
    .filter((line) => line.startsWith('refs/heads/'))
    .map((line) => line.slice('refs/heads/'.length));
  if (names.includes(branch)) {
    return {
      ok: false,
      error: TEXT.branchExists,
      detail: `branch ${shownBranch} exists in ${shown}`,
    };
  }
  const conflict = names.find((n) => n.startsWith(`${branch}/`) || branch.startsWith(`${n}/`));
  if (conflict !== undefined) {
    return {
      ok: false,
      error: TEXT.branchConflict,
      detail: `branch ${shownBranch} conflicts with ${escapeUnsafeText(conflict)} in ${shown}`,
    };
  }

  const revision = base ?? 'HEAD';
  const resolved = await runGit(
    git,
    main,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`],
    deadlineAt,
  );
  if (resolved.timedOut) return { ok: false, error: TEXT.timedOut, detail: detailOf(resolved) };
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
    return {
      ok: false,
      error: TEXT.badBase,
      detail: `base ${escapeUnsafeText(revision)} names no commit in ${shown}`,
    };
  }

  const target = worktreePath(main, branch);
  const shownTarget = escapeUnsafeText(target);
  // Claim the directory before git runs: an exclusive mkdir lets one request through, and a name
  // the file system cannot hold (over 255 bytes) is refused here, before git makes the branch.
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return { ok: false, error: TEXT.targetExists, detail: `${shownTarget} exists` };
    }
    if (code === 'ENAMETOOLONG') {
      return { ok: false, error: TEXT.nameTooLong, detail: `${shownTarget}: name too long` };
    }
    return {
      ok: false,
      error: TEXT.addFailed,
      detail: `could not create ${shownTarget}: ${escapeUnsafeText(errorToString(err))}`,
    };
  }

  const added = await runGit(
    git,
    main,
    ['worktree', 'add', '-b', branch, target, commit],
    deadlineAt,
  );
  const workspace = { repository: main, directory: target, worktree: { branch, base: commit } };
  if (added.code === 0) return { ok: true, workspace };
  return afterFailedAdd(git, main, target, branch, added, workspace);
}

/**
 * A `git worktree add` that exited non-zero, or was stopped at the deadline. A complete worktree on
 * the branch (a hook or filter failed after git made it) is used, with a notice: refusing it would
 * leave the person a worktree they did not hear about and a branch a retry cannot reuse. Anything
 * else is refused, and what git left is logged; the only thing removed is this module's own empty
 * claim, after git has exited.
 */
async function afterFailedAdd(
  git: string,
  main: string,
  target: string,
  branch: string,
  added: GitResult,
  workspace: SessionWorkspace,
): Promise<Prepared> {
  const shownTarget = escapeUnsafeText(target);
  const failure = `git worktree add ${shownTarget} ${added.timedOut ? 'was stopped' : `exited ${added.code}`}: ${detailOf(added)}`;
  if (added.timedOut) {
    // The group may still be exiting: leave everything as it is.
    return {
      ok: false,
      error: TEXT.timedOut,
      detail: `${failure}; the directory ${shownTarget} and the branch ${escapeUnsafeText(branch)} may remain`,
    };
  }

  const inspectBy = Date.now() + INSPECT_MS;
  const where = await runGit(
    git,
    target,
    ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'],
    inspectBy,
  );
  const [topLevel, onBranch] = where.stdout.split('\n');
  let realTarget = target;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    // gone: not intact
  }
  if (where.code === 0 && topLevel === realTarget && onBranch === branch) {
    const status = await runGit(
      git,
      target,
      ['status', '--porcelain', '--untracked-files=no'],
      inspectBy,
    );
    if (status.code === 0 && status.stdout.trim() === '') {
      return {
        ok: true,
        workspace,
        notice: TEXT.hookNotice,
        detail: `${failure}; the worktree is complete on its branch, so the session starts in it`,
      };
    }
  }

  const left: string[] = [];
  try {
    if (fs.readdirSync(target).length === 0) {
      fs.rmdirSync(target);
      left.push(`removed the empty claim ${shownTarget}`);
    } else {
      left.push(`the directory ${shownTarget} stays`);
    }
  } catch {
    // git removed it, or it cannot be read
  }
  const ref = await runGit(
    git,
    main,
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    inspectBy,
  );
  const branchKept = ref.code === 0;
  if (branchKept) left.push(`the branch ${escapeUnsafeText(branch)} stays`);
  return {
    ok: false,
    error: branchKept ? TEXT.addFailedBranchKept : TEXT.addFailed,
    detail: left.length > 0 ? `${failure}; ${left.join('; ')}` : failure,
  };
}
