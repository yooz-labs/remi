/**
 * Signaling Client - connects to the signaling server.
 *
 * Handles registration, code display, and relay message forwarding.
 */

import { EventEmitter } from 'node:events';

export interface SignalingClientEvents {
  registered: (code: string, expiresAt: string) => void;
  'peer-connected': () => void;
  'peer-disconnected': () => void;
  relay: (payload: string) => void;
  error: (code: string, message: string) => void;
  close: () => void;
  open: () => void;
}

export class SignalingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(url: string) {
    super();
    this.url = url;
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.closed = false;
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener('open', () => {
      this.emit('open');
      this.send({ type: 'register' });
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        switch (msg.type) {
          case 'registered':
            this.emit('registered', msg.code, msg.expiresAt);
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
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      this.emit('close');
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      // close event will follow
    });
  }

  sendRelay(payload: string): void {
    this.send({ type: 'relay', payload });
  }

  close(): void {
    this.closed = true;
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) {
        this.connect();
      }
    }, 5000);
  }
}
