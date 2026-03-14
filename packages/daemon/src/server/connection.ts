/**
 * WebSocket Connection - Wraps a WebSocket with protocol handling.
 *
 * Features:
 * - Authentication state machine (challenge-response before hello)
 * - Message serialization/deserialization
 * - Message ID tracking for deduplication
 * - Acknowledgment handling
 * - Ping/pong keep-alive
 *
 * State transitions:
 *   With auth:    authenticating -> connecting (post-auth) -> connected -> disconnected
 *   Without auth: connecting -> connected -> disconnected
 */

import {
  MessageIdTracker,
  createAck,
  createAuthResult,
  createError,
  createHelloAck,
  createPing,
  createPong,
  deserialize,
  generateId,
  now,
  serialize,
} from '@remi/shared';
import type {
  Acknowledgment,
  AnswerMessage,
  AuthResponseMessage,
  BulletExpandRequestMessage,
  CreateSessionRequestMessage,
  HelloMessage,
  KillSessionRequestMessage,
  PingMessage,
  ProtocolMessage,
  SessionHistoryRequestMessage,
  SessionListRequestMessage,
  TerminalResizeMessage,
  TranscriptLoadRequestMessage,
  UUID,
  UserInputMessage,
} from '@remi/shared';
import type { Authenticator } from '../auth/authenticator.ts';

/** Connection state */
export type ConnectionState = 'connecting' | 'authenticating' | 'connected' | 'disconnected';

/** Events emitted by connection */
export interface ConnectionEvents {
  /** Connection established */
  onConnect: (sessionId: UUID) => void;

  /** Connection closed */
  onDisconnect: (reason: string) => void;

  /** User input received */
  onUserInput: (sessionId: UUID, content: string, raw?: boolean) => void;

  /** Answer to question received */
  onAnswer: (questionId: UUID, answer: string) => void;

  /** Bullet expand request received */
  onBulletExpandRequest: (sessionId: UUID, bulletId: number, requestId: UUID) => void;

  /** Session list request received */
  onSessionListRequest: (requestId: UUID, includeExternal: boolean) => void;

  /** Transcript load request received */
  onTranscriptLoadRequest: (sessionId: string, requestId: UUID) => void;

  /** Create session request received */
  onCreateSessionRequest: (directory: string | undefined, requestId: UUID) => void;

  /** Terminal resize from attached CLI client */
  onTerminalResize: (cols: number, rows: number) => void;

  /** Kill session request received */
  onKillSessionRequest: (sessionId: UUID, requestId: UUID) => void;

  /** Session history request received */
  onSessionHistoryRequest: (requestId: UUID, limit: number | undefined) => void;

  /** Authentication succeeded */
  onAuthSuccess: (clientFingerprint: string) => void;

  /** Authentication failed */
  onAuthFailed: (error: string, clientFingerprint?: string) => void;

  /** Error occurred */
  onError: (error: Error) => void;
}

/** Connection configuration */
export interface ConnectionConfig {
  /** Server version to report */
  readonly serverVersion: string;

  /** Ping interval in ms */
  readonly pingInterval?: number;

  /** Connection timeout in ms */
  readonly connectionTimeout?: number;

  /** Skip sending HelloAck from Connection (let daemon handle it) */
  readonly skipHelloAck?: boolean;

  /** Authenticator instance (if set, authentication is required) */
  readonly authenticator?: Authenticator | undefined;
}

const DEFAULT_PING_INTERVAL = 30000;
const DEFAULT_CONNECTION_TIMEOUT = 10000;
const DEFAULT_AUTH_CONNECTION_TIMEOUT = 60000;
const SERVER_VERSION = '0.1.0';

/**
 * Represents a single WebSocket connection from a client.
 */
export class Connection {
  readonly id: UUID;
  private state: ConnectionState = 'connecting';
  private sessionId: UUID | null = null;
  private directory: string | null = null;
  private resumeSessionId: UUID | null = null;

  private readonly ws: WebSocket;
  private readonly config: Required<ConnectionConfig> & {
    skipHelloAck: boolean;
    authenticator: Authenticator | undefined;
  };
  private readonly events: Partial<ConnectionEvents>;
  private readonly messageTracker: MessageIdTracker;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    ws: WebSocket,
    events: Partial<ConnectionEvents> = {},
    config: Partial<ConnectionConfig> = {},
    id?: UUID,
  ) {
    this.id = id ?? generateId();
    this.ws = ws;
    this.events = events;
    this.messageTracker = new MessageIdTracker();

    this.config = {
      serverVersion: config.serverVersion ?? SERVER_VERSION,
      pingInterval: config.pingInterval ?? DEFAULT_PING_INTERVAL,
      connectionTimeout:
        config.connectionTimeout ??
        (config.authenticator ? DEFAULT_AUTH_CONNECTION_TIMEOUT : DEFAULT_CONNECTION_TIMEOUT),
      skipHelloAck: config.skipHelloAck ?? false,
      authenticator: config.authenticator,
    };

    // Set connection timeout (applies to both auth and hello phases)
    this.connectionTimer = setTimeout(() => {
      if (this.state === 'connecting' || this.state === 'authenticating') {
        this.close('Connection timeout');
      }
    }, this.config.connectionTimeout);

    // If authenticator is configured, send challenge immediately
    if (this.config.authenticator) {
      this.state = 'authenticating';
      const challenge = this.config.authenticator.createChallenge(this.id);
      this.send(challenge);
    }
  }

  /** Get current state */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Get session ID (null if not yet connected) */
  get connectionSessionId(): UUID | null {
    return this.sessionId;
  }

  /** Get working directory (null if not specified) */
  get connectionDirectory(): string | null {
    return this.directory;
  }

  /** Get resume session ID (null if not resuming) */
  get connectionResumeSessionId(): UUID | null {
    return this.resumeSessionId;
  }

  /** Check if connection is active */
  get isConnected(): boolean {
    return this.state === 'connected';
  }

  /**
   * Handle incoming message.
   * Should be called by the WebSocket server's message handler.
   */
  handleMessage(data: string): void {
    const message = deserialize(data);
    if (!message) {
      this.sendError('INVALID_MESSAGE', 'Failed to parse message');
      return;
    }

    // Check for duplicate
    if (this.messageTracker.checkAndMark(message.id)) {
      // Duplicate - still acknowledge but don't process
      this.sendAck(message.id, 'delivered');
      return;
    }

    // In authenticating state, only accept auth_response
    if (this.state === 'authenticating') {
      if (message.type === 'auth_response') {
        this.handleAuthResponse(message).catch((err) => {
          this.send(createAuthResult(false, undefined, 'INTERNAL_AUTH_ERROR'));
          this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
          this.close('Authentication error');
        });
      } else if (message.type === 'ping') {
        this.handlePing(message);
      } else {
        this.sendError('AUTH_REQUIRED', 'Authentication required before other messages');
      }
      return;
    }

    // Route by message type
    switch (message.type) {
      case 'hello':
        this.handleHello(message);
        break;
      case 'user_input':
        this.handleUserInput(message);
        break;
      case 'answer':
        this.handleAnswer(message);
        break;
      case 'bullet_expand_request':
        this.handleBulletExpandRequest(message);
        break;
      case 'session_list_request':
        this.handleSessionListRequest(message);
        break;
      case 'transcript_load_request':
        this.handleTranscriptLoadRequest(message);
        break;
      case 'create_session_request':
        this.handleCreateSessionRequest(message);
        break;
      case 'terminal_resize':
        this.handleTerminalResize(message);
        break;
      case 'kill_session_request':
        this.handleKillSessionRequest(message);
        break;
      case 'session_history_request':
        this.handleSessionHistoryRequest(message);
        break;
      case 'ping':
        this.handlePing(message);
        break;
      case 'pong':
        // Client responding to our ping - no action needed
        break;
      case 'ack':
        // Client acknowledging our message - just track
        break;
      default:
        this.sendError('UNKNOWN_MESSAGE', `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle connection close.
   * Should be called by the WebSocket server's close handler.
   */
  handleClose(): void {
    this.cleanup('Client disconnected');
  }

  /**
   * Handle connection error.
   * Should be called by the WebSocket server's error handler.
   */
  handleError(error: Error): void {
    this.events.onError?.(error);
  }

  /**
   * Send a protocol message to the client.
   */
  send(message: ProtocolMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serialize(message));
    }
  }

  /**
   * Close the connection.
   */
  close(reason = 'Server closing connection'): void {
    if (this.state !== 'disconnected') {
      this.sendError('CLOSING', reason);
      this.ws.close();
      this.cleanup(reason);
    }
  }

  private async handleAuthResponse(message: AuthResponseMessage): Promise<void> {
    if (this.state !== 'authenticating' || !this.config.authenticator) {
      this.sendError('INVALID_STATE', 'Not in authenticating state');
      return;
    }

    const result = await this.config.authenticator.verifyResponse(this.id, message);
    this.send(result);

    if (result.success) {
      // Auth passed; transition to 'connecting' (waiting for hello)
      this.state = 'connecting';
      this.events.onAuthSuccess?.(message.clientFingerprint);
    } else {
      this.events.onAuthFailed?.(result.error ?? 'unknown', message.clientFingerprint);
      this.close(`Authentication failed: ${result.error}`);
    }
  }

  private handleHello(message: HelloMessage): void {
    if (this.state !== 'connecting') {
      this.sendError('INVALID_STATE', 'Already connected');
      return;
    }

    // Clear connection timeout
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    // Use connection ID as session ID for consistency
    // This ensures the same ID is used everywhere
    this.sessionId = this.id;
    this.directory = message.directory ?? null;
    this.resumeSessionId = message.resumeSessionId ?? null;
    this.state = 'connected';

    // Send hello ack (unless skipHelloAck is set, which lets daemon handle it)
    if (!this.config.skipHelloAck) {
      this.send(createHelloAck(this.config.serverVersion, this.sessionId));
    }

    // Acknowledge the hello
    this.sendAck(message.id, 'delivered');

    // Start ping timer
    this.startPingTimer();

    // Notify
    this.events.onConnect?.(this.sessionId);
  }

  private handleUserInput(message: UserInputMessage): void {
    if (this.state !== 'connected') {
      this.sendError('NOT_CONNECTED', 'Connection not established');
      return;
    }

    // Acknowledge receipt
    this.sendAck(message.id, 'delivered');

    // Notify
    this.events.onUserInput?.(message.sessionId, message.content, message.raw);
  }

  private handleAnswer(message: AnswerMessage): void {
    if (this.state !== 'connected') {
      this.sendError('NOT_CONNECTED', 'Connection not established');
      return;
    }

    // Acknowledge receipt
    this.sendAck(message.id, 'delivered');

    // Notify
    this.events.onAnswer?.(message.questionId, message.answer);
  }

  private handleBulletExpandRequest(message: BulletExpandRequestMessage): void {
    if (this.state !== 'connected') {
      this.sendError('NOT_CONNECTED', 'Connection not established');
      return;
    }

    if (!this.events.onBulletExpandRequest) {
      this.sendError('UNSUPPORTED', 'Bullet expansion not available');
      return;
    }

    // Acknowledge receipt
    this.sendAck(message.id, 'delivered');

    // Notify - the CLI will handle sending the response
    this.events.onBulletExpandRequest(message.sessionId, message.bulletId, message.id);
  }

  private handleSessionListRequest(message: SessionListRequestMessage): void {
    // Session list can be requested before full connection (no state check)
    this.sendAck(message.id, 'delivered');
    this.events.onSessionListRequest?.(message.id, message.includeExternal ?? false);
  }

  private handleTranscriptLoadRequest(message: TranscriptLoadRequestMessage): void {
    this.sendAck(message.id, 'delivered');
    this.events.onTranscriptLoadRequest?.(message.sessionId, message.id);
  }

  private handleCreateSessionRequest(message: CreateSessionRequestMessage): void {
    this.sendAck(message.id, 'delivered');
    this.events.onCreateSessionRequest?.(message.directory, message.id);
  }

  private handleKillSessionRequest(message: KillSessionRequestMessage): void {
    this.sendAck(message.id, 'delivered');
    this.events.onKillSessionRequest?.(message.sessionId, message.id);
  }

  private handleSessionHistoryRequest(message: SessionHistoryRequestMessage): void {
    this.sendAck(message.id, 'delivered');
    this.events.onSessionHistoryRequest?.(message.id, message.limit);
  }

  private handleTerminalResize(message: TerminalResizeMessage): void {
    this.sendAck(message.id, 'delivered');
    this.events.onTerminalResize?.(message.cols, message.rows);
  }

  private handlePing(message: PingMessage): void {
    // Send pong
    this.send(createPong(message.id));
  }

  private sendAck(messageId: UUID, state: Acknowledgment['state']): void {
    const ack: Acknowledgment = {
      messageId,
      state,
      timestamp: now(),
    };
    this.send(createAck(ack));
  }

  private sendError(code: string, message: string): void {
    this.send(createError(code, message));
  }

  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.send(createPing());
      }
    }, this.config.pingInterval);
  }

  private cleanup(reason: string): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }

    // Clean up pending auth challenge if connection closes during auth
    this.config.authenticator?.removePendingChallenge(this.id);

    this.state = 'disconnected';
    this.events.onDisconnect?.(reason);
  }
}
