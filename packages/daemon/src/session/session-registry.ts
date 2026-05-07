/**
 * SessionRegistry - Manages a single session per daemon.
 *
 * Key concepts:
 * - One daemon = one session = one port
 * - Sessions survive connection drops (orphaned state)
 * - Orphaned sessions timeout after configurable period (default 5 minutes)
 * - Locally-owned sessions (wrapper mode) are exempt from orphan timeout
 * - Connections can resume the session within the timeout window
 * - Message history is tracked for replay on reconnect
 */

import type {
  AgentStatus,
  DiscoverableSession,
  ProtocolMessage,
  Question,
  Timestamp,
  UUID,
} from '@remi/shared';
import { errorToString } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { MessageAPI } from '../api/message-api.ts';
import type { PTYSession } from '../pty/pty-session.ts';
import { generateSessionName } from './session-name.ts';

/** Configuration for SessionRegistry */
export interface SessionRegistryConfig {
  /** How long orphaned sessions stay alive (ms). Default: 5 minutes */
  readonly orphanTimeoutMs?: number;
  /** Maximum messages to keep for replay. Default: 1000 */
  readonly maxReplayHistory?: number;
}

/** Result of attempting to attach a connection to a session */
export interface AttachResult {
  /** Whether attachment succeeded */
  readonly success: boolean;
  /** Whether this is a resume (vs new session) */
  readonly isResume: boolean;
  /** Messages to replay to the client */
  readonly replayMessages: readonly ProtocolMessage[];
  /** Current agent status */
  readonly currentStatus: AgentStatus;
  /** Current pending question (if any) */
  readonly currentQuestion: Question | null;
  /** Next bullet ID for continuation */
  readonly nextBulletId: number;
  /** Error message if attachment failed */
  readonly error?: string;
}

/** Events emitted by SessionRegistry */
export interface SessionRegistryEvents {
  /** Session was created */
  onSessionCreated?: (sessionId: UUID) => void;
  /** Session was closed (timeout or PTY exit) */
  onSessionClosed?: (sessionId: UUID, reason: 'timeout' | 'pty_exit' | 'forced') => void;
  /** Connection detached from session. For non-locally-owned sessions,
   * this means the session is now orphaned; locally-owned sessions remain active. */
  onSessionOrphaned?: (sessionId: UUID) => void;
  /** Session was resumed (connection reattached) */
  onSessionResumed?: (sessionId: UUID, connectionId: UUID) => void;
  /** A waiting connection was promoted to active after the previous client disconnected */
  onConnectionPromoted?: (sessionId: UUID, connectionId: UUID, result: AttachResult) => void;
}

/** A managed session with all its runtime state */
export interface ManagedSession {
  /** Unique session ID */
  readonly sessionId: UUID;
  /** Human-readable session name (e.g. "hostname:dirname/branch") */
  readonly name: string;
  /** When session was created */
  readonly createdAt: Timestamp;
  /** Working directory for Claude Code */
  readonly workingDirectory: string;

  /** PTY session running Claude Code */
  pty: PTYSession;
  /** Message API for structured messages */
  messageApi: MessageAPI;

  /** When session last had activity (message, status change) */
  lastActivityAt: Timestamp;

  /** Currently attached connection ID (null if no connection is attached) */
  activeConnectionId: UUID | null;
  /** When session was last disconnected (null if connected) */
  lastDisconnectedAt: Timestamp | null;
  /** Timeout handle for orphan cleanup */
  orphanTimeoutId: ReturnType<typeof setTimeout> | null;

  /** Message history for replay */
  messageHistory: ProtocolMessage[];
  /** Index of last message delivered to client (-1 if none) */
  lastDeliveredIndex: number;

  /** Current agent status */
  currentStatus: AgentStatus;
  /** Current pending question */
  currentQuestion: Question | null;

  /** Whether this session is owned by the local process (wrapper mode).
   * Locally-owned sessions are never killed by orphan timeout. */
  readonly locallyOwned: boolean;

  /** Whether the last detach was an explicit user request (tmux-style).
   * Explicitly detached sessions skip the orphan timeout entirely. */
  explicitlyDetached: boolean;
}

/**
 * SessionRegistry manages a single session per daemon process.
 *
 * This enables:
 * - Sessions surviving temporary disconnects
 * - Message replay on reconnect
 * - Graceful timeout-based cleanup
 */
export class SessionRegistry {
  private session: ManagedSession | null = null;
  private readonly events: SessionRegistryEvents;
  private readonly orphanTimeoutMs: number;
  private readonly maxReplayHistory: number;
  /** Connections waiting for the active connection to disconnect */
  private readonly waitingConnections: UUID[] = [];
  /** Buffer for messages received before session registration (from readExisting transcript) */
  private preRegistrationBuffer: ProtocolMessage[] = [];

  constructor(config: SessionRegistryConfig = {}, events: SessionRegistryEvents = {}) {
    this.orphanTimeoutMs = config.orphanTimeoutMs ?? 5 * 60 * 1000; // 5 minutes
    this.maxReplayHistory = config.maxReplayHistory ?? 1000;
    this.events = events;
  }

  /** The current session, if any. */
  get activeSession(): ManagedSession | null {
    return this.session;
  }

  /**
   * Register a new session with its PTY and message API.
   * Only one session is allowed per daemon; throws if a session already exists.
   */
  registerSession(
    sessionId: UUID,
    workingDirectory: string,
    pty: PTYSession,
    messageApi: MessageAPI,
    locallyOwned = false,
  ): void {
    if (this.session !== null) {
      throw new Error('Session already registered. Only one session per daemon is allowed.');
    }

    const name = generateSessionName(workingDirectory);

    const createdAt = now();
    this.session = {
      sessionId,
      name,
      createdAt,
      workingDirectory,
      pty,
      messageApi,
      lastActivityAt: createdAt,
      activeConnectionId: null,
      lastDisconnectedAt: null,
      orphanTimeoutId: null,
      messageHistory: [],
      lastDeliveredIndex: -1,
      currentStatus: 'idle',
      currentQuestion: null,
      locallyOwned,
      explicitlyDetached: false,
    };

    // Flush pre-registration buffer (messages from readExisting transcript entries)
    if (this.preRegistrationBuffer.length > 0) {
      this.session.messageHistory.push(...this.preRegistrationBuffer);
      this.preRegistrationBuffer = [];
    }

    this.events.onSessionCreated?.(sessionId);
  }

  /**
   * Create a new session ID.
   * The actual session components (PTY, messageApi) must be
   * registered separately via registerSession.
   */
  createSessionId(): UUID {
    return generateId();
  }

  /**
   * Get a session by its ID.
   */
  getSession(sessionId: UUID): ManagedSession | undefined {
    if (this.session !== null && this.session.sessionId === sessionId) {
      return this.session;
    }
    return undefined;
  }

  /**
   * Check if a session exists (has not been cleaned up).
   */
  hasSession(sessionId: UUID): boolean {
    return this.session !== null && this.session.sessionId === sessionId;
  }

  /**
   * Get the session for a given connection — only when that connection holds
   * the exclusive write lock. Queued connections receive replay history via
   * attachConnection() but cannot write to the PTY: input/answer/resize from
   * a queued client would race the active client's session. They are auto-
   * promoted on disconnect (FIFO).
   */
  getSessionForConnection(connectionId: UUID): ManagedSession | undefined {
    if (this.session === null) return undefined;
    if (this.session.activeConnectionId === connectionId) return this.session;
    return undefined;
  }

  /**
   * Check if a session can be resumed.
   * Returns true if session exists and has no active connection.
   */
  canResume(sessionId: UUID): boolean {
    if (this.session === null || this.session.sessionId !== sessionId) {
      return false;
    }
    return this.session.activeConnectionId === null;
  }

  /**
   * Attach a connection to the session.
   */
  attachConnection(sessionId: UUID, connectionId: UUID): AttachResult {
    if (this.session === null || this.session.sessionId !== sessionId) {
      return {
        success: false,
        isResume: false,
        replayMessages: [],
        currentStatus: 'idle',
        currentQuestion: null,
        nextBulletId: 1,
        error: 'Session not found',
      };
    }

    // If session already has an active connection, provide replay history
    // (read-only) and queue for write promotion when active disconnects.
    // Writes from queued connections are blocked at getSessionForConnection.
    if (this.session.activeConnectionId !== null) {
      if (!this.waitingConnections.includes(connectionId)) {
        this.waitingConnections.push(connectionId);
      }
      const MAX_REPLAY_MESSAGES = 200;
      const replayMessages =
        this.session.messageHistory.length > MAX_REPLAY_MESSAGES
          ? this.session.messageHistory.slice(-MAX_REPLAY_MESSAGES)
          : [...this.session.messageHistory];
      return {
        success: true,
        isResume: true,
        replayMessages,
        currentStatus: this.session.currentStatus,
        currentQuestion: this.session.currentQuestion,
        nextBulletId: this.session.messageApi.bulletCount + 1,
      };
    }

    const isResume = this.session.lastDisconnectedAt !== null;

    // Clear orphan timeout if resuming
    if (this.session.orphanTimeoutId !== null) {
      clearTimeout(this.session.orphanTimeoutId);
      this.session.orphanTimeoutId = null;
    }

    // Attach connection
    this.session.activeConnectionId = connectionId;
    this.session.lastDisconnectedAt = null;
    this.session.explicitlyDetached = false;

    // Always replay the last 200 messages for every new client.
    // Each client needs full context, not just undelivered messages.
    const MAX_REPLAY_MESSAGES = 200;
    const replayMessages =
      this.session.messageHistory.length > MAX_REPLAY_MESSAGES
        ? this.session.messageHistory.slice(-MAX_REPLAY_MESSAGES)
        : [...this.session.messageHistory];

    // Mark all as delivered
    this.session.lastDeliveredIndex = this.session.messageHistory.length - 1;

    if (isResume) {
      this.events.onSessionResumed?.(sessionId, connectionId);
    }

    return {
      success: true,
      isResume,
      replayMessages,
      currentStatus: this.session.currentStatus,
      currentQuestion: this.session.currentQuestion,
      nextBulletId: this.session.messageApi.bulletCount + 1,
    };
  }

  /**
   * Detach a connection from the session.
   * If there are waiting connections, the next one is auto-promoted.
   * Otherwise, non-locally-owned sessions become orphaned and start the timeout countdown.
   * Locally-owned sessions remain active without a timeout.
   *
   * When `explicit` is true (tmux-style detach), the orphan timeout is skipped
   * regardless of whether the session is locally owned; the session remains
   * discoverable and re-attachable indefinitely.
   */
  detachConnection(connectionId: UUID, explicit = false): void {
    if (this.session === null || this.session.activeConnectionId !== connectionId) {
      // Also remove from waiting list if it was queued
      const waitIdx = this.waitingConnections.indexOf(connectionId);
      if (waitIdx >= 0) {
        this.waitingConnections.splice(waitIdx, 1);
      }
      return;
    }

    const { sessionId } = this.session;

    // Detach connection
    this.session.activeConnectionId = null;
    this.session.lastDisconnectedAt = now();

    // Try to promote the next waiting connection (loop until one succeeds or queue exhausted)
    while (this.waitingConnections.length > 0) {
      const nextConnectionId = this.waitingConnections.shift();
      if (!nextConnectionId) continue;
      const result = this.attachConnection(sessionId, nextConnectionId);
      if (result.success) {
        try {
          this.events.onConnectionPromoted?.(sessionId, nextConnectionId, result);
        } catch (err) {
          // Callback failed (e.g., promoted connection unreachable).
          // Log the error and detach so the loop can try the next waiter.
          const msg = errorToString(err);
          console.error(
            `[SessionRegistry] Promotion callback failed for ${nextConnectionId}: ${msg}`,
          );
          this.session.activeConnectionId = null;
          this.session.lastDisconnectedAt = now();
          continue;
        }
        return;
      }
    }

    // Track explicit detach state for discovery status
    this.session.explicitlyDetached = explicit;

    // Start orphan timeout (skip for locally-owned sessions, explicit detaches,
    // and when orphanTimeoutMs === 0).
    // Explicitly detached sessions stay alive indefinitely like locally-owned ones.
    if (!this.session.locallyOwned && !explicit && this.orphanTimeoutMs > 0) {
      this.session.orphanTimeoutId = setTimeout(() => {
        this.closeSession(sessionId, 'timeout');
      }, this.orphanTimeoutMs);
    }

    this.events.onSessionOrphaned?.(sessionId);
  }

  /**
   * Remove a connection from the waiting queue.
   * Call this when a waiting connection disconnects before being promoted.
   */
  removeWaitingConnection(connectionId: UUID): void {
    const idx = this.waitingConnections.indexOf(connectionId);
    if (idx >= 0) {
      this.waitingConnections.splice(idx, 1);
    }
  }

  /**
   * Get the number of connections waiting for promotion.
   */
  get waitingConnectionCount(): number {
    return this.waitingConnections.length;
  }

  /**
   * Record an outgoing message for potential replay.
   * Call this for every message sent to the client.
   */
  recordOutgoingMessage(sessionId: UUID, message: ProtocolMessage): void {
    if (this.session === null) {
      // Session not yet registered; buffer for later (capped to prevent unbounded growth)
      this.preRegistrationBuffer.push(message);
      if (this.preRegistrationBuffer.length > this.maxReplayHistory) {
        this.preRegistrationBuffer = this.preRegistrationBuffer.slice(-this.maxReplayHistory);
      }
      return;
    }
    if (this.session.sessionId !== sessionId) {
      return;
    }

    this.session.messageHistory.push(message);
    this.session.lastActivityAt = now();

    // If connected, mark as delivered
    if (this.session.activeConnectionId !== null) {
      this.session.lastDeliveredIndex = this.session.messageHistory.length - 1;
    }

    // Prune history if too large
    this.pruneHistory(this.session);
  }

  /**
   * Update session status (from hook events).
   */
  updateStatus(sessionId: UUID, status: AgentStatus): void {
    if (this.session !== null && this.session.sessionId === sessionId) {
      this.session.currentStatus = status;
      this.session.lastActivityAt = now();
    }
  }

  /**
   * Update current question (from hook events).
   */
  updateQuestion(sessionId: UUID, question: Question | null): void {
    if (this.session !== null && this.session.sessionId === sessionId) {
      this.session.currentQuestion = question;
      this.session.lastActivityAt = now();
    }
  }

  /**
   * Close the session, cleaning up all resources.
   */
  closeSession(sessionId: UUID, reason: 'timeout' | 'pty_exit' | 'forced'): void {
    if (this.session === null || this.session.sessionId !== sessionId) {
      return;
    }

    // Clear timeout if any
    if (this.session.orphanTimeoutId !== null) {
      clearTimeout(this.session.orphanTimeoutId);
    }

    // Close PTY unless the closure was triggered by PTY exit
    if (reason !== 'pty_exit') {
      this.session.pty.close().catch((err) => {
        console.error(`Failed to close PTY for session ${sessionId}:`, err);
      });
    }

    // Clear waiting queue to prevent stale IDs leaking into a future session
    this.waitingConnections.length = 0;

    // Clear the session
    this.session = null;

    this.events.onSessionClosed?.(sessionId, reason);
  }

  /**
   * Handle PTY exit event.
   * Should be called from the PTY onExit handler.
   */
  handlePTYExit(sessionId: UUID): void {
    this.closeSession(sessionId, 'pty_exit');
  }

  /**
   * Resolve a session by its human-readable name.
   * Supports exact match and prefix match.
   */
  resolveByName(name: string): ManagedSession | undefined {
    if (this.session === null) {
      return undefined;
    }
    if (this.session.name === name || this.session.name.startsWith(name)) {
      return this.session;
    }
    return undefined;
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessionIds(): UUID[] {
    if (this.session !== null) {
      return [this.session.sessionId];
    }
    return [];
  }

  /**
   * List sessions with metadata for discovery.
   * Returns 0 or 1 sessions (one session per daemon).
   */
  listSessions(): DiscoverableSession[] {
    if (this.session === null) {
      return [];
    }

    const status = this.getDiscoverableStatus(this.session);
    const lastMessage = this.getLastMessagePreview(this.session);

    return [
      {
        sessionId: this.session.sessionId,
        name: this.session.name,
        projectPath: this.session.workingDirectory,
        status,
        createdAt: this.session.createdAt,
        lastActivity: this.session.lastActivityAt,
        messageCount: this.session.messageHistory.length,
        lastMessage,
        source: 'daemon',
        canAttach: this.session.activeConnectionId === null,
        canResume: false,
      },
    ];
  }

  private getDiscoverableStatus(
    session: ManagedSession,
  ): 'active' | 'idle' | 'orphaned' | 'detached' {
    if (session.activeConnectionId === null) {
      if (session.locallyOwned) return 'active';
      if (session.explicitlyDetached) return 'detached';
      return 'orphaned';
    }
    if (session.currentStatus === 'idle') {
      return 'idle';
    }
    return 'active';
  }

  private getLastMessagePreview(session: ManagedSession): string | undefined {
    if (session.messageHistory.length === 0) {
      return undefined;
    }

    const lastMsg = session.messageHistory[session.messageHistory.length - 1];
    if (!lastMsg) {
      return undefined;
    }

    let content: string | undefined;
    if (lastMsg.type === 'agent_output') {
      content = lastMsg.message.content;
    } else if (lastMsg.type === 'structured_agent_output') {
      content = lastMsg.message.content;
    } else if (lastMsg.type === 'user_input') {
      content = lastMsg.content;
    }

    if (!content) {
      return undefined;
    }

    return content.length > 100 ? `${content.slice(0, 97)}...` : content;
  }

  get sessionCount(): number {
    return this.session !== null ? 1 : 0;
  }

  get orphanedCount(): number {
    if (
      this.session !== null &&
      this.session.activeConnectionId === null &&
      !this.session.locallyOwned
    ) {
      return 1;
    }
    return 0;
  }

  private pruneHistory(session: ManagedSession): void {
    if (session.messageHistory.length <= this.maxReplayHistory) {
      return;
    }

    const toRemove = session.messageHistory.length - this.maxReplayHistory;
    session.messageHistory.splice(0, toRemove);

    session.lastDeliveredIndex = Math.max(-1, session.lastDeliveredIndex - toRemove);
  }

  /**
   * Shutdown the session.
   * Call this on daemon shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.session !== null) {
      if (this.session.orphanTimeoutId !== null) {
        clearTimeout(this.session.orphanTimeoutId);
      }
      try {
        await this.session.pty.close();
      } catch (err) {
        console.error('Failed to close PTY during shutdown:', err);
      }
      this.waitingConnections.length = 0;
      this.session = null;
    }
  }
}
