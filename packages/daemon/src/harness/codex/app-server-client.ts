/**
 * A JSON-RPC client for Codex's shared app-server (epic #1175, phase 1 #1181).
 *
 * It connects over the unix socket ({@link connectUnixWebSocket}), runs the
 * `initialize` / `initialized` handshake, correlates responses to requests by
 * id, hands server requests and notifications to one callback, and reconnects
 * with backoff until `stop()`. It decides nothing: every approval and question
 * is a server request that the caller answers with {@link AppServerClient.respond}.
 *
 * Invariants (plan section 2.2):
 * - `ready` is emitted right after `initialized` is sent and before any later
 *   frame is dispatched; frames that arrive earlier are queued behind it.
 * - A dropped connection rejects every in-flight request with
 *   {@link AppServerDisconnectedError}. A connection that has gone silent without dropping (Bun
 *   1.3.11 can lose a socket's 'close') is caught by a WebSocket ping every 30 s with a 10 s pong
 *   deadline, and treated the same way.
 * - The client never sends an error response to a server request, whatever the
 *   request is: it exposes only `respond` with a result (plan section 2.4).
 * - It logs method names and ids, never a frame body or params: a frame can
 *   carry other threads' metadata or credentials (plan section 5).
 */
import {
  type InboundMessage,
  type RequestId,
  type RpcErrorBody,
  classifyInbound,
} from './app-server-protocol.ts';
import {
  type WsCloseInfo,
  type WsConnection,
  type WsHandlers,
  connectUnixWebSocket,
  quoteForLog,
} from './unix-ws.ts';

export class AppServerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

export class AppServerDisconnectedError extends Error {
  constructor(message = 'app-server connection lost') {
    super(message);
    this.name = 'AppServerDisconnectedError';
  }
}

export class AppServerTimeoutError extends Error {
  constructor(message = 'app-server request timed out') {
    super(message);
    this.name = 'AppServerTimeoutError';
  }
}

/**
 * The params of a request, or the result of a response, cannot be turned into JSON (a BigInt, a
 * cycle). A bug in the caller, never a connection state: nothing was sent and no id was used.
 */
export class AppServerSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppServerSerializationError';
  }
}

export type AppServerEvent =
  | { type: 'ready'; userAgent: string; codexHome: string | null; reconnect: boolean }
  | { type: 'disconnected'; reason: string }
  | { type: 'serverRequest'; id: RequestId; method: string; params: unknown }
  | { type: 'notification'; method: string; params: unknown };

export interface AppServerClientOptions {
  /** Resolved on every attempt, so a restarted daemon's new socket path is followed. */
  socketPath: () => string;
  clientInfo: { name: string; title: string | null; version: string };
  /** Notification methods to opt out of; none until live-verified (plan LV-1). */
  optOutNotificationMethods?: readonly string[];
  connect?: typeof connectUnixWebSocket;
  /** 15_000 ms by default. */
  requestTimeoutMs?: number;
  /** 5_000 ms by default. */
  initializeTimeoutMs?: number;
  /**
   * 250 ms doubling to 5_000 ms by default, forever until `stop()`. The delay and the failure
   * count reset only after a connection stayed up for `stableMs` (5_000 ms by default): a server
   * that accepts and then closes at once is a failing server, not a recovered one.
   */
  backoff?: { initialMs: number; maxMs: number; stableMs?: number };
  /** A ping every `intervalMs` (30_000 by default), and a connection that misses the pong within `timeoutMs` (10_000) is dropped. */
  keepalive?: { intervalMs?: number; timeoutMs?: number };
  log?: (message: string) => void;
}

export type AppServerState = 'idle' | 'connecting' | 'ready' | 'closed';

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF: { initialMs: number; maxMs: number; stableMs?: number } = {
  initialMs: 250,
  maxMs: 5_000,
};
const DEFAULT_STABLE_MS = 5_000;
const DEFAULT_KEEPALIVE = { intervalMs: 30_000, timeoutMs: 10_000 };
/** Frames that may wait for the initialize reply: it is the first thing a server sends, so a flood is hostile. */
const MAX_QUEUED_FRAMES = 256;
const MAX_QUEUED_CHARS = 4 * 1024 * 1024;

/** JSON for `value`, or an `AppServerSerializationError` naming what could not be encoded (not its content). */
function serialize(value: unknown, what: string): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new AppServerSerializationError(
      `${what} cannot be serialized: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

/** A request id as it may appear in a log: truncated, never the params. */
const logId = (id: RequestId): string => String(id).slice(0, 24);

export class AppServerClient {
  private currentState: AppServerState = 'idle';
  private stopped = false;
  private nextId = 1;
  private hasBeenReady = false;
  private readonly pending = new Map<number, Pending>();
  /** Ends the live session (connection, handshake or ready) with a reason. */
  private endSession: ((reason: string) => void) | null = null;
  private live: WsConnection | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly opts: AppServerClientOptions,
    private readonly onEvent: (event: AppServerEvent) => void,
  ) {}

  get state(): AppServerState {
    return this.currentState;
  }

  /** Begin the connect loop. Never throws; a second call, or a call after `stop()`, does nothing. */
  start(): void {
    if (this.currentState !== 'idle') return;
    this.currentState = 'connecting';
    this.loop().catch((error) =>
      this.log(`connect loop failed: ${error instanceof Error ? error.name : typeof error}`),
    );
  }

  /** Close the connection and never reconnect. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.currentState = 'closed';
    this.wake?.();
    this.endSession?.('stopped');
    this.rejectAll(new AppServerDisconnectedError('app-server client stopped'));
  }

  /**
   * Send a request and resolve with its `result`; reject on an error response, a timeout, a drop
   * (`AppServerDisconnectedError`) or params that cannot be serialized (`AppServerSerializationError`,
   * with nothing sent and no id used).
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const ws = this.live;
    if (this.currentState !== 'ready' || !ws) {
      return Promise.reject(new AppServerDisconnectedError('app-server is not connected'));
    }
    let paramsJson: string | undefined;
    try {
      paramsJson = serialize(params, 'the request params');
    } catch (error) {
      return Promise.reject(error);
    }
    const id = this.nextId++;
    const text = `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)}${
      paramsJson === undefined ? '' : `,"params":${paramsJson}`
    }}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerTimeoutError(`${method} timed out after ${timeout} ms`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, timer });
      try {
        ws.send(text);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppServerDisconnectedError('app-server is not connected'));
      }
    });
  }

  /**
   * Answer a server request with a result. False when the answer was not sent because the client
   * is not connected. Throws `AppServerSerializationError` for a result that cannot be serialized,
   * so a caller can tell its own bug from a link that is down.
   */
  respond(id: RequestId, result: unknown): boolean {
    const resultJson = serialize(result, 'the result');
    if (resultJson === undefined) {
      throw new AppServerSerializationError('the result is undefined, which is not JSON');
    }
    const ws = this.live;
    if (this.currentState !== 'ready' || !ws) return false;
    try {
      ws.send(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${resultJson}}`);
      return true;
    } catch {
      return false;
    }
  }

  /** A throwing `log` option must not break the read loop or the connect loop. */
  private log(message: string): void {
    try {
      this.opts.log?.(message);
    } catch {
      // Dropped on purpose.
    }
  }

  private emit(event: AppServerEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      this.log(
        `event handler threw on ${event.type}: ${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(error);
    }
  }

  /** Connect, serve one session, back off, repeat until `stop()`. */
  private async loop(): Promise<void> {
    const backoff = this.opts.backoff ?? DEFAULT_BACKOFF;
    const stableMs = backoff.stableMs ?? DEFAULT_STABLE_MS;
    let delay = backoff.initialMs;
    let failures = 0;
    while (!this.stopped) {
      this.currentState = 'connecting';
      const outcome = await this.session();
      if (this.stopped) break;
      if (outcome.ready && outcome.uptimeMs >= stableMs) {
        failures = 0;
        delay = backoff.initialMs;
      } else {
        failures += 1;
        if (failures === 1 || failures % 10 === 0) {
          this.log(
            outcome.ready
              ? `connection did not stay up (attempt ${failures}, ${outcome.uptimeMs} ms): ${outcome.reason}`
              : `could not connect (attempt ${failures}): ${outcome.reason}`,
          );
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
      if (!(outcome.ready && outcome.uptimeMs >= stableMs)) {
        delay = Math.min(delay * 2, backoff.maxMs);
      }
    }
    this.log('connect loop ended');
  }

  /** One connection, from the attempt to its end. Resolves with whether it reached `ready`, and for how long. */
  private session(): Promise<{ ready: boolean; reason: string; uptimeMs: number }> {
    return new Promise((resolve) => {
      const connect = this.opts.connect ?? connectUnixWebSocket;
      const abort = new AbortController();
      const keepalive = { ...DEFAULT_KEEPALIVE, ...this.opts.keepalive };
      let done = false;
      let ready = false;
      let readyAt = 0;
      let ws: WsConnection | null = null;
      // Null until initialize has been sent: until then no response can be its reply, whatever its id.
      let initId: number | null = null;
      let initTimer: ReturnType<typeof setTimeout> | undefined;
      let pingTimer: ReturnType<typeof setTimeout> | undefined;
      let pongTimer: ReturnType<typeof setTimeout> | undefined;
      let pingSeq = 0;
      // Frames that arrive before `ready` wait here, so `ready` is always first.
      const queued: InboundMessage[] = [];
      let queuedChars = 0;

      const finish = (reason: string): void => {
        if (done) return;
        done = true;
        if (initTimer) clearTimeout(initTimer);
        if (pingTimer) clearTimeout(pingTimer);
        if (pongTimer) clearTimeout(pongTimer);
        // Cancels an attempt still waiting for the upgrade; it does nothing to an open connection.
        abort.abort();
        this.endSession = null;
        this.live = null;
        if (!this.stopped) this.currentState = 'connecting';
        this.rejectAll(new AppServerDisconnectedError(reason));
        try {
          ws?.close();
        } catch {
          // Already closed.
        }
        if (ready) {
          this.log(`disconnected: ${reason}`);
          this.emit({ type: 'disconnected', reason });
        }
        resolve({ ready, reason, uptimeMs: ready ? Date.now() - readyAt : 0 });
      };
      this.endSession = finish;

      // A ping every `intervalMs`, and the pong due within `timeoutMs`. Bun 1.3.11 can leave a
      // connection looking open after the peer is gone, so liveness is checked, not assumed.
      const armPing = (): void => {
        // Never two ping timers: one that was overwritten could not be cancelled any more.
        if (pingTimer) clearTimeout(pingTimer);
        pingTimer = setTimeout(() => {
          try {
            ws?.ping(String(++pingSeq));
          } catch {
            finish('connection lost before a keepalive ping');
            return;
          }
          pongTimer = setTimeout(
            () => finish(`no pong within ${keepalive.timeoutMs} ms`),
            keepalive.timeoutMs,
          );
        }, keepalive.intervalMs);
      };

      const handshakeReply = (message: InboundMessage): void => {
        if (initId === null || message.kind !== 'response' || message.id !== initId) {
          queued.push(message);
          return;
        }
        if (initTimer) clearTimeout(initTimer);
        initTimer = undefined;
        if (message.error) {
          finish(`initialize failed: ${quoteForLog(message.error.message)}`);
          return;
        }
        const result = message.result as { userAgent?: unknown; codexHome?: unknown } | null;
        if (!result || typeof result.userAgent !== 'string') {
          finish('initialize result is malformed');
          return;
        }
        try {
          ws?.send('{"jsonrpc":"2.0","method":"initialized"}');
        } catch {
          finish('connection lost during the handshake');
          return;
        }
        ready = true;
        readyAt = Date.now();
        this.live = ws;
        this.currentState = 'ready';
        const reconnect = this.hasBeenReady;
        this.hasBeenReady = true;
        armPing();
        this.emit({
          type: 'ready',
          userAgent: result.userAgent,
          codexHome: typeof result.codexHome === 'string' ? result.codexHome : null,
          reconnect,
        });
        for (const m of queued.splice(0)) {
          if (done || this.stopped) break;
          this.dispatch(m);
        }
      };

      const handlers: WsHandlers = {
        onMessage: (text) => {
          if (done) return;
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            this.log(`dropped a frame that is not JSON (${text.length} characters)`);
            return;
          }
          const message = classifyInbound(raw);
          if (!message) {
            this.log('dropped a malformed JSON-RPC frame');
            return;
          }
          if (ready) {
            this.dispatch(message);
            return;
          }
          handshakeReply(message);
          if (!ready && !done && queued.length > 0) {
            queuedChars += text.length;
            if (queued.length > MAX_QUEUED_FRAMES || queuedChars > MAX_QUEUED_CHARS) {
              finish('too many frames before the handshake finished');
            }
          }
        },
        onPong: () => {
          if (done || !ready) return;
          // A pong with no ping outstanding is unsolicited, which RFC 6455 allows and ignores: the
          // real Codex answers EVERY ping with two identical pongs (verified live, 0.160.0), and the
          // second one must not start another ping cycle.
          if (pongTimer === undefined) return;
          clearTimeout(pongTimer);
          pongTimer = undefined;
          armPing();
        },
        onClose: (info: WsCloseInfo) =>
          finish(
            info.code === undefined
              ? quoteForLog(info.reason)
              : `closed ${info.code}: ${quoteForLog(info.reason)}`,
          ),
      };

      let path: string;
      try {
        path = this.opts.socketPath();
      } catch (error) {
        finish(`no socket path: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      connect(path, handlers, { log: (m) => this.log(m), signal: abort.signal }).then(
        (connection) => {
          ws = connection;
          if (done || this.stopped) {
            connection.close();
            finish(this.stopped ? 'stopped' : 'ended before the handshake');
            return;
          }
          const id = this.nextId++;
          initId = id;
          initTimer = setTimeout(
            () => finish('initialize timed out'),
            this.opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
          );
          try {
            connection.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                method: 'initialize',
                params: {
                  clientInfo: this.opts.clientInfo,
                  capabilities: {
                    experimentalApi: true,
                    requestAttestation: false,
                    ...(this.opts.optOutNotificationMethods?.length
                      ? { optOutNotificationMethods: [...this.opts.optOutNotificationMethods] }
                      : {}),
                  },
                },
              }),
            );
          } catch {
            finish('connection lost before initialize was sent');
          }
        },
        (error: unknown) => finish(error instanceof Error ? error.message : String(error)),
      );
    });
  }

  /** Route one frame received while ready. */
  private dispatch(message: InboundMessage): void {
    if (message.kind === 'response') {
      this.onResponse(message.id, message.result, message.error);
    } else if (message.kind === 'request') {
      this.emit({
        type: 'serverRequest',
        id: message.id,
        method: message.method,
        params: message.params,
      });
    } else {
      this.emit({ type: 'notification', method: message.method, params: message.params });
    }
  }

  private onResponse(id: RequestId, result: unknown, error: RpcErrorBody | undefined): void {
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
    if (!entry) {
      // A response to a request that already timed out, or that was never ours.
      this.log(`ignored a response to unknown request ${logId(id)}`);
      return;
    }
    this.pending.delete(id as number);
    clearTimeout(entry.timer);
    if (error) entry.reject(new AppServerRpcError(error.code, error.message, error.data));
    else entry.resolve(result as never);
  }
}
