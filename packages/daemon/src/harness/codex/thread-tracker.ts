/**
 * Which thread of the shared Codex app-server is this session's, and the
 * attach to it (epic #1175, phase 3 #1177).
 *
 * The app-server shows remi every thread of every Codex window of the user
 * (`thread/started` and `thread/status/changed` reach every connection), so
 * the tracker picks its own and ignores the rest. It never logs another
 * thread's frame, keeps only ids and parent links of others, and logs an id as
 * its last eight characters (`shortThreadId`: a UUIDv7 starts with a timestamp).
 *
 * A `thread/started` is a candidate for this session's TUI thread only when ALL
 * hold: its id is a UUID (`parseThread`: the id is stored and printed in a
 * command line); not ephemeral; `threadSource` is `user` (or null with a rollout
 * `path`); at least one environment; no parent; its cwd, resolved with
 * `realpath`, is the session's; created no more than 5 s before the spawn; not
 * the tracked thread; not one the store refused; and not claimed by another remi
 * session. The TUI also starts a title-helper thread in the same directory about
 * 7 s later (ephemeral, `thread_title`, no environments): the rules above are why
 * it never binds (spike, `expB.jsonl:7` and `:12`).
 *
 * The first candidate waits `ambiguityMs` (300) before it is committed: a
 * second DISTINCT candidate that ARRIVES inside that window means two Codex
 * windows started in this directory together, and remi cannot tell which is its
 * own. Then it binds neither (fail closed): a session with no identity keeps none
 * (and keeps none for good), and a session that has one keeps it. Arrival decides,
 * not `createdAt`, which has whole-second resolution in the real frames; a
 * repeat of the same thread id is not a second candidate.
 *
 * At commit, not when the frame arrived, the claim is checked again (another
 * session may have taken the thread during the window), and so is the sibling
 * guard: a `thread/started` carries nothing that says which session it is for, so
 * while another live remi codex session in the directory could own it, nothing is
 * bound and the candidate is DROPPED, not kept (after a block it cannot be
 * attributed, and keeping it would bind a guess). For a first bind only a sibling
 * with no thread yet and a start under 60 s old is in the way; for a rotation any
 * sibling is, bound or not, so with two sessions in one directory a `/new` in
 * either is followed by neither (a known limit). Each block is logged, and the user
 * is told once (once for a first bind, once for a rotation). A thread the store then refuses (`ThreadClaimedError`) is
 * remembered and never retried.
 *
 * A candidate after the first identity is a `/new` in the TUI and rotates the
 * binding, but not while the tracked thread is `active` and not past the sibling
 * guard (decided policy, unverified live); the old id is not kept, and every
 * rotation is logged as `rotated from <last 8> to <last 8>`. Residuals: a plain non-remi
 * `codex` window opened in this directory while the session is idle looks exactly
 * like a `/new` and re-binds it, and a `/resume` inside the TUI emits no
 * `thread/started` (spike, `expB3.jsonl:12-13`), so the old thread is kept.
 *
 * Attach is `thread/resume {threadId, excludeTurns: true}` and nothing else (the
 * spike showed an override persists on the thread). It fails with `-32600`
 * ("no rollout found") until the first message of the thread, so it is retried
 * for the life of the session: at once when the tracked thread turns `active`,
 * otherwise every second (every five seconds after ten failures). A server with
 * no `thread/resume` at all (`-32601`) is asked once per connection.
 *
 * The tracked thread and every thread whose parent chain reaches it (subagents)
 * are the session's, so their status is the session's status. Two bounded
 * memories keep that: `descendants` (at most 256 ids, never pushed out by
 * anyone else's threads) holds the ones known to be ours, and `pendingLinks`
 * (at most 512, first in first out) holds the links seen before their parent was
 * known to be ours, so a thread started before its parent still counts once the
 * parent does, while the links of other windows only ever fill that second one.
 * A descendant pushed out of the first is reported idle, since its frames are
 * ignored from then on.
 *
 * A session that is connected but never learns its thread says so once, 30 s
 * after the link came up (looking again once if a candidate was then inside its
 * window): the thread is learned only from a live `thread/started`, so a
 * connection that opened after the frame never sees it.
 *
 * Phase 4 (#1178) adds two things the approval cards read. `role` says whether a
 * thread is the tracked one (`main`), a descendant of it (`subagent`) or neither,
 * which is how a server request is kept from becoming a card for a thread that is
 * not this session's. `onAttached` fires after each successful attach: the app-server
 * replays a pending request to a client that attaches, so that is the moment the
 * replay window of a reconnect starts.
 */

import { realpathSync } from 'node:fs';

import { type AppServerClient, AppServerRpcError } from './app-server-client.ts';
import { shortThreadId } from './thread-id.ts';
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
  /**
   * Persist a newly learned thread id. A throw leaves the tracker without it; a
   * `ThreadClaimedError` says the store found another session holding it.
   */
  onIdentity(threadId: string): void;
  onStatus(threadId: string, status: ThreadStatus): void;
  /**
   * The attach to the tracked thread succeeded (first time, after a retry, after a reconnect or
   * a rotation). A throw is logged and changes nothing.
   */
  onAttached?: (threadId: string) => void;
  /**
   * Is another live remi codex session in this directory in the way of binding a new thread
   * here? A `thread/started` carries nothing that says which session it is for, so while one is,
   * this tracker binds nothing (the candidate is dropped, not kept). `rotating` is false for a
   * first bind, where only a sibling still looking for its own first thread is in the way, and
   * true for a rotation, where any sibling is. Read when a candidate is about to be committed.
   */
  siblingInDirectory?: (rotating: boolean) => boolean;
  /** Tell the user something as a system message; the tracker sends each kind at most once. */
  notice?: (message: string) => void;
  log: (message: string) => void;
  /**
   * Test seams: the attach retry period (1000 ms), the ambiguity window (300 ms) and how long
   * after `ready` a session with no identity waits before saying so (30 000 ms).
   */
  retryMs?: number;
  ambiguityMs?: number;
  noIdentityMs?: number;
}

/** The store found another remi session holding the thread this one was about to take. */
export class ThreadClaimedError extends Error {
  constructor(readonly threadId: string) {
    super(`thread ${shortThreadId(threadId)} is claimed by another session`);
    this.name = 'ThreadClaimedError';
  }
}

/** A thread created more than this long before the spawn is not this session's. */
const CREATED_BEFORE_SPAWN_SLACK_MS = 5000;
/** After this many failed attaches the retry period is multiplied by RETRY_BACKOFF_FACTOR. */
const BACKOFF_AFTER_FAILURES = 10;
const RETRY_BACKOFF_FACTOR = 5;
/** How long a first candidate waits for a second before it is committed. */
const AMBIGUITY_WINDOW_MS = 300;
/** How long after `ready` a session with no thread waits before saying so. */
const NO_IDENTITY_NOTICE_MS = 30_000;
const MAX_PENDING_LINKS = 512;
const MAX_DESCENDANTS = 256;

/** What a rotation blocked by another session in the directory tells the user and the log. */
const ROTATION_BLOCKED =
  'a new thread appeared; another remi codex session shares this directory; not following it';
/** What a first bind blocked by a sibling that has no thread yet tells the user. */
const FIRST_BIND_BLOCKED =
  'another remi codex session in this directory is starting or has no thread yet; this session did not bind. Restart one of them if this persists.';

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const short = shortThreadId;

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
  private noIdentityTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private trackedStatus: ThreadStatus | null = null;
  private failures = 0;
  /** Threads the store said another session holds: never tried again. */
  private readonly rejected = new Set<string>();
  /** Kinds of notice already sent. */
  private readonly told = new Set<string>();
  /** The app-server has no `thread/resume` (`-32601`): not retried until the next `ready`. */
  private resumeUnavailable = false;
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

  /**
   * `main` for the tracked thread, `subagent` for a thread known to descend from it, null for
   * anything else (another window's thread, a candidate still inside its window, a thread of
   * before a rotation). What a server request about `threadId` may become depends on it.
   */
  role(threadId: string): 'main' | 'subagent' | null {
    if (threadId === this.current) return 'main';
    return this.descendants.has(threadId) ? 'subagent' : null;
  }

  handleNotification(method: string, params: unknown): void {
    if (this.disposed) return;
    if (method === 'thread/started') this.onThreadStarted(params);
    else if (method === 'thread/status/changed') this.onStatusChanged(params);
  }

  /** The link is up (first time or again): attach to the tracked thread, if there is one. */
  handleReady(): void {
    if (this.disposed) return;
    this.ready = true;
    this.isAttached = false;
    // A new connection is a new chance: the period starts over, and so does an app-server
    // that lacked `thread/resume` (it may have been upgraded).
    this.failures = 0;
    this.resumeUnavailable = false;
    this.watchForNoIdentity();
    this.attach();
  }

  /**
   * A thread is learned only from a live `thread/started`, so a connection that opened after
   * the frame (a cold start, a reconnect) never learns it. Nothing can be done about that
   * here (`thread/list`'s parameters are not verified), but the user is told once, 30 s after
   * the link is up, when the session still has no thread and none is about to bind.
   */
  private watchForNoIdentity(): void {
    if (
      this.current !== null ||
      this.noIdentityTimer !== undefined ||
      this.told.has('no-identity')
    ) {
      return;
    }
    this.armNoIdentityTimer(this.deps.noIdentityMs ?? NO_IDENTITY_NOTICE_MS, true);
  }

  /**
   * After `ms`, say the thread was not found if there is still none. A candidate that is inside
   * its window then may yet be refused (held by another session, a sibling in the directory), so
   * the check is made once more when that window is over (`mayExtend`); a later one is not
   * waited for, since the session has been waiting long enough.
   */
  private armNoIdentityTimer(ms: number, mayExtend: boolean): void {
    this.noIdentityTimer = setTimeout(() => {
      this.noIdentityTimer = undefined;
      if (this.disposed || this.current !== null) return;
      if (this.pending !== null) {
        if (mayExtend) this.armNoIdentityTimer(this.deps.ambiguityMs ?? AMBIGUITY_WINDOW_MS, false);
        return;
      }
      this.deps.log('no thread/started for this directory since the link came up');
      this.tell('no-identity', "remi could not find this session's Codex thread");
    }, ms);
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
    clearTimeout(this.noIdentityTimer);
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
        if (oldest !== undefined) {
          this.descendants.delete(oldest);
          // Its frames are ignored from here on, so what it last said must not stand.
          this.deps.onStatus(oldest, { type: 'idle' });
        }
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
    if (t.id === this.current || this.rejected.has(t.id)) return false;
    return !this.isClaimed(t.id);
  }

  /** Is `id` held by another session? An unreadable answer counts as held (fail closed). */
  private isClaimed(id: string): boolean {
    try {
      return this.deps.claimedByOthers().has(id);
    } catch (error) {
      this.deps.log(`could not read the claimed thread ids (${describeError(error)})`);
      return true;
    }
  }

  private isSiblingInDirectory(rotating: boolean): boolean {
    try {
      return this.deps.siblingInDirectory?.(rotating) ?? false;
    } catch (error) {
      this.deps.log(`could not read the sibling sessions (${describeError(error)})`);
      return true;
    }
  }

  /** Say `text` to the user as a system message, once per `kind` for the session. */
  private tell(kind: string, text: string): void {
    if (this.told.has(kind)) return;
    this.told.add(kind);
    try {
      this.deps.notice?.(text);
    } catch (error) {
      this.deps.log(`could not send a notice (${describeError(error)})`);
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
    this.pendingTimer = setTimeout(
      () => this.commit(),
      this.deps.ambiguityMs ?? AMBIGUITY_WINDOW_MS,
    );
  }

  private commit(): void {
    const candidate = this.pending;
    this.pending = null;
    if (candidate === null || this.disposed) return;
    if (this.current !== null && this.trackedStatus?.type === 'active') return;
    const { id } = candidate.thread;
    // The checks that decide a binding run now, not when the frame arrived: another session
    // may have taken the thread, or a sibling may have started, during the window.
    if (this.isClaimed(id)) {
      this.deps.log(`thread ${short(id)} is held by another session; not binding`);
      return;
    }
    const rotating = this.current !== null;
    if (this.isSiblingInDirectory(rotating)) {
      if (rotating) {
        this.deps.log(ROTATION_BLOCKED);
        this.tell('sibling-rotation', ROTATION_BLOCKED);
      } else {
        this.deps.log(
          'another remi codex session in this directory is starting or has no thread yet; not binding',
        );
        this.tell('sibling-first', FIRST_BIND_BLOCKED);
      }
      return;
    }
    try {
      this.deps.onIdentity(id);
    } catch (error) {
      if (error instanceof ThreadClaimedError) {
        this.rejected.add(id);
        this.deps.log(`thread ${short(id)} is claimed by another session; not binding`);
      } else {
        this.deps.log(`could not record the thread id (${describeError(error)})`);
      }
      return;
    }
    const previous = this.current;
    this.current = id;
    // The old thread's subagents are not this one's; threads that started before it was known are.
    this.descendants.clear();
    for (const [child, parent] of [...this.pendingLinks]) {
      if (parent === id) this.adopt(child);
    }
    this.isAttached = false;
    this.trackedStatus = null;
    this.failures = 0;
    this.deps.log(
      previous === null
        ? `identity: thread ${short(id)}`
        : `rotated from ${short(previous)} to ${short(id)}`,
    );
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
    if (this.resumeUnavailable) return;
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
        try {
          this.deps.onAttached?.(id);
        } catch (error) {
          this.deps.log(`attach callback failed (${describeError(error)})`);
        }
      },
      (error: unknown) => {
        this.attaching = false;
        if (this.disposed) return;
        if (this.current !== id) {
          this.attach();
          return;
        }
        if (error instanceof AppServerRpcError && error.code === METHOD_NOT_FOUND) {
          this.resumeUnavailable = true;
          this.deps.log(
            'thread/resume is not available on this app-server; not retrying until it reconnects',
          );
          return;
        }
        this.failures += 1;
        if (this.failures === 1 || this.failures % 30 === 0) {
          this.deps.log(
            `thread/resume for ${short(id)} failed (${describeError(error)}); retrying (attempt ${this.failures})`,
          );
        }
        const period = this.deps.retryMs ?? 1000;
        this.retryTimer = setTimeout(
          () => this.attach(),
          this.failures >= BACKOFF_AFTER_FAILURES ? period * RETRY_BACKOFF_FACTOR : period,
        );
      },
    );
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
