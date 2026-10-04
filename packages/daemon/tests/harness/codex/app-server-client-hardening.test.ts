/**
 * `AppServerClient` under the conditions a real daemon creates and a happy path never does (epic
 * #1175, phase 1 #1181): a peer that vanishes mid-write, one that goes silent, a forged handshake,
 * flapping, floods, hostile text, a late connection after `stop()`. Every test constructs the real
 * client; the peers are real unix-socket servers (`RawUnixPeer`, byte-level, and `FakeAppServer`,
 * a `Bun.serve` WebSocket server).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readlinkSync } from 'node:fs';
import {
  AppServerClient,
  type AppServerClientOptions,
  AppServerDisconnectedError,
  type AppServerEvent,
  AppServerSerializationError,
} from '../../../src/harness/codex/app-server-client.ts';
import { connectUnixWebSocket } from '../../../src/harness/codex/unix-ws.ts';
import { WS_OPCODE } from '../../../src/harness/codex/ws-frames.ts';
import {
  FakeAppServer,
  RawConnection,
  RawUnixPeer,
  rejection,
} from '../../helpers/fake-app-server.ts';
import { spyTimers } from '../../helpers/timer-spy.ts';

const CLIENT_INFO = { name: 'remi', title: null, version: '9.9.9' };
const FAST = { initialMs: 5, maxMs: 20 };

interface Harness {
  client: AppServerClient;
  events: AppServerEvent[];
  logs: string[];
}

const types = (h: Harness): string[] => h.events.map((e) => e.type);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(3);
  }
}

/** `promise`, or a rejection saying `what` did not happen within `ms`. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

describe('against a byte-level peer', () => {
  let peer: RawUnixPeer;
  const clients: AppServerClient[] = [];
  beforeEach(async () => {
    peer = await RawUnixPeer.start();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop();
    await peer.stop();
  });

  function make(overrides: Partial<AppServerClientOptions> = {}): Harness {
    const events: AppServerEvent[] = [];
    const logs: string[] = [];
    const client = new AppServerClient(
      {
        socketPath: () => peer.socketPath,
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

  /** Start a client and bring its first connection to `ready`. */
  async function ready(overrides: Partial<AppServerClientOptions> = {}) {
    const h = make(overrides);
    h.client.start();
    const raw = await peer.next();
    await raw.handshake();
    await waitFor(() => h.events.some((e) => e.type === 'ready'), 'ready');
    return { h, raw };
  }

  /**
   * Answer every ping on `raw` with `copies` identical pongs (the real Codex sends two), until the
   * returned function is called.
   */
  function autoPong(raw: RawConnection, copies = 1): { pings: string[]; stop: () => void } {
    const pings: string[] = [];
    let seen = 0;
    const timer = setInterval(() => {
      const frames = raw.clientFrames();
      for (; seen < frames.length; seen++) {
        const frame = frames[seen] as { opcode: number; payload: Buffer };
        if (frame.opcode === WS_OPCODE.ping) {
          pings.push(frame.payload.toString());
          for (let n = 0; n < copies; n++) {
            raw.write(RawConnection.frame(WS_OPCODE.pong, frame.payload));
          }
        }
      }
    }, 3);
    return { pings, stop: () => clearInterval(timer) };
  }

  describe('a peer that goes away, or goes silent', () => {
    for (const how of ['end', 'destroy'] as const) {
      test(`a peer that ${how}s its socket as the client writes is a disconnect and a reconnect`, async () => {
        const { h, raw } = await ready({ requestTimeoutMs: 8000 });
        await sleep(30);
        let outcome = 'pending';
        let responded: boolean | undefined;
        // One timer tick: the peer goes away and the client sends (an approval answer, a request).
        // On Bun 1.3.11 that lost the socket's 'close' event: the client stayed `ready`, the
        // request rejected only after its timeout, and respond() returned true for a lost answer.
        await new Promise<void>((resolve) => {
          setTimeout(() => (how === 'end' ? raw.socket.end() : raw.socket.destroy()), 20);
          setTimeout(() => {
            h.client.request('thread/resume', { threadId: 't' }).then(
              () => {
                outcome = 'resolved';
              },
              (error: Error) => {
                outcome = error.constructor.name;
              },
            );
            responded = h.client.respond(5, { decision: 'accept' });
            resolve();
          }, 20);
        });
        await waitFor(() => h.events.some((e) => e.type === 'disconnected'), 'disconnected', 2500);
        await waitFor(() => outcome !== 'pending', 'the request to settle', 1500);
        expect(outcome).toBe('AppServerDisconnectedError');
        expect(typeof responded).toBe('boolean');
        const second = await within(peer.next(), 3000, 'the reconnect');
        await second.handshake();
        await waitFor(() => types(h).filter((t) => t === 'ready').length === 2, 'ready again');
        expect(h.events.filter((e) => e.type === 'ready')[1]).toMatchObject({ reconnect: true });
      });
    }

    test('a peer that stops answering pings is detected: in-flight requests reject and the client reconnects', async () => {
      const { h, raw } = await ready({ keepalive: { intervalMs: 40, timeoutMs: 60 } });
      // Observed from the start: a rejection nobody is waiting on yet is an unhandled one.
      const inFlight = rejection(h.client.request('never-answered', {}, 8000));
      await waitFor(() => h.events.some((e) => e.type === 'disconnected'), 'the keepalive to fail');
      expect(h.events.find((e) => e.type === 'disconnected')).toMatchObject({
        reason: expect.stringMatching(/no pong within 60 ms/),
      });
      expect(await inFlight).toBeInstanceOf(AppServerDisconnectedError);
      expect(raw.clientFrames().some((f) => f.opcode === WS_OPCODE.ping)).toBe(true);
      const second = await within(peer.next(), 3000, 'the reconnect');
      await second.handshake();
      await waitFor(() => types(h).filter((t) => t === 'ready').length === 2, 'ready again');
    });

    test('a peer that answers every ping keeps the link up through many intervals', async () => {
      const { h, raw } = await ready({ keepalive: { intervalMs: 30, timeoutMs: 120 } });
      const pongs = autoPong(raw);
      await sleep(450);
      pongs.stop();
      expect(types(h)).toEqual(['ready']);
      expect(h.client.state).toBe('ready');
      expect(pongs.pings.length).toBeGreaterThanOrEqual(5);
      // Each ping carries its own sequence number, so a pong cannot be mistaken for an older one.
      expect(new Set(pongs.pings).size).toBe(pongs.pings.length);
    });

    test('a peer that answers every ping with TWO pongs, as Codex does, keeps the link up and is pinged once per interval (Q1)', async () => {
      // Verified live against Codex 0.160.0 (2026-10-04): the server sends two identical pongs for
      // every ping. A client that re-armed its ping timer on each of them held two ping timers,
      // then overwrote its pong timer with each ping and could not cancel the first: the link
      // dropped with "no pong within 10000 ms" about every 70 s.
      const { h, raw } = await ready({ keepalive: { intervalMs: 50, timeoutMs: 200 } });
      const pongs = autoPong(raw, 2);
      const started = Date.now();
      await waitFor(() => pongs.pings.length >= 6, 'six ping cycles', 8000);
      // A leaked pong timer fires one timeout after the ping that overwrote it: wait that out.
      await sleep(300);
      pongs.stop();
      const elapsed = Date.now() - started;
      expect(types(h), 'no disconnect across the cycles').toEqual(['ready']);
      expect(h.client.state).toBe('ready');
      // One ping per interval: never more than the interval allows, whatever number of pongs.
      expect(pongs.pings.length).toBeLessThanOrEqual(Math.floor(elapsed / 50) + 1);
      expect(new Set(pongs.pings).size).toBe(pongs.pings.length);
    });

    test('a pong with no ping outstanding is ignored: it neither re-arms the ping timer nor ends the link (Q1)', async () => {
      const { h, raw } = await ready({ keepalive: { intervalMs: 60, timeoutMs: 300 } });
      const pongs = autoPong(raw);
      // An unsolicited pong (legal, RFC 6455) every 15 ms. If each one re-armed the ping timer,
      // the 60 ms timer would be pushed back for ever and no ping would be sent.
      const noise = setInterval(
        () => raw.write(RawConnection.frame(WS_OPCODE.pong, new Uint8Array())),
        15,
      );
      await sleep(600);
      clearInterval(noise);
      pongs.stop();
      expect(pongs.pings.length, 'pings keep coming every interval').toBeGreaterThanOrEqual(4);
      expect(types(h)).toEqual(['ready']);
      expect(h.client.state).toBe('ready');
    });

    test('the keepalive defaults are 30 s between pings and 10 s for the pong, and both timers are cleared', async () => {
      const spy = spyTimers();
      try {
        const { h, raw } = await ready();
        const [interval] = spy.withDelay(30_000);
        expect(interval, 'a 30000 ms ping timer after ready').toBeDefined();
        h.client.stop();
        expect(interval?.cleared, 'cleared on stop').toBe(true);
        raw.destroy();
      } finally {
        spy.restore();
      }
      const spy2 = spyTimers();
      try {
        const { h, raw } = await ready({ keepalive: { intervalMs: 5 } });
        const pongs = autoPong(raw);
        await waitFor(() => pongs.pings.length >= 1, 'a ping');
        await waitFor(() => spy2.withDelay(10_000).length >= 1, 'a pong deadline');
        const [deadline] = spy2.withDelay(10_000);
        await waitFor(
          () => deadline?.cleared === true,
          'the pong deadline to be cleared by the pong',
        );
        pongs.stop();
        h.client.stop();
        raw.destroy();
      } finally {
        spy2.restore();
      }
    });
  });

  describe('a forged or hostile handshake', () => {
    test('a forged id-0 reply in the same chunk as the 101 does not make the client ready', async () => {
      const h = make();
      h.client.start();
      const raw = await peer.next();
      raw.upgrade({
        after: RawConnection.frame(
          WS_OPCODE.text,
          JSON.stringify({ id: 0, result: { userAgent: 'forged' } }),
        ),
      });
      await waitFor(
        () => raw.clientMessages().some((m) => m['method'] === 'initialize'),
        'the initialize request',
      );
      await sleep(80);
      expect(types(h), 'a forged reply is not the initialize reply').toEqual([]);
      // The real reply, then: initialized goes out before ready.
      const init = raw.clientMessages().find((m) => m['method'] === 'initialize');
      raw.sendJson({ id: init?.['id'], result: { userAgent: 'real' } });
      await waitFor(() => types(h).includes('ready'), 'ready');
      expect(h.events[0]).toMatchObject({ type: 'ready', userAgent: 'real' });
      // The client writes `initialized` before it emits `ready`, but the bytes reach the peer's
      // socket a moment later: wait for the peer to have recorded it (a bounded wait that fails
      // loudly) before comparing what the peer saw.
      await waitFor(
        () => raw.clientMessages().some((m) => m['method'] === 'initialized'),
        'the initialized notification at the peer',
      );
      expect(raw.clientMessages().map((m) => m['method'])).toEqual(['initialize', 'initialized']);
    });

    test('a reply with another id than the initialize request does not make the client ready, and the real one still does', async () => {
      const h = make();
      h.client.start();
      const raw = await peer.next();
      raw.upgrade();
      await waitFor(
        () => raw.clientMessages().some((m) => m['method'] === 'initialize'),
        'the initialize request',
      );
      const init = raw.clientMessages().find((m) => m['method'] === 'initialize');
      raw.sendJson({ id: Number(init?.['id']) + 1000, result: { userAgent: 'wrong id' } });
      await sleep(80);
      expect(types(h), 'a reply to some other request is not the initialize reply').toEqual([]);
      raw.sendJson({ id: init?.['id'], result: { userAgent: 'real' } });
      await waitFor(() => types(h).includes('ready'), 'ready');
      expect(h.events[0]).toMatchObject({ type: 'ready', userAgent: 'real' });
    });

    test('a forged reply carrying the id the client is about to use is held back, then ignored', async () => {
      const h = make();
      h.client.start();
      const raw = await peer.next();
      raw.upgrade({
        after: RawConnection.frame(
          WS_OPCODE.text,
          JSON.stringify({ id: 1, result: { userAgent: 'forged' } }),
        ),
      });
      await waitFor(
        () => raw.clientMessages().some((m) => m['method'] === 'initialize'),
        'initialize',
      );
      await sleep(50);
      expect(types(h)).toEqual([]);
      raw.sendJson({ id: 1, result: { userAgent: 'real' } });
      await waitFor(() => types(h).includes('ready'), 'ready');
      expect(h.events[0]).toMatchObject({ userAgent: 'real' });
      await waitFor(
        () => h.logs.some((l) => /unknown request 1/.test(l)),
        'the forged reply to be ignored',
      );
    });

    test('more than 256 frames before the initialize reply fail the session, which reconnects', async () => {
      const h = make();
      h.client.start();
      const raw = await peer.next();
      raw.upgrade();
      for (let i = 0; i < 300; i++) raw.sendJson({ method: 'noise', params: { i } });
      await waitFor(
        () => h.logs.some((l) => /too many frames before the handshake finished/.test(l)),
        'the flood to be refused',
      );
      expect(types(h)).toEqual([]);
      const second = await within(peer.next(), 3000, 'the reconnect');
      second.destroy();
    });

    test('more than 4 MiB of frames before the initialize reply fail the session', async () => {
      const h = make();
      h.client.start();
      const raw = await peer.next();
      raw.upgrade();
      raw.sendJson({ method: 'noise', params: { pad: 'x'.repeat(5 * 1024 * 1024) } });
      await waitFor(
        () => h.logs.some((l) => /too many frames before the handshake finished/.test(l)),
        'the oversized preamble to be refused',
      );
      expect(types(h)).toEqual([]);
    });

    test('a few frames before the reply are held and delivered after ready, in order', async () => {
      const h = make();
      h.client.start();
      const raw = await peer.next();
      await raw.handshake('ua', [
        { method: 'first', params: {} },
        { method: 'second', params: {} },
      ]);
      await waitFor(() => h.events.length === 3, 'ready and two notifications');
      expect(h.events.map((e) => (e.type === 'notification' ? e.method : e.type))).toEqual([
        'ready',
        'first',
        'second',
      ]);
    });

    test('stop() called from the ready handler delivers nothing queued behind ready', async () => {
      const events: string[] = [];
      const holder: { client?: AppServerClient } = {};
      const client = new AppServerClient(
        { socketPath: () => peer.socketPath, clientInfo: CLIENT_INFO, backoff: FAST },
        (e) => {
          events.push(e.type === 'notification' ? `notification:${e.method}` : e.type);
          if (e.type === 'ready') holder.client?.stop();
        },
      );
      holder.client = client;
      clients.push(client);
      client.start();
      const raw = await peer.next();
      await raw.handshake('ua', [{ method: 'queued', params: {} }]);
      await waitFor(() => events.includes('disconnected'), 'the stop');
      await sleep(50);
      expect(events).toEqual(['ready', 'disconnected']);
    });

    test('server text in a log line is quoted: an initialize error cannot forge lines', async () => {
      const h = make();
      h.client.start();
      const raw = await peer.next();
      raw.upgrade();
      await waitFor(
        () => raw.clientMessages().some((m) => m['method'] === 'initialize'),
        'initialize',
      );
      const init = raw.clientMessages().find((m) => m['method'] === 'initialize');
      raw.sendJson({
        id: init?.['id'],
        error: { code: -1, message: 'bad\r\n[remi] forged line\u001b[2J' },
      });
      await waitFor(() => h.logs.some((l) => /initialize failed/.test(l)), 'the failure log');
      for (const line of h.logs) {
        expect(line, line).not.toMatch(/[\u0000-\u001f]/);
      }
      expect(h.logs.find((l) => /initialize failed/.test(l))).toContain('\\r\\n[remi] forged line');
    });

    test('server text in a close reason is quoted in the disconnect log', async () => {
      const { h, raw } = await ready();
      const payload = Buffer.concat([
        Buffer.from([0x03, 0xe8]),
        Buffer.from('bye\r\n[remi] forged\u001b[31m'),
      ]);
      raw.write(RawConnection.frame(WS_OPCODE.close, payload));
      await waitFor(() => h.events.some((e) => e.type === 'disconnected'), 'disconnected');
      for (const line of h.logs) expect(line, line).not.toMatch(/[\u0000-\u001f]/);
      const event = h.events.find((e) => e.type === 'disconnected');
      expect(event).toMatchObject({ reason: expect.stringContaining('\\r\\n[remi] forged') });
    });
  });

  describe('flapping and recovery', () => {
    test('a server that is ready and then closes cannot hold the delay at its initial value', async () => {
      const stamps: number[] = [];
      // No stableMs: the default (5 s) is what keeps a flapping server from resetting the delay.
      const h = make({ backoff: { initialMs: 20, maxMs: 400 } });
      h.client.start();
      for (let i = 0; i < 4; i++) {
        const raw = await within(peer.next(), 3000, `connection ${i + 1}`);
        stamps.push(Date.now());
        await raw.handshake();
        await waitFor(
          () => h.events.filter((e) => e.type === 'ready').length === i + 1,
          `ready ${i + 1}`,
        );
        raw.socket.end();
        await waitFor(
          () => h.events.filter((e) => e.type === 'disconnected').length === i + 1,
          `disconnected ${i + 1}`,
        );
      }
      const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] as number));
      // Delays 20, 40, 80 between connections: each flap counts as a failure and doubles it.
      expect(gaps[0]).toBeGreaterThanOrEqual(17);
      expect(gaps[1]).toBeGreaterThanOrEqual(35);
      expect(gaps[2]).toBeGreaterThanOrEqual(70);
    });

    test('a connection that stayed up resets the delay: the next reconnect is quick again', async () => {
      const server = FakeAppServer.start();
      try {
        let up = false;
        let attempts = 0;
        const h = make({
          backoff: { initialMs: 20, maxMs: 2000, stableMs: 10 },
          socketPath: () => {
            attempts += 1;
            return up ? readlinkSync(server.linkPath) : `${server.socketPath}.absent`;
          },
        });
        h.client.start();
        // Three failures grow the delay to 160 ms.
        await waitFor(() => attempts >= 4, 'four attempts');
        up = true;
        await waitFor(() => h.events.some((e) => e.type === 'ready'), 'ready');
        await sleep(60);
        const dropped = Date.now();
        server.dropClient(server.clientIds()[0] as number);
        await waitFor(
          () => h.events.filter((e) => e.type === 'ready').length === 2,
          'the quick reconnect',
        );
        expect(Date.now() - dropped, 'a reset delay is 20 ms, not the grown 160 ms').toBeLessThan(
          120,
        );
      } finally {
        await server.stop();
      }
    });

    test('the initialize timer is cleared on the reply: a ready link outlives initializeTimeoutMs', async () => {
      const { h } = await ready({ initializeTimeoutMs: 60 });
      await sleep(250);
      expect(types(h)).toEqual(['ready']);
      expect(h.client.state).toBe('ready');
    });
  });

  describe('stop() and an attempt in progress', () => {
    test('stop() cancels an attempt that is waiting for the upgrade: the socket is dropped at once', async () => {
      const h = make({ backoff: FAST });
      h.client.start();
      const raw = await peer.next(); // accepted, never answered
      const started = Date.now();
      h.client.stop();
      await raw.waitForEnd(1500);
      expect(Date.now() - started).toBeLessThan(1500);
      await waitFor(() => h.logs.includes('connect loop ended'), 'the loop to end');
      expect(h.client.state).toBe('closed');
    });

    test('stop() wakes the backoff wait: the loop ends now, not after the delay', async () => {
      const h = make({
        backoff: { initialMs: 5000, maxMs: 5000 },
        socketPath: () => `${peer.socketPath}.absent`,
      });
      h.client.start();
      await waitFor(() => h.logs.some((l) => /could not connect/.test(l)), 'the first failure');
      const started = Date.now();
      h.client.stop();
      await waitFor(() => h.logs.includes('connect loop ended'), 'the loop to end', 1000);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    test('a connection that resolves after stop() is closed, not leaked', async () => {
      const server = FakeAppServer.start();
      try {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const events: AppServerEvent[] = [];
        const client = new AppServerClient(
          {
            socketPath: () => readlinkSync(server.linkPath),
            clientInfo: CLIENT_INFO,
            backoff: FAST,
            // Delegates to the real connect, but holds the result back until the test lets go.
            connect: async (path, handlers, opts) => {
              const connection = await connectUnixWebSocket(path, handlers, opts);
              await gate;
              return connection;
            },
          },
          (e) => events.push(e),
        );
        clients.push(client);
        client.start();
        await server.waitFor(() => server.clientIds().length === 1, 'the connection');
        client.stop();
        release?.();
        await server.waitFor(
          () => server.clientIds().length === 0,
          'the late connection to be closed',
        );
        expect(events).toEqual([]);
      } finally {
        await server.stop();
      }
    });
  });

  describe('options and callbacks that misbehave', () => {
    test('a throwing log option does not stop the client from connecting or from retrying', async () => {
      let attempts = 0;
      const h = make({
        socketPath: () => {
          attempts += 1;
          if (attempts < 3) return `${peer.socketPath}.absent`;
          return peer.socketPath;
        },
        log: () => {
          throw new Error('log failure');
        },
      });
      h.client.start();
      const raw = await within(peer.next(), 3000, 'the third attempt');
      await raw.handshake();
      await waitFor(() => types(h).includes('ready'), 'ready');
      expect(attempts).toBe(3);
    });

    test('an event handler that throws on disconnected does not make stop() throw', async () => {
      const events: string[] = [];
      const logs: string[] = [];
      const client = new AppServerClient(
        {
          socketPath: () => peer.socketPath,
          clientInfo: CLIENT_INFO,
          backoff: FAST,
          log: (m) => logs.push(m),
        },
        (e) => {
          events.push(e.type);
          if (e.type === 'disconnected') throw new Error('secret handler detail');
        },
      );
      clients.push(client);
      client.start();
      const raw = await peer.next();
      await raw.handshake();
      await waitFor(() => events.includes('ready'), 'ready');
      expect(() => client.stop()).not.toThrow();
      expect(events).toEqual(['ready', 'disconnected']);
      expect(logs.some((l) => /event handler threw on disconnected: Error/.test(l))).toBe(true);
      expect(logs.join('\n')).not.toContain('secret handler detail');
    });
  });

  describe('serialization', () => {
    test('params that cannot be serialized reject with their own error and use no id', async () => {
      const { h, raw } = await ready();
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      for (const [name, params] of [
        ['a BigInt', { n: 10n }],
        ['a cycle', circular],
      ] as const) {
        const error = await rejection(h.client.request('m', params));
        expect(error, name).toBeInstanceOf(AppServerSerializationError);
        expect(error, name).not.toBeInstanceOf(AppServerDisconnectedError);
      }
      expect(h.client.state).toBe('ready');
      // Nothing was sent, and no id was spent: the next request is the very next id.
      const answer = h.client.request('after', {});
      await waitFor(() => raw.clientMessages().some((m) => m['method'] === 'after'), 'the request');
      const [init, after] = [
        raw.clientMessages().find((m) => m['method'] === 'initialize'),
        raw.clientMessages().find((m) => m['method'] === 'after'),
      ];
      expect(after?.['id']).toBe((init?.['id'] as number) + 1);
      expect(raw.clientMessages().filter((m) => m['method'] === 'm')).toEqual([]);
      raw.sendJson({ id: after?.['id'], result: 'ok' });
      expect(await answer).toBe('ok');
    });

    test('respond() throws for a result that cannot be serialized, and tells that apart from a down link', async () => {
      const { h, raw } = await ready();
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(() => h.client.respond(7, { n: 10n })).toThrow(AppServerSerializationError);
      expect(() => h.client.respond(7, circular)).toThrow(AppServerSerializationError);
      expect(() => h.client.respond(7, undefined)).toThrow(AppServerSerializationError);
      expect(h.client.respond(7, null)).toBe(true);
      await waitFor(
        () => raw.clientMessages().some((m) => m['id'] === 7 && 'result' in m),
        'the null result',
      );
      expect(raw.clientMessages().filter((m) => m['id'] === 7)).toEqual([
        { jsonrpc: '2.0', id: 7, result: null },
      ]);
      // A client that was never connected returns false rather than throwing.
      const idle = make();
      expect(idle.client.respond(1, {})).toBe(false);
    });
  });

  describe('timers', () => {
    test('the defaults are 5 s to initialize and 15 s per request, and every request timer is cleared', async () => {
      const spy = spyTimers();
      try {
        const h = make();
        h.client.start();
        const raw = await peer.next();
        await raw.handshake();
        await waitFor(() => types(h).includes('ready'), 'ready');
        // The upgrade deadline and the initialize deadline are both 5000 ms, and both are cleared.
        const fives = spy.withDelay(5000);
        expect(fives).toHaveLength(2);
        expect(fives.every((t) => t.cleared)).toBe(true);
        const answered = h.client.request('answered', {});
        expect(spy.withDelay(15_000), 'the default request timeout').toHaveLength(1);
        await waitFor(
          () => raw.clientMessages().some((m) => m['method'] === 'answered'),
          'the request',
        );
        const sent = raw.clientMessages().find((m) => m['method'] === 'answered');
        raw.sendJson({ id: sent?.['id'], result: 1 });
        await answered;
        expect(spy.withDelay(15_000)[0]?.cleared, 'cleared when the response arrives').toBe(true);

        // A request still pending when the link drops is rejected and its timer cleared too.
        const orphan = h.client.request('orphan', {}, 7777);
        expect(spy.withDelay(7777)).toHaveLength(1);
        raw.socket.destroy();
        expect(await rejection(orphan)).toBeInstanceOf(AppServerDisconnectedError);
        expect(spy.withDelay(7777)[0]?.cleared, 'cleared when the link drops').toBe(true);
      } finally {
        spy.restore();
      }
    });
  });
});

describe('against the Bun.serve app-server double', () => {
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

  test('a string id never answers a numeric request, even when its digits match', async () => {
    const h = make();
    h.client.start();
    await server.waitFor(() => h.events.some((e) => e.type === 'ready'), 'ready');
    server.ignore('pending-method');
    const request = h.client.request<string>('pending-method', {}, 5000);
    await server.waitFor(
      () => server.framesFrom(1).some((f) => f['method'] === 'pending-method'),
      'the request',
    );
    const id = (
      server.framesFrom(1).find((f) => f['method'] === 'pending-method') as { id: number }
    ).id;
    let settled = false;
    request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    server.emitTo(1, { id: String(id), result: 'from-a-string-id' });
    await sleep(80);
    expect(settled, 'the string id must not settle the request').toBe(false);
    server.emitTo(1, { id, result: 'from-the-number' });
    expect(await request).toBe('from-the-number');
  });

  test('the injected connect receives the resolved path, the handlers, a log and an abort signal', async () => {
    const seen: Array<{ path: string; handlerKeys: string[]; hasLog: boolean; signal: unknown }> =
      [];
    const h = make({
      connect: (path, handlers, opts) => {
        seen.push({
          path,
          handlerKeys: Object.keys(handlers).sort(),
          hasLog: typeof opts?.log === 'function',
          signal: opts?.signal,
        });
        return connectUnixWebSocket(path, handlers, opts);
      },
    });
    h.client.start();
    await server.waitFor(() => h.events.some((e) => e.type === 'ready'), 'ready');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(readlinkSync(server.linkPath));
    expect(seen[0]?.handlerKeys).toEqual(['onClose', 'onMessage', 'onPong']);
    expect(seen[0]?.hasLog).toBe(true);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
