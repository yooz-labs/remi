/**
 * Which thread of the shared Codex app-server is this session's, and the
 * attach to it (epic #1175, phase 3 #1177).
 *
 * The app-server shows remi every thread of every Codex window of the user
 * (`thread/started` and `thread/status/changed` reach every connection), so
 * the tracker picks its own and ignores the rest. It never logs another
 * thread's frame, keeps only ids and parent links of others, and logs ids cut
 * to eight characters.
 *
 * A `thread/started` is a candidate for this session's TUI thread only when ALL
 * hold: not ephemeral; `threadSource` is `user` (or null with a rollout
 * `path`); at least one environment; no parent; its cwd, resolved with
 * `realpath`, is the session's; created no more than 5 s before the spawn; not
 * claimed by another remi session; and, for the first identity, none is held.
 * The TUI also starts a title-helper thread in the same directory about 7 s
 * later (ephemeral, `thread_title`, no environments): the rules above are why
 * it never binds (spike, `expB.jsonl:7` and `:12`).
 *
 * The first candidate waits `ambiguityMs` (300) before it is committed: a
 * second DISTINCT candidate arriving inside that window means two Codex windows
 * started in this directory together, and remi cannot tell which is its own.
 * Then it binds neither (fail closed): a session with no identity keeps none
 * (and keeps none for good), and a session that has one keeps it. It is decided
 * by arrival, not by `createdAt`, which has whole-second resolution in the real
 * frames; a repeat of the same thread id is not a second candidate. Residual
 * risk R4: a non-remi window in the same directory that starts in that window.
 *
 * Attach is `thread/resume {threadId, excludeTurns: true}` and nothing else (the
 * spike showed an override persists on the thread). It fails with `-32600`
 * ("no rollout found") until the first message of the thread, so it is retried:
 * at once when the tracked thread turns `active`, otherwise every second, for
 * the life of the session. A new candidate after the first identity is a `/new`
 * in the TUI and rotates the binding, but not while the tracked thread is
 * `active` (decided policy, unverified live): the old id is not kept.
 *
 * The tracked thread and every thread whose parent chain reaches it (subagents)
 * are the session's, so their status is the session's status. Two bounded
 * memories keep that: `descendants` (at most 256 ids, never pushed out by
 * anyone else's threads) holds the ones known to be ours, and `pendingLinks`
 * (at most 512, first in first out) holds the links seen before their parent was
 * known to be ours, so a thread started before its parent still counts once the
 * parent does, while the links of other windows only ever fill that second one.
 */

import { realpathSync } from 'node:fs';

import { type AppServerClient, AppServerRpcError } from './app-server-client.ts';
import {
  type ThreadInfo,
  type ThreadStatus,
  parseThread,
  parseThreadStatus,
} from './thread-protocol.ts';

export interface ThreadTrackerDeps {
  client: Pick<AppServerClient, 'request'>;
  /** The session's working directory, as `realpath` resolves it. */
  sessionCwd: string;
  spawnedAtMs: number;
  /** The thread a `remi codex resume <id>` names; null for a fresh session. */
  expectedThreadId: string | null;
  /** Thread ids held by the active non-Claude records of other remi sessions. */
  claimedByOthers: () => ReadonlySet<string>;
  /** Persist a newly learned thread id; a throw leaves the tracker without it. */
  onIdentity(threadId: string): void;
  onStatus(threadId: string, status: ThreadStatus): void;
  log: (message: string) => void;
  /** Test seams: the attach retry period (1000 ms) and the ambiguity window (300 ms). */
  retryMs?: number;
  ambiguityMs?: number;
}

/** A thread created more than this long before the spawn is not this session's. */
const CREATED_BEFORE_SPAWN_SLACK_MS = 5000;
const MAX_PENDING_LINKS = 512;
const MAX_DESCENDANTS = 256;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const short = (id: string): string => id.slice(0, 8);

function resolveCwd(cwd: string): string | null {
  try {
    return realpathSync(cwd);
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof AppServerRpcError) return `code ${error.code}`;
  return error instanceof Error ? error.name : typeof error;
}

export class ThreadTracker {
  private current: string | null;
  private isAttached = false;
  private attaching = false;
  private ready = false;
  private disposed = false;
  /** Set when two candidates were ambiguous and no identity is held: no more binding. */
  private refused = false;
  private pending: { thread: ThreadInfo; status: ThreadStatus | null } | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private trackedStatus: ThreadStatus | null = null;
  private failures = 0;
  /** Ids known to be descendants of the tracked thread, oldest first. */
  private readonly descendants = new Set<string>();
  /** Child -> parent, for links whose parent is not (yet) known to be ours. */
  private readonly pendingLinks = new Map<string, string>();

  constructor(private readonly deps: ThreadTrackerDeps) {
    this.current = deps.expectedThreadId;
  }

  /** The tracked thread, or a thread known to descend from it. */
  private isOurs(threadId: string): boolean {
    return threadId === this.current || this.descendants.has(threadId);
  }

  handleNotification(method: string, params: unknown): void {
    if (this.disposed) return;
    if (method === 'thread/started') this.onThreadStarted(params);
    else if (method === 'thread/status/changed') this.onStatusChanged(params);
  }

  /** The link is up (first time or again): attach to the tracked thread, if there is one. */
  handleReady(): void {
    this.ready = true;
    this.isAttached = false;
    this.attach();
  }

  /** The link dropped: the subscription is gone, and nothing can be retried until it is back. */
  handleDisconnected(): void {
    this.ready = false;
    this.isAttached = false;
    this.clearRetry();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.pendingTimer);
    this.clearRetry();
  }

  private onThreadStarted(params: unknown): void {
    const thread = parseThread(isRecord(params) ? params['thread'] : null);
    if (thread === null) return;
    if (thread.parentThreadId !== null) this.noteLink(thread.id, thread.parentThreadId);
    if (this.isCandidate(thread)) this.consider(thread);
  }

  /** A `thread/started` with a parent: a descendant if the parent is ours, else a link to remember. */
  private noteLink(id: string, parent: string): void {
    if (this.isOurs(parent)) {
      this.adopt(id);
      return;
    }
    this.pendingLinks.delete(id);
    this.pendingLinks.set(id, parent);
    if (this.pendingLinks.size > MAX_PENDING_LINKS) {
      const oldest = this.pendingLinks.keys().next().value;
      if (oldest !== undefined) this.pendingLinks.delete(oldest);
    }
  }

  /** `id` descends from the tracked thread; so do the threads that were waiting on it. */
  private adopt(id: string): void {
    const work = [id];
    while (work.length > 0) {
      const next = work.pop() as string;
      this.pendingLinks.delete(next);
      this.descendants.delete(next);
      this.descendants.add(next);
      if (this.descendants.size > MAX_DESCENDANTS) {
        const oldest = this.descendants.values().next().value;
        if (oldest !== undefined) this.descendants.delete(oldest);
      }
      for (const [child, parent] of this.pendingLinks) {
        if (parent === next) work.push(child);
      }
    }
  }

  private isCandidate(t: ThreadInfo): boolean {
    if (t.ephemeral) return false;
    if (!(t.threadSource === 'user' || (t.threadSource === null && t.path !== null))) return false;
    if (t.environmentCount < 1) return false;
    if (t.parentThreadId !== null) return false;
    if (t.cwd === null || resolveCwd(t.cwd) !== this.deps.sessionCwd) return false;
    if (
      t.createdAtSec === null ||
      t.createdAtSec * 1000 < this.deps.spawnedAtMs - CREATED_BEFORE_SPAWN_SLACK_MS
    ) {
      return false;
    }
    if (t.id === this.current) return false;
    try {
      return !this.deps.claimedByOthers().has(t.id);
    } catch (error) {
      this.deps.log(`could not read the claimed thread ids (${describeError(error)})`);
      return false;
    }
  }

  private consider(thread: ThreadInfo): void {
    if (this.refused) return;
    if (this.current !== null && this.trackedStatus?.type === 'active') {
      this.deps.log('ignored a new thread while the tracked thread is active');
      return;
    }
    const first = this.pending;
    if (first !== null) {
      // A repeat of the pending thread (a replay) is the same candidate, not a second.
      if (thread.id === first.thread.id) return;
      clearTimeout(this.pendingTimer);
      this.pending = null;
      if (this.current === null) this.refused = true;
      this.deps.log('two threads started in this directory together; binding neither');
      return;
    }
    this.pending = { thread, status: thread.status };
    this.pendingTimer = setTimeout(() => this.commit(), this.deps.ambiguityMs ?? 300);
  }

  private commit(): void {
    const candidate = this.pending;
    this.pending = null;
    if (candidate === null || this.disposed) return;
    if (this.current !== null && this.trackedStatus?.type === 'active') return;
    const { id } = candidate.thread;
    try {
      this.deps.onIdentity(id);
    } catch (error) {
      this.deps.log(`could not record the thread id (${describeError(error)})`);
      return;
    }
    this.current = id;
    // The old thread's subagents are not this one's; threads that started before it was known are.
    this.descendants.clear();
    for (const [child, parent] of [...this.pendingLinks]) {
      if (parent === id) this.adopt(child);
    }
    this.isAttached = false;
    this.trackedStatus = null;
    this.failures = 0;
    this.deps.log(`identity: thread ${short(id)}`);
    if (candidate.status !== null) this.applyStatus(id, candidate.status);
    this.attach();
  }

  private onStatusChanged(params: unknown): void {
    if (!isRecord(params)) return;
    const id = params['threadId'];
    const status = parseThreadStatus(params['status']);
    if (typeof id !== 'string' || status === null) return;
    if (this.pending !== null && id === this.pending.thread.id) {
      this.pending.status = status;
      return;
    }
    if (!this.isOurs(id)) return;
    this.applyStatus(id, status);
    if (id === this.current && status.type === 'active' && !this.isAttached) {
      this.clearRetry();
      this.attach();
    }
  }

  private applyStatus(id: string, status: ThreadStatus): void {
    if (id === this.current) this.trackedStatus = status;
    this.deps.onStatus(id, status);
  }

  private attach(): void {
    const id = this.current;
    if (id === null || this.isAttached || this.attaching || !this.ready || this.disposed) return;
    this.clearRetry();
    this.attaching = true;
    this.deps.client.request('thread/resume', { threadId: id, excludeTurns: true }).then(
      (result) => {
        this.attaching = false;
        if (this.disposed) return;
        if (this.current !== id) {
          this.attach();
          return;
        }
        this.failures = 0;
        this.isAttached = true;
        this.deps.log(`attached to thread ${short(id)}`);
        const resumed = parseThread(isRecord(result) ? result['thread'] : null);
        if (resumed?.status) this.applyStatus(id, resumed.status);
      },
      (error: unknown) => {
        this.attaching = false;
        if (this.disposed) return;
        if (this.current !== id) {
          this.attach();
          return;
        }
        this.failures += 1;
        if (this.failures === 1 || this.failures % 30 === 0) {
          this.deps.log(
            `thread/resume for ${short(id)} failed (${describeError(error)}); retrying (attempt ${this.failures})`,
          );
        }
        this.retryTimer = setTimeout(() => this.attach(), this.deps.retryMs ?? 1000);
      },
    );
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
