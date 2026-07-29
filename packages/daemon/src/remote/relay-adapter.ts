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
 *
 * ## Encryption engages with auth, not with the relay (#881)
 *
 * The #543 key exchange rides that handshake, so it runs ONLY when an
 * `authenticator` is present. `cli.ts` passes one only in permanent-code mode,
 * so the DEFAULT rotating-code path never derives `sessionKeys` — even when the
 * user passed `--auth`.
 *
 * The two directions then behave DIFFERENTLY, and the difference matters:
 *
 * - **Outbound** (`sendRaw`): refuses to send at all. It returns false and logs
 *   rather than falling back to plaintext, which is deliberate (#543: "a silent
 *   downgrade is exactly the bug"). The consequence is that in default mode the
 *   daemon cannot deliver ANY message over the relay — not a leak, a breakage.
 * - **Inbound** (the `relay` handler): falls through to `handleRelayMessage`
 *   on the raw payload, so an unencrypted `user_input`, `answer` or device
 *   token from a client IS accepted, and the Worker saw it in the clear.
 *
 * So "the relay is unencrypted by default" is wrong in the outbound direction
 * and right in the inbound one. Say which direction you mean; see #881.
 */

import {
  createAgentOutput,
  createAuthResult,
  createError,
  createQuestion,
  decryptRelayPayload,
  deriveRelaySessionKeys,
  encryptRelayPayload,
  errorToString,
  generateEphemeralKeyPair,
  generateId,
  isSealedAnswer,
  openSealedAnswer,
} from '@remi/shared';
import type {
  AgentStatus,
  AnswerKeyPair,
  AuthResponseMessage,
  EphemeralKeyPair,
  Message,
  ProtocolMessage,
  Question,
  RelaySessionKeys,
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

/**
 * The slice of `SignalingClient` the adapter actually uses.
 *
 * Named so a test can stand in for the transport without a network or a
 * Worker (#543). The relay's handshake had no adapter-level coverage at all
 * before this: `relay-adapter-auth.test.ts` exercises `Authenticator`
 * directly and never constructs an adapter, which is why making the key
 * exchange mandatory broke none of its tests.
 */
export interface RelayTransport {
  on(event: 'registered', cb: (code: string, expiresAt: string) => void): void;
  on(event: 'relay', cb: (payload: string) => void): void;
  on(event: 'error', cb: (code: string, message: string) => void): void;
  on(event: 'open' | 'close' | 'peer-connected' | 'peer-disconnected', cb: () => void): void;
  on(event: 'code-rotated', cb: (code: string) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: the emitter is heterogeneous by design
  on(event: string, cb: (...args: any[]) => void): void;
  sendRelay(payload: string): void;
  connect(code?: string): void;
  close(): void;
  readonly isConnected: boolean;
  readonly connectionCode: string | null;
}

/** Base relay config fields shared by both modes */
interface RelayAdapterConfigBase extends AdapterConfig {
  readonly signalingUrl: string;
  /**
   * Build the transport. Defaults to a real `SignalingClient`; tests pass a
   * stand-in so the handshake can be driven without a Worker.
   */
  readonly createTransport?: (
    url: string,
    options: { rotateOnReconnect: boolean },
  ) => RelayTransport;
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
  private client: RelayTransport | null = null;
  private running = false;
  private connectionCode: string | null = null;

  /** Single client connection ID (relay supports one remote client at a time) */
  private clientConnectionId: UUID | null = null;

  /** Auth state for the current relay peer */
  private authState: RelayAuthState = 'none';

  /**
   * Relay end-to-end encryption state (#543). All three are per-connection and
   * cleared by `resetClient`, so a new peer can never inherit the previous
   * peer's keys.
   */
  private ephemeralKeys: EphemeralKeyPair | null = null;
  private sessionKeys: RelaySessionKeys | null = null;
  private kexChallenge: string | null = null;

  /** Opens sealed lock-screen answers (#875). Absent = cannot open them. */
  private answerKey: AnswerKeyPair | null = null;

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

    const createTransport =
      this.config.createTransport ??
      ((url: string, options: { rotateOnReconnect: boolean }) => new SignalingClient(url, options));
    this.client = createTransport(this.config.signalingUrl, { rotateOnReconnect });

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
        // Open the relay key exchange along with the challenge (#543), so
        // encryption costs no extra round trip. Async because signing is, so
        // the challenge is sent from the continuation.
        this.authState = 'challenging';
        this.startKeyExchange(connectionId).catch((err) => {
          console.error(
            `Relay key exchange could not start: ${errorToString(err)}. Refusing the connection rather than relaying in the clear.`,
          );
          this.resetClient('Key exchange failed');
        });
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

    this.client.on('relay', (rawPayload: string) => {
      // Once the key exchange has completed, every payload is ciphertext
      // (#543). Before it, only the handshake messages travel, and those are
      // public keys and signatures by design.
      if (this.sessionKeys) {
        const keys = this.sessionKeys;
        decryptRelayPayload(keys.receive, rawPayload)
          .then((plaintext) => this.handleRelayMessage(plaintext))
          .catch((err) => {
            // AES-GCM authenticates, so this is a wrong key or a tampered
            // payload, never a benign parse hiccup. Drop the connection rather
            // than let an attacker probe with garbage.
            console.error(
              `Relay payload failed authenticated decryption: ${errorToString(err)}. Dropping the peer.`,
            );
            this.resetClient('Relay decryption failed');
          });
        return;
      }
      this.handleRelayMessage(rawPayload);
    });

    this.client.on('error', (code: string, msg: string) => {
      console.error(`Relay signaling error [${code}]: ${msg}`);
    });

    this.client.connect(this.config.code);
    this.running = true;
  }

  /** Handle one decrypted (or pre-handshake) relay payload. */
  private handleRelayMessage(payload: string): void {
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
      // A sealed answer (#875) carries no readable `auth` block: the auth is
      // inside the ciphertext, which is the point. Recognise it by shape.
      if (
        !this.clientConnectionId &&
        message.type === 'answer' &&
        ((message.auth && typeof message.auth === 'object') || isSealedAnswer(message))
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
  }

  /** Give the adapter the key that opens sealed answers (#875). */
  setAnswerKey(key: AnswerKeyPair): void {
    this.answerKey = key;
  }

  /**
   * Open the relay key exchange (#543): generate an ephemeral keypair, sign it
   * with the daemon identity, and send it alongside the auth challenge.
   */
  private async startKeyExchange(connectionId: string): Promise<void> {
    if (!this.config.authenticator) return;
    const ephemeral = await generateEphemeralKeyPair();
    this.ephemeralKeys = ephemeral;
    const challenge = await this.config.authenticator.createChallengeWithRelayKex(
      connectionId,
      ephemeral.publicKeyBase64,
    );
    // Kept because deriving the session keys needs the same challenge as the
    // HKDF salt, and the pending challenge is the authenticator's private state.
    this.kexChallenge = challenge.challenge;
    this.client?.sendRelay(JSON.stringify(challenge));
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

    const { result } = await this.config.authenticator.verifyResponse(
      this.clientConnectionId,
      response,
    );

    // The identity check passed; now bind the ephemeral key to that identity
    // (#543). A client that cannot do this is too old for an encrypted relay,
    // and continuing would put session content back on the wire in the clear,
    // which is the whole bug. Refuse, and say which it is.
    if (result.success) {
      const ephemeral = this.ephemeralKeys;
      const kexOk =
        ephemeral !== null &&
        (await this.config.authenticator.verifyRelayKex(
          this.kexChallenge ?? '',
          response,
          ephemeral.publicKeyBase64,
        ));
      if (!kexOk) {
        const why = response.relayEphemeralKey
          ? 'its key-exchange signature did not verify'
          : 'it did not offer a key exchange (client too old for an encrypted relay; update the app)';
        console.warn(`Relay auth failed: ${why}`);
        this.client?.sendRelay(
          JSON.stringify(createAuthResult(false, undefined, 'RELAY_KEX_FAILED')),
        );
        this.resetClient();
        return;
      }
      this.sessionKeys = await deriveRelaySessionKeys(
        ephemeral.privateKey,
        response.relayEphemeralKey as string,
        this.kexChallenge ?? '',
        true,
      );
    }

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
  private async handleRelayedAnswer(raw: Record<string, unknown>): Promise<void> {
    // A sealed envelope (#875) is opened before anything else looks at it: the
    // Worker forwards ciphertext, so sessionId/questionId/answer do not exist
    // until this succeeds. A failure is a wrong key or a tampered request, never
    // a benign shape, so the answer is dropped rather than partially honored.
    let msg = raw;
    if (isSealedAnswer(raw)) {
      if (!this.answerKey) {
        console.warn('Sealed answer dropped: this daemon has no answer key, so it cannot open it');
        return;
      }
      try {
        const opened = await openSealedAnswer(this.answerKey.privateKeyPkcs8Base64, raw);
        if (opened === null || typeof opened !== 'object') {
          console.warn('Sealed answer dropped: contents were not an object');
          return;
        }
        msg = opened as Record<string, unknown>;
      } catch (err) {
        console.warn(`Sealed answer rejected: ${errorToString(err)}`);
        return;
      }
    }

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
    // Ephemeral by definition (#543): a new peer must never inherit these.
    this.ephemeralKeys = null;
    this.sessionKeys = null;
    this.kexChallenge = null;
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
        const messageId = typeof msg['id'] === 'string' ? msg['id'] : undefined;
        this.events.onUserInput?.(
          connectionId,
          msg['sessionId'],
          msg['content'],
          msg['raw'] === true,
          claudeId,
          messageId,
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
      case 'unregister_device_token':
        if (typeof msg['token'] !== 'string') {
          console.warn('Invalid unregister_device_token payload: missing token');
          return;
        }
        this.events.onUnregisterDeviceToken?.(connectionId, msg['token']);
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

    // Post-handshake traffic is encrypted end to end (#543); the worker
    // forwards an opaque string. Refuse to send rather than fall back to
    // plaintext: this path carries user_input, answers and device tokens, and
    // a silent downgrade is exactly the bug.
    const keys = this.sessionKeys;
    if (!keys) {
      console.error('Refusing to relay a message before the key exchange completed');
      return false;
    }
    const plaintext = JSON.stringify(message);
    encryptRelayPayload(keys.send, plaintext)
      .then((sealed) => this.client?.sendRelay(sealed))
      .catch((err) => console.error(`Relay encryption failed: ${errorToString(err)}`));
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
