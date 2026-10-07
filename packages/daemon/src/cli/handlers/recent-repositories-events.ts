/**
 * The recent-repositories request (#1236 phase C, ADR 0036): answers the requesting connection
 * with the repositories of the machine's recent sessions, read from the session store. An empty
 * store, or a git that cannot answer, is an empty list, never silence: a client waits for it.
 */

import { createRecentRepositoriesResponse, errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';
import type { SessionStore } from '../../session/index.ts';
import { recentRepositories } from '../../workspace/recent.ts';
import { logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface RecentRepositoriesHandlerDeps {
  readonly sessionStore: Pick<SessionStore, 'list'>;
  readonly send: SendToConnection;
}

export function createRecentRepositoriesHandlers(deps: RecentRepositoriesHandlerDeps) {
  return {
    onRecentRepositoriesRequest: async (
      connectionId: UUID,
      requestId: UUID,
      limit: number | undefined,
    ): Promise<void> => {
      let repositories: Awaited<ReturnType<typeof recentRepositories>> = [];
      try {
        repositories = await recentRepositories(deps.sessionStore.list(), { limit });
      } catch (err) {
        logError(`[RecentRepositories] could not read the recent sessions: ${errorToString(err)}`);
      }
      deps.send(connectionId, createRecentRepositoriesResponse(repositories, requestId));
    },
  };
}
