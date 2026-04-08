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
  /** Max reconnect attempts (Infinity for unlimited) */
  readonly maxReconnectAttempts?: number;
  /** Reconnect delay in ms (base for exponential backoff) */
  readonly reconnectDelay?: number;
  /** Maximum reconnect delay in ms (caps exponential backoff) */
  readonly maxReconnectDelay?: number;
  /** Connection timeout in ms */
  readonly connectionTimeout?: number;
  /** Heartbeat interval in ms (0 to disable). Closes stale connections that miss 2 heartbeats. */
  readonly heartbeatInterval?: number;
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
  maxReconnectAttempts: Number.POSITIVE_INFINITY,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  connectionTimeout: 10000,
  heartbeatInterval: 30000,
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastDataReceived = 0;
  private missedHeartbeats = 0;
  private intentionalDisconnect = false;

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

    this.intentionalDisconnect = false;
    this.setStatus('connecting');
    this.clearTimers();

    try {
      this.ws = new WebSocket(this.config.url);

      // Set connection timeout
      this.connectionTimer = setTimeout(() => {
        if (this.status === 'connecting' || this.status === 'authenticating') {
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
    this.intentionalDisconnect = true;
    this.clearTimers();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setStatus('disconnected');
  }

  /** Send a message to the daemon */
  send(message: ProtocolMessage): boolean {
    if (!this.ws || (this.status !== 'connected' && this.status !== 'authenticating')) {
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
    this.lastDataReceived = Date.now();
    this.missedHeartbeats = 0;
    this.startHeartbeat();
    // Don't set 'connected' yet; wait for auth handshake or hello_ack.
    // Set 'authenticating' to signal that the transport is open but auth is pending.
    this.setStatus('authenticating');
  }

  /** Transition to connected state (called after auth completes) */
  setConnected(): void {
    this.setStatus('connected');
  }

  /** Handle WebSocket close */
  private handleClose(): void {
    this.ws = null;
    this.clearConnectionTimer();
    this.stopHeartbeat();

    if (
      this.config.autoReconnect &&
      !this.intentionalDisconnect &&
      this.reconnectAttempts < this.config.maxReconnectAttempts
    ) {
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
    this.lastDataReceived = Date.now();
    this.missedHeartbeats = 0;

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

    // Exponential backoff with jitter, capped at maxReconnectDelay
    const base = this.config.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 10));
    const capped = Math.min(base, this.config.maxReconnectDelay);
    // Add up to 25% jitter to prevent thundering herd
    const jitter = capped * Math.random() * 0.25;
    const delay = capped + jitter;

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

  /** Start heartbeat monitoring. Detects dead connections that the OS hasn't closed yet. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatInterval;
    if (interval <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      const elapsed = Date.now() - this.lastDataReceived;
      if (elapsed > interval) {
        this.missedHeartbeats++;
      } else {
        this.missedHeartbeats = 0;
      }

      // If no data received for 2 heartbeat intervals, the connection is likely dead.
      // Force-close so reconnection logic kicks in.
      if (this.missedHeartbeats >= 2) {
        this.stopHeartbeat();
        this.handleError(new Error('Connection stale: no data received'));
        this.ws?.close();
      }
    }, interval);
  }

  /** Stop heartbeat monitoring */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.missedHeartbeats = 0;
  }

  /** Clear all timers */
  private clearTimers(): void {
    this.clearConnectionTimer();
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
