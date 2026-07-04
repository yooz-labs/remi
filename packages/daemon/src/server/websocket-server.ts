/**
 * WebSocket Server - Manages WebSocket connections from clients.
 *
 * Uses Bun's built-in WebSocket server for high performance.
 * Handles connection lifecycle, message routing, and broadcasting.
 */

import { generateId } from '@remi/shared';
import type { AnswerExtras, ProtocolMessage, UUID } from '@remi/shared';
import { Connection, type ConnectionConfig, type ConnectionEvents } from './connection.ts';
import { shouldSkipAuthForPeer } from './peer-helpers.ts';

/** Server configuration */
export interface ServerConfig {
  /** Port to listen on */
  readonly port: number;

  /** Host to bind to */
  readonly host?: string;

  /** Path for WebSocket connections */
  readonly path?: string;

  /** Maximum number of concurrent connections */
  readonly maxConnections?: number;

  /** Connection configuration */
  readonly connection?: Partial<ConnectionConfig>;
}

/** Server events */
export interface ServerEvents {
  /** Server started listening */
  onStart: (port: number) => void;

  /** Server stopped */
  onStop: () => void;

  /** Client connected */
  onClientConnect: (connection: Connection) => void;

  /** Client disconnected */
  onClientDisconnect: (connectionId: UUID, reason: string) => void;

  /** User input from client */
  onUserInput: (
    connectionId: UUID,
    sessionId: UUID,
    content: string,
    raw?: boolean,
    claudeSessionId?: UUID,
  ) => void;

  /** Answer from client. `extra` carries structured AskUserQuestion selections /
   *  cancel (#627); omitted for a plain single answer. */
  onAnswer: (
    connectionId: UUID,
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    claudeSessionId?: UUID,
    extra?: AnswerExtras,
  ) => void;

  /**
   * Connection-independent answer relay over HTTP POST /answer (#575, P4a).
   * Resolves to a structured outcome so the route can report delivered / stale /
   * session-not-found. Distinct from `onAnswer` because the HTTP path has no
   * connection to reply on and must surface the result in the HTTP response.
   */
  onAnswerRelay: (
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    claudeSessionId?: UUID,
  ) => Promise<'delivered' | 'session-not-found' | 'stale-binding' | 'stale'>;

  /** Bullet expand request from client */
  onBulletExpandRequest: (
    connectionId: UUID,
    sessionId: UUID,
    bulletId: number,
    requestId: UUID,
  ) => void;

  /** Session list request from client */
  onSessionListRequest: (connectionId: UUID, requestId: UUID, includeExternal: boolean) => void;

  /** Transcript load request from client */
  onTranscriptLoadRequest: (connectionId: UUID, sessionId: string, requestId: UUID) => void;

  /** Create session request from client */
  onCreateSessionRequest: (
    connectionId: UUID,
    directory: string | undefined,
    requestId: UUID,
  ) => void;

  /** Terminal resize from attached CLI client */
  onTerminalResize: (connectionId: UUID, cols: number, rows: number) => void;

  /** Kill session request from client */
  onKillSessionRequest: (connectionId: UUID, sessionId: UUID, requestId: UUID) => void;

  /** Resume session request from client */
  onResumeSessionRequest: (connectionId: UUID, sessionId: string, requestId: UUID) => void;

  /** Session history request from client */
  onSessionHistoryRequest: (connectionId: UUID, requestId: UUID, limit: number | undefined) => void;

  /** Detach session request from client (tmux-style) */
  onDetachSession: (connectionId: UUID, sessionId: UUID, requestId: UUID) => void;

  /** Device token registered for push notifications */
  onRegisterDeviceToken: (connectionId: UUID, token: string, platform: 'ios' | 'android') => void;

  /** Device token unregistered — explicit user removal of this server (#690) */
  onUnregisterDeviceToken: (connectionId: UUID, token: string) => void;

  /** Error occurred */
  onError: (error: Error) => void;
}

const DEFAULT_PORT = 3847; // REMI on phone keypad
const DEFAULT_HOST = 'localhost';
const DEFAULT_PATH = '/ws';
const DEFAULT_MAX_CONNECTIONS = 100;

/**
 * Seconds of socket-level inactivity before Bun force-closes the raw
 * WebSocket (#662). A backstop behind the app-level pong reaper in
 * connection.ts: if that reaper is ever bypassed (event loop stall, an
 * unhandled exception in the ping tick), a truly wedged peer must still
 * eventually lose the connection rather than hold the session's exclusive
 * write lock forever. Set comfortably above the ping interval
 * (Connection's DEFAULT_PING_INTERVAL, 30s) so the pong reaper normally
 * fires first.
 */
const WS_IDLE_TIMEOUT_SECONDS = 120;

/** WebSocket data attached to each connection */
interface WSData {
  connectionId: UUID;
  /** Peer IP captured at upgrade time (used to skip auth for loopback). */
  peerAddress: string | null;
}

/**
 * WebSocket server for client connections.
 *
 * Usage:
 * ```ts
 * const server = new WebSocketServer({
 *   port: 3847,
 *   onClientConnect: (conn) => console.log('Client connected:', conn.id),
 *   onUserInput: (connId, sessionId, content) => {
 *     // Forward to PTY session
 *   }
 * });
 *
 * await server.start();
 * ```
 */
export class WebSocketServer {
  private readonly config: Required<ServerConfig>;
  private readonly events: Partial<ServerEvents>;
  private readonly connections: Map<UUID, Connection> = new Map();

  private server: ReturnType<typeof Bun.serve> | null = null;
  private isRunning = false;

  constructor(config: Partial<ServerConfig> = {}, events: Partial<ServerEvents> = {}) {
    this.config = {
      port: config.port ?? DEFAULT_PORT,
      host: config.host ?? DEFAULT_HOST,
      path: config.path ?? DEFAULT_PATH,
      maxConnections: config.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      connection: config.connection ?? {},
    };
    this.events = events;
  }

  /** Get number of active connections */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Get all connections */
  get allConnections(): readonly Connection[] {
    return Array.from(this.connections.values());
  }

  /** Check if server is running */
  get running(): boolean {
    return this.isRunning;
  }

  /** Get server port */
  get port(): number {
    return this.config.port;
  }

  /**
   * Get a connection by ID.
   */
  getConnection(id: UUID): Connection | undefined {
    return this.connections.get(id);
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Server already running');
    }

    const path = this.config.path;
    const self = this;

    this.server = Bun.serve<WSData>({
      port: this.config.port,
      hostname: this.config.host,

      fetch(req, server) {
        const url = new URL(req.url);

        // Only handle WebSocket upgrade on the configured path
        if (url.pathname === path) {
          // Check connection limit
          if (self.connections.size >= self.config.maxConnections) {
            return new Response('Too many connections', { status: 503 });
          }

          const peer = server.requestIP(req);
          const peerAddress = peer?.address ?? null;

          // Upgrade to WebSocket
          const success = server.upgrade(req, {
            data: {
              connectionId: generateId(),
              peerAddress,
            },
          });

          if (success) {
            return undefined; // Bun handles the response
          }

          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // CORS headers for HTTP endpoints. The daemon is a local-network
        // service that already accepts arbitrary WebSocket clients;
        // wildcard CORS does not add a security risk and is required for
        // the Capacitor iOS app (origin `capacitor://localhost`) to fetch
        // /auth-info during port-scan discovery. Without it, every probe
        // fails silently and the port-scan added in #393 reports "no
        // daemon found" even when daemons are actively serving (#403).
        const jsonCorsHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        };

        // Health check endpoint
        if (url.pathname === '/health') {
          return new Response(
            JSON.stringify({
              status: 'ok',
              connections: self.connections.size,
            }),
            { headers: jsonCorsHeaders },
          );
        }

        // Auth-info endpoint: lets clients probe whether this daemon will
        // require an Ed25519 challenge before opening the WebSocket. Loopback
        // peers are always exempt regardless of authenticator config, so the
        // probe answers from the same vantage point the WebSocket would.
        // See ConnectModal in packages/web for the consumer (#257).
        if (url.pathname === '/auth-info') {
          const peer = server.requestIP(req);
          const authenticator = self.config.connection?.authenticator;
          const authRequired =
            !shouldSkipAuthForPeer(!!authenticator, peer?.address) && !!authenticator;
          return new Response(
            JSON.stringify({
              authRequired,
              fingerprint: authenticator?.serverFingerprint ?? null,
            }),
            { headers: jsonCorsHeaders },
          );
        }

        // Connection-independent answer relay (#575, P4a). Lets a cold-start
        // push tap deliver an answer over plain HTTP before any WebSocket is
        // warm. Authenticated with the SAME trust model as the WebSocket
        // (loopback bypass + Ed25519 signature over an authorized key); routes
        // through the SAME answer core as the WebSocket `onAnswer`.
        if (url.pathname === '/answer') {
          if (req.method === 'OPTIONS') {
            return new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
              },
            });
          }
          if (req.method !== 'POST') {
            return new Response(JSON.stringify({ result: 'method-not-allowed' }), {
              status: 405,
              headers: jsonCorsHeaders,
            });
          }
          const peer = server.requestIP(req);
          return self.handleAnswerRelay(req, peer?.address ?? null, jsonCorsHeaders);
        }

        return new Response('Not found', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      },

      websocket: {
        idleTimeout: WS_IDLE_TIMEOUT_SECONDS,

        open(ws) {
          self.handleOpen(ws);
        },

        message(ws, message) {
          self.handleMessage(ws, message);
        },

        close(ws) {
          self.handleClose(ws);
        },

        // Note: Bun's WebSocket handler doesn't have an error event
        // Errors are handled through the close event or try/catch
      },
    });

    this.isRunning = true;
    this.events.onStart?.(this.config.port);
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      return;
    }

    // Close all connections
    for (const connection of this.connections.values()) {
      connection.close('Server shutting down');
    }
    this.connections.clear();

    // Stop server
    this.server.stop();
    this.server = null;
    this.isRunning = false;

    this.events.onStop?.();
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcast(message: ProtocolMessage): void {
    for (const connection of this.connections.values()) {
      if (connection.isConnected) {
        connection.send(message);
      }
    }
  }

  /**
   * Send a message to a specific connection.
   */
  sendTo(connectionId: UUID, message: ProtocolMessage): boolean {
    const connection = this.connections.get(connectionId);
    if (connection?.isConnected) {
      connection.send(message);
      return true;
    }
    return false;
  }

  /**
   * Force-close a specific connection (#662: same-device lock reclaim evicts
   * the stale connection this way). Goes through `Connection.close()` so the
   * normal error-frame + disconnect-event path runs, same as any other close.
   */
  closeConnection(connectionId: UUID, reason: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }
    connection.close(reason);
    return true;
  }

  /**
   * Handle a POST /answer relay request (#575, P4a).
   *
   * Auth reuses the WebSocket trust model: loopback peers are exempt (same
   * `shouldSkipAuthForPeer` bypass as the WS upgrade); networked peers must
   * sign the canonical request string `sessionId|questionId|answer` with a key
   * already in the daemon's authorized-keys store (the exact gate the WS
   * handshake applies). The answer is then routed through the SAME core as the
   * WebSocket `onAnswer`, so held-hook resolution / pick injection are identical.
   */
  private async handleAnswerRelay(
    req: Request,
    peerAddress: string | null,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    const reply = (status: number, result: string, extra?: Record<string, unknown>): Response =>
      new Response(JSON.stringify({ result, ...extra }), { status, headers: corsHeaders });

    // Defense-in-depth on a LAN-facing endpoint: cap the body before parsing.
    // Bun.serve defaults to a 128MB body limit; a permission answer is tiny, so
    // reject anything over 64KiB outright (before req.json() allocates).
    const MAX_BODY_BYTES = 64 * 1024;
    const contentLength = Number.parseInt(req.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      console.warn(
        `[answer-relay] rejected oversized body (${contentLength} bytes) from peer ${peerAddress ?? 'unknown'}`,
      );
      return reply(413, 'payload-too-large', { error: 'request body too large' });
    }

    let body: {
      sessionId?: unknown;
      questionId?: unknown;
      answer?: unknown;
      claudeSessionId?: unknown;
      auth?: {
        signature?: unknown;
        clientPublicKey?: unknown;
        clientFingerprint?: unknown;
      };
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return reply(400, 'bad-request', { error: 'invalid JSON body' });
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const questionId = typeof body.questionId === 'string' ? body.questionId : '';
    const answer = typeof body.answer === 'string' ? body.answer : '';
    const claudeSessionId =
      typeof body.claudeSessionId === 'string' ? body.claudeSessionId : undefined;
    if (!sessionId || !questionId || !answer) {
      return reply(400, 'bad-request', {
        error: 'sessionId, questionId, and answer are required',
      });
    }

    // Authenticate with the same trust model as the WebSocket.
    const authenticator = this.config.connection?.authenticator;
    if (authenticator && !shouldSkipAuthForPeer(true, peerAddress)) {
      const auth = body.auth;
      const signature = typeof auth?.signature === 'string' ? auth.signature : '';
      const clientPublicKey = typeof auth?.clientPublicKey === 'string' ? auth.clientPublicKey : '';
      const clientFingerprint =
        typeof auth?.clientFingerprint === 'string' ? auth.clientFingerprint : '';
      if (!signature || !clientPublicKey || !clientFingerprint) {
        console.warn(
          `[answer-relay] auth rejected: missing signature from peer ${peerAddress ?? 'unknown'}`,
        );
        return reply(401, 'unauthorized', { error: 'missing auth signature' });
      }
      // Bind the signature to this exact answer so it cannot be replayed for a
      // different question. Matches the client-side canonicalization.
      const message = `${sessionId}|${questionId}|${answer}`;
      const ok = await authenticator.verifyDetachedRequest(
        message,
        signature,
        clientPublicKey,
        clientFingerprint,
      );
      if (!ok) {
        console.warn(
          `[answer-relay] auth rejected: signature verification failed from peer ${peerAddress ?? 'unknown'} (key ${clientPublicKey.slice(0, 12)}…)`,
        );
        return reply(401, 'unauthorized', { error: 'signature verification failed' });
      }
    }

    if (!this.events.onAnswerRelay) {
      return reply(503, 'unavailable', { error: 'answer relay not wired' });
    }

    let outcome: 'delivered' | 'session-not-found' | 'stale-binding' | 'stale';
    try {
      outcome = await this.events.onAnswerRelay(
        sessionId as UUID,
        questionId as UUID,
        answer,
        claudeSessionId as UUID | undefined,
      );
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      return reply(500, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const status = outcome === 'delivered' ? 200 : outcome === 'session-not-found' ? 404 : 409;
    return reply(status, outcome);
  }

  private handleOpen(ws: { data: WSData }): void {
    const connectionEvents: Partial<ConnectionEvents> = {
      onConnect: (_sessionId) => {
        const connection = this.connections.get(ws.data.connectionId);
        if (connection) {
          this.events.onClientConnect?.(connection);
        }
      },

      onDisconnect: (reason) => {
        const connectionId = ws.data.connectionId;
        this.connections.delete(connectionId);
        this.events.onClientDisconnect?.(connectionId, reason);
      },

      onUserInput: (sessionId, content, raw, claudeSessionId) => {
        this.events.onUserInput?.(ws.data.connectionId, sessionId, content, raw, claudeSessionId);
      },

      onAnswer: (sessionId, questionId, answer, claudeSessionId, extra) => {
        this.events.onAnswer?.(
          ws.data.connectionId,
          sessionId,
          questionId,
          answer,
          claudeSessionId,
          extra,
        );
      },

      onBulletExpandRequest: (sessionId, bulletId, requestId) => {
        this.events.onBulletExpandRequest?.(ws.data.connectionId, sessionId, bulletId, requestId);
      },

      onSessionListRequest: (requestId, includeExternal) => {
        this.events.onSessionListRequest?.(ws.data.connectionId, requestId, includeExternal);
      },

      onTranscriptLoadRequest: (sessionId, requestId) => {
        this.events.onTranscriptLoadRequest?.(ws.data.connectionId, sessionId, requestId);
      },

      onCreateSessionRequest: (directory, requestId) => {
        this.events.onCreateSessionRequest?.(ws.data.connectionId, directory, requestId);
      },

      onTerminalResize: (cols, rows) => {
        this.events.onTerminalResize?.(ws.data.connectionId, cols, rows);
      },

      onKillSessionRequest: (sessionId, requestId) => {
        this.events.onKillSessionRequest?.(ws.data.connectionId, sessionId, requestId);
      },

      onResumeSessionRequest: (sessionId, requestId) => {
        this.events.onResumeSessionRequest?.(ws.data.connectionId, sessionId, requestId);
      },

      onSessionHistoryRequest: (requestId, limit) => {
        this.events.onSessionHistoryRequest?.(ws.data.connectionId, requestId, limit);
      },

      onDetachSession: (sessionId, requestId) => {
        this.events.onDetachSession?.(ws.data.connectionId, sessionId, requestId);
      },

      onRegisterDeviceToken: (token, platform) => {
        this.events.onRegisterDeviceToken?.(ws.data.connectionId, token, platform);
      },

      onUnregisterDeviceToken: (token) => {
        this.events.onUnregisterDeviceToken?.(ws.data.connectionId, token);
      },

      onError: (error) => {
        this.events.onError?.(error);
      },
    };

    // Localhost-no-auth (#257): even when an authenticator is configured,
    // peers connecting from the loopback interface are trusted by virtue of
    // being on the same machine. Drop the authenticator from this peer's
    // connection so it never receives an auth_challenge.
    let perConnectionConfig = this.config.connection;
    if (shouldSkipAuthForPeer(!!perConnectionConfig?.authenticator, ws.data.peerAddress)) {
      perConnectionConfig = { ...perConnectionConfig, authenticator: undefined };
    }

    const connection = new Connection(
      ws as unknown as WebSocket,
      connectionEvents,
      perConnectionConfig,
      ws.data.connectionId,
    );

    this.connections.set(ws.data.connectionId, connection);
  }

  private handleMessage(ws: { data: WSData }, message: string | Buffer): void {
    const connection = this.connections.get(ws.data.connectionId);
    if (connection) {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
      connection.handleMessage(data);
    }
  }

  private handleClose(ws: { data: WSData }): void {
    const connection = this.connections.get(ws.data.connectionId);
    if (connection) {
      connection.handleClose();
    }
  }
}
