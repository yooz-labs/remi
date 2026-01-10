/**
 * WebSocket Connection - Wraps a WebSocket with protocol handling.
 *
 * Features:
 * - Message serialization/deserialization
 * - Message ID tracking for deduplication
 * - Acknowledgment handling
 * - Ping/pong keep-alive
 */

import {
  generateId,
  now,
  serialize,
  deserialize,
  createHelloAck,
  createAck,
  createPong,
  createError,
  MessageIdTracker,
} from '@remi/shared';
import type {
  UUID,
  ProtocolMessage,
  HelloMessage,
  UserInputMessage,
  AnswerMessage,
  PingMessage,
  Acknowledgment,
} from '@remi/shared';

/** Connection state */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** Events emitted by connection */
export interface ConnectionEvents {
  /** Connection established */
  onConnect: (sessionId: UUID) => void;

  /** Connection closed */
  onDisconnect: (reason: string) => void;

  /** User input received */
  onUserInput: (sessionId: UUID, content: string) => void;

  /** Answer to question received */
  onAnswer: (questionId: UUID, answer: string) => void;

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
}

const DEFAULT_PING_INTERVAL = 30000;
const DEFAULT_CONNECTION_TIMEOUT = 10000;
const SERVER_VERSION = '0.1.0';

/**
 * Represents a single WebSocket connection from a client.
 */
export class Connection {
  readonly id: UUID;
  private state: ConnectionState = 'connecting';
  private sessionId: UUID | null = null;

  private readonly ws: WebSocket;
  private readonly config: Required<ConnectionConfig>;
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
      connectionTimeout: config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
    };

    // Set connection timeout
    this.connectionTimer = setTimeout(() => {
      if (this.state === 'connecting') {
        this.close('Connection timeout');
      }
    }, this.config.connectionTimeout);
  }

  /** Get current state */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Get session ID (null if not yet connected) */
  get connectionSessionId(): UUID | null {
    return this.sessionId;
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
      case 'ping':
        this.handlePing(message);
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
  close(reason: string = 'Server closing connection'): void {
    if (this.state !== 'disconnected') {
      this.sendError('CLOSING', reason);
      this.ws.close();
      this.cleanup(reason);
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

    // Generate session ID
    this.sessionId = generateId();
    this.state = 'connected';

    // Send hello ack
    this.send(createHelloAck(this.config.serverVersion, this.sessionId));

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
    this.events.onUserInput?.(message.sessionId, message.content);
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
      // Bun WebSocket has built-in ping/pong, but we can also use protocol-level
      if (this.ws.readyState === WebSocket.OPEN) {
        // Let's rely on Bun's built-in ping/pong for now
        // The protocol ping/pong is available for application-level health checks
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

    this.state = 'disconnected';
    this.events.onDisconnect?.(reason);
  }
}
