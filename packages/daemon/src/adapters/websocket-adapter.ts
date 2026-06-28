/**
 * WebSocket Adapter - Wraps WebSocketServer to implement ConnectionAdapter.
 *
 * This adapter provides backward compatibility with the existing WebSocket
 * implementation while conforming to the adapter interface.
 */

import type { AgentStatus, Message, ProtocolMessage, Question, UUID } from '@remi/shared';
import { createAgentOutput, createQuestion, createSessionUpdate } from '@remi/shared';
import type { Authenticator } from '../auth/authenticator.ts';
import {
  type ServerConfig,
  type ServerEvents,
  WebSocketServer,
} from '../server/websocket-server.ts';
import type {
  AdapterConfig,
  AdapterEvents,
  AdapterMetadata,
  ConnectionAdapter,
} from './connection-adapter.ts';

/** WebSocket adapter configuration */
export interface WebSocketAdapterConfig extends AdapterConfig {
  /** Port to listen on */
  readonly port: number;

  /** Host to bind to */
  readonly host?: string;

  /** Path for WebSocket connections */
  readonly path?: string;

  /** Maximum concurrent connections */
  readonly maxConnections?: number;

  /** Authenticator instance (enables SSH-style auth) */
  readonly authenticator?: Authenticator | undefined;
}

const DEFAULT_PORT = 8765;

/**
 * WebSocket adapter implementation.
 *
 * Wraps the existing WebSocketServer to implement ConnectionAdapter.
 */
export class WebSocketAdapter implements ConnectionAdapter {
  readonly type = 'websocket';

  private readonly config: WebSocketAdapterConfig;
  private readonly events: Partial<AdapterEvents>;
  private server: WebSocketServer | null = null;
  private running = false;

  constructor(config: Partial<WebSocketAdapterConfig> = {}, events: Partial<AdapterEvents> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      port: config.port ?? DEFAULT_PORT,
      ...(config.host && { host: config.host }),
      ...(config.path && { path: config.path }),
      ...(config.maxConnections !== undefined && { maxConnections: config.maxConnections }),
      ...(config.authenticator && { authenticator: config.authenticator }),
    } as WebSocketAdapterConfig;
    this.events = events;
  }

  get connectionCount(): number {
    return this.server?.connectionCount ?? 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('WebSocket adapter already running');
    }

    if (!this.config.enabled) {
      console.log('WebSocket adapter disabled');
      return;
    }

    const serverEvents: Partial<ServerEvents> = {
      onStart: (port) => {
        console.log(`WebSocket adapter listening on port ${port}`);
      },

      onStop: () => {
        console.log('WebSocket adapter stopped');
      },

      onClientConnect: (connection) => {
        const metadata: AdapterMetadata = {
          adapterType: this.type,
          displayName: `ws-${connection.id.slice(0, 8)}`,
          platformData: {
            kind: 'websocket',
            directory: connection.connectionDirectory,
            resumeSessionId: connection.connectionResumeSessionId,
            mode: connection.connectionMode,
          },
        };
        this.events.onConnect?.(connection.id, metadata);
      },

      onClientDisconnect: (connectionId, reason) => {
        this.events.onDisconnect?.(connectionId, reason);
      },

      onUserInput: (connectionId, sessionId, content, raw, claudeSessionId) => {
        this.events.onUserInput?.(connectionId, sessionId, content, raw, claudeSessionId);
      },

      onAnswer: (connectionId, sessionId, questionId, answer, claudeSessionId, extra) => {
        this.events.onAnswer?.(connectionId, sessionId, questionId, answer, claudeSessionId, extra);
      },

      onAnswerRelay: async (sessionId, questionId, answer, claudeSessionId) =>
        // No relay handler wired => behave like an unknown session rather than
        // throwing inside the HTTP route.
        (await this.events.onAnswerRelay?.(sessionId, questionId, answer, claudeSessionId)) ??
        'session-not-found',

      onBulletExpandRequest: (connectionId, sessionId, bulletId, requestId) => {
        this.events.onBulletExpandRequest?.(connectionId, sessionId, bulletId, requestId);
      },

      onSessionListRequest: (connectionId, requestId, includeExternal) => {
        this.events.onSessionListRequest?.(connectionId, requestId, includeExternal);
      },

      onTranscriptLoadRequest: (connectionId, sessionId, requestId) => {
        this.events.onTranscriptLoadRequest?.(connectionId, sessionId, requestId);
      },

      onCreateSessionRequest: (connectionId, directory, requestId) => {
        this.events.onCreateSessionRequest?.(connectionId, directory, requestId);
      },

      onTerminalResize: (connectionId, cols, rows) => {
        this.events.onTerminalResize?.(connectionId, cols, rows);
      },

      onKillSessionRequest: (connectionId, sessionId, requestId) => {
        this.events.onKillSessionRequest?.(connectionId, sessionId, requestId);
      },

      onResumeSessionRequest: (connectionId, sessionId, requestId) => {
        this.events.onResumeSessionRequest?.(connectionId, sessionId, requestId);
      },

      onSessionHistoryRequest: (connectionId, requestId, limit) => {
        this.events.onSessionHistoryRequest?.(connectionId, requestId, limit);
      },

      onDetachSession: (connectionId, sessionId, requestId) => {
        this.events.onDetachSession?.(connectionId, sessionId, requestId);
      },

      onRegisterDeviceToken: (connectionId, token, platform) => {
        this.events.onRegisterDeviceToken?.(connectionId, token, platform);
      },

      onError: (error) => {
        // For server-level errors, use a dummy connection ID
        this.events.onError?.('server' as UUID, error);
      },
    };

    const serverConfig: Partial<ServerConfig> = {
      port: this.config.port,
      ...(this.config.host && { host: this.config.host }),
      ...(this.config.path && { path: this.config.path }),
      ...(this.config.maxConnections !== undefined && {
        maxConnections: this.config.maxConnections,
      }),
      // Let daemon handle HelloAck to include resume info
      connection: {
        skipHelloAck: true,
        ...(this.config.authenticator && { authenticator: this.config.authenticator }),
      },
    };

    this.server = new WebSocketServer(serverConfig, serverEvents);
    await this.server.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running || !this.server) {
      return;
    }

    await this.server.stop();
    this.server = null;
    this.running = false;
  }

  sendMessage(connectionId: UUID, message: Message): boolean {
    if (!this.server) {
      return false;
    }

    const protocolMessage = createAgentOutput(message);
    return this.server.sendTo(connectionId, protocolMessage);
  }

  sendQuestion(connectionId: UUID, question: Question, sessionId: UUID): boolean {
    if (!this.server) {
      return false;
    }

    const protocolMessage = createQuestion(question, sessionId);
    return this.server.sendTo(connectionId, protocolMessage);
  }

  sendStatus(connectionId: UUID, status: AgentStatus, context?: string): boolean {
    if (!this.server) {
      return false;
    }

    // Get session ID from connection
    const connection = this.server.getConnection(connectionId);
    if (!connection?.connectionSessionId) {
      return false;
    }

    const protocolMessage = createSessionUpdate(connection.connectionSessionId, status, context);
    return this.server.sendTo(connectionId, protocolMessage);
  }

  sendRaw(connectionId: UUID, message: ProtocolMessage): boolean {
    if (!this.server) {
      return false;
    }
    return this.server.sendTo(connectionId, message);
  }

  broadcast(message: ProtocolMessage): void {
    this.server?.broadcast(message);
  }

  hasConnection(connectionId: UUID): boolean {
    return this.server?.getConnection(connectionId) !== undefined;
  }
}
