/**
 * Connection Adapter - Abstract interface for different transport layers.
 *
 * Allows the daemon to work with WebSocket, Telegram, Discord, etc.
 * without coupling to a specific transport.
 */

import type {
  AgentStatus,
  AnswerExtras,
  Message,
  ProtocolMessage,
  Question,
  UUID,
} from '@remi/shared';

/**
 * Adapter-specific metadata, discriminated by `kind`.
 *
 * Each adapter populates exactly one variant; the daemon narrows on `kind`
 * before reading transport-specific fields. Without the discriminator, any
 * adapter could set any field (websocket setting `chatId`, etc.) and the
 * type checker would smile — discriminating locks the contract per adapter.
 */
export interface WebSocketPlatformData {
  readonly kind: 'websocket';
  /** Working directory the client requested for the Claude Code session. */
  readonly directory?: string | null;
  /** Session ID the client wants to resume. */
  readonly resumeSessionId?: UUID | null;
  /**
   * `'query'` means the client is a utility (ls, kill, etc.) that should not
   * auto-attach. `'attach'` (or undefined) means auto-attach if a primary
   * session exists.
   */
  readonly mode?: 'query' | 'attach' | undefined;
}

export interface TelegramPlatformData {
  readonly kind: 'telegram';
  readonly chatId: number;
  readonly topicId: number;
  readonly directory?: string | null;
}

export interface RelayPlatformData {
  readonly kind: 'relay';
  readonly code: string | null;
}

export type AdapterPlatformData = WebSocketPlatformData | TelegramPlatformData | RelayPlatformData;

/** Metadata about a connection */
export interface AdapterMetadata {
  /** Type of adapter (websocket, telegram, etc.) */
  readonly adapterType: string;

  /** Human-readable name for the connection */
  readonly displayName?: string;

  /** Adapter-specific metadata. Each adapter populates exactly one variant. */
  readonly platformData?: AdapterPlatformData;
}

/** Events emitted from adapter to daemon */
export interface AdapterEvents {
  /** New connection established */
  onConnect: (connectionId: UUID, metadata: AdapterMetadata) => void;

  /** Connection closed */
  onDisconnect: (connectionId: UUID, reason: string) => void;

  /** User input received */
  onUserInput: (
    connectionId: UUID,
    sessionId: UUID,
    content: string,
    raw?: boolean,
    claudeSessionId?: UUID,
  ) => void;

  /** Answer to question received. `extra` carries structured AskUserQuestion
   *  selections / cancel (#627); omitted for a plain single answer. */
  onAnswer: (
    connectionId: UUID,
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    claudeSessionId?: UUID,
    extra?: AnswerExtras,
  ) => void;

  /**
   * Connection-independent answer relay (#575, P4a). Used by the HTTP /answer
   * endpoint (WebSocket adapter) and, for a lock-screen / backgrounded phone, by
   * the relay adapter's self-authenticating answer path (#591). Returns a
   * structured outcome so the caller can act on / encode it.
   */
  onAnswerRelay?: (
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    claudeSessionId?: UUID,
  ) => Promise<'delivered' | 'session-not-found' | 'stale-binding' | 'stale'>;

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
  sendQuestion(connectionId: UUID, question: Question, sessionId: UUID): boolean;

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
