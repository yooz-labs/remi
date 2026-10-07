/**
 * Recent repositories (#1236 phase C, ADR 0036): the repositories of the machine's recent
 * sessions, so a client can offer "new session in repository X on machine Y".
 *
 * The source is the session store (`sessions.json`, most recent first, at most 100 records). Each
 * session's directory is resolved to its repository's main worktree with the resolver both other
 * phases use, so a subdirectory or a linked worktree names its repository, a submodule or a
 * separate-git-dir checkout names itself, and a directory that is gone, outside any repository or
 * in a bare one is left out. One deadline covers the walk: when git cannot answer in time, the
 * walk ends with what it found.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RecentRepository } from '@remi/shared';
import { escapeUnsafeText } from '@remi/shared';
import { findGit, hasControl, resolveRepository } from './git.ts';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
/** How long the whole walk may take. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** A requested limit: an integer from 1 to 20, or the default. */
function limitOf(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

const plain = (text: string): boolean => !hasControl(text) && escapeUnsafeText(text) === text;

/**
 * The repositories `sessions` ran in, main worktrees only, most recent first, each once, with the
 * start of the most recent session in it. `sessions` is in the store's order (most recent first).
 */
export async function recentRepositories(
  sessions: readonly { readonly projectPath: string; readonly startedAt: string }[],
  options: { limit?: unknown; timeoutMs?: number } = {},
): Promise<RecentRepository[]> {
  const limit = limitOf(options.limit);
  const git = findGit();
  if (git === null) return [];
  const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const found: RecentRepository[] = [];
  const seenRepositories = new Set<string>();
  const seenDirectories = new Set<string>();
  for (const session of sessions) {
    if (found.length >= limit || Date.now() >= deadlineAt) break;
    const dir = session.projectPath;
    if (seenDirectories.has(dir)) continue;
    seenDirectories.add(dir);
    try {
      if (!(await fs.promises.stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    // Past the deadline every git call returns at once, and the check above ends the walk.
    const lookup = await resolveRepository(git, dir, deadlineAt);
    if (lookup.kind !== 'repository' || lookup.mainIsBare) continue;
    const { repository } = lookup;
    if (seenRepositories.has(repository) || !plain(repository)) continue;
    seenRepositories.add(repository);
    found.push({ repository, name: path.basename(repository), lastUsedAt: session.startedAt });
  }
  return found;
}
