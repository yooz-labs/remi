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
} from '../../../src/harness/codex/unix-ws.ts';
import { WS_OPCODE } from '../../../src/harness/codex/ws-frames.ts';
import {
  FakeAppServer,
  RawConnection,
  RawUnixPeer,
  rejection,
} from '../../helpers/fake-app-server.ts';

interface Probe {
  messages: string[];
  closes: WsCloseInfo[];
  logs: string[];
}

function probe(): Probe & { handlers: Parameters<typeof connectUnixWebSocket>[1] } {
  const messages: string[] = [];
  const closes: WsCloseInfo[] = [];
  return {
    messages,
    closes,
    logs: [],
    handlers: { onMessage: (t) => messages.push(t), onClose: (i) => closes.push(i) },
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Decode the masked client frames in `bytes`, independently of the codec under test. */
function clientFrames(bytes: Uint8Array): Array<{ opcode: number; payload: Buffer }> {
  const out: Array<{ opcode: number; payload: Buffer }> = [];
  let i = 0;
  while (i < bytes.length) {
    const opcode = (bytes[i] as number) & 0x0f;
    expect((bytes[i + 1] as number) & 0x80, 'client frame is masked').toBe(0x80);
    let length = (bytes[i + 1] as number) & 0x7f;
    let offset = i + 2;
    if (length === 126) {
      length = ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
      offset += 2;
    } else if (length === 127) {
      length = Number(Buffer.from(bytes.subarray(offset, offset + 8)).readBigUInt64BE());
      offset += 8;
    }
    const mask = bytes.subarray(offset, offset + 4);
    const payload = Buffer.from(
      Buffer.from(bytes.subarray(offset + 4, offset + 4 + length)).map(
        (b, k) => b ^ (mask[k % 4] as number),
      ),
    );
    out.push({ opcode, payload });
    i = offset + 4 + length;
  }
  return out;
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
    expect(((await rejection(silent)) as Error).message).toMatch(/upgrade timed out/);
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

  describe('a framing violation closes with 1002 and stops reading', () => {
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
