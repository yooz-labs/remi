/**
 * The test doubles under test (epic #1175, phase 1 #1181): the helpers in
 * `fake-app-server.ts` are code the other tests trust, so what they promise is pinned here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type WsConnection, connectUnixWebSocket } from '../../src/harness/codex/unix-ws.ts';
import { placeholderUuid } from './codex-fixtures.ts';
import { FakeAppServer, socketDir } from './fake-app-server.ts';

describe('socketDir', () => {
  const made: string[] = [];
  const originalTmpdir = process.env['TMPDIR'];
  afterEach(() => {
    if (originalTmpdir === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
    else process.env['TMPDIR'] = originalTmpdir;
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('uses the temp directory when the socket path fits', () => {
    const base = mkdtempSync('/tmp/sd-');
    made.push(base);
    process.env['TMPDIR'] = base;
    const dir = socketDir('sock-', 's.sock');
    made.push(dir);
    expect(dir.startsWith(base)).toBe(true);
  });

  test('falls back to /tmp when a long TMPDIR would overflow sun_path', () => {
    const base = join(mkdtempSync('/tmp/sd-'), 'x'.repeat(120));
    mkdirSync(base);
    made.push(base);
    process.env['TMPDIR'] = base;
    const dir = socketDir('sock-', 's.sock');
    made.push(dir);
    expect(dir.startsWith('/tmp/sock-')).toBe(true);
    expect(join(dir, 's.sock').length).toBeLessThanOrEqual(100);
    // The directory that was too long is not left behind.
    expect(readdirSync(base)).toEqual([]);
  });
});

describe('FakeAppServer: the modeled behavior, one claim per test', () => {
  const clients: WsConnection[] = [];
  let server: FakeAppServer;
  beforeEach(() => {
    server = FakeAppServer.start();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.stop();
  });

  interface JsonClient {
    conn: WsConnection;
    /** Every frame received, in order. */
    frames: Array<Record<string, unknown>>;
    send(frame: unknown): void;
    /** The `result` or `error` of the response to request `id`. */
    answerTo(id: number): Promise<Record<string, unknown>>;
  }

  async function connect(): Promise<JsonClient> {
    const frames: Array<Record<string, unknown>> = [];
    const conn = await connectUnixWebSocket(server.socketPath, {
      onMessage: (text) => frames.push(JSON.parse(text) as Record<string, unknown>),
      onClose: () => {},
    });
    clients.push(conn);
    return {
      conn,
      frames,
      send: (frame) => conn.send(JSON.stringify(frame)),
      answerTo: async (id) => {
        await server.waitFor(
          () => frames.some((f) => f['id'] === id && !('method' in f)),
          `answer ${id}`,
        );
        return frames.find((f) => f['id'] === id && !('method' in f)) as Record<string, unknown>;
      },
    };
  }

  /** Initialize is not required by the model; resume a thread and wait for the reply. */
  async function resume(
    c: JsonClient,
    threadId: string,
    id: number,
  ): Promise<Record<string, unknown>> {
    c.send({ jsonrpc: '2.0', id, method: 'thread/resume', params: { threadId } });
    return c.answerTo(id);
  }

  const requestFrame = {
    method: 'item/commandExecution/requestApproval',
    params: { command: 'x' },
  };
  const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const requests = (c: JsonClient): Array<Record<string, unknown>> =>
    c.frames.filter((f) => f['method'] === requestFrame.method);
  const resolved = (c: JsonClient): Array<Record<string, unknown>> =>
    c.frames.filter((f) => f['method'] === 'serverRequest/resolved');

  test('initialize answers with the fixture result, then sends the configured frames', async () => {
    server.initializeFrames = [{ method: 'configWarning', params: { summary: 'test' } }];
    const c = await connect();
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const answer = await c.answerTo(1);
    expect((answer['result'] as { userAgent: string }).userAgent).toBe('remi/0.160.0 (test)');
    await server.waitFor(() => c.frames.length === 2, 'the configured frame');
    expect(c.frames[1]).toEqual({ method: 'configWarning', params: { summary: 'test' } });
  });

  test('thread/resume is the report-derived -32600 until createRollout, then subscribes with the thread id asked for', async () => {
    const c = await connect();
    const threadId = placeholderUuid(60);
    const failed = await resume(c, threadId, 1);
    expect(failed['error']).toEqual({
      code: -32600,
      message: `no rollout found for thread id ${threadId}`,
    });
    server.createRollout(threadId);
    const ok = (await resume(c, threadId, 2))['result'] as {
      thread: { id: string; sessionId: string };
    };
    expect(ok.thread.id).toBe(threadId);
    expect(ok.thread.sessionId).toBe(threadId);
  });

  test('a pending request is replayed only to a client that subscribes to its thread, with the same id', async () => {
    const [t1, t2] = [placeholderUuid(61), placeholderUuid(62)];
    server.createRollout(t1);
    server.createRollout(t2);
    const early = await connect();
    await resume(early, t1, 1);
    const id = server.request(requestFrame, t1);
    await server.waitFor(() => requests(early).length === 1, 'the first delivery');
    const other = await connect();
    await resume(other, t2, 1);
    await settle();
    expect(requests(other), 'a subscriber of another thread gets no replay').toHaveLength(0);
    const late = await connect();
    await resume(late, t1, 1);
    await server.waitFor(() => requests(late).length === 1, 'the replay');
    expect(requests(late)[0]?.['id']).toBe(id);
  });

  test('a request that was answered is not replayed to a later subscriber', async () => {
    const t = placeholderUuid(63);
    server.createRollout(t);
    const a = await connect();
    await resume(a, t, 1);
    const id = server.request(requestFrame, t);
    await server.waitFor(() => requests(a).length === 1, 'the request');
    a.send({ jsonrpc: '2.0', id, result: { decision: 'accept' } });
    await server.waitFor(() => resolved(a).length === 1, 'resolved');
    const late = await connect();
    await resume(late, t, 1);
    await settle();
    expect(requests(late)).toHaveLength(0);
  });

  test('a request is never delivered to a client that did not subscribe, a broadcast notification is', async () => {
    const t = placeholderUuid(64);
    server.createRollout(t);
    const subscriber = await connect();
    const bystander = await connect();
    await resume(subscriber, t, 1);
    server.request(requestFrame, t);
    server.emit({ method: 'thread/status/changed', params: { threadId: t } }, { threadId: t });
    server.emit({ method: 'thread/started', params: {} }, { broadcast: true });
    await server.waitFor(() => requests(subscriber).length === 1, 'the request');
    await settle();
    expect(requests(bystander)).toHaveLength(0);
    expect(bystander.frames.map((f) => f['method'])).toEqual(['thread/started']);
    expect(subscriber.frames.map((f) => f['method'])).toContain('thread/status/changed');
  });

  test('thread/unsubscribe answers {status: "unsubscribed"} and ends the subscription', async () => {
    const t = placeholderUuid(65);
    server.createRollout(t);
    const c = await connect();
    await resume(c, t, 1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'thread/unsubscribe', params: { threadId: t } });
    expect((await c.answerTo(2))['result']).toEqual({ status: 'unsubscribed' });
    server.request(requestFrame, t);
    server.emit({ method: 'thread/status/changed', params: { threadId: t } }, { threadId: t });
    await settle();
    expect(requests(c)).toHaveLength(0);
    expect(c.frames.some((f) => f['method'] === 'thread/status/changed')).toBe(false);
  });

  test('the first answer wins: every subscriber is told once, and a late answer draws no reply at all', async () => {
    const t = placeholderUuid(66);
    server.createRollout(t);
    const a = await connect();
    const b = await connect();
    await resume(a, t, 1);
    await resume(b, t, 1);
    const id = server.request(requestFrame, t);
    await server.waitFor(() => requests(a).length === 1 && requests(b).length === 1, 'delivery');
    b.send({ jsonrpc: '2.0', id, result: { decision: 'accept' } });
    await server.waitFor(
      () => resolved(a).length === 1 && resolved(b).length === 1,
      'resolved on both',
    );
    expect(resolved(a)[0]?.['params']).toEqual({ threadId: t, requestId: id });
    const [seenA, seenB] = [a.frames.length, b.frames.length];
    a.send({ jsonrpc: '2.0', id, result: { decision: 'accept' } });
    await settle();
    expect([a.frames.length, b.frames.length], 'no error frame, no second resolved').toEqual([
      seenA,
      seenB,
    ]);
  });

  test('an answer from a client that is not subscribed to the thread decides nothing', async () => {
    const t = placeholderUuid(67);
    server.createRollout(t);
    const subscriber = await connect();
    const stranger = await connect();
    await resume(subscriber, t, 1);
    const id = server.request(requestFrame, t);
    await server.waitFor(() => requests(subscriber).length === 1, 'the request');
    stranger.send({ jsonrpc: '2.0', id, result: { decision: 'accept' } });
    await settle();
    expect(resolved(subscriber), 'a stranger cannot resolve it').toHaveLength(0);
    subscriber.send({ jsonrpc: '2.0', id, result: { decision: 'accept' } });
    await server.waitFor(() => resolved(subscriber).length === 1, 'the subscriber resolves it');
  });

  test('ids come from one counter shared by every thread', () => {
    const t = placeholderUuid(68);
    const ids = [
      server.request(requestFrame, t),
      server.request(requestFrame, placeholderUuid(69)),
      server.request(requestFrame, t),
    ];
    expect(ids).toEqual([1, 2, 3]);
  });

  test('generic JSON-RPC behavior, not Codex frames: -32601 for an unknown method, -32603 for a handler that throws, silence for ignore()', async () => {
    const c = await connect();
    c.send({ jsonrpc: '2.0', id: 1, method: 'no/such/method' });
    expect((await c.answerTo(1))['error']).toMatchObject({ code: -32601 });
    server.onRequest('boom', () => {
      throw new Error('handler failed');
    });
    c.send({ jsonrpc: '2.0', id: 2, method: 'boom' });
    expect((await c.answerTo(2))['error']).toMatchObject({
      code: -32603,
      message: 'handler failed',
    });
    server.onRequest('slow', async () => ({ ok: true }));
    c.send({ jsonrpc: '2.0', id: 3, method: 'slow' });
    expect((await c.answerTo(3))['result']).toEqual({ ok: true });
    server.ignore('quiet');
    c.send({ jsonrpc: '2.0', id: 4, method: 'quiet' });
    await settle();
    expect(c.frames.some((f) => f['id'] === 4)).toBe(false);
  });
});
