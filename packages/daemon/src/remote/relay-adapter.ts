/**
 * Relay Adapter - bridges signaling server to daemon's adapter interface.
 *
 * Uses the signaling server as a message relay for remote clients.
 * Remi protocol messages are serialized as relay payloads.
 *
 * Supports two modes:
 * - Rotating codes (default): code changes on each reconnect; no Ed25519 auth
 * - Permanent code (--permanent-code): code persists; Ed25519 auth required
 *
 * Auth is determined by the presence of an `authenticator` in the config.
 * When set, the adapter runs a challenge-response handshake before accepting
 * any protocol messages from the relay peer:
 *   peer-connected -> auth_challenge -> auth_response -> auth_result -> onConnect
 */

import {
  createAgentOutput,
  createAuthResult,
  createError,
  createQuestion,
  generateId,
} from '@remi/shared';
import type {
  AgentStatus,
  AuthResponseMessage,
  Message,
  ProtocolMessage,
  Question,
  UUID,
} from '@remi/shared';
import type {
  AdapterConfig,
  AdapterEvents,
  AdapterMetadata,
  ConnectionAdapter,
} from '../adapters/connection-adapter.ts';
import type { Authenticator } from '../auth/authenticator.ts';
import { SignalingClient } from './signaling-client.ts';

/** Base relay config fields shared by both modes */
interface RelayAdapterConfigBase extends AdapterConfig {
  readonly signalingUrl: string;
}

/** Rotating codes (default): code changes on reconnect; no auth required */
interface RelayRotatingConfig extends RelayAdapterConfigBase {
  readonly rotateCode?: true;
  readonly code?: string;
  readonly authenticator?: Authenticator;
}

/** Permanent code: code persists; Ed25519 auth is mandatory */
interface RelayPermanentConfig extends RelayAdapterConfigBase {
  readonly rotateCode: false;
  readonly code: string;
  readonly authenticator: Authenticator;
}

export type RelayAdapterConfig = RelayRotatingConfig | RelayPermanentConfig;

type RelayAuthState = 'none' | 'challenging' | 'authenticated';

export class RelayAdapter implements ConnectionAdapter {
  readonly type = 'relay';

  private readonly config: RelayAdapterConfig;
  private readonly events: Partial<AdapterEvents>;
  private client: SignalingClient | null = null;
  private running = false;
  private connectionCode: string | null = null;

  /** Single client connection ID (relay supports one remote client at a time) */
  private clientConnectionId: UUID | null = null;

  /** Auth state for the current relay peer */
  private authState: RelayAuthState = 'none';

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

  private get requiresAuth(): boolean {
    return this.config.authenticator != null;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Relay adapter already running');
    }

    if (!this.config.enabled) {
      console.log('Relay adapter disabled');
      return;
    }

    const rotateOnReconnect = this.config.rotateCode !== false;

    this.client = new SignalingClient(this.config.signalingUrl, { rotateOnReconnect });

    this.client.on('registered', (code: string) => {
      this.connectionCode = code;
      console.log(`Remote access code: ${code}`);
    });

    this.client.on('open', () => {
      this.connectionCode = this.client?.connectionCode ?? null;
      if (this.connectionCode) {
        console.log(`Remote access code: ${this.connectionCode}`);
      }
    });

    this.client.on('code-rotated', (newCode: string) => {
      this.connectionCode = newCode;
      console.log(`Code rotated: ${newCode}`);
    });

    this.client.on('peer-connected', () => {
      const connectionId = generateId();
      this.clientConnectionId = connectionId;

      if (this.requiresAuth && this.config.authenticator) {
        // Send auth challenge before accepting messages
        const challenge = this.config.authenticator.createChallenge(connectionId);
        this.authState = 'challenging';
        this.client?.sendRelay(JSON.stringify(challenge));
      } else {
        // No auth required; accept connection immediately
        this.authState = 'authenticated';
        const metadata: AdapterMetadata = {
          adapterType: this.type,
          displayName: 'Remote Client',
          platformData: { kind: 'relay', code: this.connectionCode },
        };
        this.events.onConnect?.(connectionId, metadata);
      }
    });

    this.client.on('peer-disconnected', () => {
      this.resetClient('Remote client disconnected');
    });

    this.client.on('relay', (payload: string) => {
      try {
        const message = JSON.parse(payload);
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
          console.warn('Relay payload missing required "type" field');
          return;
        }

        // #591: a connection-independent relayed answer (lock-screen / backgrounded
        // phone) is SELF-AUTHENTICATING — it carries an Ed25519 `auth` block and is
        // dispatched via the relayAnswer path, so it needs NO connected /
        // handshake-authenticated WS peer (there is none). Gate on the ABSENCE of a
        // connected peer so a normal connected peer's answer always uses the
        // standard onAnswer routing even if a future client signs WS answers.
        if (
          !this.clientConnectionId &&
          message.type === 'answer' &&
          message.auth &&
          typeof message.auth === 'object'
        ) {
          this.handleRelayedAnswer(message).catch((err) =>
            console.warn('Relayed answer error:', err instanceof Error ? err.message : err),
          );
          return;
        }

        if (!this.clientConnectionId) {
          console.warn('Received relay message before client connection established');
          return;
        }

        // Handle auth_response during challenging state
        if (message.type === 'auth_response') {
          this.handleAuthResponse(message as AuthResponseMessage).catch((err) => {
            console.error('Relay auth error:', err instanceof Error ? err.message : err);
            const failResult = createAuthResult(false, undefined, 'INTERNAL_AUTH_ERROR');
            this.client?.sendRelay(JSON.stringify(failResult));
            this.resetClient();
          });
          return;
        }

        // Block all other messages until authenticated
        if (this.authState !== 'authenticated') {
          console.warn(`Relay message '${message.type}' dropped: not authenticated`);
          return;
        }

        // Route incoming protocol messages from the remote client
        this.routeMessage(message);
      } catch (e) {
        console.warn('Failed to parse relay payload:', e instanceof Error ? e.message : e);
      }
    });

    this.client.on('error', (code: string, msg: string) => {
      console.error(`Relay signaling error [${code}]: ${msg}`);
    });

    this.client.connect(this.config.code);
    this.running = true;
  }

  private async handleAuthResponse(response: AuthResponseMessage): Promise<void> {
    if (
      this.authState !== 'challenging' ||
      !this.clientConnectionId ||
      !this.config.authenticator
    ) {
      console.warn('Unexpected auth_response: not in challenging state');
      return;
    }

    const result = await this.config.authenticator.verifyResponse(
      this.clientConnectionId,
      response,
    );

    // Send auth_result to the client
    this.client?.sendRelay(JSON.stringify(result));

    if (result.success) {
      this.authState = 'authenticated';
      const metadata: AdapterMetadata = {
        adapterType: this.type,
        displayName: 'Remote Client (authenticated)',
        platformData: { kind: 'relay', code: this.connectionCode },
      };
      this.events.onConnect?.(this.clientConnectionId, metadata);
    } else {
      console.warn(`Relay auth failed: ${result.error}`);
      this.resetClient();
    }
  }

  /**
   * #591: handle a connection-independent relayed answer (a lock-screen /
   * backgrounded phone) forwarded by the signaling Worker's `/answer/{code}`
   * route. Unlike a peer's relay message there is no connected /
   * handshake-authenticated WS peer, so the answer carries its own Ed25519 `auth`
   * block which we verify here before dispatching via the relayAnswer path (the
   * same one the HTTP /answer endpoint uses). When the adapter runs without an
   * authenticator (rotating-code no-auth mode) the room code is the only gate,
   * consistent with the relay's WS path.
   */
  private async handleRelayedAnswer(msg: Record<string, unknown>): Promise<void> {
    const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
    const questionId = typeof msg['questionId'] === 'string' ? msg['questionId'] : '';
    const answer = typeof msg['answer'] === 'string' ? msg['answer'] : '';
    if (!sessionId || !questionId || !answer) {
      console.warn('Relayed answer dropped: missing sessionId, questionId, or answer');
      return;
    }

    if (this.config.authenticator) {
      const auth = msg['auth'] as Record<string, unknown>;
      const signature = typeof auth['signature'] === 'string' ? auth['signature'] : '';
      const clientPublicKey =
        typeof auth['clientPublicKey'] === 'string' ? auth['clientPublicKey'] : '';
      const clientFingerprint =
        typeof auth['clientFingerprint'] === 'string' ? auth['clientFingerprint'] : '';
      if (!signature || !clientPublicKey || !clientFingerprint) {
        console.warn('Relayed answer rejected: missing auth signature');
        return;
      }
      // Canonical message must match the phone's signing input and the daemon's
      // HTTP /answer verification (push-answer-relay.ts / websocket-server.ts).
      const message = `${sessionId}|${questionId}|${answer}`;
      const ok = await this.config.authenticator.verifyDetachedRequest(
        message,
        signature,
        clientPublicKey,
        clientFingerprint,
      );
      if (!ok) {
        console.warn('Relayed answer rejected: signature verification failed');
        return;
      }
    }

    // Fail loud if the connection-independent relay handler is not wired (a
    // partial events object) — otherwise a lock-screen answer would vanish with
    // no trace and the permission would stay held forever.
    if (!this.events.onAnswerRelay) {
      console.warn('Relayed answer dropped: onAnswerRelay not wired on the relay adapter');
      return;
    }
    const claudeId =
      typeof msg['claudeSessionId'] === 'string' ? (msg['claudeSessionId'] as UUID) : undefined;
    const outcome = await this.events.onAnswerRelay(
      sessionId as UUID,
      questionId as UUID,
      answer,
      claudeId,
    );
    if (outcome !== 'delivered') {
      console.warn(`Relayed answer not delivered: ${outcome}`);
    }
  }

  /** Reset client state, cleaning up auth challenges and notifying disconnect if authenticated. */
  private resetClient(reason?: string): void {
    if (!this.clientConnectionId) return;
    if (this.authState === 'challenging' && this.config.authenticator) {
      this.config.authenticator.removePendingChallenge(this.clientConnectionId);
    }
    if (this.authState === 'authenticated') {
      this.events.onDisconnect?.(this.clientConnectionId, reason ?? 'Connection reset');
    }
    this.clientConnectionId = null;
    this.authState = 'none';
  }

  private routeMessage(msg: Record<string, unknown>): void {
    if (!this.clientConnectionId) return;
    const connectionId = this.clientConnectionId;
    switch (msg['type']) {
      case 'user_input': {
        if (typeof msg['content'] !== 'string' || typeof msg['sessionId'] !== 'string') {
          console.warn('Invalid user_input payload: missing content or sessionId');
          return;
        }
        const claudeId =
          typeof msg['claudeSessionId'] === 'string' ? msg['claudeSessionId'] : undefined;
        this.events.onUserInput?.(
          connectionId,
          msg['sessionId'],
          msg['content'],
          msg['raw'] === true,
          claudeId,
        );
        break;
      }
      case 'answer': {
        if (typeof msg['questionId'] !== 'string' || typeof msg['answer'] !== 'string') {
          console.warn('Invalid answer payload: missing questionId or answer');
          return;
        }
        const claudeId =
          typeof msg['claudeSessionId'] === 'string' ? msg['claudeSessionId'] : undefined;
        this.events.onAnswer?.(
          connectionId,
          typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '',
          msg['questionId'],
          msg['answer'],
          claudeId,
        );
        break;
      }
      case 'session_list_request':
        if (typeof msg['id'] !== 'string') {
          console.warn('Invalid session_list_request payload: missing id');
          return;
        }
        this.events.onSessionListRequest?.(
          connectionId,
          msg['id'],
          (msg['includeExternal'] as boolean) ?? false,
        );
        break;
      case 'transcript_load_request':
        if (typeof msg['sessionId'] !== 'string' || typeof msg['id'] !== 'string') {
          console.warn('Invalid transcript_load_request payload: missing sessionId or id');
          return;
        }
        this.events.onTranscriptLoadRequest?.(connectionId, msg['sessionId'], msg['id']);
        break;
      case 'create_session_request':
        if (typeof msg['id'] !== 'string') {
          console.warn('Invalid create_session_request payload: missing id');
          return;
        }
        this.events.onCreateSessionRequest?.(
          connectionId,
          msg['directory'] as string | undefined,
          msg['id'],
        );
        break;
      case 'resume_session_request':
        if (typeof msg['sessionId'] !== 'string' || typeof msg['id'] !== 'string') {
          console.warn('Invalid resume_session_request payload: missing sessionId or id');
          return;
        }
        this.events.onResumeSessionRequest?.(connectionId, msg['sessionId'], msg['id']);
        break;
      case 'bullet_expand_request':
        if (
          typeof msg['sessionId'] !== 'string' ||
          typeof msg['bulletId'] !== 'number' ||
          typeof msg['id'] !== 'string'
        ) {
          console.warn('Invalid bullet_expand_request payload: missing required fields');
          return;
        }
        this.events.onBulletExpandRequest?.(
          connectionId,
          msg['sessionId'],
          msg['bulletId'],
          msg['id'],
        );
        break;
      case 'terminal_resize':
        if (typeof msg['cols'] !== 'number' || typeof msg['rows'] !== 'number') {
          console.warn('Invalid terminal_resize payload: cols and rows must be numbers');
          return;
        }
        this.events.onTerminalResize?.(connectionId, msg['cols'], msg['rows']);
        break;
      case 'kill_session_request':
        if (typeof msg['sessionId'] !== 'string' || typeof msg['id'] !== 'string') {
          console.warn('Invalid kill_session_request payload: missing sessionId or id');
          return;
        }
        this.events.onKillSessionRequest?.(connectionId, msg['sessionId'], msg['id']);
        break;
      case 'detach_session':
        if (typeof msg['sessionId'] !== 'string' || typeof msg['id'] !== 'string') {
          console.warn('Invalid detach_session payload: missing sessionId or id');
          return;
        }
        this.events.onDetachSession?.(connectionId, msg['sessionId'], msg['id']);
        break;
      case 'session_history_request': {
        if (typeof msg['id'] !== 'string') {
          console.warn('Invalid session_history_request payload: missing id');
          return;
        }
        const limit = typeof msg['limit'] === 'number' ? msg['limit'] : undefined;
        this.events.onSessionHistoryRequest?.(connectionId, msg['id'], limit);
        break;
      }
      case 'register_device_token':
        if (typeof msg['token'] !== 'string') {
          console.warn('Invalid register_device_token payload: missing token');
          return;
        }
        if (msg['platform'] !== 'ios' && msg['platform'] !== 'android') {
          console.warn('Invalid register_device_token payload: platform must be ios or android');
          return;
        }
        this.events.onRegisterDeviceToken?.(connectionId, msg['token'], msg['platform']);
        break;
      case 'ping':
        // Liveness ping needs no reply over relay.
        break;
      case 'hello':
        // Hello is handled at connection level, not message level
        break;
      default:
        console.warn(`Unknown relay message type: ${msg['type']}`);
        this.client?.sendRelay(
          JSON.stringify(
            createError(
              'UNSUPPORTED',
              `Message type '${String(msg['type'])}' is not supported over relay`,
            ),
          ),
        );
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.client) return;

    this.resetClient('Relay adapter stopped');

    this.client.close();
    this.client = null;
    this.running = false;
    this.connectionCode = null;
  }

  sendMessage(connectionId: UUID, message: Message): boolean {
    return this.sendRaw(connectionId, createAgentOutput(message));
  }

  sendQuestion(connectionId: UUID, question: Question, sessionId: UUID): boolean {
    return this.sendRaw(connectionId, createQuestion(question, sessionId));
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
