/**
 * The recent-repositories request (#1236 phase C, ADR 0036): answers the requesting connection
 * with the repositories of the machine's recent sessions, read from the session store. An empty
 * store, or a git that cannot answer, is an empty list, never silence: a client waits for it.
 * Requests that arrive while a walk is running share it, so many requests cost one walk.
 */

import { createRecentRepositoriesResponse, errorToString, escapeUnsafeText } from '@remi/shared';
import type { RecentRepository, UUID } from '@remi/shared';
import type { SessionStore } from '../../session/index.ts';
import {
  MAX_RECENT_REPOSITORIES,
  recentRepositoriesLimit,
  recentRepositoriesReport,
} from '../../workspace/recent.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface RecentRepositoriesHandlerDeps {
  readonly sessionStore: Pick<SessionStore, 'list'>;
  readonly send: SendToConnection;
}

export function createRecentRepositoriesHandlers(deps: RecentRepositoriesHandlerDeps) {
  let walking: Promise<RecentRepository[]> | null = null;
  let lastLine = '';

  /** One walk at the largest limit; each request takes its own share of it. */
  const walk = async (): Promise<RecentRepository[]> => {
    try {
      const report = await recentRepositoriesReport(deps.sessionStore.list(), {
        limit: MAX_RECENT_REPOSITORIES,
      });
      const left = Object.entries(report.skipped).filter(([, count]) => count > 0);
      // Counts only: the paths of the sessions stay out of the log.
      const parts = [`listed ${report.repositories.length}`];
      if (report.noGit) parts.push('git is not on the PATH');
      if (left.length > 0) {
        parts.push(`left out: ${left.map(([reason, count]) => `${reason} ${count}`).join(', ')}`);
      }
      if (report.timedOut) parts.push('the deadline ended the walk');
      const line = `[RecentRepositories] ${parts.join('; ')}`;
      // Said once until it changes: a machine with an unchanging gap would otherwise log every walk.
      if (parts.length > 1 && line !== lastLine) log(line);
      lastLine = line;
      return report.repositories;
    } catch (err) {
      logError(
        `[RecentRepositories] could not read the recent sessions: ${escapeUnsafeText(errorToString(err))}`,
      );
      return [];
    }
  };

  return {
    onRecentRepositoriesRequest: async (
      connectionId: UUID,
      requestId: UUID,
      limit: number | undefined,
    ): Promise<void> => {
      walking ??= walk().finally(() => {
        walking = null;
      });
      const repositories = await walking;
      deps.send(
        connectionId,
        createRecentRepositoriesResponse(
          repositories.slice(0, recentRepositoriesLimit(limit)),
          requestId,
        ),
      );
    },
  };
}
