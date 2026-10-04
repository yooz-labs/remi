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
import { ThreadTracker } from '../../../src/harness/codex/thread-tracker.ts';
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
  statuses: Array<{ id: string; status: ThreadStatus }>;
  logs: string[];
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
}

interface Options {
  expected?: string | null;
  throwOnIdentity?: boolean;
  claimedThrows?: boolean;
  retryMs?: number;
  spawnedAtMs?: number;
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
  const statuses: Ctx['statuses'] = [];
  const logs: string[] = [];
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
      if (opts.throwOnIdentity) throw new Error('the store is unavailable');
      identities.push(id);
    },
    onStatus: (id, status) => statuses.push({ id, status }),
    log: (m) => logs.push(m),
    retryMs: opts.retryMs ?? 40,
    ambiguityMs: 150,
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
    statuses,
    logs,
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
    expect(ctx.logs.some((l) => l.includes(`attached to thread ${id.slice(0, 8)}`))).toBe(true);
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

  test('a chain of parents counts up to eight hops and no further', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    const chain = Array.from({ length: 10 }, () => crypto.randomUUID());
    chain.forEach((id, i) => {
      ctx.started('tui', id, setKey('parentThreadId', i === 0 ? a : chain[i - 1]));
    });
    await settle(300);
    const ours = await oursOf(ctx, chain);
    expect([6, 7, 8, 9].map((i) => ours.has(chain[i] as string))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  test('the memory of parent links is bounded: the oldest is forgotten first', async () => {
    const ctx = await setup();
    const a = crypto.randomUUID();
    ctx.started('tui', a);
    await waitUntil(ctx, () => ctx.identities.length === 1, 'the identity');
    const children = Array.from({ length: 520 }, () => crypto.randomUUID());
    for (const id of children) ctx.started('tui', id, setKey('parentThreadId', a));
    await settle(400);
    // 520 links against a memory of 512: the first eight are gone, the ninth is not.
    const ours = await oursOf(ctx, [
      children[0],
      children[7],
      children[8],
      children[519],
    ] as string[]);
    expect([0, 7, 8, 519].map((i) => ours.has(children[i] as string))).toEqual([
      false,
      false,
      true,
      true,
    ]);
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
    expect(log).toContain(id.slice(0, 8));
    expect(log).not.toContain(id);
    expect(log).not.toContain(helper.slice(0, 8));
    expect(log).not.toContain(stray.slice(0, 8));
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
