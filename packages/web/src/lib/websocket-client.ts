/**
 * WebSocket client for daemon connection.
 *
 * Handles connection, reconnection, and protocol message serialization.
 */

import type { ConnectionStatus } from '@/types';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { createPing, createPong, deserialize, serialize } from '@remi/shared/protocol.ts';

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
  /**
   * Heartbeat interval in ms (0 to disable). Each tick sends the client's own
   * `ping` probe and checks whether the previous one got any reply; closes
   * the connection after `MAX_MISSED_HEARTBEATS` consecutive misses (#664).
   */
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
  /**
   * Called when auto-reconnect exhausts `maxReconnectAttempts` on the current
   * URL (the daemon's port is closed or it moved). The owner should escalate:
   * re-resolve the port from the host and `reconnectWithUrl`, or give up and
   * present a terminal `unreachable` state. If no handler is provided the
   * client falls back to `disconnected`.
   */
  onReconnectExhausted?: () => void;
}

/**
 * Default ceiling on consecutive reconnect attempts before `onReconnectExhausted`
 * fires. Finite (was Infinity) so a daemon that closed or moved its port stops
 * being retried forever and instead triggers port rediscovery / a terminal state.
 *
 * At the default backoff (1s base, doubling, capped at 30s) six attempts span
 * roughly 1+2+4+8+16+30 ≈ 60s of retries before escalating — long enough to
 * ride out a daemon restart, short enough that a real move is noticed quickly.
 */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6;

/**
 * Consecutive keep-alive probes allowed to go unanswered before the
 * connection is treated as dead (#664). Each probe is the client's OWN
 * outbound `ping`, sent every `heartbeatInterval`; the daemon always replies
 * to a ping with a `pong` (connection.ts `handlePing`), so under a healthy
 * network every probe gets some reply well inside one interval. This
 * decouples client-side staleness detection from the server's independent
 * keep-alive schedule -- the old bug was a passive silence watchdog whose
 * 30s window had zero margin over the server's own 30s ping cadence, so any
 * latency blip on the server's side force-closed a healthy socket. 3
 * consecutive misses gives real tolerance for transient jitter while still
 * catching a truly dead peer well inside the Bun-level idleTimeout backstop
 * (120s, websocket-server.ts).
 */
const MAX_MISSED_HEARTBEATS = 3;

/**
 * Multiplier on `heartbeatInterval` used by `isHealthy` to decide whether a
 * connection has seen traffic recently enough that a caller doing proactive
 * housekeeping (e.g. an app-resume force-reconnect sweep, #664) can trust it
 * without tearing it down. Looser than `MAX_MISSED_HEARTBEATS`, the reap
 * threshold, on purpose: this only needs to rule out real doubt, not confirm
 * death -- the internal heartbeat already owns the latter.
 */
const HEALTHY_WINDOW_MULTIPLIER = 2;

/** Default configuration */
const DEFAULT_CONFIG: Required<Omit<WebSocketClientConfig, 'url'>> = {
  autoReconnect: true,
  maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  connectionTimeout: 10000,
  heartbeatInterval: 15000,
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
  /** When the current cycle's keep-alive probe was sent; 0 if none is
   *  outstanding yet (fresh connection, or heartbeat just (re)started). */
  private lastPingSentAt = 0;
  private intentionalDisconnect = false;
  /** Live target URL. Starts at config.url; `reconnectWithUrl` rebinds it to a
   *  rediscovered port without recreating the client. */
  private currentUrl: string;

  constructor(config: WebSocketClientConfig, events: WebSocketClientEvents = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.events = events;
    this.currentUrl = config.url;
  }

  /** The URL the client is currently targeting. */
  get url(): string {
    return this.currentUrl;
  }

  /** Get current connection status */
  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** Check if connected */
  get isConnected(): boolean {
    return this.status === 'connected';
  }

  /** Whether the underlying transport is currently open, independent of the
   *  higher-level auth/connected status machine (#664): a status can lag a
   *  zombie socket after a long background suspend, so a stampede-avoidance
   *  caller needs the raw transport state to tell "already dead, reconnect
   *  now" apart from "open but uncertain, worth staggering". */
  get isTransportOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Whether this connection is open and has seen inbound traffic recently
   *  enough that a caller doing proactive housekeeping (e.g. an app-resume
   *  force-reconnect sweep, #664) can trust it without tearing it down. */
  get isHealthy(): boolean {
    if (!this.isTransportOpen) return false;
    if (this.config.heartbeatInterval <= 0) return true;
    return Date.now() - this.lastDataReceived < this.config.heartbeatInterval * HEALTHY_WINDOW_MULTIPLIER;
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
      this.ws = new WebSocket(this.currentUrl);

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

  /** Force-close and immediately reconnect (for network transitions and app resume). */
  forceReconnect(): void {
    if (this.intentionalDisconnect) return;
    this.clearTimers();
    this.reconnectAttempts = 0;
    if (this.ws) {
      // Detach handlers to prevent handleClose from scheduling a competing reconnect
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('reconnecting');
    // Small delay for the new network interface to stabilize
    setTimeout(() => this.connect(), 500);
  }

  /** Rebind to a (re-resolved) URL and reconnect immediately, resetting the
   *  reconnect counter. Used by the owner's `onReconnectExhausted` escalation
   *  after port rediscovery finds a live daemon port (which may be the same
   *  port, if the daemon simply restarted, or a sibling). */
  reconnectWithUrl(url: string): void {
    this.currentUrl = url;
    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;
    this.clearTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.connect();
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
    this.lastDataReceived = Date.now();
    this.missedHeartbeats = 0;
    this.startHeartbeat();
    // Don't reset reconnectAttempts here: the transport opening is not a
    // fully-established connection. Resetting on open would pin a connection
    // that opens but never authenticates (auth fail/timeout, post-auth drop,
    // heartbeat miss) to the base reconnectDelay forever, so the backoff never
    // grows and onReconnectExhausted never fires (a ~1s reconnect storm).
    // The counter is reset in setConnected(), the post-auth 'connected'
    // transition. See #586.
    //
    // Don't set 'connected' yet; wait for auth handshake or hello_ack.
    // Set 'authenticating' to signal that the transport is open but auth is pending.
    this.setStatus('authenticating');
  }

  /** Transition to connected state (called after auth completes) */
  setConnected(): void {
    // Only a fully-established (authenticated) connection clears the reconnect
    // counter, so a healthy connection that drops on a network blip and
    // reconnects successfully resets here, while an open-but-never-connected
    // connection keeps its growing backoff toward onReconnectExhausted (#586).
    this.reconnectAttempts = 0;
    this.setStatus('connected');
  }

  /** Handle WebSocket close */
  private handleClose(): void {
    this.ws = null;
    this.clearConnectionTimer();
    this.stopHeartbeat();

    if (this.intentionalDisconnect || !this.config.autoReconnect) {
      this.setStatus('disconnected');
      return;
    }

    if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.scheduleReconnect();
      return;
    }

    // Exhausted the ceiling on this URL. Clear the 'reconnecting' status first
    // so the client never reports a phantom in-progress reconnect after it has
    // stopped (and so the owner's onStatusChange runs its disconnect cleanup),
    // then hand off to the owner to rediscover the port or surface a terminal
    // state. With no handler we simply stay 'disconnected'.
    this.setStatus('disconnected');
    if (this.events.onReconnectExhausted) {
      this.events.onReconnectExhausted();
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

      if (message) {
        // Reply to the server's keep-alive ping (#662 review): the daemon's
        // pong-based liveness reaper force-closes a connection that never
        // answers its ping, even a healthy one. Handled here at the
        // transport layer (not a per-consumer case in a message switch) so
        // every consumer of WebSocketClient gets correct protocol behavior
        // for free, not just whichever ones remember to handle 'ping'.
        if (message.type === 'ping') {
          this.send(createPong(message.id));
        }
        this.events.onMessage?.(message);
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

  /**
   * Start heartbeat monitoring. Detects dead connections that the OS hasn't
   * closed yet by actively probing the peer rather than passively waiting
   * for it to speak first (#664): each tick checks whether the PREVIOUS
   * probe got any reply (any inbound message counts, not just an explicit
   * pong -- handleMessage already treats any message as proof of life), then
   * sends this cycle's probe.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatInterval;
    if (interval <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }

      // Skip the miss check on the very first tick: no probe has gone out yet.
      if (this.lastPingSentAt > 0) {
        if (this.lastDataReceived < this.lastPingSentAt) {
          this.missedHeartbeats++;
        } else {
          this.missedHeartbeats = 0;
        }
      }

      if (this.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
        this.stopHeartbeat();
        this.handleError(new Error('Connection stale: no reply to keep-alive ping'));
        this.ws?.close();
        return;
      }

      this.lastPingSentAt = Date.now();
      this.send(createPing());
    }, interval);
  }

  /** Stop heartbeat monitoring */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.missedHeartbeats = 0;
    this.lastPingSentAt = 0;
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
