/**
 * `AppServerClient` against a real WebSocket app-server double (epic #1175,
 * phase 1 #1181). Every test constructs the real client and talks to
 * `FakeAppServer`, a real `Bun.serve({ unix })` server replaying fixture frames.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readlinkSync } from 'node:fs';
import {
  AppServerClient,
  type AppServerClientOptions,
  AppServerDisconnectedError,
  type AppServerEvent,
  AppServerRpcError,
  AppServerTimeoutError,
} from '../../../src/harness/codex/app-server-client.ts';
import { placeholderUuid } from '../../helpers/codex-fixtures.ts';
import { FakeAppServer, rejection } from '../../helpers/fake-app-server.ts';

const CLIENT_INFO = { name: 'remi', title: null, version: '9.9.9' };
const FAST = { initialMs: 5, maxMs: 20 };

interface Harness {
  client: AppServerClient;
  events: AppServerEvent[];
  logs: string[];
}

describe('AppServerClient', () => {
  let server: FakeAppServer;
  const clients: AppServerClient[] = [];

  beforeEach(() => {
    server = FakeAppServer.start();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await server.stop();
  });

  function make(overrides: Partial<AppServerClientOptions> = {}): Harness {
    const events: AppServerEvent[] = [];
    const logs: string[] = [];
    const client = new AppServerClient(
      {
        socketPath: () => readlinkSync(server.linkPath),
        clientInfo: CLIENT_INFO,
        backoff: FAST,
        log: (m) => logs.push(m),
        ...overrides,
      },
      (e) => events.push(e),
    );
    clients.push(client);
    return { client, events, logs };
  }

  async function ready(h: Harness): Promise<void> {
    h.client.start();
    await server.waitFor(() => h.events.some((e) => e.type === 'ready'), 'ready');
  }

  const eventTypes = (h: Harness): string[] => h.events.map((e) => e.type);

  describe('the handshake', () => {
    test('sends initialize, then initialized, and reports ready with the server identity', async () => {
      const h = make();
      expect(h.client.state).toBe('idle');
      await ready(h);
      expect(h.client.state).toBe('ready');
      expect(h.events[0]).toEqual({
        type: 'ready',
        userAgent: 'remi/0.160.0 (test)',
        codexHome: '/work/codex-home',
        reconnect: false,
      });
      // `initialized` is written before `ready` is emitted but reaches the server a moment later.
      await server.waitFor(() => server.framesFrom(1).length >= 2, 'the initialized notification');
      const [first, second] = server.framesFrom(1);
      expect(first).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      });
      expect(second).toEqual({ jsonrpc: '2.0', method: 'initialized' });
    });

    test('offers an opt-out list only when one is given', async () => {
      const h = make({ optOutNotificationMethods: ['thread/tokenUsage/updated'] });
      await ready(h);
      const params = (server.framesFrom(1)[0] as { params: { capabilities: unknown } }).params;
      expect(params.capabilities).toEqual({
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: ['thread/tokenUsage/updated'],
      });
    });

    test('frames that arrive before the initialize result are held until after ready', async () => {
      const early = { method: 'configWarning', params: { summary: 'early' } };
      server.onRequest('initialize', (_params, client) => {
        server.emitTo(client, early);
        return { userAgent: 'ua', codexHome: null };
      });
      const h = make();
      await ready(h);
      await server.waitFor(() => h.events.length === 2, 'the held notification');
      expect(h.events[0]).toMatchObject({ type: 'ready', codexHome: null });
      expect(h.events[1]).toEqual({
        type: 'notification',
        method: 'configWarning',
        params: early.params,
      });
    });

    test('frames sent right after the initialize result come after ready', async () => {
      server.initializeFrames = [{ method: 'configWarning', params: { summary: 'late' } }];
      const h = make();
      await ready(h);
      await server.waitFor(() => h.events.length === 2, 'the notification');
      expect(eventTypes(h)).toEqual(['ready', 'notification']);
    });

    test('an initialize that fails never becomes ready, and the client keeps trying', async () => {
      let calls = 0;
      server.onRequest('initialize', () => {
        calls += 1;
        if (calls === 1) throw { code: -32000, message: 'not yet' };
        return { userAgent: 'ua' };
      });
      const h = make();
      await ready(h);
      expect(calls).toBe(2);
      expect(h.logs.some((l) => /initialize failed: "not yet"/.test(l))).toBe(true);
    });

    test('an initialize result with no userAgent is refused and the client keeps trying', async () => {
      let calls = 0;
      server.onRequest('initialize', () => {
        calls += 1;
        return calls === 1 ? {} : { userAgent: 'ua' };
      });
      const h = make();
      await ready(h);
      expect(calls).toBe(2);
      expect(h.logs.some((l) => /initialize result is malformed/.test(l))).toBe(true);
    });

    test('an initialize that never answers times out and the client reconnects', async () => {
      server.ignore('initialize');
      const h = make({ initializeTimeoutMs: 40 });
      h.client.start();
      await server.waitFor(
        () => server.received.filter((r) => r.frame['method'] === 'initialize').length >= 2,
        'a second initialize',
      );
      expect(eventTypes(h)).toEqual([]);
      expect(h.logs.some((l) => /initialize timed out/.test(l))).toBe(true);
    });

    test('start() is idempotent: one connection', async () => {
      const h = make();
      h.client.start();
      h.client.start();
      await server.waitFor(() => h.events.length === 1, 'ready');
      expect(server.clientIds()).toHaveLength(1);
    });
  });

  describe('requests', () => {
    test('a result resolves its request, with params passed through and ids counting up', async () => {
      server.onRequest('thread/loaded/list', (params) => ({ data: [], echoed: params }));
      const h = make();
      await ready(h);
      const result = await h.client.request<{ data: unknown[]; echoed: unknown }>(
        'thread/loaded/list',
        {
          limit: 3,
        },
      );
      expect(result).toEqual({ data: [], echoed: { limit: 3 } });
      await h.client.request('thread/loaded/list');
      const requests = server.framesFrom(1).filter((f) => f['method'] === 'thread/loaded/list');
      expect(requests.map((f) => f['id'])).toEqual([2, 3]);
      expect(requests[1]).not.toHaveProperty('params');
    });

    test('concurrent requests are matched to their own responses, whatever order they arrive in', async () => {
      server.onRequest('slow', async () => {
        await new Promise((r) => setTimeout(r, 60));
        return 'slow-result';
      });
      server.onRequest('fast', () => 'fast-result');
      const h = make();
      await ready(h);
      const slow = h.client.request('slow');
      const fast = h.client.request('fast');
      expect(await fast).toBe('fast-result');
      expect(await slow).toBe('slow-result');
    });

    test('an error response rejects with AppServerRpcError carrying code, message and data', async () => {
      server.onRequest('boom', () => {
        throw { code: -32001, message: 'it broke', data: { hint: 1 } };
      });
      const h = make();
      await ready(h);
      const error = (await h.client.request('boom').catch((e) => e)) as AppServerRpcError;
      expect(error).toBeInstanceOf(AppServerRpcError);
      expect(error).toMatchObject({ code: -32001, message: 'it broke' });
    });

    test('the report-derived "no rollout found" error (not in the spike logs) is an AppServerRpcError(-32600)', async () => {
      const h = make();
      await ready(h);
      const threadId = placeholderUuid(40);
      const error = (await h.client
        .request('thread/resume', { threadId, excludeTurns: true })
        .catch((e) => e)) as AppServerRpcError;
      expect(error).toBeInstanceOf(AppServerRpcError);
      expect(error.code).toBe(-32600);
      expect(error.message).toBe(`no rollout found for thread id ${threadId}`);
    });

    test('a request nobody answers rejects with AppServerTimeoutError after its timeout', async () => {
      server.ignore('never');
      const h = make();
      await ready(h);
      const started = Date.now();
      const error = await h.client.request('never', {}, 50).catch((e) => e);
      expect(error).toBeInstanceOf(AppServerTimeoutError);
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    });

    test('the default request timeout comes from the options', async () => {
      server.ignore('never');
      const h = make({ requestTimeoutMs: 40 });
      await ready(h);
      expect(await rejection(h.client.request('never'))).toBeInstanceOf(AppServerTimeoutError);
    });

    test('a response that arrives after its request timed out is ignored without noise', async () => {
      server.ignore('late');
      const h = make();
      await ready(h);
      await h.client.request('late', {}, 30).catch(() => {});
      const id = (server.framesFrom(1).find((f) => f['method'] === 'late') as { id: number }).id;
      server.emitTo(1, { id, result: 'too late' });
      await server.waitFor(() => h.logs.some((l) => /unknown request/.test(l)), 'the ignore log');
      expect(h.client.state).toBe('ready');
      expect(eventTypes(h)).toEqual(['ready']);
    });

    test('a request before the client is connected rejects with AppServerDisconnectedError', async () => {
      const h = make();
      expect(await rejection(h.client.request('anything'))).toBeInstanceOf(
        AppServerDisconnectedError,
      );
      expect(h.client.respond(1, {})).toBe(false);
    });
  });

  describe('server requests and notifications', () => {
    test('a server request surfaces with its id and params and nothing is sent back unasked', async () => {
      const h = make();
      await ready(h);
      server.emitTo(1, {
        method: 'item/commandExecution/requestApproval',
        id: 7,
        params: { k: 'v' },
      });
      server.emitTo(1, { method: 'item/tool/call', id: 'abc', params: {} });
      await server.waitFor(() => h.events.length === 3, 'both requests');
      expect(h.events.slice(1)).toEqual([
        {
          type: 'serverRequest',
          id: 7,
          method: 'item/commandExecution/requestApproval',
          params: { k: 'v' },
        },
        { type: 'serverRequest', id: 'abc', method: 'item/tool/call', params: {} },
      ]);
    });

    test('the client never answers a server request with an error: zero frames sent', async () => {
      const h = make();
      await ready(h);
      const sentBefore = server.framesFrom(1).length;
      for (const method of [
        'item/tool/call',
        'account/chatgptAuthTokens/refresh',
        'attestation/generate',
        'currentTime/read',
        'some/method/remi/has/never/heard/of',
      ]) {
        server.emitTo(1, { method, id: method.length, params: {} });
      }
      await server.waitFor(() => h.events.length === 6, 'all five server requests');
      // Give a wrongly eager client time to answer.
      await new Promise((r) => setTimeout(r, 100));
      expect(server.framesFrom(1)).toHaveLength(sentBefore);
      expect(sentBefore).toBe(2);
    });

    test('respond() sends a result frame the server arbitrates, first answer wins, late ones are dropped silently', async () => {
      const threadId = placeholderUuid(41);
      server.createRollout(threadId);
      const a = make();
      const b = make();
      await ready(a);
      await ready(b);
      await a.client.request('thread/resume', { threadId });
      await b.client.request('thread/resume', { threadId });
      const id = server.request(
        {
          method: 'item/commandExecution/requestApproval',
          params: { threadId, command: 'touch x' },
        },
        threadId,
      );
      await server.waitFor(
        () => [a, b].every((h) => h.events.some((e) => e.type === 'serverRequest' && e.id === id)),
        'the request on both clients',
      );
      expect(b.client.respond(id, { decision: 'accept' })).toBe(true);
      await server.waitFor(
        () =>
          [a, b].every((h) =>
            h.events.some(
              (e) => e.type === 'notification' && e.method === 'serverRequest/resolved',
            ),
          ),
        'serverRequest/resolved on both',
      );
      // A's late answer is accepted by the socket and ignored by the server: no error comes back.
      const eventsBefore = [a.events.length, b.events.length];
      expect(a.client.respond(id, { decision: 'accept' })).toBe(true);
      await new Promise((r) => setTimeout(r, 80));
      // Nothing came back to either client: no frame logged as unknown, no extra event.
      expect([a.events.length, b.events.length]).toEqual(eventsBefore);
      for (const h of [a, b]) {
        expect(h.logs.filter((l) => /unknown request/.test(l))).toEqual([]);
      }
      const answered = server.received.filter((r) => r.frame['id'] === id && 'result' in r.frame);
      expect(answered).toHaveLength(2);
      expect(answered[0]?.frame).toEqual({ jsonrpc: '2.0', id, result: { decision: 'accept' } });
      for (const h of [a, b]) {
        expect(
          h.events.filter(
            (e) => e.type === 'notification' && e.method === 'serverRequest/resolved',
          ),
        ).toHaveLength(1);
        expect(h.client.state).toBe('ready');
      }
    });

    test('server request ids are one daemon-global counter, not per thread', async () => {
      const [t1, t2] = [placeholderUuid(43), placeholderUuid(44)];
      server.createRollout(t1);
      server.createRollout(t2);
      const h = make();
      await ready(h);
      await h.client.request('thread/resume', { threadId: t1 });
      await h.client.request('thread/resume', { threadId: t2 });
      const params = { command: 'true' };
      const ids = [
        server.request({ method: 'item/commandExecution/requestApproval', params }, t1),
        server.request({ method: 'item/commandExecution/requestApproval', params }, t2),
        server.request({ method: 'item/commandExecution/requestApproval', params }, t1),
      ];
      expect(ids).toEqual([1, 2, 3]);
      await server.waitFor(
        () => h.events.filter((e) => e.type === 'serverRequest').length === 3,
        'three server requests',
      );
      expect(h.events.flatMap((e) => (e.type === 'serverRequest' ? [e.id] : []))).toEqual([
        1, 2, 3,
      ]);
    });

    test('a client that subscribes late is replayed the pending request with the same id', async () => {
      const threadId = placeholderUuid(42);
      server.createRollout(threadId);
      const early = make();
      await ready(early);
      await early.client.request('thread/resume', { threadId });
      const id = server.request(
        { method: 'item/commandExecution/requestApproval', params: { threadId } },
        threadId,
      );
      await server.waitFor(
        () => early.events.some((e) => e.type === 'serverRequest'),
        'the first delivery',
      );
      const late = make();
      await ready(late);
      await late.client.request('thread/resume', { threadId });
      await server.waitFor(() => late.events.some((e) => e.type === 'serverRequest'), 'the replay');
      expect(late.events.find((e) => e.type === 'serverRequest')).toMatchObject({ id });
    });

    test('malformed and non-JSON frames are dropped, the read loop carries on, and no body is logged', async () => {
      const h = make();
      await ready(h);
      server.emitRaw(1, 'this is not json SECRET-BODY');
      server.emitRaw(1, JSON.stringify({ id: null, result: 'SECRET-BODY' }));
      server.emitRaw(1, JSON.stringify([1, 2, 'SECRET-BODY']));
      server.emitTo(1, { id: 9999, result: { x: 'SECRET-BODY' } });
      server.emitTo(1, { method: 'ok/notification', params: {} });
      await server.waitFor(() => h.events.length === 2, 'the valid notification');
      expect(h.events[1]).toMatchObject({ type: 'notification', method: 'ok/notification' });
      expect(h.logs.length).toBeGreaterThanOrEqual(3);
      expect(h.logs.join('\n')).not.toContain('SECRET-BODY');
    });

    test('an event handler that throws does not stop later events', async () => {
      const events: AppServerEvent[] = [];
      const logs: string[] = [];
      const client = new AppServerClient(
        {
          socketPath: () => readlinkSync(server.linkPath),
          clientInfo: CLIENT_INFO,
          backoff: FAST,
          log: (m) => logs.push(m),
        },
        (e) => {
          events.push(e);
          if (e.type === 'ready') throw new Error('handler failure');
        },
      );
      clients.push(client);
      client.start();
      await server.waitFor(() => events.length === 1, 'ready');
      server.emitTo(1, { method: 'after', params: {} });
      await server.waitFor(() => events.length === 2, 'the next event');
      expect(client.state).toBe('ready');
      expect(logs.some((l) => /event handler threw on ready: Error/.test(l))).toBe(true);
      // Only the error's name is logged: whatever a consumer's handler throws may carry data.
      expect(logs.join('\n')).not.toContain('handler failure');
    });
  });

  describe('disconnects and reconnects', () => {
    test('a drop rejects in-flight requests, reports disconnected, then reconnects as a reconnect', async () => {
      server.ignore('hang');
      const h = make();
      await ready(h);
      const inFlight = h.client.request('hang', {}, 5000);
      await server.waitFor(
        () => server.framesFrom(1).some((f) => f['method'] === 'hang'),
        'the request',
      );
      server.dropClient(1);
      expect(await rejection(inFlight)).toBeInstanceOf(AppServerDisconnectedError);
      await server.waitFor(
        () => h.events.filter((e) => e.type === 'ready').length === 2,
        'the reconnect',
      );
      expect(eventTypes(h)).toEqual(['ready', 'disconnected', 'ready']);
      expect(h.events[1]).toMatchObject({ type: 'disconnected' });
      expect(h.events[2]).toMatchObject({ type: 'ready', reconnect: true });
    });

    test('the socket path is resolved on every attempt, and connects once the socket exists', async () => {
      let up = false;
      let attempts = 0;
      const h = make({
        socketPath: () => {
          attempts += 1;
          return up ? readlinkSync(server.linkPath) : `${server.socketPath}.absent`;
        },
      });
      h.client.start();
      await server.waitFor(() => attempts >= 3, 'three failed attempts');
      expect(eventTypes(h)).toEqual([]);
      expect(h.client.state).toBe('connecting');
      up = true;
      await server.waitFor(() => h.events.length === 1, 'ready');
      expect(h.events[0]).toMatchObject({ type: 'ready', reconnect: false });
    });

    test('a socketPath that throws is a failed attempt, not a crash', async () => {
      let attempts = 0;
      const h = make({
        socketPath: () => {
          attempts += 1;
          throw new Error('no socket yet');
        },
      });
      expect(() => h.client.start()).not.toThrow();
      await server.waitFor(() => attempts >= 3, 'retries');
      expect(h.logs.some((l) => /no socket yet/.test(l))).toBe(true);
    });

    test('backoff doubles from initialMs to maxMs and stays there', async () => {
      const stamps: number[] = [];
      const h = make({
        backoff: { initialMs: 10, maxMs: 40 },
        socketPath: () => {
          stamps.push(Date.now());
          return `${server.socketPath}.absent`;
        },
      });
      h.client.start();
      await server.waitFor(() => stamps.length >= 8, 'eight attempts', 5000);
      h.client.stop();
      const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] as number));
      // 10, 20, 40, 40, 40 ... : lower bounds for the doubling, an upper bound for the cap.
      expect(gaps[0]).toBeGreaterThanOrEqual(9);
      expect(gaps[1]).toBeGreaterThanOrEqual(19);
      expect(gaps[2]).toBeGreaterThanOrEqual(39);
      expect(gaps[5]).toBeLessThan(160);
    });

    test('logs the first failure and then every tenth', async () => {
      let attempts = 0;
      const h = make({
        backoff: { initialMs: 1, maxMs: 2 },
        socketPath: () => {
          attempts += 1;
          return `${server.socketPath}.absent`;
        },
      });
      h.client.start();
      await server.waitFor(() => attempts >= 21, 'twenty-one attempts', 5000);
      h.client.stop();
      const logged = h.logs
        .map((l) => /attempt (\d+)/.exec(l)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);
      expect(logged.slice(0, 3)).toEqual([1, 10, 20]);
      expect(logged.every((n) => n === 1 || n % 10 === 0)).toBe(true);
    });

    test('a successful connection resets the failure count: the next failure is logged as attempt 1', async () => {
      let up = false;
      let attempts = 0;
      const h = make({
        backoff: { initialMs: 2, maxMs: 2, stableMs: 30 },
        socketPath: () => {
          attempts += 1;
          return up ? readlinkSync(server.linkPath) : `${server.socketPath}.absent`;
        },
      });
      h.client.start();
      await server.waitFor(() => attempts >= 3, 'three failed attempts');
      up = true;
      await server.waitFor(() => h.events.length === 1, 'ready');
      // Up for longer than stableMs, so this success counts.
      await new Promise((r) => setTimeout(r, 60));
      up = false;
      const before = attempts;
      server.dropClient(1);
      await server.waitFor(() => attempts >= before + 3, 'failures after the drop');
      h.client.stop();
      const logged = h.logs.map((l) => /attempt (\d+)/.exec(l)?.[1]).filter(Boolean);
      expect(logged).toEqual(['1', '1']);
    });
  });

  describe('stop()', () => {
    test('closes the connection, rejects in-flight requests, and never reconnects', async () => {
      server.ignore('hang');
      const h = make();
      await ready(h);
      const inFlight = h.client.request('hang', {}, 5000);
      await server.waitFor(
        () => server.framesFrom(1).some((f) => f['method'] === 'hang'),
        'the request',
      );
      h.client.stop();
      expect(h.client.state).toBe('closed');
      expect(await rejection(inFlight)).toBeInstanceOf(AppServerDisconnectedError);
      expect(await rejection(h.client.request('x'))).toBeInstanceOf(AppServerDisconnectedError);
      expect(h.client.respond(1, {})).toBe(false);
      await new Promise((r) => setTimeout(r, 150));
      expect(h.client.state).toBe('closed');
      expect(server.clientIds()).toEqual([]);
      expect(h.events.filter((e) => e.type === 'ready')).toHaveLength(1);
      h.client.stop();
      h.client.start();
      expect(h.client.state).toBe('closed');
    });

    test('stopping while still trying to connect ends the loop', async () => {
      let attempts = 0;
      const h = make({
        socketPath: () => {
          attempts += 1;
          return `${server.socketPath}.absent`;
        },
      });
      h.client.start();
      await server.waitFor(() => attempts >= 2, 'two attempts');
      h.client.stop();
      const at = attempts;
      await new Promise((r) => setTimeout(r, 100));
      expect(attempts).toBe(at);
    });
  });
});
