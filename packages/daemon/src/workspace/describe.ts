/**
 * The workspace a session runs in (#1236 phase B, ADR 0036): what git says about the session's
 * directory, for its session-list entry.
 *
 * It is read from git, not remembered from a create request, so a session a person started in a
 * worktree is described too, and a branch the agent checks out later shows. The session list never
 * waits on git: {@link WorkspaceCache} answers from its last read and refreshes a stale one in the
 * background, so the first list after a change still shows the previous read and the next one shows
 * the change.
 */

import * as fs from 'node:fs';
import type { SessionGitWorkspace } from '@remi/shared';
import { escapeUnsafeText } from '@remi/shared';
import { detailOf, findGit, hasControl, outputLines, resolveRepository, runGit } from './git.ts';

/** How long one description may take by default. */
const DEFAULT_DESCRIBE_TIMEOUT_MS = 5_000;
/** How long a read stays fresh before the next one is started. */
const DEFAULT_TTL_MS = 10_000;

/** What git said: a workspace, none (not in a repository), or unknown (git could not answer). */
export type WorkspaceReading = SessionGitWorkspace | null | { readonly unknown: string };

const unknown = (reason: string): WorkspaceReading => ({ unknown: reason });

/** Text that would reach a client as it is: no control, bidi or invisible character. */
function plain(text: string): boolean {
  return !hasControl(text) && escapeUnsafeText(text) === text;
}

/**
 * Reads the workspace `dir` is in. Null when it is in no repository, in a bare one, inside a `.git`
 * directory, or when a path or the branch holds a character that would reach clients as something
 * else (a control, bidi or invisible one: the agent can name a branch). `{unknown}` when git could
 * not answer: missing, timed out, older than 2.36, or refusing a repository it does not trust.
 */
export async function readWorkspace(
  dir: string,
  options: { timeoutMs?: number } = {},
): Promise<WorkspaceReading> {
  try {
    if (!(await fs.promises.stat(dir)).isDirectory()) return null;
  } catch {
    return null;
  }
  const git = findGit();
  if (git === null) return unknown('git is not on the PATH');
  const deadlineAt = Date.now() + (options.timeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS);

  const lookup = await resolveRepository(git, dir, deadlineAt);
  // A path holding a newline is never described (it would reach clients as text), as before #1282.
  if (lookup.kind === 'none' || lookup.kind === 'bare' || lookup.kind === 'ambiguous') return null;
  if (lookup.kind === 'unknown') {
    const { result } = lookup;
    if (result.timedOut) return unknown('git timed out');
    if (result.code === 129) return unknown('git is older than 2.36');
    if (result.stderr.includes('dubious ownership'))
      return unknown('git does not trust the repository');
    return unknown(`git failed: ${detailOf(result)}`);
  }

  // The full ref, not `--short`, which writes `heads/<name>` when a tag shares the name.
  const ref = await runGit(git, dir, ['symbolic-ref', '-q', 'HEAD'], deadlineAt);
  let branch: string | null;
  if (ref.timedOut) return unknown('git timed out');
  if (ref.code === 1) branch = null;
  else if (ref.code === 0) {
    const full = outputLines(ref.stdout)[0] ?? '';
    branch = full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : null;
  } else return unknown(`git failed: ${detailOf(ref)}`);

  const { repository, top: directory } = lookup;
  if (!plain(repository) || !plain(directory) || (branch !== null && !plain(branch))) return null;
  return { repository, directory, branch };
}

/** {@link readWorkspace} with "unknown" read as none: for a caller that has no previous answer. */
export async function describeWorkspace(
  dir: string,
  options: { timeoutMs?: number } = {},
): Promise<SessionGitWorkspace | null> {
  const reading = await readWorkspace(dir, options);
  return reading !== null && 'unknown' in reading ? null : reading;
}

interface Entry {
  /** The last answer: a workspace, or null for none. Absent until a read has answered. */
  value?: SessionGitWorkspace | null;
  readAt: number;
  pending?: Promise<void> | undefined;
  /** Reasons already logged for this directory, so a stuck git is said once, not every read. */
  readonly logged: Set<string>;
}

/**
 * Descriptions by directory, for a list that must not wait. `get` returns the last answer at once
 * (nothing before the first read answers) and starts a read when there is none, or when the last one
 * is older than the entry's lifetime; reads of one directory never overlap. A read git could not
 * answer keeps the previous answer and is logged once per reason. The map holds one entry per
 * directory asked about; a daemon asks about its one session's directory.
 */
export class WorkspaceCache {
  private readonly entries = new Map<string, Entry>();
  /** Reads started since construction: what a caller that asked many times actually cost. */
  private started = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(
    options: {
      ttlMs?: number;
      now?: () => number;
      timeoutMs?: number;
      log?: (line: string) => void;
    } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
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
    const entry: Entry = previous ?? { readAt: 0, logged: new Set() };
    this.entries.set(dir, entry);
    this.started += 1;
    entry.pending = readWorkspace(dir, { timeoutMs: this.timeoutMs })
      .catch((err: unknown) => unknown(`read failed: ${String(err)}`))
      .then((reading) => {
        if (reading !== null && 'unknown' in reading) {
          if (!entry.logged.has(reading.unknown)) {
            entry.logged.add(reading.unknown);
            this.log(
              `workspace of ${escapeUnsafeText(dir)} unknown (${reading.unknown}); keeping the last answer`,
            );
          }
        } else {
          entry.value = reading;
        }
        entry.readAt = this.now();
        entry.pending = undefined;
      });
  }
}
