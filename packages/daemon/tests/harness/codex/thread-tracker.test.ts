/**
 * `ThreadTracker` against the real `AppServerClient` and the `FakeAppServer`
 * (a real WebSocket server on a unix socket replaying redacted spike frames).
 * Nothing the tracker calls is replaced: its client is the real one, so what a
 * test sees on the fake server is what Codex would see. Frames are the real
 * `thread/started` frames of the spike, re-addressed (tests/helpers/codex-threads.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from '../../../src/harness/codex/app-server-client.ts';
import type { ThreadStatus } from '../../../src/harness/codex/thread-protocol.ts';
import { ThreadClaimedError, ThreadTracker } from '../../../src/harness/codex/thread-tracker.ts';
import { type Json, threadStartedFrame, threadStatusFrame } from '../../helpers/codex-threads.ts';
import { FakeAppServer } from '../../helpers/fake-app-server.ts';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** A tweak that sets one field of a frame's `thread`. */
const setKey =
  (key: string, value: unknown) =>
  (t: Json): void => {
    t[key] = value;
  };

interface Ctx {
  server: FakeAppServer;
  client: AppServerClient;
  tracker: ThreadTracker;
  /** The session's directory, as realpath resolves it. */
  cwd: string;
  /** Another directory that exists, for a thread that is not this session's. */
  otherDir: string;
  identities: string[];
  /** When each identity was committed, in `Date.now()` terms. */
  identityAt: number[];
  statuses: Array<{ id: string; status: ThreadStatus }>;
  logs: string[];
  /** What the tracker asked to tell the user (system messages). */
  notices: string[];
  /** The `rotating` argument of each sibling question the tracker asked. */
  siblingAsked: boolean[];
  claimed: Set<string>;
  /** The frames the tracker's client sent for `thread/resume`, across connections. */
  resumeFrames(): Json[];
  /** Emit a `thread/started` to every connection. */
  started(
    kind: 'tui' | 'title',
    id: string,
    tweak?: (t: Json) => void,
    createdAtSec?: number,
  ): void;
  status(id: string, status: Json): void;
  /** How many times the tracker logged a successful attach. */
  attachCount(): number;
  /** The thread id of each `onAttached` call, in order. */
  attached: string[];
}

interface Options {
  expected?: string | null;
  throwOnIdentity?: boolean;
  /** `onIdentity` throws this instead (a thread the store says another session holds). */
  identityError?: Error;
  claimedThrows?: boolean;
  /** Answers "is another remi codex session in this directory in the way?", for a rotation or a first bind. */
  siblingInDirectory?: (rotating: boolean) => boolean;
  /** How long after ready a session with no thread waits before saying so. */
  noIdentityMs?: number;
  /** The ambiguity window; 'default' leaves it to the tracker's own (300 ms). */
  ambiguityMs?: number | 'default';
  /** The notice callback throws (a client the message cannot be sent to). */
  noticeThrows?: boolean;
  retryMs?: number;
  spawnedAtMs?: number;
  /** `onAttached` throws (a callback that fails must not break the attach). */
  attachedThrows?: boolean;
}

async function setup(opts: Options = {}): Promise<Ctx> {
  const server = FakeAppServer.start();
  cleanups.push(() => server.stop());
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'remi-tracker-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'project');
  const otherDir = join(base, 'elsewhere');
  for (const dir of [cwd, otherDir]) await Bun.write(join(dir, '.keep'), '');

  const identities: string[] = [];
  const identityAt: number[] = [];
  const statuses: Ctx['statuses'] = [];
  const logs: string[] = [];
  const notices: string[] = [];
  const siblingAsked: boolean[] = [];
  const attached: string[] = [];
  const claimed = new Set<string>();
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const client = new AppServerClient(
    {
      socketPath: () => server.socketPath,
      clientInfo: { name: 'remi', title: null, version: 'test' },
      backoff: { initialMs: 10, maxMs: 40 },
    },
    (event) => {
      if (event.type === 'ready') {
        tracker.handleReady();
        ready();
      } else if (event.type === 'disconnected') {
        tracker.handleDisconnected();
      } else if (event.type === 'notification') {
        tracker.handleNotification(event.method, event.params);
      }
    },
  );
  cleanups.push(() => client.stop());
  const tracker = new ThreadTracker({
    client,
    sessionCwd: cwd,
    spawnedAtMs: opts.spawnedAtMs ?? Date.now(),
    expectedThreadId: opts.expected ?? null,
    claimedByOthers: () => {
      if (opts.claimedThrows) throw new Error('the store is unavailable');
      return claimed;
    },
    onIdentity: (id) => {
      if (opts.identityError) throw opts.identityError;
      if (opts.throwOnIdentity) throw new Error('the store is unavailable');
      identities.push(id);
      identityAt.push(Date.now());
    },
    siblingInDirectory: (rotating) => {
      siblingAsked.push(rotating);
      return (opts.siblingInDirectory ?? (() => false))(rotating);
    },
    notice: (m) => {
      if (opts.noticeThrows) throw new Error('the message cannot be sent');
      notices.push(m);
    },
    onStatus: (id, status) => statuses.push({ id, status }),
    onAttached: (id) => {
      attached.push(id);
      if (opts.attachedThrows) throw new Error('the callback failed');
    },
    log: (m) => logs.push(m),
    retryMs: opts.retryMs ?? 40,
    ...(opts.ambiguityMs === 'default' ? {} : { ambiguityMs: opts.ambiguityMs ?? 150 }),
    ...(opts.noIdentityMs !== undefined ? { noIdentityMs: opts.noIdentityMs } : {}),
  });
  cleanups.push(() => tracker.dispose());
  client.start();
  await isReady;

  return {
    server,
    client,
    tracker,
    cwd,
    otherDir,
    identities,
    identityAt,
    statuses,
    logs,
    notices,
    siblingAsked,
    claimed,
    resumeFrames: () =>
      server.received.filter((r) => r.frame['method'] === 'thread/resume').map((r) => r.frame),
    started: (kind, id, tweak, createdAtSec) =>
      server.emit(
        threadStartedFrame(kind, { id, cwd, createdAtSec: createdAtSec ?? nowSec() }, tweak),
        {
          broadcast: true,
        },
      ),
    status: (id, status) => server.emit(threadStatusFrame(id, status), { broadcast: true }),
    attachCount: () => logs.filter((l) => l.startsWith('attached to thread')).length,
    attached,
  };
}

/**
 * Which of `ids` the tracker treats as this session's threads: a status for each is sent, and
 * the ones that reach `onStatus` are ours. Asked this way so the tests need no accessor that
 * only they would call.
 */
async function oursOf(ctx: Ctx, ids: string[]): Promise<Set<string>> {
  const before = ctx.statuses.length;
  for (const id of ids) ctx.status(id, { type: 'active', activeFlags: ['probe'] });
  await settle(350);
  return new Set(
    ctx.statuses
      .slice(before)
      .filter((s) => s.status.type === 'active' && s.status.activeFlags.includes('probe'))
      .map((s) => s.id),
  );
}

const waitUntil = (ctx: Ctx, predicate: () => boolean, what: string, timeoutMs = 4000) =>
  ctx.server.waitFor(predicate, what, timeoutMs);
const settle = (ms = 330) => Bun.sleep(ms);

describe('identity discovery', () => {
  test('the TUI thread binds once, after the window, and the attach frame is exactly {threadId, excludeTurns}', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    ctx.started('tui', id);

    // Not committed at once: the window is what lets a second candidate be seen.
    expect(ctx.identities).toEqual([]);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.identities).toEqual([id]);
    await waitUntil(ctx, () => ctx.resumeFrames().length >= 1, 'the first thread/resume');
    expect(ctx.resumeFrames()[0]?.['params']).toStrictEqual({ threadId: id, excludeTurns: true });
  });

  test('a thread of the legacy shape (no source, but a rollout path) binds', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    ctx.started('tui', id, (t) => {
      t['threadSource'] = null;
    });
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.identities).toEqual([id]);
  });

  /** Each frame breaks exactly one rule, so removing any one rule makes it bind. */
  const violations: Array<[string, (ctx: Ctx) => (t: Json) => void, number?]> = [
    ['is ephemeral', () => setKey('ephemeral', true)],
    ['comes from the title helper', () => setKey('threadSource', 'thread_title')],
    ['has another source', () => setKey('threadSource', 'exec')],
    [
      'has neither a source nor a path',
      () => (t) => {
        t['threadSource'] = null;
        t['path'] = null;
      },
    ],
    ['has no environment', () => setKey('environments', [])],
    ['has a parent', () => setKey('parentThreadId', crypto.randomUUID())],
    ['is in another directory', (c) => setKey('cwd', c.otherDir)],
    ['has a directory that does not exist', (c) => setKey('cwd', join(c.cwd, 'gone'))],
    ['was created long before the spawn', () => () => {}, nowSec() - 60],
    [
      'is claimed by another remi session',
      (c) => (t) => {
        c.claimed.add(t['id'] as string);
      },
    ],
  ];
  for (const [name, tweak, createdAtSec] of violations) {
    test(`a thread that ${name} is not this session's, and the real one still binds`, async () => {
      const ctx = await setup();
      const stray = crypto.randomUUID();
      const real = crypto.randomUUID();
      ctx.started('tui', stray, tweak(ctx), createdAtSec);
      ctx.started('tui', real);
      await waitUntil(ctx, () => ctx.identities.length >= 1, 'an identity');
      await settle();
      expect(ctx.identities).toEqual([real]);
    });
  }

  test('a thread created within 5 s before the spawn still counts (the slack)', async () => {
    const spawnedAtMs = Date.now();
    const ctx = await setup({ spawnedAtMs });
    const id = crypto.randomUUID();
    ctx.started('tui', id, undefined, Math.floor((spawnedAtMs - 4000) / 1000));
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.identities).toEqual([id]);
  });

  test('two candidates created together bind neither, and the session stays without an identity', async () => {
    const ctx = await setup();
    const sec = nowSec();
    ctx.started('tui', crypto.randomUUID(), undefined, sec);
    ctx.started('tui', crypto.randomUUID(), undefined, sec);
    await settle(420);
    expect(ctx.identities).toEqual([]);
    expect(ctx.resumeFrames()).toEqual([]);
    expect(ctx.logs.some((l) => l.includes('binding neither'))).toBe(true);

    // Fail closed for good: a later, unambiguous thread does not rescue it.
    ctx.started('tui', crypto.randomUUID());
    await settle(420);
    expect(ctx.identities).toEqual([]);
  });

  test('ambiguity is decided by arrival: two distinct candidates inside the window bind neither, whatever their creation times (W4)', async () => {
    // createdAt has whole-second resolution in the real frames, so "created within 300 ms" can
    // only ever have meant "the same second". What the tracker can see is when they arrived.
    const sec = nowSec();
    for (const apartSec of [0, 1, 5]) {
      const ctx = await setup();
      ctx.started('tui', crypto.randomUUID(), undefined, sec);
      ctx.started('tui', crypto.randomUUID(), undefined, sec + apartSec);
      await settle(420);
      expect(ctx.identities, `${apartSec} s apart`).toEqual([]);
      expect(ctx.logs.some((l) => l.includes('binding neither'))).toBe(true);
    }
  });

  test('a candidate that arrives after the window is not part of it: the first has bound by then', async () => {
    const ctx = await setup();
    const first = crypto.randomUUID();
    ctx.started('tui', first);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the first identity');
    ctx.status(first, { type: 'active', activeFlags: [] });
    await settle(100);
    // Tracked and active: the later candidate is ignored (not ambiguous, not bound).
    ctx.started('tui', crypto.randomUUID());
    await settle(420);
    expect(ctx.identities).toEqual([first]);
    expect(ctx.logs.some((l) => l.includes('binding neither'))).toBe(false);
  });

  test('the production window is 300 ms: nothing binds sooner (W4)', async () => {
    const ctx = await setup({ ambiguityMs: 'default' });
    const sent = Date.now();
    ctx.started('tui', crypto.randomUUID());
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    // A timer is never early, so load can only make this bound easier to meet, never fail it.
    expect((ctx.identityAt[0] as number) - sent).toBeGreaterThanOrEqual(270);
  });

  test("an ambiguity ends the first candidate's window: a later candidate keeps a whole window of its own (W4)", async () => {
    const ctx = await setup({ ambiguityMs: 600 });
    const tracked = crypto.randomUUID();
    ctx.started('tui', tracked);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the first identity');
    ctx.status(tracked, { type: 'idle' });
    await settle(100);

    // A and B arrive together: ambiguous, neither binds. A's own timer must not outlive that.
    ctx.started('tui', crypto.randomUUID());
    ctx.started('tui', crypto.randomUUID());
    await settle(150);
    // C opens a window (to +750 ms). D arrives at +675 ms: after A's timer would have fired,
    // inside C's window, so C and D are ambiguous as well.
    ctx.started('tui', crypto.randomUUID());
    await settle(525);
    ctx.started('tui', crypto.randomUUID());
    await settle(1000);
    expect(ctx.identities).toEqual([tracked]);
    expect(ctx.logs.filter((l) => l.includes('binding neither'))).toHaveLength(2);
  }, 15000);

  test('a duplicate thread/started for the same thread is one candidate, not an ambiguity (W5)', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    const sec = nowSec();
    // Two identical frames inside the window (a replay, a reconnect that re-sent the start).
    ctx.started('tui', id, undefined, sec);
    ctx.started('tui', id, undefined, sec);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    await settle(420);
    expect(ctx.identities).toEqual([id]);
    expect(ctx.logs.some((l) => l.includes('binding neither'))).toBe(false);

    // And it did not latch the refusal: after the thread goes idle, a later thread rotates it.
    ctx.status(id, { type: 'idle' });
    await settle(100);
    const next = crypto.randomUUID();
    ctx.started('tui', next);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation');
    expect(ctx.identities).toEqual([id, next]);
  });

  test('a callback that throws leaves the tracker without the id, and says so', async () => {
    const ctx = await setup({ throwOnIdentity: true });
    ctx.started('tui', crypto.randomUUID());
    await waitUntil(ctx, () => ctx.logs.some((l) => l.includes('could not record')), 'the log');
    await settle(200);
    expect(ctx.resumeFrames()).toEqual([]);
  });

  test('a repeated thread/started for the tracked thread changes nothing', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    ctx.status(id, { type: 'idle' });
    await settle(100);
    ctx.started('tui', id);
    await settle(420);
    expect(ctx.identities).toEqual([id]);
  });

  test('when the claimed ids cannot be read, nothing binds, and it says so', async () => {
    const ctx = await setup({ claimedThrows: true });
    ctx.started('tui', crypto.randomUUID());
    await waitUntil(ctx, () => ctx.logs.some((l) => l.includes('claimed thread ids')), 'the log');
    await settle(500);
    expect(ctx.identities).toEqual([]);
  });

  test('a known thread (resume) needs no thread/started: it attaches on ready and records nothing', async () => {
    const known = crypto.randomUUID();
    const ctx = await setup({ expected: known });
    await waitUntil(ctx, () => ctx.resumeFrames().length >= 1, 'thread/resume on ready');
    expect(ctx.resumeFrames()[0]?.['params']).toStrictEqual({
      threadId: known,
      excludeTurns: true,
    });
    expect(ctx.identities).toEqual([]);

    // The title helper beside it changes nothing.
    ctx.started('title', crypto.randomUUID());
    await settle();
    // Still the known thread, and only the known thread, that it keeps trying to attach to.
    expect(ctx.identities).toEqual([]);
    for (const frame of ctx.resumeFrames()) {
      expect(frame['params']).toStrictEqual({ threadId: known, excludeTurns: true });
    }
  });
});

describe('rotation (/new in the TUI)', () => {
  test('a later candidate rotates the binding when the tracked thread is not active', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the first identity');
    ctx.status(a, { type: 'idle' });
    await settle(100);

    ctx.started('tui', b);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation');
    expect(ctx.identities).toEqual([a, b]);
    await waitUntil(
      ctx,
      () => ctx.resumeFrames().some((f) => (f['params'] as Json)['threadId'] === b),
      'the attach of the new thread',
    );
  });

  test('no rotation while the tracked thread is active; after it goes idle a candidate rotates', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the first identity');

    ctx.status(a, { type: 'active', activeFlags: [] });
    await settle(100);
    ctx.started('tui', crypto.randomUUID());
    await settle(420);
    expect(ctx.identities).toEqual([a]);
    expect(ctx.logs.some((l) => l.includes('while the tracked thread is active'))).toBe(true);

    ctx.status(a, { type: 'idle' });
    await settle(100);
    const c = crypto.randomUUID();
    ctx.started('tui', c);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation after idle');
    expect(ctx.identities).toEqual([a, c]);
  });

  test('a tracked thread that turns active inside the window is not rotated away', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the first identity');
    ctx.status(a, { type: 'idle' });
    await settle(100);

    ctx.started('tui', crypto.randomUUID());
    ctx.status(a, { type: 'active', activeFlags: [] });
    await settle(420);
    expect(ctx.identities).toEqual([a]);
  });

  test('two candidates together leave an existing binding alone, and a later one still rotates', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the first identity');
    ctx.status(a, { type: 'idle' });
    await settle(100);

    const sec = nowSec();
    ctx.started('tui', crypto.randomUUID(), undefined, sec);
    ctx.started('tui', crypto.randomUUID(), undefined, sec);
    await settle(420);
    expect(ctx.identities).toEqual([a]);

    const d = crypto.randomUUID();
    ctx.started('tui', d);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'a rotation after the ambiguity');
    expect(ctx.identities).toEqual([a, d]);
  });
});

describe('attach', () => {
  test('it is retried on -32600 with the same exact frame until the rollout exists, then it stops', async () => {
    const ctx = await setup({ retryMs: 40 });
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.resumeFrames().length >= 3, 'retried thread/resume frames');
    expect(ctx.attachCount()).toBe(0);

    ctx.server.createRollout(id);
    await waitUntil(ctx, () => ctx.attachCount() === 1, 'the attach');
    expect(ctx.logs.some((l) => l.includes(`attached to thread ${id.slice(-8)}`))).toBe(true);
    const count = ctx.resumeFrames().length;
    await settle(400);
    expect(ctx.resumeFrames()).toHaveLength(count);
    for (const frame of ctx.resumeFrames()) {
      expect(frame['params']).toStrictEqual({ threadId: id, excludeTurns: true });
    }
  });

  test('the tracked thread turning active retries at once, whatever the period', async () => {
    const ctx = await setup({ retryMs: 60_000 });
    const id = crypto.randomUUID();
    const other = crypto.randomUUID();
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.resumeFrames().length === 1, 'the first thread/resume');

    // Another thread going active is no reason to retry, nor is a subagent of this one.
    ctx.status(other, { type: 'active', activeFlags: [] });
    const child = crypto.randomUUID();
    ctx.started('tui', child, setKey('parentThreadId', id));
    ctx.status(child, { type: 'active', activeFlags: [] });
    await settle(300);
    expect(ctx.resumeFrames()).toHaveLength(1);

    ctx.status(id, { type: 'active', activeFlags: ['waitingOnApproval'] });
    await waitUntil(ctx, () => ctx.resumeFrames().length === 2, 'the retry on the active status');
  });

  test('any error is retried, not only -32600', async () => {
    const ctx = await setup({ retryMs: 40 });
    ctx.server.onRequest('thread/resume', () => {
      throw { code: -32603, message: 'internal error' };
    });
    ctx.started('tui', crypto.randomUUID());
    await waitUntil(ctx, () => ctx.resumeFrames().length >= 3, 'retries after another error');
    expect(ctx.logs.some((l) => l.includes('code -32603'))).toBe(true);
    // One line for the first failure, not one per second for the life of the session.
    expect(ctx.logs.filter((l) => l.includes('thread/resume'))).toHaveLength(1);
  });

  test('after the link drops and returns it attaches again, on the new connection', async () => {
    const ctx = await setup({ retryMs: 40 });
    const id = crypto.randomUUID();
    ctx.server.createRollout(id);
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.attachCount() === 1, 'the first attach');
    const firstClient = ctx.server.clientIds()[0] as number;

    ctx.server.dropClient(firstClient);
    await waitUntil(ctx, () => ctx.attachCount() === 2, 'the attach on the new connection');
    const newClient = ctx.server.clientIds().find((c) => c !== firstClient);
    expect(newClient).toBeDefined();
    expect(
      ctx.server
        .framesFrom(newClient as number)
        .filter((f) => f['method'] === 'thread/resume')[0]?.['params'],
    ).toStrictEqual({ threadId: id, excludeTurns: true });
  });

  test('handleDisconnected forgets the attach and handleReady attaches again', async () => {
    const ctx = await setup({ retryMs: 40 });
    const id = crypto.randomUUID();
    ctx.server.createRollout(id);
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.attachCount() === 1, 'the attach');
    const frames = ctx.resumeFrames().length;

    ctx.tracker.handleDisconnected();
    await settle(150);
    expect(ctx.resumeFrames()).toHaveLength(frames);

    ctx.tracker.handleReady();
    await waitUntil(ctx, () => ctx.resumeFrames().length === frames + 1, 'the new attach');
    await waitUntil(ctx, () => ctx.attachCount() === 2, 'attached again');
  });

  test('a method the app-server does not have (-32601) is logged once and not retried until the next ready (W10)', async () => {
    const ctx = await setup({ retryMs: 40 });
    ctx.server.onRequest('thread/resume', () => {
      throw { code: -32601, message: 'method not found' };
    });
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.resumeFrames().length === 1, 'the first thread/resume');
    // Neither the timer nor the tracked thread going active retries it.
    ctx.status(id, { type: 'active', activeFlags: [] });
    await settle(400);
    expect(ctx.resumeFrames()).toHaveLength(1);
    expect(ctx.logs.filter((l) => l.includes('not available'))).toHaveLength(1);

    // A new connection may be a newer server: one more try, and again no retry.
    ctx.tracker.handleDisconnected();
    ctx.tracker.handleReady();
    await waitUntil(ctx, () => ctx.resumeFrames().length === 2, 'the try after ready');
    await settle(300);
    expect(ctx.resumeFrames()).toHaveLength(2);
  });

  test('after ten failures the retry slows to five times the period (W10)', async () => {
    const ctx = await setup({ retryMs: 20 });
    const at: number[] = [];
    ctx.server.onRequest('thread/resume', () => {
      at.push(Date.now());
      throw { code: -32600, message: 'no rollout found' };
    });
    ctx.started('tui', crypto.randomUUID());
    await waitUntil(ctx, () => at.length >= 13, 'thirteen attempts', 8000);
    const gap = (i: number) => (at[i + 1] as number) - (at[i] as number);
    // Failure k schedules the gap after attempt k, so the 10th failure is the first slowed one:
    // gap(9) and every gap after are 5 x 20 ms. Timers are never early, so these lower bounds
    // hold under load, and a backoff that starts one failure late fails gap(9).
    expect(gap(9)).toBeGreaterThanOrEqual(80);
    expect(gap(10)).toBeGreaterThanOrEqual(80);
    // The first ten attempts ran at the plain period, so the first slowed gap is well above the
    // typical earlier one. A ratio, not a wall-clock bound: a busy machine stretches both. A
    // backoff that starts at the first failure makes eight of the nine earlier gaps 100 ms.
    const earlier = Array.from({ length: 9 }, (_, i) => gap(i)).sort((x, y) => x - y);
    expect(gap(9)).toBeGreaterThan(2 * (earlier[4] as number));
  });

  /** Every attempt fails with -32600; what the tests below read is when, and for which thread. */
  function failingAttempts(ctx: Ctx): Array<{ id: unknown; at: number }> {
    const attempts: Array<{ id: unknown; at: number }> = [];
    ctx.server.onRequest('thread/resume', (params) => {
      attempts.push({ id: (params as Json)['threadId'], at: Date.now() });
      throw { code: -32600, message: 'no rollout found' };
    });
    return attempts;
  }

  test('a new connection starts the period over, whatever the failures before it (W10)', async () => {
    const ctx = await setup({ retryMs: 60 });
    const attempts = failingAttempts(ctx);
    ctx.started('tui', crypto.randomUUID());
    await waitUntil(ctx, () => attempts.length >= 12, 'twelve attempts', 15000);
    const slowed = (attempts[11] as { at: number }).at - (attempts[10] as { at: number }).at;
    expect(slowed).toBeGreaterThanOrEqual(250);

    ctx.tracker.handleDisconnected();
    ctx.tracker.handleReady();
    await waitUntil(ctx, () => attempts.length >= 14, 'two more attempts', 15000);
    const restarted = (attempts[13] as { at: number }).at - (attempts[12] as { at: number }).at;
    expect(restarted).toBeLessThan(slowed / 2);
  }, 30000);

  test('a rotation starts the period over for the new thread (W10)', async () => {
    const ctx = await setup({ retryMs: 60 });
    const attempts = failingAttempts(ctx);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => attempts.length >= 12, 'twelve attempts', 15000);
    const slowed = (attempts[11] as { at: number }).at - (attempts[10] as { at: number }).at;
    expect(slowed).toBeGreaterThanOrEqual(250);

    ctx.started('tui', b);
    const forB = () => attempts.filter((x) => x.id === b);
    await waitUntil(ctx, () => forB().length >= 2, 'two attempts for the new thread', 15000);
    expect((forB()[1] as { at: number }).at - (forB()[0] as { at: number }).at).toBeLessThan(
      slowed / 2,
    );
  }, 30000);

  test('the status in the resume result is applied', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    ctx.server.createRollout(id);
    ctx.started('tui', id, (t) => {
      t['status'] = null;
    });
    await waitUntil(ctx, () => ctx.attachCount() === 1, 'the attach');
    expect(ctx.statuses.some((s) => s.id === id)).toBe(true);
  });
});

describe('status', () => {
  test('the tracked thread and its descendants report; other threads do not', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const child = crypto.randomUUID();
    const grandchild = crypto.randomUUID();
    const unrelated = crypto.randomUUID();
    const orphanChild = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    ctx.statuses.length = 0;

    ctx.started('tui', child, setKey('parentThreadId', a));
    ctx.started('tui', grandchild, setKey('parentThreadId', child));
    ctx.started('tui', orphanChild, setKey('parentThreadId', crypto.randomUUID()));
    for (const id of [a, child, grandchild, unrelated, orphanChild]) {
      ctx.status(id, { type: 'active', activeFlags: ['waitingOnApproval'] });
    }
    await waitUntil(ctx, () => ctx.statuses.length >= 3, 'three statuses');
    await settle(200);
    expect(ctx.statuses.map((s) => s.id).sort()).toEqual([a, child, grandchild].sort());
  });

  test('a chain of subagents counts however deep it goes, in order of arrival', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    const chain = Array.from({ length: 12 }, () => crypto.randomUUID());
    chain.forEach((id, i) => {
      ctx.started('tui', id, setKey('parentThreadId', i === 0 ? a : chain[i - 1]));
    });
    await settle(300);
    const ours = await oursOf(ctx, chain);
    expect(ours.size).toBe(12);
  });

  test('a subagent seen before its parent counts once the parent is known to be ours', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const child = crypto.randomUUID();
    const grandchild = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    // The grandchild's start arrives before its parent's: nothing says it is ours yet.
    ctx.started('tui', grandchild, setKey('parentThreadId', child));
    await settle(150);
    expect((await oursOf(ctx, [grandchild])).size).toBe(0);
    ctx.started('tui', child, setKey('parentThreadId', a));
    await settle(150);
    expect((await oursOf(ctx, [child, grandchild])).size).toBe(2);
  });

  test('threads that started before the tracked thread was known are adopted when it binds', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const child = crypto.randomUUID();
    // The child's start arrives inside the window, before the parent has committed.
    ctx.started('tui', a);
    ctx.started('tui', child, setKey('parentThreadId', a));
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    await settle(150);
    expect((await oursOf(ctx, [child])).size).toBe(1);
  });

  test("other windows' subagents never become ours, and a rotation drops the old thread's", async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const child = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    ctx.started('tui', child, setKey('parentThreadId', a));
    ctx.started('tui', foreign, setKey('parentThreadId', crypto.randomUUID()));
    await settle(150);
    const before = await oursOf(ctx, [a, child, foreign]);
    expect([before.has(a), before.has(child), before.has(foreign)]).toEqual([true, true, false]);

    ctx.status(a, { type: 'idle' });
    await settle(100);
    const b = crypto.randomUUID();
    ctx.started('tui', b);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation');
    const after = await oursOf(ctx, [a, child, b]);
    expect([after.has(a), after.has(child), after.has(b)]).toEqual([false, false, true]);
  });

  test("520 links of other windows' threads do not push our subagent out of the memory (W9)", async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const child = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    ctx.started('tui', child, setKey('parentThreadId', a));
    // One memory shared by foreign and own links used to evict ours after 512 foreign ones.
    for (let i = 0; i < 520; i++) {
      ctx.started('tui', crypto.randomUUID(), setKey('parentThreadId', crypto.randomUUID()));
    }
    await settle(500);
    expect((await oursOf(ctx, [child])).size).toBe(1);
  });

  test('our own subagents are bounded too: of 300, the oldest 44 are forgotten', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    const children = Array.from({ length: 300 }, () => crypto.randomUUID());
    for (const id of children) ctx.started('tui', id, setKey('parentThreadId', a));
    await settle(500);
    const ours = await oursOf(ctx, [
      children[0],
      children[43],
      children[44],
      children[299],
    ] as string[]);
    expect([0, 43, 44, 299].map((i) => ours.has(children[i] as string))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  test('a subagent pushed out of the memory is reported idle, so the session does not keep its last status (R7)', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    const children = Array.from({ length: 257 }, () => crypto.randomUUID());
    for (const id of children.slice(0, 256)) ctx.started('tui', id, setKey('parentThreadId', a));
    await settle(500);
    const first = children[0] as string;
    ctx.status(first, { type: 'active', activeFlags: ['waitingOnApproval'] });
    await waitUntil(
      ctx,
      () => ctx.statuses.some((s) => s.id === first && s.status.type === 'active'),
      'the first subagent to be active',
    );

    // The 257th pushes the first out. Its frames are ignored from now on, so whatever it last
    // said must not stand: it is reported idle once, at the moment it is forgotten.
    ctx.started('tui', children[256] as string, setKey('parentThreadId', a));
    await waitUntil(
      ctx,
      () => ctx.statuses.some((s) => s.id === first && s.status.type === 'idle'),
      'the evicted subagent to be reported idle',
    );
    const mine = ctx.statuses.filter((s) => s.id === first);
    expect(mine.map((s) => s.status.type)).toEqual(['active', 'idle']);
    // Nobody else was swept up: the second subagent is still ours.
    expect((await oursOf(ctx, [children[1] as string])).size).toBe(1);
  });

  /** A link whose parent is nobody's we know: it fills the memory of links waiting for a parent. */
  const foreignLinks = (ctx: Ctx, n: number): void => {
    for (let i = 0; i < n; i++) {
      ctx.started('tui', crypto.randomUUID(), setKey('parentThreadId', crypto.randomUUID()));
    }
  };

  /** `parent` turns out to descend from the tracked thread, which adopts the links waiting on it. */
  const parentIsOurs = (ctx: Ctx, parent: string, tracked: string): void =>
    ctx.started('tui', parent, setKey('parentThreadId', tracked));

  describe('the memory of links waiting for a parent holds 512 and forgets the oldest first (W9)', () => {
    async function tracked() {
      const ctx = await setup();
      const a = crypto.randomUUID();
      ctx.started('tui', a);
      await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
      return { ctx, a };
    }

    test('512 links are all kept: the first of them still counts once its parent is ours', async () => {
      const { ctx, a } = await tracked();
      const child = crypto.randomUUID();
      const parent = crypto.randomUUID();
      ctx.started('tui', child, setKey('parentThreadId', parent));
      foreignLinks(ctx, 511);
      await settle(600);
      parentIsOurs(ctx, parent, a);
      await settle(300);
      expect((await oursOf(ctx, [child, parent])).size).toBe(2);
    });

    test('the 513th pushes out the oldest', async () => {
      const { ctx, a } = await tracked();
      const child = crypto.randomUUID();
      const parent = crypto.randomUUID();
      ctx.started('tui', child, setKey('parentThreadId', parent));
      foreignLinks(ctx, 512);
      await settle(600);
      parentIsOurs(ctx, parent, a);
      await settle(300);
      const ours = await oursOf(ctx, [child, parent]);
      expect([ours.has(child), ours.has(parent)]).toEqual([false, true]);
    });

    test('a link seen again is the newest again', async () => {
      const { ctx, a } = await tracked();
      const child = crypto.randomUUID();
      const parent = crypto.randomUUID();
      ctx.started('tui', child, setKey('parentThreadId', parent));
      foreignLinks(ctx, 511);
      // Seen again (a replay): it moves to the back, so the next link pushes out another one.
      ctx.started('tui', child, setKey('parentThreadId', parent));
      foreignLinks(ctx, 1);
      await settle(600);
      parentIsOurs(ctx, parent, a);
      await settle(300);
      expect((await oursOf(ctx, [child])).size).toBe(1);
    });

    test('a link that was adopted no longer takes a place', async () => {
      const { ctx, a } = await tracked();
      const kept = crypto.randomUUID();
      const keptParent = crypto.randomUUID();
      const adopted = crypto.randomUUID();
      const adoptedParent = crypto.randomUUID();
      ctx.started('tui', kept, setKey('parentThreadId', keptParent));
      ctx.started('tui', adopted, setKey('parentThreadId', adoptedParent));
      // Its parent descends from the tracked thread: the link is used up and leaves the memory.
      parentIsOurs(ctx, adoptedParent, a);
      foreignLinks(ctx, 511);
      await settle(600);
      parentIsOurs(ctx, keptParent, a);
      await settle(300);
      expect((await oursOf(ctx, [kept, adopted])).size).toBe(2);
    });
  });

  test('a subagent seen again is the newest again, in the memory of our own', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    const children = Array.from({ length: 257 }, () => crypto.randomUUID());
    for (const id of children.slice(0, 256)) ctx.started('tui', id, setKey('parentThreadId', a));
    // The oldest is seen again, so the 257th pushes out the second-oldest instead.
    ctx.started('tui', children[0] as string, setKey('parentThreadId', a));
    ctx.started('tui', children[256] as string, setKey('parentThreadId', a));
    await settle(600);
    const ours = await oursOf(ctx, [children[0], children[1], children[256]] as string[]);
    expect([0, 1, 256].map((i) => ours.has(children[i] as string))).toEqual([true, false, true]);
  });

  test('a status that arrives during the window is delivered when the thread commits', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    ctx.status(id, { type: 'active', activeFlags: ['waitingOnApproval'] });
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.statuses.at(-1)).toEqual({
      id,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    });
  });

  test('a thread that is not tracked yet reports no status', async () => {
    const ctx = await setup();
    ctx.status(crypto.randomUUID(), { type: 'active', activeFlags: [] });
    await settle(200);
    expect(ctx.statuses).toEqual([]);
  });
});

describe('what it logs, and after dispose', () => {
  test('thread ids are logged cut to eight characters, and no other thread appears in a log', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    const helper = crypto.randomUUID();
    const stray = crypto.randomUUID();
    ctx.started('tui', stray, setKey('cwd', ctx.otherDir));
    ctx.started('title', helper);
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.identities.includes(id), 'the identity');
    await waitUntil(ctx, () => ctx.resumeFrames().length >= 2, 'a retry, which logs');
    const log = ctx.logs.join('\n');
    expect(log).toContain(id.slice(-8));
    expect(log).not.toContain(id);
    expect(log).not.toContain(helper.slice(-8));
    expect(log).not.toContain(stray.slice(-8));
    expect(log).not.toContain(ctx.cwd);
  });

  test('after dispose it binds nothing, attaches nothing and reports nothing', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    // The first attempt has failed (so no request is in flight to hide a later attach).
    await waitUntil(
      ctx,
      () => ctx.logs.some((l) => l.includes('thread/resume')),
      'the failed attach',
    );
    ctx.tracker.dispose();
    const frames = ctx.resumeFrames().length;
    const statuses = ctx.statuses.length;

    ctx.status(a, { type: 'active', activeFlags: [] });
    ctx.started('tui', crypto.randomUUID());
    ctx.tracker.handleReady();
    await settle(420);
    expect(ctx.resumeFrames()).toHaveLength(frames);
    expect(ctx.statuses).toHaveLength(statuses);
    expect(ctx.identities).toEqual([a]);
  });

  test('a candidate still inside its window is not committed after dispose', async () => {
    const ctx = await setup();
    ctx.started('tui', crypto.randomUUID());
    await settle(30);
    ctx.tracker.dispose();
    await settle(500);
    expect(ctx.identities).toEqual([]);
    expect(ctx.resumeFrames()).toEqual([]);
  });
});

describe('binding re-checks the claims, and a sibling session keeps us from taking its thread (W2)', () => {
  test('a thread that another session claimed while the window ran is not bound', async () => {
    const ctx = await setup();
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    // Free when the frame arrived, held by the time the window ends.
    await settle(40);
    ctx.claimed.add(id);
    await settle(420);
    expect(ctx.identities).toEqual([]);
    expect(ctx.resumeFrames()).toEqual([]);
    expect(ctx.logs.some((l) => l.includes('held by another session'))).toBe(true);
  });

  test('the claimed-thread error names the thread by its last eight characters (Q2)', () => {
    const id = '01a106f2-2f1c-7a35-9d4e-8b6f1c2d3e4a';
    expect(new ThreadClaimedError(id).message).toBe(
      'thread 1c2d3e4a is claimed by another session',
    );
    expect(new ThreadClaimedError(id).threadId).toBe(id);
  });

  test('a store that says another session holds the thread is logged as that, and the thread is not retried', async () => {
    const id = crypto.randomUUID();
    const ctx = await setup({ identityError: new ThreadClaimedError(id) });
    ctx.started('tui', id);
    await waitUntil(
      ctx,
      () => ctx.logs.some((l) => l.includes('claimed by another session')),
      'the log',
    );
    expect(ctx.logs.some((l) => l.includes('could not record'))).toBe(false);
    const attempts = ctx.logs.filter((l) => l.includes('claimed by another session')).length;

    // The same thread again (a replay): not tried again.
    ctx.started('tui', id);
    await settle(500);
    expect(ctx.logs.filter((l) => l.includes('claimed by another session'))).toHaveLength(attempts);
    expect(ctx.resumeFrames()).toEqual([]);
  });

  test('when the sibling sessions cannot be read, nothing binds, and it says so (W2)', async () => {
    const ctx = await setup({
      siblingInDirectory: () => {
        throw new Error('the store is unavailable');
      },
    });
    ctx.started('tui', crypto.randomUUID());
    await settle(500);
    expect(ctx.identities).toEqual([]);
    expect(ctx.resumeFrames()).toEqual([]);
    expect(ctx.logs.some((l) => l.includes('could not read the sibling sessions'))).toBe(true);
  });

  const FIRST_NOTICE =
    'another remi codex session in this directory is starting or has no thread yet; this session did not bind. Restart one of them if this persists.';
  const ROTATION_NOTICE =
    'a new thread appeared; another remi codex session shares this directory; not following it';

  test('a sibling session in the way blocks a first binding, drops the thread, and says what to do, once (R1, R2)', async () => {
    const ctx = await setup({ siblingInDirectory: () => true });
    ctx.started('tui', crypto.randomUUID());
    await settle(500);
    expect(ctx.identities).toEqual([]);
    expect(ctx.resumeFrames()).toEqual([]);
    expect(ctx.siblingAsked).toEqual([false]);
    expect(ctx.logs.some((l) => l.includes('another remi codex session in this directory'))).toBe(
      true,
    );
    expect(ctx.notices).toEqual([FIRST_NOTICE]);

    // Once per session, however many threads come; and the dropped thread is not kept: when the
    // sibling is out of the way a repeat of it is a new candidate, not a retained one.
    ctx.started('tui', crypto.randomUUID());
    await settle(500);
    expect(ctx.notices).toHaveLength(1);
    expect(ctx.identities).toEqual([]);
  });

  test('a blocked first bind and a blocked rotation are each told once, separately (R1, R2)', async () => {
    let inTheWay = true;
    const ctx = await setup({ siblingInDirectory: () => inTheWay });
    ctx.started('tui', crypto.randomUUID());
    await settle(500);
    expect(ctx.notices).toEqual([FIRST_NOTICE]);

    inTheWay = false;
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    ctx.status(a, { type: 'idle' });
    await settle(100);

    inTheWay = true;
    ctx.started('tui', crypto.randomUUID());
    await settle(500);
    expect(ctx.identities).toEqual([a]);
    expect(ctx.notices).toEqual([FIRST_NOTICE, ROTATION_NOTICE]);
  });

  test('a sibling in the directory, bound or not, blocks a rotation of an idle session; a first bind is asked about separately (R1)', async () => {
    let inTheWay = false;
    const ctx = await setup({ siblingInDirectory: (rotating) => rotating && inTheWay });
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.siblingAsked).toEqual([false]);
    ctx.status(a, { type: 'idle' });
    await settle(100);

    inTheWay = true;
    ctx.started('tui', crypto.randomUUID());
    await settle(500);
    expect(ctx.identities).toEqual([a]);
    expect(ctx.siblingAsked).toEqual([false, true]);
    expect(ctx.notices).toEqual([ROTATION_NOTICE]);
    expect(ctx.logs).toContain(ROTATION_NOTICE);
    expect(ctx.logs.some((l) => l.startsWith('rotated from'))).toBe(false);

    // Once per session, and the dropped thread is gone: the next one is a candidate of its own.
    ctx.started('tui', crypto.randomUUID());
    await settle(500);
    expect(ctx.notices).toHaveLength(1);

    // The sibling has gone: a later new thread is an ordinary rotation again.
    inTheWay = false;
    const c = crypto.randomUUID();
    ctx.started('tui', c);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation');
    expect(ctx.identities).toEqual([a, c]);
  });

  test('a rotation between two UUIDv7 ids that share their first eight characters is logged so the two can be told apart (Q2)', async () => {
    // Verified live (Codex 0.160.0, 2026-10-04): the log read `rotated from 01a106f2 to 01a106f2`,
    // which looks like no rotation. A UUIDv7 starts with a millisecond timestamp; its random part
    // is at the end.
    const ctx = await setup();
    const a = '01a106f2-2f1c-7a35-9d4e-8b6f1c2d3e4a';
    const b = '01a106f2-40b8-7c91-a2f7-5d9e0b7a6c13';
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.logs).toContain('identity: thread 1c2d3e4a');
    ctx.status(a, { type: 'idle' });
    await settle(100);
    ctx.started('tui', b);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation');
    expect(ctx.logs).toContain('rotated from 1c2d3e4a to 0b7a6c13');
    expect(ctx.logs.join('\n')).not.toContain('01a106f2');
  });

  test('a rotation is logged with the last eight characters of both ids, the plain-window residual made visible', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.logs.some((l) => l.startsWith('identity: thread'))).toBe(true);
    ctx.status(a, { type: 'idle' });
    await settle(100);

    // A plain codex window opened in this directory by hand looks exactly like a /new.
    ctx.started('tui', b);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation');
    expect(ctx.logs).toContain(`rotated from ${a.slice(-8)} to ${b.slice(-8)}`);
    expect(ctx.logs.join('\n')).not.toContain(a);
    expect(ctx.logs.join('\n')).not.toContain(b);
  });
});

describe('a session that never learns its thread says so (W11)', () => {
  const NOTICE = "remi could not find this session's Codex thread";

  test('with no thread/started after the wait, one log line and one notice, once per session', async () => {
    const ctx = await setup({ noIdentityMs: 150 });
    await waitUntil(ctx, () => ctx.notices.length === 1, 'the notice');
    expect(ctx.notices).toEqual([NOTICE]);
    expect(ctx.logs.filter((l) => l.includes('no thread/started'))).toHaveLength(1);
    // Not again, on the same connection or after a reconnect.
    ctx.tracker.handleDisconnected();
    ctx.tracker.handleReady();
    await settle(500);
    expect(ctx.notices).toHaveLength(1);
  });

  test('it does not stop the tracker: a thread that shows up later still binds', async () => {
    const ctx = await setup({ noIdentityMs: 100 });
    await waitUntil(ctx, () => ctx.notices.length === 1, 'the notice');
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the late identity');
    expect(ctx.identities).toEqual([id]);
  });

  test('nothing is said when the thread is found in time, or already known', async () => {
    const found = await setup({ noIdentityMs: 400 });
    found.started('tui', crypto.randomUUID());
    await waitUntil(found, () => found.identities.length === 1, 'the identity');
    await settle(700);
    expect(found.notices).toEqual([]);

    const resumed = await setup({ noIdentityMs: 100, expected: crypto.randomUUID() });
    await settle(500);
    expect(resumed.notices).toEqual([]);
  });

  test('a thread whose id is not a UUID never binds, and the wait ends in the notice (R3)', async () => {
    const ctx = await setup({ noIdentityMs: 250 });
    ctx.started('tui', 'x; touch /tmp/pwned');
    await waitUntil(ctx, () => ctx.notices.length === 1, 'the notice');
    expect(ctx.notices).toEqual([NOTICE]);
    expect(ctx.identities).toEqual([]);
    expect(ctx.resumeFrames()).toEqual([]);
    expect(ctx.logs.join('\n')).not.toContain('touch');
  });

  test('a candidate pending when the wait ends is looked at again, so a refusal still reaches the user (R8)', async () => {
    const ctx = await setup({ noIdentityMs: 100 });
    // The wait ends at 100 ms with this candidate still in its 150 ms window; the store then
    // says another session holds it, so nothing binds and the session is still without a thread.
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    await settle(40);
    ctx.claimed.add(id);
    await waitUntil(ctx, () => ctx.notices.length === 1, 'the notice after the refusal');
    expect(ctx.notices).toEqual([NOTICE]);
    expect(ctx.identities).toEqual([]);
    // Once only: the second look is the last.
    await settle(500);
    expect(ctx.notices).toHaveLength(1);
  });

  test('a notice that cannot be sent is logged and never thrown', async () => {
    const ctx = await setup({ noIdentityMs: 100, noticeThrows: true });
    await waitUntil(
      ctx,
      () => ctx.logs.some((l) => l.includes('could not send a notice')),
      'the failure to be logged',
    );
    expect(ctx.notices).toEqual([]);
    expect(ctx.logs.some((l) => l.includes('no thread/started'))).toBe(true);
  });

  test('after dispose the wait ends in silence', async () => {
    const ctx = await setup({ noIdentityMs: 150 });
    ctx.tracker.dispose();
    await settle(450);
    expect(ctx.notices).toEqual([]);
    expect(ctx.logs.some((l) => l.includes('no thread/started'))).toBe(false);
  });

  test('a candidate still inside its window is no reason to say it', async () => {
    const ctx = await setup({ noIdentityMs: 100 });
    // The window (150 ms) is still open when the 100 ms wait ends; the thread binds at 150 ms.
    ctx.started('tui', crypto.randomUUID());
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    await settle(400);
    expect(ctx.notices).toEqual([]);
  });
});

describe("role: which of the threads on the link are this session's (#1178)", () => {
  test('before an identity nothing has a role, a pending candidate included', async () => {
    // A window of ten minutes: the candidate cannot commit during the test, whatever the machine does.
    const ctx = await setup({ ambiguityMs: 600_000 });
    const a = crypto.randomUUID();
    expect(ctx.tracker.role(a)).toBeNull();
    ctx.started('tui', a);
    await settle(100);
    // Seen, but still inside its window: not committed, so not ours.
    expect(ctx.identities).toEqual([]);
    expect(ctx.tracker.role(a)).toBeNull();
  });

  test('the tracked thread is main once it has committed', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    expect(ctx.tracker.role(a)).toBe('main');
  });

  test('a known thread (resume) is main from the start, with no thread/started; nothing else is', async () => {
    const known = crypto.randomUUID();
    const ctx = await setup({ expected: known });
    expect(ctx.tracker.role(known)).toBe('main');
    expect(ctx.tracker.role(crypto.randomUUID())).toBeNull();
  });

  test("the tracked thread is main, a descendant at any depth is a subagent, another window's thread is nothing", async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const child = crypto.randomUUID();
    const grandchild = crypto.randomUUID();
    const stranger = crypto.randomUUID();
    const strangerChild = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    ctx.started('tui', child, setKey('parentThreadId', a));
    ctx.started('tui', grandchild, setKey('parentThreadId', child));
    ctx.started('tui', strangerChild, setKey('parentThreadId', stranger));
    await settle(150);
    expect(ctx.tracker.role(a)).toBe('main');
    expect(ctx.tracker.role(child)).toBe('subagent');
    expect(ctx.tracker.role(grandchild)).toBe('subagent');
    expect(ctx.tracker.role(stranger)).toBeNull();
    expect(ctx.tracker.role(strangerChild)).toBeNull();
    expect(ctx.tracker.role('not-a-thread')).toBeNull();
  });

  test('a rotation takes the old thread and its subagents out: they have no role afterwards', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    const child = crypto.randomUUID();
    const b = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    ctx.started('tui', child, setKey('parentThreadId', a));
    await settle(150);
    expect([ctx.tracker.role(a), ctx.tracker.role(child)]).toEqual(['main', 'subagent']);

    ctx.status(a, { type: 'idle' });
    await settle(100);
    ctx.started('tui', b);
    await waitUntil(ctx, () => ctx.identities.length === 2, 'the rotation');
    expect([ctx.tracker.role(a), ctx.tracker.role(child), ctx.tracker.role(b)]).toEqual([
      null,
      null,
      'main',
    ]);
  });
});

describe('onAttached: the attach to the tracked thread succeeded (#1178)', () => {
  test('it fires once per successful attach, with the thread, and not for a failed one', async () => {
    const ctx = await setup({ retryMs: 40 });
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.resumeFrames().length >= 2, 'a failed attach and a retry');
    expect(ctx.attached).toEqual([]);
    ctx.server.createRollout(id);
    await waitUntil(ctx, () => ctx.attached.length === 1, 'the attach');
    expect(ctx.attached).toEqual([id]);
    await settle(200);
    expect(ctx.attached).toEqual([id]);
  });

  test('it fires again after the link drops and returns, and after a rotation, for the new thread', async () => {
    const ctx = await setup({ retryMs: 40 });
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    ctx.server.createRollout(a);
    ctx.server.createRollout(b);
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.attached.length === 1, 'the first attach');
    ctx.server.dropClient(ctx.server.clientIds()[0] as number);
    await waitUntil(ctx, () => ctx.attached.length === 2, 'the attach after the reconnect');
    ctx.status(a, { type: 'idle' });
    await settle(100);
    ctx.started('tui', b);
    await waitUntil(ctx, () => ctx.attached.length === 3, 'the attach of the new thread');
    expect(ctx.attached).toEqual([a, a, b]);
  });

  test('a callback that throws is logged and does not undo the attach or stop later ones', async () => {
    const ctx = await setup({ retryMs: 40, attachedThrows: true });
    const id = crypto.randomUUID();
    ctx.server.createRollout(id);
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.attached.length === 1, 'the attach');
    expect(ctx.attachCount()).toBe(1);
    expect(ctx.logs.some((l) => l.includes('attach callback failed'))).toBe(true);
    // Still attached: no retry follows, and a reconnect attaches (and calls back) again.
    const frames = ctx.resumeFrames().length;
    await settle(150);
    expect(ctx.resumeFrames()).toHaveLength(frames);
    ctx.server.dropClient(ctx.server.clientIds()[0] as number);
    await waitUntil(ctx, () => ctx.attached.length === 2, 'the next attach');
  });

  test('after dispose it fires no more', async () => {
    const ctx = await setup({ retryMs: 40 });
    const id = crypto.randomUUID();
    ctx.started('tui', id);
    await waitUntil(ctx, () => ctx.resumeFrames().length >= 1, 'the first attach attempt');
    ctx.tracker.dispose();
    ctx.server.createRollout(id);
    await settle(250);
    expect(ctx.attached).toEqual([]);
  });
});
