/**
 * `connectUnixWebSocket` against real peers (epic #1175, phase 1 #1181): a real
 * `Bun.serve({ unix })` WebSocket server for the happy path, and a byte-level
 * unix peer for what a server library will not do on purpose.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readlinkSync } from 'node:fs';
import { Socket } from 'node:net';
import {
  type UnixWsOptions,
  type WsCloseInfo,
  type WsConnection,
  connectUnixWebSocket,
  encodeCloseReason,
  isValidCloseCode,
  quoteForLog,
} from '../../../src/harness/codex/unix-ws.ts';
import { WS_OPCODE, WsFrameParser } from '../../../src/harness/codex/ws-frames.ts';
import {
  FakeAppServer,
  RawConnection,
  RawUnixPeer,
  decodeClientFrames as clientFrames,
  rejection,
} from '../../helpers/fake-app-server.ts';
import { spyTimers } from '../../helpers/timer-spy.ts';

interface Probe {
  messages: string[];
  closes: WsCloseInfo[];
  logs: string[];
  pongs: number[];
}

function probe(): Probe & { handlers: Parameters<typeof connectUnixWebSocket>[1] } {
  const messages: string[] = [];
  const closes: WsCloseInfo[] = [];
  const pongs: number[] = [];
  return {
    messages,
    closes,
    logs: [],
    pongs,
    handlers: {
      onMessage: (t) => messages.push(t),
      onClose: (i) => closes.push(i),
      onPong: () => pongs.push(Date.now()),
    },
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const closeCode = (payload: Buffer): number => payload.readUInt16BE(0);

describe('against a real WebSocket server (Bun.serve over a unix socket)', () => {
  let server: FakeAppServer;
  const open: WsConnection[] = [];
  beforeEach(() => {
    server = FakeAppServer.start();
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await server.stop();
  });

  async function connect(opts?: UnixWsOptions) {
    const p = probe();
    const conn = await connectUnixWebSocket(readlinkSync(server.linkPath), p.handlers, {
      log: (m) => p.logs.push(m),
      ...opts,
    });
    open.push(conn);
    return { ...p, conn };
  }

  test('handshakes at the target of a symlinked socket path, sends text and receives the reply', async () => {
    const { conn, messages } = await connect();
    expect(conn.isOpen).toBe(true);
    conn.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await waitFor(() => messages.length === 1, 'the initialize reply');
    const reply = JSON.parse(messages[0] as string) as {
      id: number;
      result: { userAgent: string };
    };
    expect(reply.id).toBe(1);
    expect(reply.result.userAgent).toBe('remi/0.160.0 (test)');
    expect(server.received).toHaveLength(1);
  });

  test('carries 16-bit and 64-bit length messages in both directions', async () => {
    const { conn, messages } = await connect();
    server.onRequest('echo', (params) => params);
    for (const size of [200, 70_000]) {
      const pad = 'x'.repeat(size);
      messages.length = 0;
      conn.send(JSON.stringify({ id: size, method: 'echo', params: { pad } }));
      await waitFor(() => messages.length === 1, `the ${size}-byte echo`);
      const echoed = JSON.parse(messages[0] as string) as { result: { pad: string } };
      expect(echoed.result.pad.length).toBe(size);
    }
  });

  test('answers a server ping with a pong carrying the same payload', async () => {
    await connect();
    const [client] = server.clientIds();
    server.ping(client as number, Buffer.from('ping-payload'));
    await server.waitFor(() => server.pongPayloads().length === 1, 'the pong');
    expect(Buffer.from(server.pongPayloads()[0] as Uint8Array).toString()).toBe('ping-payload');
  });

  test('close() runs the close handshake: onClose fires once, clean, with code 1000', async () => {
    const { conn, closes } = await connect();
    conn.close();
    await waitFor(() => closes.length === 1, 'onClose');
    expect(closes[0]).toEqual({ code: 1000, reason: '', clean: true });
    expect(conn.isOpen).toBe(false);
    expect(() => conn.send('late')).toThrow(/not open/);
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toHaveLength(1);
  });

  test('a server-initiated close reports its code and reason, clean', async () => {
    const { closes } = await connect();
    const [client] = server.clientIds();
    server.closeClient(client as number, 4001, 'going away');
    await waitFor(() => closes.length === 1, 'onClose');
    expect(closes[0]).toEqual({ code: 4001, reason: 'going away', clean: true });
  });

  test('a dropped socket reports an unclean close with no code', async () => {
    const { closes, conn } = await connect();
    server.dropClient(server.clientIds()[0] as number);
    await waitFor(() => closes.length === 1, 'onClose');
    expect(closes[0]?.clean).toBe(false);
    expect(closes[0]?.code).toBeUndefined();
    expect(conn.isOpen).toBe(false);
  });

  test('every listener is attached before the socket connects', async () => {
    // Under `bun test` on Bun 1.3.11 a connect failure can emit 'error' synchronously inside
    // `connect`, before a listener attached afterwards could see it. Whether that happens depends on
    // runner state, so assert the ordering itself. This observes `Socket.prototype.connect` and
    // delegates to the original; nothing is replaced.
    const seen: Array<{ error: number; close: number; data: number }> = [];
    const original = Socket.prototype.connect;
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
      seen.push({
        error: this.listenerCount('error'),
        close: this.listenerCount('close'),
        data: this.listenerCount('data'),
      });
      return (original as (...a: unknown[]) => Socket).apply(this, args);
    } as typeof Socket.prototype.connect;
    try {
      await rejection(connectUnixWebSocket(`${server.socketPath}.never`, probe().handlers));
    } finally {
      Socket.prototype.connect = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBeGreaterThan(0);
    expect(seen[0]?.close).toBeGreaterThan(0);
    expect(seen[0]?.data).toBeGreaterThan(0);
  });

  test('rejects when nothing listens on the path', async () => {
    const error = await rejection(
      connectUnixWebSocket(`${server.socketPath}.missing`, probe().handlers),
    );
    expect(error).toBeInstanceOf(Error);
  });
});

describe('against a byte-level peer', () => {
  let peer: RawUnixPeer;
  beforeEach(async () => {
    peer = await RawUnixPeer.start();
  });
  afterEach(async () => {
    await peer.stop();
  });

  /** Replace the peer for one test, for a peer built differently. */
  async function restartPeer(opts: { allowHalfOpen?: boolean }): Promise<RawUnixPeer> {
    await peer.stop();
    return RawUnixPeer.start(opts);
  }

  async function connect(opts?: UnixWsOptions, accept = true) {
    const p = probe();
    const pending = connectUnixWebSocket(peer.socketPath, p.handlers, {
      log: (m) => p.logs.push(m),
      ...opts,
    });
    const raw = await peer.next();
    if (accept) raw.upgrade();
    return { ...p, raw, pending };
  }

  test('the upgrade request: GET /, Host localhost, version 13, no Origin, no extensions', async () => {
    const { raw, pending } = await connect();
    const conn = await pending;
    const lines = raw.requestHead.split('\r\n');
    expect(lines[0]).toBe('GET / HTTP/1.1');
    expect(lines).toContain('Host: localhost');
    expect(lines).toContain('Upgrade: websocket');
    expect(lines).toContain('Connection: Upgrade');
    expect(lines).toContain('Sec-WebSocket-Version: 13');
    expect(raw.key).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(raw.requestHead.toLowerCase()).not.toContain('origin');
    expect(raw.requestHead.toLowerCase()).not.toContain('sec-websocket-extensions');
    expect(raw.requestHead.toLowerCase()).not.toContain('sec-websocket-protocol');
    conn.close();
  });

  test('host and path are configurable', async () => {
    const { raw, pending } = await connect({ host: 'example.test', path: '/rpc' });
    await pending;
    expect(raw.requestHead.split('\r\n').slice(0, 2)).toEqual([
      'GET /rpc HTTP/1.1',
      'Host: example.test',
    ]);
  });

  test('every key is fresh, and the accept check binds to this connection', async () => {
    const first = await connect();
    await first.pending;
    const second = await connect();
    await second.pending;
    expect(first.raw.key).not.toBe(second.raw.key);
  });

  test('refuses a Sec-WebSocket-Accept that does not match the key', async () => {
    const p = probe();
    const pending = connectUnixWebSocket(peer.socketPath, p.handlers);
    const raw = await peer.next();
    raw.upgrade({ accept: 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' });
    expect(((await rejection(pending)) as Error).message).toMatch(/Sec-WebSocket-Accept/);
  });

  test('refuses a response that is not 101, lacks an upgrade header, or selects an extension or subprotocol', async () => {
    const cases: Array<[string, Parameters<RawConnection['upgrade']>[0], RegExp]> = [
      ['a 200', { status: 'HTTP/1.1 200 OK' }, /upgrade refused/],
      ['an extension', { headers: ['Sec-WebSocket-Extensions: permessage-deflate'] }, /extension/],
      ['a subprotocol', { headers: ['Sec-WebSocket-Protocol: chat'] }, /subprotocol/],
      ['no Upgrade header', { omit: ['Upgrade'] }, /Upgrade: websocket/],
      ['no Connection header', { omit: ['Connection'] }, /Connection: Upgrade/],
    ];
    for (const [name, response, reason] of cases) {
      const pending = connectUnixWebSocket(peer.socketPath, probe().handlers);
      const raw = await peer.next();
      raw.upgrade(response);
      expect(((await rejection(pending)) as Error).message, name).toMatch(reason);
    }
  });

  test('rejects when the peer closes before the upgrade, and when it never answers', async () => {
    const early = connectUnixWebSocket(peer.socketPath, probe().handlers);
    (await peer.next()).destroy();
    expect(((await rejection(early)) as Error).message).toMatch(/closed before the upgrade/);

    const silent = connectUnixWebSocket(peer.socketPath, probe().handlers, {
      handshakeTimeoutMs: 50,
    });
    await peer.next();
    expect(((await rejection(silent)) as Error).message).toMatch(/timed out before the upgrade/);
  });

  test('frames in the same chunk as the 101 are delivered', async () => {
    const p = probe();
    const pending = connectUnixWebSocket(peer.socketPath, p.handlers);
    const raw = await peer.next();
    raw.upgrade({ after: RawConnection.frame(WS_OPCODE.text, 'early') });
    await pending;
    expect(p.messages).toEqual(['early']);
  });

  test('client frames are masked and carry the text', async () => {
    const { raw, pending } = await connect();
    const conn = await pending;
    conn.send('héllo');
    const bytes = await raw.waitForBytes(2);
    await raw.waitForBytes(bytes.length);
    const [frame] = clientFrames(raw.received);
    expect(frame?.opcode).toBe(WS_OPCODE.text);
    expect(frame?.payload.toString('utf8')).toBe('héllo');
  });

  test('ping() sends a masked ping with its payload, a pong reaches onPong, and ping() refuses when closed', async () => {
    const { raw, pending, pongs } = await connect();
    const conn = await pending;
    conn.ping('are-you-there');
    await raw.waitForBytes(1);
    await waitFor(() => clientFrames(raw.received).length === 1, 'the ping frame');
    const [frame] = clientFrames(raw.received);
    expect(frame?.opcode).toBe(WS_OPCODE.ping);
    expect(frame?.payload.toString()).toBe('are-you-there');
    raw.write(RawConnection.frame(WS_OPCODE.pong, 'are-you-there'));
    await waitFor(() => pongs.length === 1, 'onPong');
    expect(() => conn.ping('x'.repeat(126))).toThrow();
    conn.close();
    expect(() => conn.ping('late')).toThrow(/not open/);
  });

  test('every client frame draws a fresh mask', async () => {
    const { raw, pending } = await connect();
    const conn = await pending;
    for (let i = 0; i < 16; i++) conn.send('same');
    const frameBytes = 2 + 4 + 4;
    const bytes = await raw.waitForBytes(16 * frameBytes);
    const masks = new Set<string>();
    for (let i = 0; i < 16; i++) {
      masks.add(bytes.subarray(i * frameBytes + 2, i * frameBytes + 6).toString('hex'));
    }
    expect(masks.size).toBeGreaterThan(1);
  });

  test('a fragmented message is delivered once, whole, and a ping between fragments is answered', async () => {
    const { raw, pending, messages } = await connect();
    await pending;
    raw.write(RawConnection.frame(WS_OPCODE.text, 'frag', false));
    raw.write(RawConnection.frame(WS_OPCODE.ping, 'mid'));
    raw.write(RawConnection.frame(WS_OPCODE.continuation, 'men', false));
    raw.write(RawConnection.frame(WS_OPCODE.continuation, 'ted', true));
    await waitFor(() => messages.length === 1, 'the reassembled message');
    expect(messages).toEqual(['fragmented']);
    await raw.waitForBytes(1);
    const frames = clientFrames(raw.received);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe(WS_OPCODE.pong);
    expect(frames[0]?.payload.toString()).toBe('mid');
  });

  test('a binary message is dropped with a log and the next text message still arrives', async () => {
    const { raw, pending, messages, logs } = await connect();
    await pending;
    raw.write(RawConnection.frame(WS_OPCODE.binary, Buffer.from([1, 2, 3])));
    raw.write(RawConnection.frame(WS_OPCODE.text, 'after'));
    await waitFor(() => messages.length === 1, 'the text message');
    expect(messages).toEqual(['after']);
    expect(logs.some((l) => /binary/.test(l))).toBe(true);
  });

  test('a server close frame is echoed and reported clean with its code and reason', async () => {
    const { raw, pending, closes } = await connect();
    await pending;
    raw.write(
      RawConnection.frame(
        WS_OPCODE.close,
        Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from('bye')]),
      ),
    );
    await waitFor(() => closes.length === 1, 'onClose');
    expect(closes[0]).toEqual({ code: 1001, reason: 'bye', clean: true });
    await raw.waitForBytes(1);
    const [frame] = clientFrames(raw.received);
    expect(frame?.opcode).toBe(WS_OPCODE.close);
    expect(closeCode(frame?.payload as Buffer)).toBe(1001);
  });

  test('close() against a peer that never answers drops the socket after the close timeout', async () => {
    const { raw, pending, closes } = await connect({ closeTimeoutMs: 50 });
    const conn = await pending;
    conn.close(1000);
    expect(conn.isOpen).toBe(false);
    await waitFor(() => closes.length === 1, 'onClose after the timeout');
    expect(closes[0]).toEqual({ code: 1000, reason: '', clean: false });
    const frame = clientFrames(await raw.waitForBytes(1)).find((f) => f.opcode === WS_OPCODE.close);
    expect(closeCode(frame?.payload as Buffer)).toBe(1000);
  });

  test('an abrupt end of the socket is an unclean close', async () => {
    const { raw, pending, closes } = await connect();
    await pending;
    raw.destroy();
    await waitFor(() => closes.length === 1, 'onClose');
    expect(closes[0]).toEqual({
      code: undefined,
      reason: 'socket closed without a close frame',
      clean: false,
    });
  });

  describe('a framing violation closes with 1002 and nothing after it is delivered', () => {
    const violations: Array<[string, (raw: RawConnection) => void, UnixWsOptions?]> = [
      ['an RSV bit', (raw) => raw.write(RawConnection.frame(WS_OPCODE.text, 'x', true, 0x40))],
      ['a masked server frame', (raw) => raw.write(Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0x61]))],
      ['an unknown opcode', (raw) => raw.write(Buffer.from([0x83, 0x00]))],
      [
        'a continuation with nothing to continue',
        (raw) => raw.write(RawConnection.frame(WS_OPCODE.continuation, 'x')),
      ],
      [
        'a new data frame inside a fragmented message',
        (raw) => {
          raw.write(RawConnection.frame(WS_OPCODE.text, 'a', false));
          raw.write(RawConnection.frame(WS_OPCODE.text, 'b'));
        },
      ],
      [
        'a payload over the limit',
        (raw) => raw.write(RawConnection.frame(WS_OPCODE.text, 'toolong')),
        { maxPayloadBytes: 4 },
      ],
      [
        'a fragmented message over the limit in total',
        (raw) => {
          raw.write(RawConnection.frame(WS_OPCODE.text, 'abc', false));
          raw.write(RawConnection.frame(WS_OPCODE.continuation, 'def'));
        },
        { maxPayloadBytes: 5 },
      ],
    ];
    for (const [name, misbehave, opts] of violations) {
      test(name, async () => {
        const { raw, pending, closes, messages } = await connect(opts);
        await pending;
        misbehave(raw);
        // Anything the peer sends after the violation must not be read.
        raw.write(RawConnection.frame(WS_OPCODE.text, 'ghost'));
        await waitFor(() => closes.length === 1, 'onClose');
        expect(closes[0]).toMatchObject({ code: 1002, clean: false });
        expect(messages).toEqual([]);
        await raw.waitForBytes(1);
        const frame = clientFrames(raw.received).find((f) => f.opcode === WS_OPCODE.close);
        expect(closeCode(frame?.payload as Buffer)).toBe(1002);
      });
    }
  });

  test('after a violation a hostile peer that keeps writing is not parsed, buffered or logged', async () => {
    peer = await restartPeer({ allowHalfOpen: true });
    const { raw, pending, closes, messages, logs } = await connect({ closeTimeoutMs: 10_000 });
    await pending;
    // Count what reaches a parser (delegating to the real one). Garbage read as frames is a
    // violation and a log line per chunk, and a parser that is fed it keeps every byte, because a
    // header that throws is never consumed (64 MiB of garbage grew the process by 64 MiB).
    const pushes: number[] = [];
    const original = WsFrameParser.prototype.push;
    WsFrameParser.prototype.push = function (this: WsFrameParser, chunk: Uint8Array) {
      pushes.push(chunk.length);
      return original.call(this, chunk);
    };
    try {
      raw.write(RawConnection.frame(WS_OPCODE.text, 'x', true, 0x40));
      await new Promise((r) => setTimeout(r, 20));
      const garbage = Buffer.alloc(64 * 1024, 0xff);
      for (let i = 0; i < 8 && !raw.socket.destroyed; i++) {
        raw.socket.write(garbage);
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      WsFrameParser.prototype.push = original;
    }
    expect(pushes, 'only the chunk with the violation reached a parser').toHaveLength(1);
    expect(messages).toEqual([]);
    expect(logs.filter((l) => /closing the connection/.test(l))).toHaveLength(1);
    expect(logs.length).toBeLessThanOrEqual(2);
    raw.destroy();
    await waitFor(() => closes.length === 1, 'onClose');
    expect(closes[0]).toMatchObject({ code: 1002, clean: false });
  });

  test('a peer that ends or destroys its socket as the client writes is still reported closed', async () => {
    for (const how of ['end', 'destroy'] as const) {
      const { raw, pending, closes } = await connect();
      const conn = await pending;
      await new Promise((r) => setTimeout(r, 30));
      // The same timer tick: the peer goes away and the client sends. On Bun 1.3.11 the 'close'
      // event of a socket whose write raced the peer's close never arrived, so the connection
      // looked open for ever; only 'end' did.
      await new Promise<void>((resolve) => {
        setTimeout(() => (how === 'end' ? raw.socket.end() : raw.socket.destroy()), 20);
        setTimeout(() => {
          try {
            conn.send('{"id":1}');
          } catch {
            // A close that was already noticed makes the send throw, which is also fine.
          }
          resolve();
        }, 20);
      });
      await waitFor(() => closes.length === 1, `onClose after the peer's ${how}`);
      expect(closes[0]?.clean).toBe(false);
      expect(conn.isOpen).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(closes, 'onClose fires once').toHaveLength(1);
    }
  });

  test('a text message that is not UTF-8 closes with 1007', async () => {
    const { raw, pending, closes, messages } = await connect();
    await pending;
    raw.write(RawConnection.frame(WS_OPCODE.text, Buffer.from([0xff, 0xfe, 0xfd])));
    raw.write(RawConnection.frame(WS_OPCODE.text, 'ghost'));
    await waitFor(() => closes.length === 1, 'onClose');
    expect(closes[0]).toMatchObject({ code: 1007, clean: false });
    expect(messages).toEqual([]);
  });

  test('a throwing message handler is logged and the read loop carries on', async () => {
    const closes: WsCloseInfo[] = [];
    const logs: string[] = [];
    const seen: string[] = [];
    const pending = connectUnixWebSocket(
      peer.socketPath,
      {
        onMessage: (t) => {
          seen.push(t);
          if (t === 'boom') throw new Error('handler failure');
        },
        onClose: (i) => closes.push(i),
      },
      { log: (m) => logs.push(m) },
    );
    const raw = await peer.next();
    raw.upgrade();
    await pending;
    raw.write(RawConnection.frame(WS_OPCODE.text, 'boom'));
    raw.write(RawConnection.frame(WS_OPCODE.text, 'next'));
    await waitFor(() => seen.length === 2, 'both messages');
    expect(seen).toEqual(['boom', 'next']);
    expect(logs.some((l) => /handler failure/.test(l))).toBe(true);
    expect(closes).toEqual([]);
  });
});

describe('input validation, log safety and the close-frame rules', () => {
  let peer: RawUnixPeer;
  beforeEach(async () => {
    peer = await RawUnixPeer.start();
  });
  afterEach(async () => {
    await peer.stop();
  });

  async function open(
    opts?: UnixWsOptions,
    handlers?: Partial<ReturnType<typeof probe>['handlers']>,
  ) {
    const p = probe();
    const pending = connectUnixWebSocket(
      peer.socketPath,
      { ...p.handlers, ...handlers },
      { log: (m) => p.logs.push(m), ...opts },
    );
    const raw = await peer.next();
    raw.upgrade();
    return { ...p, raw, conn: await pending };
  }

  const message = async (promise: Promise<unknown>): Promise<string> =>
    ((await rejection(promise)) as Error).message;

  describe('the request and the socket path', () => {
    test('a path or host that could end the request line or inject a header is refused before any connect', async () => {
      const bad: Array<[string, UnixWsOptions]> = [
        ['CR LF in the path', { path: '/a\r\nX-Injected: 1' }],
        ['a space in the path', { path: '/a b' }],
        ['a path that is not absolute', { path: 'rpc' }],
        ['a non-ASCII path', { path: '/\u4e2d\u6587' }],
        ['CR LF in the host', { host: 'localhost\r\nX-Injected: 1' }],
        ['a space in the host', { host: 'local host' }],
        ['an empty host', { host: '' }],
      ];
      for (const [name, opts] of bad) {
        const error = await rejection(
          connectUnixWebSocket(peer.socketPath, probe().handlers, opts),
        );
        expect(error, name).toBeInstanceOf(TypeError);
      }
      expect(peer.connections, 'nothing was connected').toHaveLength(0);
    });

    test('a path with a query and a host with a port are fine', async () => {
      const { raw, conn } = await open({ path: '/rpc?x=1&y=2', host: 'localhost:8765' });
      expect(raw.requestHead.split('\r\n').slice(0, 2)).toEqual([
        'GET /rpc?x=1&y=2 HTTP/1.1',
        'Host: localhost:8765',
      ]);
      conn.close();
    });

    test('a socket path that is not a non-empty absolute string never touches net', async () => {
      for (const bad of ['', 'relative.sock', './s.sock', 'a\0b', '/tmp/a\0b']) {
        const error = await rejection(connectUnixWebSocket(bad, probe().handlers));
        expect(error, JSON.stringify(bad)).toBeInstanceOf(TypeError);
      }
      // An empty path made Bun 1.3.11 try TCP and throw an uncaught TypeError about 250 ms later.
      await new Promise((r) => setTimeout(r, 400));
      expect(peer.connections).toHaveLength(0);
    });
  });

  describe('the upgrade response', () => {
    test('only a 101 is an upgrade: other 1xx statuses and an HTTP/1.0 101 are refused', async () => {
      for (const status of [
        'HTTP/1.1 100 Continue',
        'HTTP/1.1 102 Processing',
        'HTTP/1.1 1010',
        'HTTP/1.0 101 Switching Protocols',
      ]) {
        const pending = connectUnixWebSocket(peer.socketPath, probe().handlers);
        const raw = await peer.next();
        raw.upgrade({ status });
        expect(await message(pending), status).toMatch(/upgrade refused/);
      }
    });

    test('a 20 KiB header block that arrives in one write is refused, as is one that never ends', async () => {
      const whole = connectUnixWebSocket(peer.socketPath, probe().handlers);
      const first = await peer.next();
      first.upgrade({ headers: [`X-Pad: ${'a'.repeat(20 * 1024)}`] });
      expect(await message(whole)).toMatch(/too large/);

      const endless = connectUnixWebSocket(peer.socketPath, probe().handlers);
      const second = await peer.next();
      second.write(
        Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${'a'.repeat(17 * 1024)}`),
      );
      expect(await message(endless)).toMatch(/too large/);
    });

    test('a header block just under the cap is accepted', async () => {
      const pending = connectUnixWebSocket(peer.socketPath, probe().handlers);
      const raw = await peer.next();
      raw.upgrade({ headers: [`X-Pad: ${'a'.repeat(12 * 1024)}`] });
      const conn = await pending;
      expect(conn.isOpen).toBe(true);
      conn.close();
    });

    test('server text in the refusal is quoted: no raw control character reaches the message', async () => {
      const pending = connectUnixWebSocket(peer.socketPath, probe().handlers);
      const raw = await peer.next();
      raw.upgrade({ status: 'HTTP/1.1 500 \u001b[2Jforged' });
      const text = await message(pending);
      expect(text).toMatch(/upgrade refused/);
      expect(text).not.toContain('\u001b');
      expect(text).toContain('\\u001b');
    });
  });

  describe('the default deadlines', () => {
    test('the upgrade has 5 s and the peer 1 s to answer a close, and the upgrade timer is cleared once open', async () => {
      const spy = spyTimers();
      try {
        const pending = connectUnixWebSocket(peer.socketPath, probe().handlers);
        const raw = await peer.next();
        const [upgradeTimer] = spy.withDelay(5000);
        expect(upgradeTimer, 'a 5000 ms upgrade deadline').toBeDefined();
        raw.upgrade();
        const conn = await pending;
        expect(upgradeTimer?.cleared, 'cleared once the upgrade finished').toBe(true);
        conn.close();
        expect(spy.withDelay(1000), 'a 1000 ms close deadline').toHaveLength(1);
        raw.destroy();
      } finally {
        spy.restore();
      }
    });
  });

  describe('an attempt that is aborted', () => {
    test('a signal aborts an attempt stuck waiting for the upgrade, and the socket is dropped', async () => {
      const controller = new AbortController();
      const pending = connectUnixWebSocket(peer.socketPath, probe().handlers, {
        signal: controller.signal,
        handshakeTimeoutMs: 10_000,
      });
      const raw = await peer.next();
      const started = Date.now();
      controller.abort();
      expect(await message(pending)).toMatch(/aborted/);
      expect(Date.now() - started).toBeLessThan(1000);
      await raw.waitForEnd();
    });

    test('an already aborted signal rejects without connecting', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await rejection(
        connectUnixWebSocket(peer.socketPath, probe().handlers, { signal: controller.signal }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(peer.connections).toHaveLength(0);
    });

    test('aborting after the connection is open does nothing to it', async () => {
      const controller = new AbortController();
      const { conn } = await open({ signal: controller.signal });
      controller.abort();
      await new Promise((r) => setTimeout(r, 50));
      expect(conn.isOpen).toBe(true);
      conn.close();
    });
  });

  describe('a log callback that throws', () => {
    test('does not break the connection: the next message still arrives', async () => {
      const messages: string[] = [];
      const pending = connectUnixWebSocket(
        peer.socketPath,
        { onMessage: (t) => messages.push(t), onClose() {} },
        {
          log: () => {
            throw new Error('log failure');
          },
        },
      );
      const raw = await peer.next();
      raw.upgrade();
      await pending;
      // A binary message is dropped with a log line, which throws here.
      raw.write(RawConnection.frame(WS_OPCODE.binary, Buffer.from([1])));
      raw.write(RawConnection.frame(WS_OPCODE.text, 'still-here'));
      await waitFor(() => messages.length === 1, 'the text message');
      expect(messages).toEqual(['still-here']);
    });
  });

  describe('quoteForLog', () => {
    test('escapes control characters, cuts at the limit and keeps ordinary text readable', () => {
      expect(quoteForLog('plain text')).toBe('"plain text"');
      const forged = quoteForLog('ok\r\n[error] forged\u001b[2J');
      expect(forged).not.toMatch(/[\u0000-\u001f]/);
      expect(forged).toContain('\\r\\n');
      expect(quoteForLog('x'.repeat(500), 10)).toBe(`"${'x'.repeat(10)}..."`);
    });
  });

  describe('text is delivered as sent', () => {
    test('a leading byte order mark is part of the message, not stripped', async () => {
      const { raw, messages } = await open();
      raw.write(RawConnection.frame(WS_OPCODE.text, '\ufeff{"a":1}'));
      await waitFor(() => messages.length === 1, 'the message');
      expect(messages[0]).toBe('\ufeff{"a":1}');
    });
  });

  describe('the close-frame rules (RFC 6455 5.5.1 and 7.4.1)', () => {
    const closeFrame = (code: number | null, reason: Uint8Array | string = ''): Buffer => {
      const bytes = Buffer.from(reason);
      const body =
        code === null
          ? Buffer.alloc(0)
          : Buffer.concat([Buffer.from([code >> 8, code & 0xff]), bytes]);
      return RawConnection.frame(WS_OPCODE.close, body);
    };
    const sentClose = async (raw: RawConnection): Promise<Buffer> => {
      await waitFor(
        () => clientFrames(raw.received).some((f) => f.opcode === WS_OPCODE.close),
        "the client's close frame",
      );
      return (
        clientFrames(raw.received).find((f) => f.opcode === WS_OPCODE.close) as { payload: Buffer }
      ).payload;
    };

    test('every code outside the registered ranges closes the connection with 1002', async () => {
      for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535]) {
        const { raw, closes } = await open();
        raw.write(closeFrame(code));
        await waitFor(() => closes.length === 1, `onClose for ${code}`);
        expect(closes[0], `code ${code}`).toMatchObject({ code: 1002, clean: false });
        expect(closeCode(await sentClose(raw)), `code ${code}`).toBe(1002);
        raw.destroy();
      }
    });

    test('a one-byte payload closes with 1002', async () => {
      const { raw, closes } = await open();
      raw.write(RawConnection.frame(WS_OPCODE.close, Buffer.from([0x03])));
      await waitFor(() => closes.length === 1, 'onClose');
      expect(closes[0]).toMatchObject({ code: 1002, clean: false });
      expect(closeCode(await sentClose(raw))).toBe(1002);
    });

    test('a reason that is not UTF-8 closes with 1007', async () => {
      const { raw, closes } = await open();
      raw.write(closeFrame(1000, Buffer.from([0xff, 0xfe])));
      await waitFor(() => closes.length === 1, 'onClose');
      expect(closes[0]).toMatchObject({ code: 1007, clean: false });
      expect(closeCode(await sentClose(raw))).toBe(1007);
    });

    test('every registered code is accepted, reported, and echoed with the original reason bytes', async () => {
      for (const code of [
        1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4000, 4999,
      ]) {
        const { raw, closes } = await open();
        // A leading BOM and multi-byte text must come back byte for byte.
        const reason = Buffer.from('\ufeffr\u00e9sum\u00e9 \u2603');
        raw.write(closeFrame(code, reason));
        await waitFor(() => closes.length === 1, `onClose for ${code}`);
        expect(closes[0], `code ${code}`).toEqual({
          code,
          reason: '\ufeffr\u00e9sum\u00e9 \u2603',
          clean: true,
        });
        const echoed = await sentClose(raw);
        expect(closeCode(echoed), `code ${code}`).toBe(code);
        expect(echoed.subarray(2).equals(reason), `reason bytes for ${code}`).toBe(true);
        raw.destroy();
      }
    });

    test('a close frame with no payload is a clean close with no code, answered with 1000', async () => {
      const { raw, closes } = await open();
      raw.write(closeFrame(null));
      await waitFor(() => closes.length === 1, 'onClose');
      expect(closes[0]).toEqual({ code: undefined, reason: '', clean: true });
      expect(closeCode(await sentClose(raw))).toBe(1000);
    });

    test('close(code) sends a registered code and refuses 1005, 1006, 1015 and the unassigned', async () => {
      for (const code of [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 1.5, Number.NaN]) {
        const { raw, conn } = await open();
        expect(() => conn.close(code), `code ${code}`).toThrow(RangeError);
        expect(conn.isOpen, `code ${code}`).toBe(true);
        raw.destroy();
      }
      const { raw, conn } = await open();
      conn.close(4001);
      expect(closeCode(await sentClose(raw))).toBe(4001);
    });

    test('send and ping are refused as soon as close() starts, not only when it ends', async () => {
      const { conn } = await open({ closeTimeoutMs: 5000 });
      conn.close();
      expect(conn.isOpen).toBe(false);
      expect(() => conn.send('x')).toThrow(/not open/);
      expect(() => conn.ping()).toThrow(/not open/);
    });

    test('isValidCloseCode is the registered set', () => {
      const valid = [1000, 1001, 1002, 1003, 1007, 1011, 1012, 1013, 1014, 3000, 4999];
      const invalid = [0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535, -1, 1000.5];
      for (const code of valid) expect(isValidCloseCode(code), String(code)).toBe(true);
      for (const code of invalid) expect(isValidCloseCode(code), String(code)).toBe(false);
    });

    test('a reason is cut on a code point boundary at 123 bytes', () => {
      expect(encodeCloseReason('short')).toEqual(new TextEncoder().encode('short'));
      const long = encodeCloseReason('a'.repeat(200));
      expect(long.length).toBe(123);
      // 61 two-byte characters is 122 bytes; the 62nd would straddle byte 123, so it is dropped whole.
      const twoByte = encodeCloseReason('\u00e9'.repeat(100));
      expect(twoByte.length).toBe(122);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(twoByte)).toBe('\u00e9'.repeat(61));
      // A 4-byte character cut at the boundary is dropped whole too.
      const emoji = encodeCloseReason(`${'a'.repeat(121)}\u{1f600}`);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(emoji)).toBe('a'.repeat(121));
    });
  });
});
