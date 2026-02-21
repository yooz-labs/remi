/**
 * Relay Adapter - bridges signaling server to daemon's adapter interface.
 *
 * Uses the signaling server as a message relay for remote clients.
 * Remi protocol messages are serialized as relay payloads.
 */

import { createAgentOutput, createQuestion, generateId } from '@remi/shared';
import type { AgentStatus, Message, ProtocolMessage, Question, UUID } from '@remi/shared';
import type {
  AdapterConfig,
  AdapterEvents,
  AdapterMetadata,
  ConnectionAdapter,
} from '../adapters/connection-adapter.ts';
import { SignalingClient } from './signaling-client.ts';

export interface RelayAdapterConfig extends AdapterConfig {
  readonly signalingUrl: string;
}

export class RelayAdapter implements ConnectionAdapter {
  readonly type = 'relay';

  private readonly config: RelayAdapterConfig;
  private readonly events: Partial<AdapterEvents>;
  private client: SignalingClient | null = null;
  private running = false;
  private connectionCode: string | null = null;

  /** Single client connection ID (relay supports one remote client at a time) */
  private clientConnectionId: UUID | null = null;

  constructor(config: RelayAdapterConfig, events: Partial<AdapterEvents> = {}) {
    this.config = config;
    this.events = events;
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

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Relay adapter already running');
    }

    if (!this.config.enabled) {
      console.log('Relay adapter disabled');
      return;
    }

    this.client = new SignalingClient(this.config.signalingUrl);

    this.client.on('registered', (code: string) => {
      this.connectionCode = code;
      console.log(`Remote access code: ${code}`);
    });

    this.client.on('open', () => {
      // The code is generated locally by SignalingClient before connecting
      this.connectionCode = this.client?.connectionCode ?? null;
      if (this.connectionCode) {
        console.log(`Remote access code: ${this.connectionCode}`);
      }
    });

    this.client.on('peer-connected', () => {
      const connectionId = generateId();
      this.clientConnectionId = connectionId;

      const metadata: AdapterMetadata = {
        adapterType: this.type,
        displayName: 'Remote Client',
        platformData: { code: this.connectionCode },
      };

      this.events.onConnect?.(connectionId, metadata);
    });

    this.client.on('peer-disconnected', () => {
      if (this.clientConnectionId) {
        this.events.onDisconnect?.(this.clientConnectionId, 'Remote client disconnected');
        this.clientConnectionId = null;
      }
    });

    this.client.on('relay', (payload: string) => {
      if (!this.clientConnectionId) {
        console.warn('Received relay message before client connection established');
        return;
      }

      try {
        const message = JSON.parse(payload);
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
          console.warn('Relay payload missing required "type" field');
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
          case 'terminal_resize':
            this.events.onTerminalResize?.(this.clientConnectionId, message.cols, message.rows);
            break;
          case 'hello':
            // Forward as connect event (already handled above)
            break;
          default:
            console.warn(`Unknown relay message type: ${message.type}`);
        }
      } catch (e) {
        console.warn('Failed to parse relay payload:', e instanceof Error ? e.message : e);
      }
    });

    this.client.on('error', (code: string, msg: string) => {
      console.error(`Relay signaling error [${code}]: ${msg}`);
    });

    this.client.connect();
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running || !this.client) return;

    if (this.clientConnectionId) {
      this.events.onDisconnect?.(this.clientConnectionId, 'Relay adapter stopped');
      this.clientConnectionId = null;
    }

    this.client.close();
    this.client = null;
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
    // Status updates are sent as raw session_update messages by the daemon
    return false;
  }

  sendRaw(connectionId: UUID, message: ProtocolMessage): boolean {
    if (connectionId !== this.clientConnectionId || !this.client?.isConnected) {
      return false;
    }

    this.client.sendRelay(JSON.stringify(message));
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
}
