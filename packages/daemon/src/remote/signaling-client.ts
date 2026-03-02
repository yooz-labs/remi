/**
 * Signaling Client - connects to the signaling server.
 *
 * Connects to a code-named room (using a provided or locally generated code)
 * and handles relay message forwarding.
 */

import { EventEmitter } from 'node:events';

/** Unambiguous characters for code generation (no 0/O, 1/I/L) */
const ALPHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const NUMERIC_CHARS = '23456789';

/** Generate a connection code locally (XXXX-YYYY format) */
export function generateConnectionCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let alpha = '';
  let numeric = '';
  for (let i = 0; i < 4; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index bounded by array length
    alpha += ALPHA_CHARS[bytes[i]! % ALPHA_CHARS.length];
  }
  for (let i = 0; i < 4; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index bounded by array length
    numeric += NUMERIC_CHARS[bytes[4 + i]! % NUMERIC_CHARS.length];
  }
  return `${alpha}-${numeric}`;
}

export interface SignalingClientOptions {
  /** Rotate to a new code on each auto-reconnect (default: true) */
  rotateOnReconnect?: boolean;
}

export interface SignalingClientEvents {
  registered: (code: string, expiresAt: string) => void;
  'peer-connected': () => void;
  'peer-disconnected': () => void;
  relay: (payload: string) => void;
  error: (code: string, message: string) => void;
  close: () => void;
  open: () => void;
  'code-rotated': (newCode: string) => void;
}

export class SignalingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly baseUrl: string;
  private readonly rotateOnReconnect: boolean;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private code: string | null = null;
  private isReconnect = false;

  constructor(baseUrl: string, options?: SignalingClientOptions) {
    super();
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.rotateOnReconnect = options?.rotateOnReconnect ?? true;
  }

  connect(code?: string): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.closed = false;

    if (code) {
      // Explicit code provided (initial connect)
      this.code = code;
    } else if (this.isReconnect && this.rotateOnReconnect) {
      // Auto-reconnect with rotation: generate new code
      this.code = generateConnectionCode();
      this.emit('code-rotated', this.code);
    } else if (!this.code) {
      // First connect with no code: generate one
      this.code = generateConnectionCode();
    }
    // Otherwise: reuse existing code (permanent mode)
    const wsUrl = `${this.baseUrl}/${this.code}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.emit('open');
      // Register as host in the code-named room
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
          default:
            console.warn(`Unknown signaling message type: ${msg.type}`);
        }
      } catch (e) {
        console.warn('Failed to parse signaling message:', e instanceof Error ? e.message : e);
      }
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      this.emit('close');
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', (event) => {
      console.warn('Signaling WebSocket error:', event);
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

  get connectionCode(): string | null {
    return this.code;
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
        this.isReconnect = true;
        this.connect();
      }
    }, 5000);
  }
}
