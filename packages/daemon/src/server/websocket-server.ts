/**
 * WebSocket Server - Manages WebSocket connections from clients.
 *
 * Uses Bun's built-in WebSocket server for high performance.
 * Handles connection lifecycle, message routing, and broadcasting.
 */

import { generateId } from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { Connection, type ConnectionConfig, type ConnectionEvents } from './connection.ts';

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
  onUserInput: (connectionId: UUID, sessionId: UUID, content: string) => void;

  /** Answer from client */
  onAnswer: (connectionId: UUID, questionId: UUID, answer: string) => void;

  /** Bullet expand request from client */
  onBulletExpandRequest: (
    connectionId: UUID,
    sessionId: UUID,
    bulletId: number,
    requestId: UUID,
  ) => void;

  /** Session list request from client */
  onSessionListRequest: (connectionId: UUID, requestId: UUID, includeExternal: boolean) => void;

  /** Error occurred */
  onError: (error: Error) => void;
}

const DEFAULT_PORT = 3847; // REMI on phone keypad
const DEFAULT_HOST = 'localhost';
const DEFAULT_PATH = '/ws';
const DEFAULT_MAX_CONNECTIONS = 100;

/** WebSocket data attached to each connection */
interface WSData {
  connectionId: UUID;
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

          // Upgrade to WebSocket
          const success = server.upgrade(req, {
            data: {
              connectionId: generateId(),
            },
          });

          if (success) {
            return undefined; // Bun handles the response
          }

          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // Health check endpoint
        if (url.pathname === '/health') {
          return new Response(
            JSON.stringify({
              status: 'ok',
              connections: self.connections.size,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        return new Response('Not found', { status: 404 });
      },

      websocket: {
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

  private handleOpen(ws: { data: WSData }): void {
    const connectionEvents: Partial<ConnectionEvents> = {
      onConnect: (sessionId) => {
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

      onUserInput: (sessionId, content) => {
        this.events.onUserInput?.(ws.data.connectionId, sessionId, content);
      },

      onAnswer: (questionId, answer) => {
        this.events.onAnswer?.(ws.data.connectionId, questionId, answer);
      },

      onBulletExpandRequest: (sessionId, bulletId, requestId) => {
        this.events.onBulletExpandRequest?.(ws.data.connectionId, sessionId, bulletId, requestId);
      },

      onSessionListRequest: (requestId, includeExternal) => {
        this.events.onSessionListRequest?.(ws.data.connectionId, requestId, includeExternal);
      },

      onError: (error) => {
        this.events.onError?.(error);
      },
    };

    const connection = new Connection(
      ws as unknown as WebSocket,
      connectionEvents,
      this.config.connection,
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
