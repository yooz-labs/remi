import type { UUID } from '@remi/shared';
import type { MessageAPI } from '../api/message-api.ts';
import type { AwakeConfig } from '../config/config.ts';
import type { SessionRegistryEvents } from '../session/session-registry.ts';
import { AwakeSession, type AwakeSessionOptions } from './awake-session.ts';

export interface AwakeWiringOptions {
  /** `remi serve`: the hub is session-less and never holds (#1773). */
  readonly serveMode: boolean;
  readonly config: AwakeConfig;
  readonly log: (message: string) => void;
  readonly platform?: NodeJS.Platform;
  /** Passed to each `AwakeSession`; tests use it for the holder and the clock. */
  readonly session?: AwakeSessionOptions;
}

/**
 * Whether this process holds keep-awake assertions: a session daemon or a plain
 * wrapper session on macOS with `[awake] level1` on. The hub, other platforms
 * and `level1 = false` hold nothing.
 */
export function awakeApplies(
  serveMode: boolean,
  platform: NodeJS.Platform,
  config: AwakeConfig,
): boolean {
  return !serveMode && platform === 'darwin' && config.level1;
}

/**
 * The daemon's keep-awake glue: one `AwakeSession` per session, fed by the
 * session's `MessageAPI` work events and by the registry's question and close
 * callbacks. `cli.ts` and the wiring tests both build the registry through
 * `registryEvents`, so the tests exercise the same glue the daemon runs.
 */
export class AwakeWiring {
  private readonly sessions = new Map<UUID, AwakeSession>();
  readonly enabled: boolean;

  constructor(private readonly options: AwakeWiringOptions) {
    this.enabled = awakeApplies(
      options.serveMode,
      options.platform ?? process.platform,
      options.config,
    );
  }

  /** Follow a new session's work events; null where keep-awake does not apply. */
  attach(sessionId: UUID, messageApi: MessageAPI): AwakeSession | null {
    if (!this.enabled) return null;
    this.close(sessionId);
    const awake = new AwakeSession(
      sessionId,
      messageApi,
      this.options.config,
      this.options.log,
      this.options.session,
    );
    this.sessions.set(sessionId, awake);
    return awake;
  }

  session(sessionId: UUID): AwakeSession | undefined {
    return this.sessions.get(sessionId);
  }

  questionsChanged(sessionId: UUID, count: number): void {
    this.sessions.get(sessionId)?.questionsChanged(count);
  }

  /** Release and forget one session (registry close, failed start). */
  close(sessionId: UUID): void {
    const awake = this.sessions.get(sessionId);
    if (!awake) return;
    this.sessions.delete(sessionId);
    awake.dispose();
  }

  /** Release every session (daemon cleanup and the synchronous exit path). */
  disposeAll(): void {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    for (const awake of all) awake.dispose();
  }

  /**
   * The registry callbacks with the keep-awake glue in front of them: a change in
   * the pending questions and a session close reach that session's
   * `AwakeSession` first. A keep-awake failure never stops the callback behind it.
   */
  registryEvents(events: SessionRegistryEvents): SessionRegistryEvents {
    return {
      ...events,
      onQuestionsChanged: (sessionId, questions) => {
        this.guard(() => this.questionsChanged(sessionId, questions.length));
        events.onQuestionsChanged?.(sessionId, questions);
      },
      onSessionClosed: (sessionId, reason, pendingQuestionIds) => {
        this.guard(() => this.close(sessionId));
        events.onSessionClosed?.(sessionId, reason, pendingQuestionIds);
      },
    };
  }

  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.options.log(
        `[Awake] keep-awake glue failed (${error instanceof Error ? error.name : typeof error})`,
      );
    }
  }
}
