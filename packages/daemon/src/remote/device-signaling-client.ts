/**
 * Device Signaling Client - persistent connection to a device room.
 *
 * Unlike SignalingClient (ephemeral, code-based), this maintains a
 * long-lived WebSocket to /device/<deviceId> for reconnection without codes.
 */

import { EventEmitter } from 'node:events';

export interface DeviceSignalingClientEvents {
  registered: () => void;
  'client-connect': (clientId: string) => void;
  'peer-connected': () => void;
  'peer-disconnected': () => void;
  relay: (payload: string) => void;
  error: (code: string, message: string) => void;
  close: () => void;
  open: () => void;
}

export class DeviceSignalingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly signalingUrl: string;
  private readonly deviceId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_DELAY_MS = 60_000;
  private static readonly BASE_RECONNECT_DELAY_MS = 5_000;
  private static readonly PING_INTERVAL_MS = 30_000;

  constructor(signalingUrl: string, deviceId: string) {
    super();
    // Convert /connect base URL to /device
    this.signalingUrl = signalingUrl.replace(/\/connect\/?$/, '').replace(/\/$/, '');
    this.deviceId = deviceId;
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.closed = false;

    const wsUrl = `${this.signalingUrl}/device/${this.deviceId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.emit('open');
      // Register as device host
      this.send({ type: 'device_register', deviceId: this.deviceId });
      this.startPing();
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        switch (msg.type) {
          case 'device_registered':
            this.emit('registered');
            break;
          case 'client_connect_request':
            this.emit('client-connect', msg.clientId);
            break;
          case 'peer-connected':
            this.emit('peer-connected');
            break;
          case 'peer-disconnected':
            this.emit('peer-disconnected');
            break;
          case 'relay':
            this.emit('relay', msg.payload);
            break;
          case 'error':
            this.emit('error', msg.code, msg.message);
            break;
          default:
            console.warn(`Unknown device signaling message type: ${msg.type}`);
        }
      } catch (e) {
        console.warn(
          'Failed to parse device signaling message:',
          e instanceof Error ? e.message : e,
        );
      }
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      this.stopPing();
      this.emit('close');
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', (event) => {
      console.warn('Device signaling WebSocket error:', event);
    });
  }

  sendRelay(payload: string): void {
    this.send({ type: 'relay', payload });
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Bun WebSocket supports ping(); standard WebSocket does not
        (this.ws as unknown as { ping?: () => void }).ping?.();
      }
    }, DeviceSignalingClient.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      DeviceSignalingClient.BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      DeviceSignalingClient.MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) {
        this.connect();
      }
    }, delay);
  }
}
