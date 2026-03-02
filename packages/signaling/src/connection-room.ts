/**
 * ConnectionRoom Durable Object.
 *
 * Manages a single signaling room for WebRTC connection establishment.
 * Handles two peers: host and client.
 *
 * Uses WebSocket Hibernation API. Room state (code, expiresAt) is
 * persisted to storage so join validation works after hibernation.
 * Peer roles are tracked via WebSocket attachment metadata.
 *
 * Note: This module uses Cloudflare Workers types which differ from Bun.
 * Type assertions are used where necessary for compatibility.
 */

import {
  type ConnectionCode,
  type SignalingMessage,
  parseMessage,
  serializeMessage,
} from './types.ts';

// Cloudflare-specific types (available at runtime in Workers)
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type DurableObjectState = any;
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type CFWebSocket = any;

/** Environment bindings */
interface Env {
  CONNECTION_TIMEOUT_MS: string;
}

/** Attached to each WebSocket to track role across hibernation */
interface WsAttachment {
  role: 'host' | 'client';
  urlCode?: string;
}

/**
 * Durable Object for managing a signaling room.
 */
export class ConnectionRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  private code: ConnectionCode | null = null;
  private expiresAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Handle HTTP requests (WebSocket upgrade).
   */
  async fetch(request: Request): Promise<Response> {
    // Only accept WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Restore persisted state if we were hibernated
    await this.restoreState();

    // Extract room code from URL path (e.g., /connect/AXBY-1234)
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/\/connect\/([A-Z0-9-]+)$/i);
    const urlCode = pathMatch?.[1]?.toUpperCase() ?? undefined;

    // Create WebSocket pair (Cloudflare-specific API)
    const WebSocketPair = (globalThis as unknown as { WebSocketPair: new () => CFWebSocket[] })
      .WebSocketPair;
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = pair;

    // Accept with no tags initially; role is set via attachment on register/join
    this.state.acceptWebSocket(serverWs);

    // Attach URL code so handlers can access it after hibernation wake
    serverWs.serializeAttachment({ role: 'pending', urlCode });

    // webSocket property is Cloudflare-specific ResponseInit extension
    return new Response(null, { status: 101, webSocket: clientWs } as ResponseInit);
  }

  /**
   * Handle WebSocket messages.
   */
  async webSocketMessage(ws: CFWebSocket, data: string | ArrayBuffer): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const message = parseMessage(text);

    if (!message) {
      this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
      return;
    }

    switch (message.type) {
      case 'register':
        await this.handleRegister(ws);
        break;
      case 'join':
        await this.handleJoin(ws, message.code);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'relay':
        this.handleSignaling(ws, message);
        break;
      default:
        this.sendError(ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(ws: CFWebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    const peerWs = this.getPeer(ws);

    if (peerWs && attachment?.role) {
      this.send(peerWs, { type: 'peer-disconnected', role: attachment.role });
    }

    // If no more connected sockets, clean up
    const remaining = this.state.getWebSockets().filter((s: CFWebSocket) => s !== ws);
    if (remaining.length === 0) {
      this.code = null;
      this.expiresAt = 0;
      await this.state.storage.deleteAll();
    }
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: CFWebSocket, _error: Error): Promise<void> {
    await this.webSocketClose(ws);
  }

  /**
   * Handle host registration.
   */
  private async handleRegister(ws: CFWebSocket): Promise<void> {
    // Check if already have a host
    if (this.findByRole('host')) {
      this.sendError(ws, 'ALREADY_REGISTERED', 'Room already has a host');
      return;
    }

    // Get URL code from attachment
    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    const urlCode = attachment?.urlCode;
    if (!urlCode) {
      this.sendError(ws, 'INTERNAL_ERROR', 'Room code not available');
      return;
    }
    this.code = urlCode as ConnectionCode;

    // Set expiration
    const timeoutMs = Number.parseInt(this.env.CONNECTION_TIMEOUT_MS) || 300000;
    this.expiresAt = Date.now() + timeoutMs;

    // Mark this WebSocket as host
    ws.serializeAttachment({ role: 'host', urlCode });

    // Persist state to survive hibernation
    await this.state.storage.put({ code: this.code, expiresAt: this.expiresAt });

    // Send registration confirmation
    this.send(ws, {
      type: 'registered',
      code: this.code,
      expiresAt: new Date(this.expiresAt).toISOString(),
    });

    // Schedule cleanup
    this.scheduleCleanup(timeoutMs);
  }

  /**
   * Handle client joining with code.
   */
  private async handleJoin(ws: CFWebSocket, code: ConnectionCode): Promise<void> {
    // Restore state if needed (hibernation recovery)
    await this.restoreState();

    // Validate code
    if (!this.code || this.code !== code) {
      this.sendError(ws, 'INVALID_CODE', 'Connection code not found or expired');
      return;
    }

    // Check if expired
    if (Date.now() > this.expiresAt) {
      this.sendError(ws, 'EXPIRED', 'Connection code has expired');
      return;
    }

    // Check if already have a client
    if (this.findByRole('client')) {
      this.sendError(ws, 'ROOM_FULL', 'Room already has a client');
      return;
    }

    // Mark this WebSocket as client
    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    ws.serializeAttachment({ role: 'client', urlCode: attachment?.urlCode });

    // Send join confirmation
    this.send(ws, { type: 'joined', code: this.code });

    // Notify both peers
    const hostWs = this.findByRole('host');
    if (hostWs) {
      this.send(hostWs, { type: 'peer-connected', role: 'client' });
      this.send(ws, { type: 'peer-connected', role: 'host' });
    }
  }

  /**
   * Handle signaling messages (offer, answer, ice-candidate, relay).
   */
  private handleSignaling(ws: CFWebSocket, message: SignalingMessage): void {
    const target = this.getPeer(ws);

    if (!target) {
      this.sendError(ws, 'NO_PEER', 'No peer connected to forward message');
      return;
    }

    this.send(target, message);
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

  private scheduleCleanup(timeoutMs: number): void {
    this.state.storage.setAlarm(Date.now() + timeoutMs);
  }

  async alarm(): Promise<void> {
    await this.restoreState();

    if (Date.now() > this.expiresAt) {
      const hostWs = this.findByRole('host');
      const clientWs = this.findByRole('client');

      if (hostWs) {
        this.sendError(hostWs, 'EXPIRED', 'Connection code has expired');
        hostWs.close();
      }
      if (clientWs) {
        this.sendError(clientWs, 'EXPIRED', 'Connection code has expired');
        clientWs.close();
      }

      this.code = null;
      this.expiresAt = 0;
      await this.state.storage.deleteAll();
    }
  }

  /**
   * Restore persisted state from storage (after hibernation).
   */
  private async restoreState(): Promise<void> {
    if (this.code) return;

    const stored = await this.state.storage.get(['code', 'expiresAt']);
    if (stored) {
      this.code = (stored.get('code') as ConnectionCode) ?? null;
      this.expiresAt = (stored.get('expiresAt') as number) ?? 0;
    }
  }

  /**
   * Find a connected WebSocket by its role attachment.
   */
  private findByRole(role: string): CFWebSocket | null {
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      if (attachment?.role === role) return ws;
    }
    return null;
  }

  /**
   * Get the peer WebSocket (the other connected socket).
   */
  private getPeer(ws: CFWebSocket): CFWebSocket | null {
    const sockets = this.state.getWebSockets();
    for (const s of sockets) {
      if (s !== ws) {
        const attachment = s.deserializeAttachment() as WsAttachment | null;
        if (attachment?.role === 'host' || attachment?.role === 'client') {
          return s;
        }
      }
    }
    return null;
  }
}
