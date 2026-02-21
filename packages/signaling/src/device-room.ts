/**
 * DeviceRoom Durable Object.
 *
 * Manages a persistent device room for reconnection without codes.
 * The daemon (host) maintains a long-lived WebSocket. Paired clients
 * connect by device name; authentication happens end-to-end via relay.
 */

import { type SignalingMessage, parseMessage, serializeMessage } from './types.ts';

// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type DurableObjectState = any;
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type CFWebSocket = any;

interface Env {
  DEVICE_IDLE_TIMEOUT_MS: string;
}

/** Rate limit entry per IP */
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;

export class DeviceRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  private deviceId: string | null = null;
  private host: CFWebSocket | null = null;
  private client: CFWebSocket | null = null;

  /** Rate limiting by IP address */
  private rateLimits = new Map<string, RateLimitEntry>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Extract client IP for rate limiting
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

    const WebSocketPair = (globalThis as unknown as { WebSocketPair: new () => CFWebSocket[] })
      .WebSocketPair;
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = pair;

    // Store IP in tags for rate limiting
    this.state.acceptWebSocket(serverWs, [ip]);

    return new Response(null, { status: 101, webSocket: clientWs } as ResponseInit);
  }

  async webSocketMessage(ws: CFWebSocket, data: string | ArrayBuffer): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const message = parseMessage(text);

    if (!message) {
      this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
      return;
    }

    switch (message.type) {
      case 'device_register':
        this.handleDeviceRegister(ws, message.deviceId);
        break;
      case 'connect_device':
        this.handleConnectDevice(ws, message.clientId);
        break;
      case 'relay':
        this.handleRelay(ws, message);
        break;
      default:
        this.sendError(ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${message.type}`);
    }
  }

  async webSocketClose(ws: CFWebSocket): Promise<void> {
    if (this.host === ws) {
      this.host = null;
      // Notify client that host disconnected
      if (this.client) {
        this.send(this.client, { type: 'peer-disconnected', role: 'host' });
      }
    } else if (this.client === ws) {
      this.client = null;
      // Notify host that client disconnected
      if (this.host) {
        this.send(this.host, { type: 'peer-disconnected', role: 'client' });
      }
    }

    // Schedule idle cleanup if both are gone
    if (!this.host && !this.client) {
      const idleMs = Number.parseInt(this.env.DEVICE_IDLE_TIMEOUT_MS) || 3_600_000;
      this.state.storage.setAlarm(Date.now() + idleMs);
    }
  }

  async webSocketError(ws: CFWebSocket, _error: Error): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    // If both peers are still gone after idle timeout, clean up stored state
    if (!this.host && !this.client) {
      this.deviceId = null;
      await this.state.storage.deleteAll();
    }
  }

  private handleDeviceRegister(ws: CFWebSocket, deviceId: string): void {
    if (this.host) {
      this.sendError(ws, 'ALREADY_REGISTERED', 'Device room already has a host');
      return;
    }

    this.deviceId = deviceId;
    this.host = ws;

    this.send(ws, {
      type: 'device_registered',
      deviceId,
    });
  }

  private handleConnectDevice(ws: CFWebSocket, clientId: string): void {
    // Rate limiting
    const tags = this.state.getTags(ws) ?? [];
    const ip = tags[0] ?? 'unknown';
    if (!this.checkRateLimit(ip)) {
      this.sendError(ws, 'RATE_LIMITED', 'Too many connection attempts');
      ws.close(4429, 'Rate limited');
      return;
    }

    if (!this.host) {
      this.sendError(ws, 'DEVICE_OFFLINE', 'Device is not currently online');
      return;
    }

    if (this.client) {
      this.sendError(ws, 'ROOM_FULL', 'Device already has a connected client');
      return;
    }

    this.client = ws;

    // Forward the connection request to the daemon for authentication
    this.send(this.host, {
      type: 'client_connect_request',
      clientId,
    });

    // Notify client that host is present (relay can now start for auth handshake)
    this.send(ws, {
      type: 'peer-connected',
      role: 'host',
    });

    // Notify host
    this.send(this.host, {
      type: 'peer-connected',
      role: 'client',
    });
  }

  private handleRelay(ws: CFWebSocket, message: SignalingMessage): void {
    let target: CFWebSocket | null = null;

    if (this.host === ws) {
      target = this.client;
    } else if (this.client === ws) {
      target = this.host;
    }

    if (!target) {
      this.sendError(ws, 'NO_PEER', 'No peer connected');
      return;
    }

    this.send(target, message);
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(ip);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(ip, { count: 1, windowStart: now });
      return true;
    }

    entry.count++;
    return entry.count <= RATE_LIMIT_MAX_ATTEMPTS;
  }

  private send(ws: CFWebSocket, message: SignalingMessage): boolean {
    try {
      ws.send(serializeMessage(message));
      return true;
    } catch (e) {
      console.error(`Failed to send ${message.type} message:`, e);
      return false;
    }
  }

  private sendError(ws: CFWebSocket, code: string, message: string): void {
    this.send(ws, { type: 'error', code, message });
  }
}
