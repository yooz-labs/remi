/**
 * Relay Adapter - bridges signaling server to daemon's adapter interface.
 *
 * Runs two signaling connections:
 * 1. SignalingClient (ephemeral): code-based, for initial pairing
 * 2. DeviceSignalingClient (persistent): device-named, for reconnection
 *
 * Pairing: new client connects via code, daemon issues pairing token.
 * Reconnection: paired client connects via device name, proves token via HMAC.
 */

import * as crypto from 'node:crypto';
import {
  createAgentOutput,
  createAuthChallenge,
  createAuthResult,
  createPairResponse,
  createQuestion,
  generateId,
} from '@remi/shared';
import type { AgentStatus, Message, ProtocolMessage, Question, UUID } from '@remi/shared';
import type {
  AdapterConfig,
  AdapterEvents,
  AdapterMetadata,
  ConnectionAdapter,
} from '../adapters/connection-adapter.ts';
import { DeviceSignalingClient } from './device-signaling-client.ts';
import type { DeviceIdentity } from './identity.ts';
import { SignalingClient } from './signaling-client.ts';

export interface RelayAdapterConfig extends AdapterConfig {
  readonly signalingUrl: string;
}

export class RelayAdapter implements ConnectionAdapter {
  readonly type = 'relay';

  private readonly config: RelayAdapterConfig;
  private readonly events: Partial<AdapterEvents>;
  private readonly identity: DeviceIdentity;

  /** Ephemeral client for code-based pairing */
  private codeClient: SignalingClient | null = null;
  /** Persistent client for device-based reconnection */
  private deviceClient: DeviceSignalingClient | null = null;

  private running = false;
  private connectionCode: string | null = null;

  /** Single client connection ID (one remote client at a time) */
  private clientConnectionId: UUID | null = null;
  /** Which signaling client is currently active for the connected client */
  private activeClient: 'code' | 'device' | null = null;
  /** Pending auth state for device reconnection */
  private pendingAuth: { clientId: string; nonce: string } | null = null;

  constructor(
    config: RelayAdapterConfig,
    events: Partial<AdapterEvents>,
    identity: DeviceIdentity,
  ) {
    this.config = config;
    this.events = events;
    this.identity = identity;
  }

  get connectionCount(): number {
    return this.clientConnectionId ? 1 : 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get code(): string | null {
    return this.connectionCode;
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Relay adapter already running');
    }

    if (!this.config.enabled) {
      console.log('Relay adapter disabled');
      return;
    }

    // Start ephemeral code-based client (for pairing)
    this.startCodeClient();

    // Start persistent device client (for reconnection)
    this.startDeviceClient();

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.clientConnectionId) {
      this.events.onDisconnect?.(this.clientConnectionId, 'Relay adapter stopped');
      this.clientConnectionId = null;
      this.activeClient = null;
    }

    this.codeClient?.close();
    this.codeClient = null;
    this.deviceClient?.close();
    this.deviceClient = null;
    this.running = false;
    this.connectionCode = null;
  }

  sendMessage(connectionId: UUID, message: Message): boolean {
    return this.sendRaw(connectionId, createAgentOutput(message));
  }

  sendQuestion(connectionId: UUID, question: Question): boolean {
    return this.sendRaw(connectionId, createQuestion(question));
  }

  sendStatus(_connectionId: UUID, _status: AgentStatus, _context?: string): boolean {
    return false;
  }

  sendRaw(connectionId: UUID, message: ProtocolMessage): boolean {
    if (connectionId !== this.clientConnectionId) return false;

    const client = this.activeClient === 'device' ? this.deviceClient : this.codeClient;
    if (!client?.isConnected) return false;

    client.sendRelay(JSON.stringify(message));
    return true;
  }

  broadcast(message: ProtocolMessage): void {
    if (this.clientConnectionId) {
      this.sendRaw(this.clientConnectionId, message);
    }
  }

  hasConnection(connectionId: UUID): boolean {
    return connectionId === this.clientConnectionId;
  }

  // --- Ephemeral code-based signaling (for pairing) ---

  private startCodeClient(): void {
    this.codeClient = new SignalingClient(this.config.signalingUrl);

    this.codeClient.on('registered', (code: string) => {
      this.connectionCode = code;
    });

    this.codeClient.on('open', () => {
      this.connectionCode = this.codeClient?.connectionCode ?? null;
    });

    this.codeClient.on('peer-connected', () => {
      // Only accept if no client is already connected via device
      if (this.clientConnectionId) return;

      const connectionId = generateId();
      this.clientConnectionId = connectionId;
      this.activeClient = 'code';

      const metadata: AdapterMetadata = {
        adapterType: this.type,
        displayName: 'Remote Client (pairing)',
        platformData: { code: this.connectionCode },
      };

      this.events.onConnect?.(connectionId, metadata);
    });

    this.codeClient.on('peer-disconnected', () => {
      if (this.activeClient === 'code' && this.clientConnectionId) {
        this.events.onDisconnect?.(this.clientConnectionId, 'Remote client disconnected');
        this.clientConnectionId = null;
        this.activeClient = null;
      }
    });

    this.codeClient.on('relay', (payload: string) => {
      if (this.activeClient !== 'code') return;
      this.handleRelayPayload(payload, 'code');
    });

    this.codeClient.on('error', (code: string, msg: string) => {
      console.error(`Relay signaling error [${code}]: ${msg}`);
    });

    this.codeClient.connect();
  }

  // --- Persistent device-based signaling (for reconnection) ---

  private startDeviceClient(): void {
    this.deviceClient = new DeviceSignalingClient(this.config.signalingUrl, this.identity.deviceId);

    this.deviceClient.on('registered', () => {
      console.log(`Device room registered: ${this.identity.deviceId}`);
    });

    this.deviceClient.on('client-connect', (clientId: string) => {
      // A client wants to connect via device name. Start auth challenge.
      const client = this.identity.findClient(clientId);
      if (!client) {
        console.warn(`Unknown client ID attempted device connection: ${clientId}`);
        // Send rejection via relay
        if (this.deviceClient?.isConnected) {
          this.deviceClient.sendRelay(JSON.stringify(createAuthResult(false, 'Unknown client')));
        }
        return;
      }

      // Generate and send challenge nonce
      const nonce = crypto.randomBytes(32).toString('hex');
      this.pendingAuth = { clientId, nonce };
      if (this.deviceClient?.isConnected) {
        this.deviceClient.sendRelay(JSON.stringify(createAuthChallenge(nonce)));
      }
    });

    this.deviceClient.on('peer-connected', () => {
      // Peer connected but not yet authenticated; auth happens via relay
    });

    this.deviceClient.on('peer-disconnected', () => {
      if (this.activeClient === 'device' && this.clientConnectionId) {
        this.events.onDisconnect?.(this.clientConnectionId, 'Remote client disconnected');
        this.clientConnectionId = null;
        this.activeClient = null;
      }
      this.pendingAuth = null;
    });

    this.deviceClient.on('relay', (payload: string) => {
      this.handleRelayPayload(payload, 'device');
    });

    this.deviceClient.on('error', (code: string, msg: string) => {
      console.error(`Device signaling error [${code}]: ${msg}`);
    });

    this.deviceClient.connect();
  }

  // --- Unified relay payload handler ---

  private handleRelayPayload(payload: string, source: 'code' | 'device'): void {
    let message: { type: string; [key: string]: unknown };
    try {
      message = JSON.parse(payload);
    } catch (e) {
      console.warn('Failed to parse relay payload:', e instanceof Error ? e.message : e);
      return;
    }

    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      console.warn('Relay payload missing required "type" field');
      return;
    }

    try {
      this.routeRelayMessage(message, source);
    } catch (e) {
      console.error(`Error handling relay message type=${message.type}:`, e);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic relay payload from JSON
  private routeRelayMessage(message: any, source: 'code' | 'device'): void {
    // Handle pairing messages (only from code-based connections)
    if (source === 'code' && message.type === 'pair_request') {
      this.handlePairRequest(message.clientName);
      return;
    }

    // Handle auth response (only from device-based connections, before authenticated)
    if (source === 'device' && message.type === 'auth_response') {
      this.handleAuthResponse(message.clientId, message.hmac);
      return;
    }

    // All other messages require an authenticated connection
    if (!this.clientConnectionId) {
      console.warn('Received relay message before client authenticated');
      return;
    }

    // Route incoming protocol messages from the remote client
    switch (message.type) {
      case 'user_input':
        if (typeof message.content !== 'string' || typeof message.sessionId !== 'string') {
          console.warn('Invalid user_input payload: missing content or sessionId');
          return;
        }
        this.events.onUserInput?.(this.clientConnectionId, message.sessionId, message.content);
        break;
      case 'answer':
        if (typeof message.questionId !== 'string' || typeof message.answer !== 'string') {
          console.warn('Invalid answer payload: missing questionId or answer');
          return;
        }
        this.events.onAnswer?.(this.clientConnectionId, message.questionId, message.answer);
        break;
      case 'session_list_request':
        this.events.onSessionListRequest?.(
          this.clientConnectionId,
          message.id,
          message.includeExternal ?? false,
        );
        break;
      case 'transcript_load_request':
        this.events.onTranscriptLoadRequest?.(
          this.clientConnectionId,
          message.sessionId,
          message.id,
        );
        break;
      case 'create_session_request':
        this.events.onCreateSessionRequest?.(
          this.clientConnectionId,
          message.directory,
          message.id,
        );
        break;
      case 'bullet_expand_request':
        this.events.onBulletExpandRequest?.(
          this.clientConnectionId,
          message.sessionId,
          message.bulletId,
          message.id,
        );
        break;
      case 'hello':
        break;
      default:
        console.warn(`Unknown relay message type: ${message.type}`);
    }
  }

  // --- Pairing protocol ---

  private handlePairRequest(clientName: string): void {
    if (this.activeClient !== 'code' || !this.clientConnectionId || !this.codeClient?.isConnected) {
      console.warn('Pair request received but no active code-based connection');
      return;
    }

    const clientId = generateId();
    const token = this.identity.addPairedClient(clientId, clientName || 'Remote Client');

    console.log(`Paired new client: ${clientName} (${clientId})`);

    const response = createPairResponse(this.identity.deviceId, clientId, token);
    this.codeClient.sendRelay(JSON.stringify(response));
  }

  // --- Auth protocol (device reconnection) ---

  private handleAuthResponse(clientId: string, hmac: string): void {
    if (!this.pendingAuth) {
      console.warn(`Auth response from ${clientId} but no pending challenge`);
      this.deviceClient?.sendRelay(JSON.stringify(createAuthResult(false, 'No pending challenge')));
      return;
    }
    if (!this.deviceClient?.isConnected) {
      console.warn('Auth response received but device signaling client disconnected');
      return;
    }

    // Verify the clientId matches the one we challenged
    if (this.pendingAuth.clientId !== clientId) {
      this.deviceClient.sendRelay(JSON.stringify(createAuthResult(false, 'Client ID mismatch')));
      return;
    }

    const nonce = this.pendingAuth.nonce;
    this.pendingAuth = null;

    const accepted = this.identity.verifyChallenge(clientId, nonce, hmac);

    if (accepted) {
      // Authenticate and register the connection
      const connectionId = generateId();
      this.clientConnectionId = connectionId;
      this.activeClient = 'device';

      this.identity.touchClient(clientId);

      const client = this.identity.findClient(clientId);
      const metadata: AdapterMetadata = {
        adapterType: this.type,
        displayName: `Remote Client (${client?.clientName ?? 'paired'})`,
        platformData: { deviceId: this.identity.deviceId, clientId },
      };

      this.deviceClient.sendRelay(JSON.stringify(createAuthResult(true)));
      this.events.onConnect?.(connectionId, metadata);

      console.log(`Authenticated paired client: ${client?.clientName} (${clientId})`);
    } else {
      console.warn(`Authentication failed for client: ${clientId}`);
      this.deviceClient.sendRelay(JSON.stringify(createAuthResult(false, 'Invalid credentials')));
    }
  }
}
