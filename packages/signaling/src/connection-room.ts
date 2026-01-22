/**
 * ConnectionRoom Durable Object.
 *
 * Manages a single signaling room for WebRTC connection establishment.
 * Handles two peers: host and client.
 *
 * Note: This module uses Cloudflare Workers types which differ from Bun.
 * Type assertions are used where necessary for compatibility.
 */

import { generateCode } from './code-generator.ts';
import {
  type ConnectionCode,
  type PeerRole,
  type SignalingMessage,
  parseMessage,
  serializeMessage,
} from './types.ts';

// Cloudflare-specific types (available at runtime in Workers)
/* eslint-disable @typescript-eslint/no-explicit-any */
type DurableObjectState = any;
type CFWebSocket = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Session data for each connected peer */
interface PeerSession {
  ws: CFWebSocket;
  role: PeerRole;
  connectedAt: number;
}

/** Environment bindings */
interface Env {
  CONNECTION_TIMEOUT_MS: string;
}

/**
 * Durable Object for managing a signaling room.
 */
export class ConnectionRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  private code: ConnectionCode | null = null;
  private host: PeerSession | null = null;
  private client: PeerSession | null = null;
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

    // Create WebSocket pair (Cloudflare-specific API)
    // WebSocketPair is a Cloudflare Workers global, not available in Bun/Node
    const WebSocketPair = (globalThis as unknown as { WebSocketPair: new () => CFWebSocket[] })
      .WebSocketPair;
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = pair;

    // Accept the connection
    this.state.acceptWebSocket(serverWs);

    // webSocket property is Cloudflare-specific ResponseInit extension
    return new Response(null, { status: 101, webSocket: clientWs } as ResponseInit);
  }

  /**
   * Handle WebSocket messages.
   */
  async webSocketMessage(ws: CFWebSocket, data: string | ArrayBuffer): Promise<void> {
    // Parse message
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const message = parseMessage(text);

    if (!message) {
      this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
      return;
    }

    // Route by message type
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
        await this.handleSignaling(ws, message);
        break;
      default:
        this.sendError(ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle WebSocket close.
   */
  async webSocketClose(ws: CFWebSocket): Promise<void> {
    // Clean up the peer
    if (this.host?.ws === ws) {
      const wasHost = this.host;
      this.host = null;

      // Notify client if connected
      if (this.client) {
        this.send(this.client.ws, {
          type: 'peer-disconnected',
          role: 'host',
        });
      }
    } else if (this.client?.ws === ws) {
      this.client = null;

      // Notify host if connected
      if (this.host) {
        this.send(this.host.ws, {
          type: 'peer-disconnected',
          role: 'client',
        });
      }
    }

    // If both peers are gone, we can clean up
    if (!this.host && !this.client) {
      this.code = null;
    }
  }

  /**
   * Handle WebSocket error.
   */
  async webSocketError(ws: CFWebSocket, error: Error): Promise<void> {
    // Just close the connection on error
    await this.webSocketClose(ws);
  }

  /**
   * Handle host registration.
   */
  private async handleRegister(ws: CFWebSocket): Promise<void> {
    // Check if already registered
    if (this.host) {
      this.sendError(ws, 'ALREADY_REGISTERED', 'Room already has a host');
      return;
    }

    // Generate connection code
    this.code = generateCode();

    // Set expiration
    const timeoutMs = Number.parseInt(this.env.CONNECTION_TIMEOUT_MS) || 300000;
    this.expiresAt = Date.now() + timeoutMs;

    // Register as host
    this.host = {
      ws,
      role: 'host',
      connectedAt: Date.now(),
    };

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
    // Validate code
    if (this.code !== code) {
      this.sendError(ws, 'INVALID_CODE', 'Connection code not found or expired');
      return;
    }

    // Check if expired
    if (Date.now() > this.expiresAt) {
      this.sendError(ws, 'EXPIRED', 'Connection code has expired');
      return;
    }

    // Check if already have a client
    if (this.client) {
      this.sendError(ws, 'ROOM_FULL', 'Room already has a client');
      return;
    }

    // Register as client
    this.client = {
      ws,
      role: 'client',
      connectedAt: Date.now(),
    };

    // Send join confirmation
    this.send(ws, {
      type: 'joined',
      code: this.code,
    });

    // Notify both peers
    if (this.host) {
      this.send(this.host.ws, {
        type: 'peer-connected',
        role: 'client',
      });
      this.send(ws, {
        type: 'peer-connected',
        role: 'host',
      });
    }
  }

  /**
   * Handle signaling messages (offer, answer, ice-candidate).
   */
  private async handleSignaling(ws: CFWebSocket, message: SignalingMessage): Promise<void> {
    // Determine sender and target
    let target: PeerSession | null = null;

    if (this.host?.ws === ws) {
      target = this.client;
    } else if (this.client?.ws === ws) {
      target = this.host;
    }

    if (!target) {
      this.sendError(ws, 'NO_PEER', 'No peer connected to forward message');
      return;
    }

    // Forward the message
    this.send(target.ws, message);
  }

  /**
   * Send a message to a WebSocket.
   */
  private send(ws: CFWebSocket, message: SignalingMessage): void {
    try {
      ws.send(serializeMessage(message));
    } catch {
      // Ignore send errors (connection might be closed)
    }
  }

  /**
   * Send an error message.
   */
  private sendError(ws: CFWebSocket, code: string, message: string): void {
    this.send(ws, {
      type: 'error',
      code,
      message,
    });
  }

  /**
   * Schedule cleanup after timeout.
   */
  private scheduleCleanup(timeoutMs: number): void {
    // Cloudflare Workers don't support setTimeout in Durable Objects directly
    // Instead, we use alarms
    this.state.storage.setAlarm(Date.now() + timeoutMs);
  }

  /**
   * Handle alarm for cleanup.
   */
  async alarm(): Promise<void> {
    // Check if expired
    if (Date.now() > this.expiresAt) {
      // Close all connections
      if (this.host) {
        this.sendError(this.host.ws, 'EXPIRED', 'Connection code has expired');
        this.host.ws.close();
        this.host = null;
      }
      if (this.client) {
        this.sendError(this.client.ws, 'EXPIRED', 'Connection code has expired');
        this.client.ws.close();
        this.client = null;
      }
      this.code = null;
    }
  }
}
