/**
 * PTY Manager - Manages multiple Claude Code terminal sessions.
 *
 * Responsibilities:
 * - Create and track PTY sessions
 * - Route events from sessions
 * - Handle session lifecycle
 */

import type { UUID } from '@remi/shared';
import { PTYSession, type PTYSessionConfig, type PTYSessionEvents } from './pty-session.ts';

/** Manager-level events */
export interface PTYManagerEvents {
  /** Session was created */
  onSessionCreated: (session: PTYSession) => void;

  /** Session started running */
  onSessionStarted: (session: PTYSession) => void;

  /** Session exited */
  onSessionExited: (session: PTYSession, exitCode: number | null, signal: string | null) => void;

  /** Data received from session */
  onSessionData: (session: PTYSession, data: string) => void;

  /** Error from session */
  onSessionError: (session: PTYSession, error: Error) => void;
}

/**
 * Manages multiple PTY sessions.
 *
 * Usage:
 * ```ts
 * const manager = new PTYManager({
 *   onSessionData: (session, data) => console.log(`[${session.id}] ${data}`)
 * });
 *
 * const session = await manager.createSession({ cwd: '/path/to/project' });
 * session.write('hello\n');
 * ```
 */
export class PTYManager {
  private readonly sessions: Map<UUID, PTYSession> = new Map();
  private readonly events: Partial<PTYManagerEvents>;

  constructor(events: Partial<PTYManagerEvents> = {}) {
    this.events = events;
  }

  /** Get all active sessions */
  get activeSessions(): readonly PTYSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.isRunning);
  }

  /** Get all sessions (including exited) */
  get allSessions(): readonly PTYSession[] {
    return Array.from(this.sessions.values());
  }

  /** Get session by ID */
  getSession(id: UUID): PTYSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Create and start a new PTY session.
   *
   * @param config - Session configuration
   * @returns Started session
   */
  async createSession(config: PTYSessionConfig = {}): Promise<PTYSession> {
    const sessionEvents: Partial<PTYSessionEvents> = {
      onData: (data) => {
        this.events.onSessionData?.(session, data);
      },
      onExit: (exitCode, signal) => {
        this.events.onSessionExited?.(session, exitCode, signal);
      },
      onError: (error) => {
        this.events.onSessionError?.(session, error);
      },
    };

    const session = new PTYSession(config, sessionEvents);
    this.sessions.set(session.id, session);
    this.events.onSessionCreated?.(session);

    await session.start();
    this.events.onSessionStarted?.(session);

    return session;
  }

  /**
   * Close a session by ID.
   *
   * @param id - Session ID
   * @param timeoutMs - Timeout for graceful shutdown
   */
  async closeSession(id: UUID, timeoutMs?: number): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      await session.close(timeoutMs);
    }
  }

  /**
   * Close all sessions.
   *
   * @param timeoutMs - Timeout for graceful shutdown per session
   */
  async closeAll(timeoutMs?: number): Promise<void> {
    const closures = Array.from(this.sessions.values()).map((session) => session.close(timeoutMs));
    await Promise.all(closures);
  }

  /**
   * Remove exited sessions from tracking.
   * Returns the number of sessions removed.
   */
  pruneExitedSessions(): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (!session.isRunning) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Get count of active sessions */
  get activeCount(): number {
    return this.activeSessions.length;
  }

  /** Get total count of tracked sessions */
  get totalCount(): number {
    return this.sessions.size;
  }
}
