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

/** Upper bound on concurrently-pending questions per session. Real prompts are
 *  few (main + a handful of subagents); the cap is a backstop against a runaway
 *  prompt loop growing the map unbounded. Oldest is evicted first. */
const MAX_PENDING_QUESTIONS = 8;

/** Configuration for SessionRegistry */
export interface SessionRegistryConfig {
  /** How long orphaned sessions stay alive (ms). Default: 5 minutes */
  readonly orphanTimeoutMs?: number;
  /** Maximum messages to keep for replay. Default: 1000 */
  readonly maxReplayHistory?: number;
}

/**
 * A connection waiting for the active connection to disconnect, plus the
 * deviceId its hello carried (#662). Carrying deviceId here (not just the
 * bare connectionId) means a queued connection that gets FIFO-promoted still
 * has its device identity on record afterward — so if IT later goes stale,
 * a genuine reconnect from the same device can still reclaim the lock
 * instead of falling back to queuing behind a connection that's gone for
 * good. Without this, only the FIRST-ever active connection's device got
 * reclaim protection; every promoted connection would lose it.
 */
interface WaitingConnection {
  readonly connectionId: UUID;
  readonly deviceId?: string;
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
  /** Currently pending questions (multiple can be in flight: main + subagent). */
  readonly currentQuestions: readonly Question[];
  /** Next bullet ID for continuation */
  readonly nextBulletId: number;
  /** Error message if attachment failed */
  readonly error?: string;
  /**
   * Whether the connection ended up holding the exclusive write lock
   * ('attached') or is read-only, waiting for the current holder to
   * disconnect ('queued') (#662). Undefined only on the failure path
   * (session not found), where the distinction is moot.
   */
  readonly attachState?: 'attached' | 'queued';
}

/** Events emitted by SessionRegistry */
export interface SessionRegistryEvents {
  /** Session was created */
  onSessionCreated?: (sessionId: UUID) => void;
  /** Session was closed (timeout or PTY exit) */
  onSessionClosed?: (sessionId: UUID, reason: 'timeout' | 'pty_exit' | 'forced') => void;
  /** Connection detached from the session. Fires for ALL detach reasons, not
   * only genuine orphans: a plain non-locally-owned, non-persistent session
   * becomes orphaned (orphan timeout armed), while locally-owned, persistent,
   * and explicitly-detached sessions stay alive with no timeout. Inspect the
   * session flags (locallyOwned / persistent / explicitlyDetached) to tell
   * which case fired. */
  onSessionOrphaned?: (sessionId: UUID) => void;
  /** Session was resumed (connection reattached) */
  onSessionResumed?: (sessionId: UUID, connectionId: UUID) => void;
  /** A waiting connection was promoted to active after the previous client disconnected */
  onConnectionPromoted?: (sessionId: UUID, connectionId: UUID, result: AttachResult) => void;
  /**
   * Same device reclaimed the exclusive write lock from its own stale
   * connection (#662): `attachConnection` was called with a `deviceId` that
   * matches the device already holding the lock, so the stale connection was
   * evicted from the registry's bookkeeping in favor of the new one. The
   * caller (cli.ts) must still force-close the stale connection's actual
   * transport — the registry has no transport handle to do that itself.
   */
  onConnectionReclaimed?: (sessionId: UUID, staleConnectionId: UUID, newConnectionId: UUID) => void;
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
  /**
   * Device id the active connection's hello carried (null if unset or no
   * active connection). Compared against an incoming hello's deviceId
   * (#662) to distinguish "same device reconnecting after a blip" (reclaim
   * the lock) from "a second writer" (queue behind the FIFO as before).
   */
  activeDeviceId: string | null;
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
  /** Currently pending questions, keyed by questionId. Multiple can be in
   *  flight at once (e.g. main agent + a subagent since #419), so an answer to
   *  one must not invalidate the others. Bounded by MAX_PENDING_QUESTIONS. */
  currentQuestions: Map<UUID, Question>;

  /** Whether this session is owned by the local process (wrapper mode).
   * Locally-owned sessions are never killed by orphan timeout. */
  readonly locallyOwned: boolean;

  /** Whether the last detach was an explicit user request (tmux-style).
   * Explicitly detached sessions skip the orphan timeout entirely. */
  explicitlyDetached: boolean;

  /** Whether this session persists after the last client disconnects
   * (tmux-style). Persistent sessions skip the orphan timeout entirely and
   * stay re-attachable until Claude exits or they are explicitly stopped.
   * Driven by `daemon.persist_sessions` (default true). */
  readonly persistent: boolean;
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
  private readonly waitingConnections: WaitingConnection[] = [];
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
    persistent = false,
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
      activeDeviceId: null,
      lastDisconnectedAt: null,
      orphanTimeoutId: null,
      messageHistory: [],
      lastDeliveredIndex: -1,
      currentStatus: 'idle',
      currentQuestions: new Map(),
      locallyOwned,
      explicitlyDetached: false,
      persistent,
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
   * Attach a connection to the session. `deviceId`, when present and equal to
   * the device already holding the exclusive write lock, reclaims that lock
   * instead of queuing behind it (#662) — see `reclaimForSameDevice`.
   */
  attachConnection(sessionId: UUID, connectionId: UUID, deviceId?: string): AttachResult {
    if (this.session === null || this.session.sessionId !== sessionId) {
      return {
        success: false,
        isResume: false,
        replayMessages: [],
        currentStatus: 'idle',
        currentQuestions: [],
        nextBulletId: 1,
        error: 'Session not found',
      };
    }

    if (this.session.activeConnectionId !== null) {
      const sameDeviceReconnecting =
        deviceId !== undefined &&
        this.session.activeDeviceId !== null &&
        this.session.activeDeviceId === deviceId;

      if (sameDeviceReconnecting) {
        return this.reclaimForSameDevice(this.session, connectionId, deviceId);
      }

      // Different (or unknown) device: provide replay history (read-only)
      // and queue for write promotion when the active connection disconnects.
      // Writes from queued connections are blocked at getSessionForConnection.
      // deviceId travels with the queue entry (#662) so promotion still
      // leaves this connection reclaimable if it later goes stale itself.
      if (!this.waitingConnections.some((w) => w.connectionId === connectionId)) {
        this.waitingConnections.push({ connectionId, ...(deviceId !== undefined && { deviceId }) });
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
        currentQuestions: [...this.session.currentQuestions.values()],
        nextBulletId: this.session.messageApi.bulletCount + 1,
        attachState: 'queued',
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
    this.session.activeDeviceId = deviceId ?? null;
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
      currentQuestions: [...this.session.currentQuestions.values()],
      nextBulletId: this.session.messageApi.bulletCount + 1,
      attachState: 'attached',
    };
  }

  /**
   * Same physical device reconnecting while its own previous connection is
   * still marked active (#662) — a dead-socket reconnect (missed pongs, iOS
   * background, NAT drop) rather than a second writer. Evicts the stale
   * connection from the registry's bookkeeping and hands the lock straight
   * to the new one, instead of FIFO-queuing behind a connection that will
   * likely never come back. `onConnectionReclaimed` tells the caller which
   * connection id is now stale so it can force-close the underlying
   * transport; the registry itself has no transport handle to do that.
   */
  private reclaimForSameDevice(
    session: ManagedSession,
    connectionId: UUID,
    deviceId: string,
  ): AttachResult {
    const staleId = session.activeConnectionId;
    if (staleId === null) {
      // Unreachable: attachConnection only calls this when activeConnectionId
      // is non-null. Guarded defensively rather than asserted.
      throw new Error('reclaimForSameDevice called without an active connection');
    }

    session.activeConnectionId = connectionId;
    session.activeDeviceId = deviceId;
    session.lastDisconnectedAt = null;
    session.explicitlyDetached = false;

    const MAX_REPLAY_MESSAGES = 200;
    const replayMessages =
      session.messageHistory.length > MAX_REPLAY_MESSAGES
        ? session.messageHistory.slice(-MAX_REPLAY_MESSAGES)
        : [...session.messageHistory];
    session.lastDeliveredIndex = session.messageHistory.length - 1;

    this.events.onConnectionReclaimed?.(session.sessionId, staleId, connectionId);

    return {
      success: true,
      isResume: true,
      replayMessages,
      currentStatus: session.currentStatus,
      currentQuestions: [...session.currentQuestions.values()],
      nextBulletId: session.messageApi.bulletCount + 1,
      attachState: 'attached',
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
      const waitIdx = this.waitingConnections.findIndex((w) => w.connectionId === connectionId);
      if (waitIdx >= 0) {
        this.waitingConnections.splice(waitIdx, 1);
      }
      return;
    }

    const { sessionId } = this.session;

    // Detach connection
    this.session.activeConnectionId = null;
    this.session.activeDeviceId = null;
    this.session.lastDisconnectedAt = now();

    // Try to promote the next waiting connection (loop until one succeeds or queue exhausted)
    while (this.waitingConnections.length > 0) {
      const next = this.waitingConnections.shift();
      if (!next) continue;
      // Carrying deviceId through promotion (#662) means this connection
      // stays reclaimable by the same device if it later goes stale itself,
      // instead of only the original active connection getting that protection.
      const result = this.attachConnection(sessionId, next.connectionId, next.deviceId);
      if (result.success) {
        try {
          this.events.onConnectionPromoted?.(sessionId, next.connectionId, result);
        } catch (err) {
          // Callback failed (e.g., promoted connection unreachable).
          // Log the error and detach so the loop can try the next waiter.
          const msg = errorToString(err);
          console.error(
            `[SessionRegistry] Promotion callback failed for ${next.connectionId}: ${msg}`,
          );
          this.session.activeConnectionId = null;
          this.session.activeDeviceId = null;
          this.session.lastDisconnectedAt = now();
          continue;
        }
        return;
      }
    }

    // Track explicit detach state for discovery status
    this.session.explicitlyDetached = explicit;

    // Start orphan timeout (skip for locally-owned sessions, persistent
    // (tmux-style) sessions, explicit detaches, and when orphanTimeoutMs === 0).
    // Persistent and explicitly-detached sessions stay alive indefinitely like
    // locally-owned ones — they only end on Claude exit or an explicit stop.
    if (
      !this.session.locallyOwned &&
      !this.session.persistent &&
      !explicit &&
      this.orphanTimeoutMs > 0
    ) {
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
    const idx = this.waitingConnections.findIndex((w) => w.connectionId === connectionId);
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
   * Register a pending question. Multiple can coexist (main + subagent); each
   * is tracked by its own id so answering one never invalidates another.
   * Bounded by MAX_PENDING_QUESTIONS (oldest evicted first) so a runaway
   * prompt loop cannot grow the map without limit.
   */
  addQuestion(sessionId: UUID, question: Question): void {
    if (this.session === null || this.session.sessionId !== sessionId) return;
    const map = this.session.currentQuestions;
    map.delete(question.id); // re-insert so a refreshed question is "newest"
    map.set(question.id, question);
    while (map.size > MAX_PENDING_QUESTIONS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      const evicted = map.get(oldest);
      map.delete(oldest);
      // Log: an evicted prompt may have an outstanding APNS push whose answer
      // will now be refused as STALE_ANSWER. Should be unreachable in normal
      // use (cap is generous); a hit signals a runaway prompt loop.
      console.warn(
        `[SessionRegistry] pending-question cap (${MAX_PENDING_QUESTIONS}) exceeded; evicted oldest id=${oldest} text="${evicted?.text.slice(0, 60) ?? ''}"`,
      );
    }
    this.session.lastActivityAt = now();
  }

  /** Remove one answered/resolved question by id. */
  removeQuestion(sessionId: UUID, questionId: UUID): void {
    if (this.session !== null && this.session.sessionId === sessionId) {
      this.session.currentQuestions.delete(questionId);
      this.session.lastActivityAt = now();
    }
  }

  /** Drop all pending questions on Claude session restart (/clear, /resume).
   *  Status-leaving-'waiting' is handled by QuestionPresenceTracker and the
   *  client; this covers the restart path only, so answers to the dying
   *  session's prompts are refused. */
  clearQuestions(sessionId: UUID): void {
    if (this.session !== null && this.session.sessionId === sessionId) {
      this.session.currentQuestions.clear();
      this.session.lastActivityAt = now();
    }
  }

  /** Look up a pending question by id (null if not awaitable). */
  getQuestion(sessionId: UUID, questionId: UUID): Question | null {
    if (this.session === null || this.session.sessionId !== sessionId) return null;
    return this.session.currentQuestions.get(questionId) ?? null;
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
      if (session.explicitlyDetached || session.persistent) return 'detached';
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
      !this.session.locallyOwned &&
      // Persistent (tmux-style) sessions are intentionally kept alive, not orphaned.
      !this.session.persistent
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
