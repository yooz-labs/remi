/**
 * The workspace a session runs in (#1236 phase B, ADR 0036): what git says about the session's
 * directory, for its session-list entry.
 *
 * It is read from git, not remembered from a create request, so a session a person started in a
 * worktree is described too, and a branch the agent checks out later shows. The session list never
 * waits on git: {@link WorkspaceCache} answers from its last read and refreshes a stale one in the
 * background.
 */

import * as fs from 'node:fs';
import type { SessionGitWorkspace } from '@remi/shared';
import { findGit, hasControl, runGit } from './git.ts';

/** How long one description may take; a session-list entry does without one past that. */
const DESCRIBE_DEADLINE_MS = 5_000;
/** How long a read stays fresh before the next one is started. */
const DEFAULT_TTL_MS = 10_000;

/**
 * The repository (its main worktree; a bare repository's own directory), the worktree `dir` is in
 * (its top level) and the branch checked out there (null when HEAD is detached), or null when `dir`
 * is not in a repository git can read, git is missing or older than 2.36, or a path holds a control
 * character (it would reach clients as text).
 */
export async function describeWorkspace(dir: string): Promise<SessionGitWorkspace | null> {
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const git = findGit();
  if (git === null) return null;
  const deadlineAt = Date.now() + DESCRIBE_DEADLINE_MS;

  const top = await runGit(git, dir, ['rev-parse', '--show-toplevel'], deadlineAt);
  if (top.code !== 0) return null;
  const directory = top.stdout.trim();

  const list = await runGit(git, dir, ['worktree', 'list', '--porcelain', '-z'], deadlineAt);
  if (list.code !== 0) return null;
  const head = list.stdout.split('\0')[0] ?? '';
  if (!head.startsWith('worktree ')) return null;
  const repository = head.slice('worktree '.length);

  // `symbolic-ref` names the branch even before its first commit, and exits 1 for a detached HEAD.
  const ref = await runGit(git, dir, ['symbolic-ref', '--short', '-q', 'HEAD'], deadlineAt);
  let branch: string | null;
  if (ref.code === 0) branch = ref.stdout.trim();
  else if (ref.code === 1) branch = null;
  else return null;

  if (hasControl(directory) || hasControl(repository) || (branch !== null && hasControl(branch))) {
    return null;
  }
  return { repository, directory, branch };
}

interface Entry {
  /** The last answer: a workspace, or null for none. Absent until the first read finishes. */
  value?: SessionGitWorkspace | null;
  readAt: number;
  pending?: Promise<void> | undefined;
}

/**
 * Descriptions by directory, for a list that must not wait. `get` returns the last answer at once
 * (nothing before the first read finishes) and starts a read when there is none, or when the last
 * one is older than the entry's lifetime; reads of one directory never overlap.
 */
export class WorkspaceCache {
  private readonly entries = new Map<string, Entry>();
  /** Reads started since construction: what a caller that asked many times actually cost. */
  private started = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get(dir: string): SessionGitWorkspace | undefined {
    const entry = this.entries.get(dir);
    if (
      entry === undefined ||
      (entry.pending === undefined && this.now() - entry.readAt >= this.ttlMs)
    ) {
      this.read(dir, entry);
    }
    return entry?.value ?? undefined;
  }

  /** Resolves once the read of `dir` in flight (if any) has finished. */
  async settled(dir: string): Promise<void> {
    await this.entries.get(dir)?.pending;
  }

  /** How many reads have been started. */
  readsStarted(): number {
    return this.started;
  }

  /** How many reads are running. */
  inFlight(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.pending !== undefined) count++;
    return count;
  }

  private read(dir: string, previous: Entry | undefined): void {
    const entry: Entry = previous ?? { readAt: 0 };
    this.entries.set(dir, entry);
    this.started += 1;
    entry.pending = describeWorkspace(dir)
      .catch(() => null)
      .then((value) => {
        entry.value = value;
        entry.readAt = this.now();
        entry.pending = undefined;
      });
  }
}
