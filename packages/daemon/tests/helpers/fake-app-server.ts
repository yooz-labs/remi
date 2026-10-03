/**
 * Test doubles for Codex's app-server transport (epic #1175, phase 1 #1181).
 *
 * Two real peers, both listening on a unix socket in a temp directory; neither
 * replaces any remi code, so a test against them exercises the real client:
 *
 * - {@link FakeAppServer}: a real WebSocket server (`Bun.serve({ unix })`)
 *   that replays redacted spike frames. It models only what a spike frame
 *   backs: `initialize` returns the fixture result; `thread/resume` errors
 *   `-32600` until `createRollout(threadId)`, then subscribes the client and
 *   replays the pending requests; the first answer to a request wins and a
 *   `serverRequest/resolved` reaches every subscriber; later answers are
 *   dropped silently; request ids come from one daemon-global counter. Its
 *   fidelity to Codex is what the live verification steps check, not this file.
 * - {@link RawUnixPeer}: a byte-level peer for what a WebSocket server library
 *   will not do on purpose (a wrong accept key, an RSV bit, a fragmented
 *   message, a frame in the same chunk as the 101). It computes the accept key
 *   with `node:crypto` directly, never with the module under test.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { type Server as NetServer, type Socket, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureFrameAt, loadFixtureFrames } from './codex-fixtures.ts';

type Json = Record<string, unknown>;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A frame the server received, with the id of the connection that sent it. */
export interface ReceivedFrame {
  client: number;
  frame: Json;
}

interface ClientData {
  id: number;
}

interface Pending {
  threadId: string;
  frame: Json;
}

export class FakeAppServer {
  /** `<tmp>/codex-home`: the fake `CODEX_HOME`. */
  readonly codexHome: string;
  /** `<codexHome>/app-server-control/app-server-control.sock`, a symlink to {@link socketPath}. */
  readonly linkPath: string;
  /** The short real socket path (macOS `sun_path` is 104 bytes, so a client connects here). */
  readonly socketPath: string;
  readonly received: ReceivedFrame[] = [];

  private readonly dir: string;
  private readonly server: Bun.Server<ClientData>;
  private readonly clients = new Map<number, Bun.ServerWebSocket<ClientData>>();
  private readonly subscriptions = new Map<number, Set<string>>();
  private readonly rollouts = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly handlers = new Map<string, (params: unknown, client: number) => unknown>();
  private readonly silent = new Set<string>();
  private readonly pongs: Uint8Array[] = [];
  private nextClient = 1;
  private nextRequest = 1;

  private constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'remi-fake-codex-'));
    this.socketPath = join(this.dir, 's.sock');
    this.codexHome = join(this.dir, 'codex-home');
    mkdirSync(join(this.codexHome, 'app-server-control'), { recursive: true });
    this.linkPath = join(this.codexHome, 'app-server-control', 'app-server-control.sock');
    this.server = Bun.serve<ClientData>({
      unix: this.socketPath,
      fetch: (req, server) => {
        const id = this.nextClient++;
        if (server.upgrade(req, { data: { id } })) return undefined;
        return new Response('expected a WebSocket upgrade', { status: 426 });
      },
      websocket: {
        open: (ws) => {
          this.clients.set(ws.data.id, ws);
          this.subscriptions.set(ws.data.id, new Set());
        },
        message: (ws, message) => this.onMessage(ws.data.id, String(message)),
        close: (ws) => {
          this.clients.delete(ws.data.id);
          this.subscriptions.delete(ws.data.id);
        },
        pong: (_ws, data) => {
          this.pongs.push(new Uint8Array(data));
        },
      },
    });
    symlinkSync(this.socketPath, this.linkPath);
  }

  static start(): FakeAppServer {
    return new FakeAppServer();
  }

  /** Stop the server, drop every client, and remove the temp directory. */
  async stop(): Promise<void> {
    await this.server.stop(true);
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Connected client ids, oldest first. */
  clientIds(): number[] {
    return [...this.clients.keys()];
  }

  /** The frames one client sent, in order. */
  framesFrom(client: number): Json[] {
    return this.received.filter((r) => r.client === client).map((r) => r.frame);
  }

  /** Let `thread/resume` for `threadId` succeed from now on. */
  createRollout(threadId: string): void {
    this.rollouts.add(threadId);
  }

  /** Answer a client request: `reply` returns the JSON-RPC `result` (or throws `{code, message}` as an error). */
  onRequest(method: string, reply: (params: unknown, client: number) => unknown): void {
    this.handlers.set(method, reply);
  }

  /** Never answer `method` (for timeout tests). */
  ignore(method: string): void {
    this.silent.add(method);
  }

  /** Send a notification (or any frame) to one thread's subscribers, or to every connection with `broadcast`. */
  emit(frame: Json, target: { threadId?: string; broadcast?: boolean } = {}): void {
    const text = JSON.stringify(frame);
    for (const [id, ws] of this.clients) {
      if (
        target.broadcast ||
        (target.threadId && this.subscriptions.get(id)?.has(target.threadId))
      ) {
        ws.send(text);
      }
    }
  }

  /** Send one frame to one client, whatever it subscribed to. */
  emitTo(client: number, frame: Json): void {
    this.clients.get(client)?.send(JSON.stringify(frame));
  }

  /**
   * A server request: takes the next daemon-global id, goes to the thread's
   * subscribers, and is replayed to anyone who subscribes while it is pending.
   */
  request(frame: { method: string; params: Json }, threadId: string): number {
    const id = this.nextRequest++;
    const full: Json = { method: frame.method, id, params: frame.params };
    this.pending.set(this.key(threadId, id), { threadId, frame: full });
    this.emit(full, { threadId });
    return id;
  }

  /** Close one client's socket abruptly, with no close frame. */
  dropClient(client: number): void {
    this.clients.get(client)?.terminate();
  }

  /** Close one client's socket with a close frame. */
  closeClient(client: number, code: number, reason: string): void {
    this.clients.get(client)?.close(code, reason);
  }

  /** Ping a client; the pong payloads it answered with are in {@link pongPayloads}. */
  ping(client: number, data: Uint8Array): void {
    this.clients.get(client)?.ping(data);
  }

  pongPayloads(): Uint8Array[] {
    return this.pongs;
  }

  /** Wait until `predicate` holds, polling; rejects after `timeoutMs`. */
  async waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private key(threadId: string, id: number | string): string {
    return `${threadId}:${String(id)}`;
  }

  private onMessage(client: number, text: string): void {
    let frame: Json;
    try {
      frame = JSON.parse(text) as Json;
    } catch {
      return;
    }
    this.received.push({ client, frame });
    const method = typeof frame['method'] === 'string' ? frame['method'] : undefined;
    if (!method) {
      this.onAnswer(frame);
      return;
    }
    if (frame['id'] === undefined || this.silent.has(method)) return;
    const reply = (result: unknown): void => this.emitTo(client, { id: frame['id'], result });
    const fail = (code: number, message: string): void =>
      this.emitTo(client, { id: frame['id'], error: { code, message } });
    const custom = this.handlers.get(method);
    if (custom) {
      try {
        reply(custom(frame['params'], client));
      } catch (error) {
        const e = error as { code?: number; message?: string };
        fail(e.code ?? -32603, e.message ?? 'internal error');
      }
    } else if (method === 'initialize') {
      reply(this.fixtureResult('expA-accept.jsonl', 2));
    } else if (method === 'thread/resume') {
      this.resume(client, frame, reply, fail);
    } else if (method === 'thread/unsubscribe') {
      const threadId = (frame['params'] as Json | undefined)?.['threadId'];
      if (typeof threadId === 'string') this.subscriptions.get(client)?.delete(threadId);
      reply({ status: 'unsubscribed' });
    } else {
      fail(-32601, `method not found: ${method}`);
    }
  }

  /** A client's answer to a server request: the first one wins, the rest are dropped silently. */
  private onAnswer(frame: Json): void {
    for (const [key, { threadId, frame: request }] of this.pending) {
      if (request['id'] !== frame['id']) continue;
      this.pending.delete(key);
      this.emit(
        { method: 'serverRequest/resolved', params: { threadId, requestId: frame['id'] } },
        { threadId },
      );
      return;
    }
  }

  private resume(
    client: number,
    frame: Json,
    reply: (result: unknown) => void,
    fail: (code: number, message: string) => void,
  ): void {
    const threadId = String((frame['params'] as Json | undefined)?.['threadId']);
    if (!this.rollouts.has(threadId)) {
      const derived = loadFixtureFrames('report-derived.jsonl')[0]?.frame['error'] as Json;
      fail(Number(derived['code']), String(derived['message']).replace(UUID, threadId));
      return;
    }
    this.subscriptions.get(client)?.add(threadId);
    const result = this.fixtureResult('expA-accept.jsonl', 38) as { thread: Json };
    result.thread['id'] = threadId;
    result.thread['sessionId'] = threadId;
    reply(result);
    for (const { threadId: t, frame: request } of this.pending.values()) {
      if (t === threadId) this.emitTo(client, request);
    }
  }

  /** A fresh copy of the `result` of fixture frame `line`. */
  private fixtureResult(file: string, line: number): unknown {
    const result = fixtureFrameAt(file, line).frame['result'];
    return JSON.parse(JSON.stringify(result));
  }
}

/** One accepted connection of a {@link RawUnixPeer}. */
export class RawConnection {
  /** Bytes the client sent after its upgrade request, in arrival order. */
  received = Buffer.alloc(0);
  /** The client's upgrade request: request line and headers. */
  requestHead = '';
  /** The client's `Sec-WebSocket-Key`. */
  key = '';
  /** Resolves once the client's upgrade request has arrived in full. */
  readonly headReady: Promise<void>;
  private headDone = false;

  constructor(readonly socket: Socket) {
    let buf = Buffer.alloc(0);
    let resolveHead = (): void => {};
    this.headReady = new Promise<void>((resolve) => {
      resolveHead = resolve;
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.headDone) {
        this.received = Buffer.concat([this.received, chunk]);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      this.requestHead = buf.subarray(0, end).toString('latin1');
      this.key = /sec-websocket-key:\s*(\S+)/i.exec(this.requestHead)?.[1] ?? '';
      this.received = buf.subarray(end + 4);
      this.headDone = true;
      resolveHead();
    });
    socket.on('error', () => {});
  }

  /** The `Sec-WebSocket-Accept` a correct server sends for this client's key. */
  correctAccept(): string {
    return createHash('sha1')
      .update(this.key + GUID)
      .digest('base64');
  }

  /** Write the upgrade response; `accept` and extra header lines can be overridden to break it. */
  upgrade(
    opts: {
      accept?: string;
      headers?: string[];
      status?: string;
      after?: Uint8Array;
      /** Header names (case-insensitive) to leave out of the response. */
      omit?: string[];
    } = {},
  ): void {
    const omitted = new Set((opts.omit ?? []).map((h) => h.toLowerCase()));
    const lines = [
      opts.status ?? 'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${opts.accept ?? this.correctAccept()}`,
      ...(opts.headers ?? []),
    ].filter((line, i) => i === 0 || !omitted.has(line.split(':')[0]?.toLowerCase() ?? ''));
    lines.push('', '');
    this.socket.write(
      Buffer.concat([Buffer.from(lines.join('\r\n')), opts.after ?? Buffer.alloc(0)]),
    );
  }

  /** An unmasked server frame, built independently of the codec under test. */
  static frame(opcode: number, payload: Uint8Array | string, fin = true, rsv = 0): Buffer {
    const body = Buffer.from(payload);
    const first = (fin ? 0x80 : 0) | rsv | opcode;
    const n = body.length;
    let head: Buffer;
    if (n < 126) {
      head = Buffer.from([first, n]);
    } else if (n <= 0xffff) {
      head = Buffer.from([first, 126, n >> 8, n & 0xff]);
    } else {
      head = Buffer.alloc(10);
      head[0] = first;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    return Buffer.concat([head, body]);
  }

  write(bytes: Uint8Array): void {
    this.socket.write(bytes);
  }

  /** Wait until the client has sent at least `n` bytes after its upgrade request. */
  async waitForBytes(n: number, timeoutMs = 3000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} bytes`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.received;
  }

  /** Wait until the client closes its end of the socket. */
  async waitForEnd(timeoutMs = 3000): Promise<void> {
    if (this.socket.destroyed || this.socket.readableEnded) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for the client to end')),
        timeoutMs,
      );
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('end', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** A real unix-socket listener that hands each connection to the test, which speaks the protocol by hand. */
export class RawUnixPeer {
  readonly socketPath: string;
  readonly connections: RawConnection[] = [];
  private readonly dir: string;
  private readonly server: NetServer;
  private unclaimed: RawConnection[] = [];
  private waiting: Array<(c: RawConnection) => void> = [];

  private constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'remi-raw-peer-'));
    this.socketPath = join(this.dir, 'r.sock');
    this.server = createServer((socket) => {
      const connection = new RawConnection(socket);
      this.connections.push(connection);
      const waiter = this.waiting.shift();
      if (waiter) waiter(connection);
      else this.unclaimed.push(connection);
    });
    this.server.listen(this.socketPath);
  }

  static async start(): Promise<RawUnixPeer> {
    const peer = new RawUnixPeer();
    await new Promise<void>((resolve) => peer.server.once('listening', resolve));
    return peer;
  }

  /** The next connection, once its upgrade request has arrived in full. */
  async next(): Promise<RawConnection> {
    const connection =
      this.unclaimed.shift() ??
      (await new Promise<RawConnection>((resolve) => this.waiting.push(resolve)));
    await connection.headReady;
    return connection;
  }

  async stop(): Promise<void> {
    for (const c of this.connections) c.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}
