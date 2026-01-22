/**
 * WebSocket client for daemon connection.
 *
 * Handles connection, reconnection, and protocol message serialization.
 */

import type { ConnectionStatus } from '@/types';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { deserialize, serialize } from '@remi/shared/protocol.ts';

/** WebSocket client configuration */
export interface WebSocketClientConfig {
  /** URL to connect to */
  readonly url: string;
  /** Reconnect on close */
  readonly autoReconnect?: boolean;
  /** Max reconnect attempts */
  readonly maxReconnectAttempts?: number;
  /** Reconnect delay in ms */
  readonly reconnectDelay?: number;
  /** Connection timeout in ms */
  readonly connectionTimeout?: number;
}

/** WebSocket client events */
export interface WebSocketClientEvents {
  /** Called when connection status changes */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Called when a message is received */
  onMessage?: (message: ProtocolMessage) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

/** Default configuration */
const DEFAULT_CONFIG: Required<Omit<WebSocketClientConfig, 'url'>> = {
  autoReconnect: true,
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
  connectionTimeout: 10000,
};

/**
 * WebSocket client for connecting to the Remi daemon.
 */
export class WebSocketClient {
  private readonly config: Required<WebSocketClientConfig>;
  private readonly events: WebSocketClientEvents;

  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: WebSocketClientConfig, events: WebSocketClientEvents = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;
  }

  /** Get current connection status */
  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** Check if connected */
  get isConnected(): boolean {
    return this.status === 'connected';
  }

  /** Connect to the daemon */
  connect(): void {
    if (this.ws && this.status !== 'disconnected') {
      return;
    }

    this.setStatus('connecting');
    this.clearTimers();

    try {
      this.ws = new WebSocket(this.config.url);

      // Set connection timeout
      this.connectionTimer = setTimeout(() => {
        if (this.status === 'connecting') {
          this.handleError(new Error('Connection timeout'));
          this.ws?.close();
        }
      }, this.config.connectionTimeout);

      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
      this.ws.onerror = this.handleWsError.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Disconnect from the daemon */
  disconnect(): void {
    this.clearTimers();
    this.config.autoReconnect && (this.reconnectAttempts = this.config.maxReconnectAttempts);

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setStatus('disconnected');
  }

  /** Send a message to the daemon */
  send(message: ProtocolMessage): boolean {
    if (!this.ws || this.status !== 'connected') {
      return false;
    }

    try {
      this.ws.send(serialize(message));
      return true;
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /** Handle WebSocket open */
  private handleOpen(): void {
    this.clearConnectionTimer();
    this.reconnectAttempts = 0;
    this.setStatus('connected');
  }

  /** Handle WebSocket close */
  private handleClose(): void {
    this.ws = null;
    this.clearConnectionTimer();

    if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.setStatus('disconnected');
    }
  }

  /** Handle WebSocket error */
  private handleWsError(): void {
    // The close event will follow, so we don't need to do much here
    this.handleError(new Error('WebSocket error'));
  }

  /** Handle incoming message */
  private handleMessage(event: MessageEvent): void {
    try {
      const data = typeof event.data === 'string' ? event.data : '';
      const message = deserialize(data);

      if (message && this.events.onMessage) {
        this.events.onMessage(message);
      }
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error('Failed to parse message'));
    }
  }

  /** Handle error */
  private handleError(error: Error): void {
    this.setStatus('error');
    this.events.onError?.(error);
  }

  /** Set connection status and notify */
  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.events.onStatusChange?.(status);
    }
  }

  /** Schedule reconnection attempt */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.setStatus('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff
    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Clear connection timeout timer */
  private clearConnectionTimer(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  /** Clear all timers */
  private clearTimers(): void {
    this.clearConnectionTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
