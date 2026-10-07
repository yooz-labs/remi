/**
 * Recent repositories (#1236 phase C, ADR 0036): the repositories of the machine's recent
 * sessions, so a client can offer "new session in repository X on machine Y".
 *
 * The source is the session store (`sessions.json`, at most 100 records). The store drops a session
 * seven days after it exited, so a repository leaves the list a week after its last session there
 * ended, and at once if the session's directory is removed (a worktree the person deleted).
 * Sessions are walked by last use: when a session ended, or now for one still running. Each
 * session's directory is resolved to its repository's main worktree with the resolver both other
 * phases use, so a subdirectory or a linked worktree names its repository, a submodule or a
 * separate-git-dir checkout names itself, and a directory that is gone, outside any repository or
 * in a bare one is left out, as is one git cannot run in. One deadline covers the walk (every
 * directory check and git call; reading the store comes before it): when it passes, the walk ends
 * with what it found.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RecentRepository } from '@remi/shared';
import { escapeUnsafeText } from '@remi/shared';
import { findGit, hasControl, resolveRepository } from './git.ts';

const DEFAULT_LIMIT = 10;
/** The most a client may ask for. */
export const MAX_RECENT_REPOSITORIES = 20;
/** How long the whole walk may take. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** A requested limit: 1 to 20 as asked, above 20 is 20, and absent or anything else is 10. */
export function recentRepositoriesLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_RECENT_REPOSITORIES);
}

const plain = (text: string): boolean => !hasControl(text) && escapeUnsafeText(text) === text;

/** A session as the walk reads it from the store. */
export interface RecentSession {
  readonly projectPath: string;
  readonly exitedAt: string | null;
}

/** A repository's display name: its directory name, or its path when it has none (the root). */
export function repositoryName(repository: string): string {
  return path.basename(repository) || repository;
}

/** Why a session named no repository, counted for the log (never the path). */
export type RecentSkip = 'gone' | 'unreadable' | 'outside' | 'bare' | 'unknown' | 'unsafe';

export interface RecentRepositoriesReport {
  readonly repositories: RecentRepository[];
  readonly skipped: Readonly<Record<RecentSkip, number>>;
  /** Whether the deadline ended the walk, or cut a lookup short, before the limit was reached. */
  readonly timedOut: boolean;
  /** Whether no git was found on the PATH, so nothing could be looked up. */
  readonly noGit: boolean;
}

const TIMED_OUT = Symbol('timed out');

/** `work`, or {@link TIMED_OUT} once `deadlineAt` passes, whichever comes first. */
async function beforeDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadlineAt - Date.now()));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/**
 * The walk, with what it left out and whether the deadline ended it: main worktrees only, most
 * recently used first, each once, with the last use of the most recent session in it.
 */
export async function recentRepositoriesReport(
  sessions: readonly RecentSession[],
  options: { limit?: unknown; timeoutMs?: number; now?: () => number } = {},
): Promise<RecentRepositoriesReport> {
  const skipped: Record<RecentSkip, number> = {
    gone: 0,
    unreadable: 0,
    outside: 0,
    bare: 0,
    unknown: 0,
    unsafe: 0,
  };
  const found: RecentRepository[] = [];
  const git = findGit();
  if (git === null) return { repositories: found, skipped, timedOut: false, noGit: true };
  const limit = recentRepositoriesLimit(options.limit);
  const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const usedNow = new Date((options.now ?? Date.now)()).toISOString();
  const ordered = sessions
    .map((session, order) => ({ session, lastUsedAt: session.exitedAt ?? usedNow, order }))
    .sort((a, b) => timeOf(b.lastUsedAt) - timeOf(a.lastUsedAt) || a.order - b.order);

  const seenRepositories = new Set<string>();
  const seenDirectories = new Set<string>();
  let timedOut = false;
  for (const { session, lastUsedAt } of ordered) {
    if (found.length >= limit) break;
    if (Date.now() >= deadlineAt) {
      timedOut = true;
      break;
    }
    const dir = session.projectPath;
    if (seenDirectories.has(dir)) continue;
    seenDirectories.add(dir);
    let stat: fs.Stats | typeof TIMED_OUT;
    try {
      // A directory on a mount that stopped answering must not outlast the deadline.
      stat = await beforeDeadline(fs.promises.stat(dir), deadlineAt);
    } catch {
      skipped.gone += 1;
      continue;
    }
    if (stat === TIMED_OUT) {
      timedOut = true;
      break;
    }
    if (!stat.isDirectory()) {
      skipped.gone += 1;
      continue;
    }
    let lookup: Awaited<ReturnType<typeof resolveRepository>>;
    try {
      // Past the deadline every git call returns at once, and the check above ends the walk.
      lookup = await resolveRepository(git, dir, deadlineAt);
    } catch {
      // git could not be started there (a directory without search permission, or gone since).
      skipped.unreadable += 1;
      continue;
    }
    if (lookup.kind === 'none') {
      skipped.outside += 1;
      continue;
    }
    if (lookup.kind === 'ambiguous') {
      skipped.unsafe += 1;
      continue;
    }
    if (lookup.kind === 'unknown') {
      if (lookup.result.timedOut) timedOut = true;
      skipped.unknown += 1;
      continue;
    }
    if (lookup.kind === 'bare' || lookup.mainIsBare) {
      skipped.bare += 1;
      continue;
    }
    const { repository } = lookup;
    if (seenRepositories.has(repository)) continue;
    if (!plain(repository)) {
      skipped.unsafe += 1;
      continue;
    }
    seenRepositories.add(repository);
    found.push({ repository, name: repositoryName(repository), lastUsedAt });
  }
  return { repositories: found, skipped, timedOut, noGit: false };
}

/** The repositories `sessions` ran in: {@link recentRepositoriesReport} without the report. */
export async function recentRepositories(
  sessions: readonly RecentSession[],
  options: { limit?: unknown; timeoutMs?: number; now?: () => number } = {},
): Promise<RecentRepository[]> {
  return (await recentRepositoriesReport(sessions, options)).repositories;
}
