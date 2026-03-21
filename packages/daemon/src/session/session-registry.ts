/**
 * SessionRegistry - Manages session lifecycle independently of connections.
 *
 * Key concepts:
 * - Sessions survive connection drops (orphaned state)
 * - Orphaned sessions timeout after configurable period (default 5 minutes)
 * - Locally-owned sessions (wrapper mode) are exempt from orphan timeout
 * - Connections can resume existing sessions within timeout window
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
import { generateId, now } from '@remi/shared';
import type { MessageAPI } from '../api/message-api.ts';
import type { PTYSession } from '../pty/pty-session.ts';
import { generateSessionName, makeUniqueName } from './session-name.ts';

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
}

/**
 * SessionRegistry manages session lifecycle independently of WebSocket connections.
 *
 * This enables:
 * - Sessions surviving temporary disconnects
 * - Message replay on reconnect
 * - Graceful timeout-based cleanup
 */
export class SessionRegistry {
  private readonly sessions: Map<UUID, ManagedSession> = new Map();
  private readonly connectionToSession: Map<UUID, UUID> = new Map();
  private readonly events: SessionRegistryEvents;
  private readonly orphanTimeoutMs: number;
  private readonly maxReplayHistory: number;

  constructor(config: SessionRegistryConfig = {}, events: SessionRegistryEvents = {}) {
    this.orphanTimeoutMs = config.orphanTimeoutMs ?? 5 * 60 * 1000; // 5 minutes
    this.maxReplayHistory = config.maxReplayHistory ?? 1000;
    this.events = events;
  }

  /**
   * Register a new session with its PTY and message API.
   */
  registerSession(
    sessionId: UUID,
    workingDirectory: string,
    pty: PTYSession,
    messageApi: MessageAPI,
    locallyOwned = false,
  ): void {
    const baseName = generateSessionName(workingDirectory);
    const existingNames = this.getExistingNames();
    const name = makeUniqueName(baseName, existingNames);

    const createdAt = now();
    const session: ManagedSession = {
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
    };

    this.sessions.set(sessionId, session);
    this.events.onSessionCreated?.(sessionId);
  }

  /**
   * Create a new session ID for a fresh connection.
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
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists (has not been cleaned up).
   */
  hasSession(sessionId: UUID): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get the session for a given connection.
   */
  getSessionForConnection(connectionId: UUID): ManagedSession | undefined {
    const sessionId = this.connectionToSession.get(connectionId);
    if (sessionId === undefined) {
      return undefined;
    }
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session can be resumed.
   * Returns true if session exists and has no active connection.
   */
  canResume(sessionId: UUID): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return false;
    }
    // Can only resume sessions with no active connection
    return session.activeConnectionId === null;
  }

  /**
   * Attach a connection to a session.
   * For new sessions, pass the newly created sessionId.
   * For resume, pass the existing sessionId.
   */
  attachConnection(sessionId: UUID, connectionId: UUID): AttachResult {
    const session = this.sessions.get(sessionId);

    if (session === undefined) {
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

    // Check if session already has an active connection
    if (session.activeConnectionId !== null) {
      return {
        success: false,
        isResume: false,
        replayMessages: [],
        currentStatus: session.currentStatus,
        currentQuestion: session.currentQuestion,
        nextBulletId: session.messageApi.bulletCount + 1,
        error: 'Session already has active connection',
      };
    }

    const isResume = session.lastDisconnectedAt !== null;

    // Clear orphan timeout if resuming
    if (session.orphanTimeoutId !== null) {
      clearTimeout(session.orphanTimeoutId);
      session.orphanTimeoutId = null;
    }

    // Attach connection
    session.activeConnectionId = connectionId;
    session.lastDisconnectedAt = null;
    this.connectionToSession.set(connectionId, sessionId);

    // Get messages to replay (from after last delivered)
    const replayMessages = session.messageHistory.slice(session.lastDeliveredIndex + 1);

    // Mark all as delivered now
    session.lastDeliveredIndex = session.messageHistory.length - 1;

    if (isResume) {
      this.events.onSessionResumed?.(sessionId, connectionId);
    }

    return {
      success: true,
      isResume,
      replayMessages,
      currentStatus: session.currentStatus,
      currentQuestion: session.currentQuestion,
      nextBulletId: session.messageApi.bulletCount + 1,
    };
  }

  /**
   * Detach a connection from its session.
   * Non-locally-owned sessions become orphaned and start the timeout countdown.
   * Locally-owned sessions remain active without a timeout.
   */
  detachConnection(connectionId: UUID): void {
    const sessionId = this.connectionToSession.get(connectionId);
    if (sessionId === undefined) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.connectionToSession.delete(connectionId);
      return;
    }

    // Detach connection
    session.activeConnectionId = null;
    session.lastDisconnectedAt = now();
    this.connectionToSession.delete(connectionId);

    // Start orphan timeout (skip for locally-owned sessions; they stay alive
    // until PTY exits, explicit kill, or daemon shutdown).
    // orphanTimeoutMs === 0 disables automatic cleanup.
    if (!session.locallyOwned && this.orphanTimeoutMs > 0) {
      session.orphanTimeoutId = setTimeout(() => {
        this.closeSession(sessionId, 'timeout');
      }, this.orphanTimeoutMs);
    }

    this.events.onSessionOrphaned?.(sessionId);
  }

  /**
   * Record an outgoing message for potential replay.
   * Call this for every message sent to the client.
   */
  recordOutgoingMessage(sessionId: UUID, message: ProtocolMessage): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }

    session.messageHistory.push(message);
    session.lastActivityAt = now();

    // If connected, mark as delivered
    if (session.activeConnectionId !== null) {
      session.lastDeliveredIndex = session.messageHistory.length - 1;
    }

    // Prune history if too large
    this.pruneHistory(session);
  }

  /**
   * Update session status (from hook events).
   */
  updateStatus(sessionId: UUID, status: AgentStatus): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.currentStatus = status;
      session.lastActivityAt = now();
    }
  }

  /**
   * Update current question (from hook events).
   */
  updateQuestion(sessionId: UUID, question: Question | null): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.currentQuestion = question;
      session.lastActivityAt = now();
    }
  }

  /**
   * Close a session, cleaning up all resources.
   */
  closeSession(sessionId: UUID, reason: 'timeout' | 'pty_exit' | 'forced'): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }

    // Clear timeout if any
    if (session.orphanTimeoutId !== null) {
      clearTimeout(session.orphanTimeoutId);
    }

    // Remove connection mapping if still exists
    if (session.activeConnectionId !== null) {
      this.connectionToSession.delete(session.activeConnectionId);
    }

    // Close PTY unless the closure was triggered by PTY exit
    if (reason !== 'pty_exit') {
      session.pty.close().catch((err) => {
        // Log but don't throw; we're already cleaning up
        console.error(`Failed to close PTY for session ${sessionId}:`, err);
      });
    }

    // Remove from registry
    this.sessions.delete(sessionId);

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
    // Exact match first
    for (const session of this.sessions.values()) {
      if (session.name === name) {
        return session;
      }
    }
    // Prefix match (e.g. "mac/remi" matches "mac/remi/main")
    const matches: ManagedSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.name.startsWith(name)) {
        matches.push(session);
      }
    }
    if (matches.length === 1) {
      return matches[0];
    }
    return undefined;
  }

  /**
   * Get all existing session names for uniqueness checks.
   */
  private getExistingNames(): Set<string> {
    const names = new Set<string>();
    for (const session of this.sessions.values()) {
      names.add(session.name);
    }
    return names;
  }

  /**
   * Get all active session IDs.
   */
  getActiveSessionIds(): UUID[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * List all sessions with metadata for discovery.
   * Returns daemon-managed sessions as DiscoverableSession objects.
   */
  listSessions(): DiscoverableSession[] {
    const result: DiscoverableSession[] = [];

    for (const session of this.sessions.values()) {
      const status = this.getDiscoverableStatus(session);
      const lastMessage = this.getLastMessagePreview(session);

      result.push({
        sessionId: session.sessionId,
        name: session.name,
        projectPath: session.workingDirectory,
        status,
        createdAt: session.createdAt,
        lastActivity: session.lastActivityAt,
        messageCount: session.messageHistory.length,
        lastMessage,
        source: 'daemon',
        canAttach: session.activeConnectionId === null,
        canResume: false, // Daemon-managed sessions are alive; use canAttach instead
      });
    }

    return result;
  }

  /**
   * Determine discoverable status from managed session state.
   */
  private getDiscoverableStatus(session: ManagedSession): 'active' | 'idle' | 'orphaned' {
    if (session.activeConnectionId === null) {
      return session.locallyOwned ? 'active' : 'orphaned';
    }
    if (session.currentStatus === 'idle') {
      return 'idle';
    }
    return 'active';
  }

  /**
   * Get a truncated preview of the last message content.
   */
  private getLastMessagePreview(session: ManagedSession): string | undefined {
    if (session.messageHistory.length === 0) {
      return undefined;
    }

    const lastMsg = session.messageHistory[session.messageHistory.length - 1];
    if (!lastMsg) {
      return undefined;
    }

    // Extract content from different message types
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

    // Truncate to 100 chars
    return content.length > 100 ? `${content.slice(0, 97)}...` : content;
  }

  /**
   * Get count of sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get count of orphaned sessions.
   */
  get orphanedCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.activeConnectionId === null && !session.locallyOwned) {
        count++;
      }
    }
    return count;
  }

  /**
   * Prune old messages from history to prevent unbounded growth.
   */
  private pruneHistory(session: ManagedSession): void {
    if (session.messageHistory.length <= this.maxReplayHistory) {
      return;
    }

    const toRemove = session.messageHistory.length - this.maxReplayHistory;
    session.messageHistory.splice(0, toRemove);

    // Adjust delivered index
    session.lastDeliveredIndex = Math.max(-1, session.lastDeliveredIndex - toRemove);
  }

  /**
   * Shutdown all sessions.
   * Call this on daemon shutdown.
   */
  async shutdown(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const sessionId of this.sessions.keys()) {
      const session = this.sessions.get(sessionId);
      if (session !== undefined) {
        // Clear timeout
        if (session.orphanTimeoutId !== null) {
          clearTimeout(session.orphanTimeoutId);
        }
        closePromises.push(session.pty.close());
      }
    }

    await Promise.all(closePromises);
    this.sessions.clear();
    this.connectionToSession.clear();
  }
}
