/**
 * Connection Adapter - Abstract interface for different transport layers.
 *
 * Allows the daemon to work with WebSocket, Telegram, Discord, etc.
 * without coupling to a specific transport.
 */

import type { AgentStatus, Message, ProtocolMessage, Question, UUID } from '@remi/shared';

/** Metadata about a connection */
export interface AdapterMetadata {
  /** Type of adapter (websocket, telegram, etc.) */
  readonly adapterType: string;

  /** Human-readable name for the connection */
  readonly displayName?: string;

  /** Platform-specific metadata */
  readonly platformData?: Record<string, unknown>;
}

/** Events emitted from adapter to daemon */
export interface AdapterEvents {
  /** New connection established */
  onConnect: (connectionId: UUID, metadata: AdapterMetadata) => void;

  /** Connection closed */
  onDisconnect: (connectionId: UUID, reason: string) => void;

  /** User input received */
  onUserInput: (connectionId: UUID, sessionId: UUID, content: string, raw?: boolean) => void;

  /** Answer to question received */
  onAnswer: (connectionId: UUID, questionId: UUID, answer: string) => void;

  /** Bullet expand request received */
  onBulletExpandRequest: (
    connectionId: UUID,
    sessionId: UUID,
    bulletId: number,
    requestId: UUID,
  ) => void;

  /** Session list request received */
  onSessionListRequest: (connectionId: UUID, requestId: UUID, includeExternal: boolean) => void;

  /** Transcript load request received */
  onTranscriptLoadRequest: (connectionId: UUID, sessionId: string, requestId: UUID) => void;

  /** Create session request received */
  onCreateSessionRequest: (
    connectionId: UUID,
    directory: string | undefined,
    requestId: UUID,
  ) => void;

  /** Terminal resize from attached CLI client */
  onTerminalResize: (connectionId: UUID, cols: number, rows: number) => void;

  /** Kill session request received */
  onKillSessionRequest: (connectionId: UUID, sessionId: UUID, requestId: UUID) => void;

  /** Resume session request received */
  onResumeSessionRequest: (connectionId: UUID, sessionId: string, requestId: UUID) => void;

  /** Session history request received */
  onSessionHistoryRequest: (connectionId: UUID, requestId: UUID, limit: number | undefined) => void;

  /** Detach session request received (tmux-style) */
  onDetachSession: (connectionId: UUID, sessionId: UUID, requestId: UUID) => void;

  /** Device token registered for push notifications */
  onRegisterDeviceToken: (connectionId: UUID, token: string, platform: 'ios' | 'android') => void;

  /** Error occurred */
  onError: (connectionId: UUID, error: Error) => void;
}

/** Configuration for an adapter */
export interface AdapterConfig {
  /** Whether this adapter is enabled */
  readonly enabled?: boolean;
}

/**
 * Abstract interface for connection adapters.
 *
 * Each adapter translates between its native protocol (WebSocket, Telegram, etc.)
 * and the daemon's internal event model.
 */
export interface ConnectionAdapter {
  /** Unique type identifier for this adapter */
  readonly type: string;

  /** Number of active connections */
  readonly connectionCount: number;

  /** Whether the adapter is currently running */
  readonly isRunning: boolean;

  /**
   * Start the adapter.
   * Should begin listening for connections.
   */
  start(): Promise<void>;

  /**
   * Stop the adapter.
   * Should close all connections and stop listening.
   */
  stop(): Promise<void>;

  /**
   * Send a message to a specific connection.
   * @returns true if message was sent, false if connection not found
   */
  sendMessage(connectionId: UUID, message: Message): boolean;

  /**
   * Send a question to a specific connection.
   * The adapter is responsible for formatting appropriately
   * (e.g., inline keyboard for Telegram).
   */
  sendQuestion(connectionId: UUID, question: Question, sessionId?: UUID): boolean;

  /**
   * Send a status update to a specific connection.
   * The adapter can format this as appropriate (typing indicator, etc.).
   */
  sendStatus(connectionId: UUID, status: AgentStatus, context?: string): boolean;

  /**
   * Send a raw protocol message to a specific connection.
   * Used for low-level protocol messages (ack, pong, etc.).
   */
  sendRaw(connectionId: UUID, message: ProtocolMessage): boolean;

  /**
   * Broadcast a message to all connections.
   */
  broadcast(message: ProtocolMessage): void;

  /**
   * Check if a connection exists and is active.
   */
  hasConnection(connectionId: UUID): boolean;
}

/**
 * Factory function type for creating adapters.
 */
export type AdapterFactory<TConfig extends AdapterConfig = AdapterConfig> = (
  config: TConfig,
  events: Partial<AdapterEvents>,
) => ConnectionAdapter;
