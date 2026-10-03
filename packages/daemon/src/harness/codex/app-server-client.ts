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
 *   {@link AppServerDisconnectedError}.
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
  /** 250 ms doubling to 5_000 ms by default, forever until `stop()`. */
  backoff?: { initialMs: number; maxMs: number };
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
const DEFAULT_BACKOFF = { initialMs: 250, maxMs: 5_000 };

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
    this.loop().catch((error) => this.log(`connect loop stopped: ${String(error)}`));
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

  /** Send a request and resolve with its `result`; reject on an error response, a timeout or a drop. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const ws = this.live;
    if (this.currentState !== 'ready' || !ws) {
      return Promise.reject(new AppServerDisconnectedError('app-server is not connected'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerTimeoutError(`${method} timed out after ${timeout} ms`));
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AppServerDisconnectedError('app-server is not connected'));
      }
    });
  }

  /** Answer a server request with a result. False when not connected (the answer was not sent). */
  respond(id: RequestId, result: unknown): boolean {
    const ws = this.live;
    if (this.currentState !== 'ready' || !ws) return false;
    try {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
      return true;
    } catch {
      return false;
    }
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  private emit(event: AppServerEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      this.log(`event handler threw on ${event.type}: ${String(error)}`);
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
    let delay = backoff.initialMs;
    let failures = 0;
    while (!this.stopped) {
      this.currentState = 'connecting';
      const outcome = await this.session();
      if (this.stopped) return;
      if (outcome.ready) {
        failures = 0;
        delay = backoff.initialMs;
      } else {
        failures += 1;
        if (failures === 1 || failures % 10 === 0) {
          this.log(`could not connect (attempt ${failures}): ${outcome.reason}`);
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
      if (!outcome.ready) delay = Math.min(delay * 2, backoff.maxMs);
    }
  }

  /** One connection, from the attempt to its end. Resolves with whether it reached `ready`. */
  private session(): Promise<{ ready: boolean; reason: string }> {
    return new Promise((resolve) => {
      const connect = this.opts.connect ?? connectUnixWebSocket;
      let done = false;
      let ready = false;
      let ws: WsConnection | null = null;
      let initId = 0;
      let initTimer: ReturnType<typeof setTimeout> | undefined;
      // Frames that arrive before `ready` wait here, so `ready` is always first.
      const queued: InboundMessage[] = [];

      const finish = (reason: string): void => {
        if (done) return;
        done = true;
        if (initTimer) clearTimeout(initTimer);
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
        resolve({ ready, reason });
      };
      this.endSession = finish;

      const handshakeReply = (message: InboundMessage): void => {
        if (message.kind !== 'response' || message.id !== initId) {
          queued.push(message);
          return;
        }
        if (initTimer) clearTimeout(initTimer);
        if (message.error) {
          finish(`initialize failed: ${message.error.message.slice(0, 120)}`);
          return;
        }
        const result = message.result as { userAgent?: unknown; codexHome?: unknown } | null;
        if (!result || typeof result.userAgent !== 'string') {
          finish('initialize result is malformed');
          return;
        }
        try {
          ws?.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
        } catch {
          finish('connection lost during the handshake');
          return;
        }
        ready = true;
        this.live = ws;
        this.currentState = 'ready';
        const reconnect = this.hasBeenReady;
        this.hasBeenReady = true;
        this.emit({
          type: 'ready',
          userAgent: result.userAgent,
          codexHome: typeof result.codexHome === 'string' ? result.codexHome : null,
          reconnect,
        });
        for (const m of queued.splice(0)) this.dispatch(m);
      };

      const handlers: WsHandlers = {
        onMessage: (text) => {
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
          if (ready) this.dispatch(message);
          else handshakeReply(message);
        },
        onClose: (info: WsCloseInfo) =>
          finish(info.code === undefined ? info.reason : `closed ${info.code}: ${info.reason}`),
      };

      let path: string;
      try {
        path = this.opts.socketPath();
      } catch (error) {
        finish(`no socket path: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      connect(path, handlers, { log: (m) => this.log(m) }).then(
        (connection) => {
          ws = connection;
          if (done || this.stopped) {
            connection.close();
            finish(this.stopped ? 'stopped' : 'ended before the handshake');
            return;
          }
          initId = this.nextId++;
          initTimer = setTimeout(
            () => finish('initialize timed out'),
            this.opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
          );
          try {
            connection.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: initId,
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
