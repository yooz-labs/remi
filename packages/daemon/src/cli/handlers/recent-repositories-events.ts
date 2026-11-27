/**
 * The recent-repositories request (#1236 phase C, ADR 0036): answers the requesting connection
 * with the repositories of the machine's recent sessions and remembered hub starts (#1284). An empty
 * pair of sources, or a git that cannot answer, is an empty list, never silence: a client waits for it.
 * Requests that arrive while a walk is running share it, so many requests cost one walk.
 */

import { createRecentRepositoriesResponse, errorToString, escapeUnsafeText } from '@remi/shared';
import type { RecentRepository, UUID } from '@remi/shared';
import type { Profiles } from '../../profiles/profile-config.ts';
import { type ProfileSidecar, sessionProfileOwner } from '../../profiles/session-owner.ts';
import {
  canonicalDirectory,
  deviceDefault,
  hiddenDirectoryPredicate,
  isInside,
  isProfileHidden,
} from '../../profiles/visibility.ts';
import type { SessionStore } from '../../session/index.ts';
import type { RecentRepositoryStore } from '../../workspace/recent-store.ts';
import {
  MAX_RECENT_REPOSITORIES,
  recentRepositoriesLimit,
  recentRepositoriesReport,
} from '../../workspace/recent.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface RecentRepositoriesHandlerDeps {
  readonly profiles: () => Profiles;
  readonly sidecar: () => ProfileSidecar;
  readonly remiProfileEnv?: string | undefined;
  readonly sessionStore: Pick<SessionStore, 'list'>;
  readonly send: SendToConnection;
  readonly repositoryStore?: Pick<RecentRepositoryStore, 'list'>;
}

export function createRecentRepositoriesHandlers(deps: RecentRepositoriesHandlerDeps) {
  let walking: Promise<RecentRepository[]> | null = null;
  let lastLine = '';

  /** One walk at the largest limit; each request takes its own share of it. */
  const walk = async (): Promise<RecentRepository[]> => {
    try {
      let sessions: ReturnType<SessionStore['list']> = [];
      try {
        sessions = deps.sessionStore.list();
      } catch (err) {
        logError(
          `[RecentRepositories] could not read the recent sessions: ${escapeUnsafeText(errorToString(err))}`,
        );
      }
      const profiles = deps.profiles();
      const sidecar = deps.sidecar();
      const canonicalPaths = new Map<string, string>();
      const canonicalize = (dir: string): string => {
        let resolved = canonicalPaths.get(dir);
        if (resolved === undefined) {
          resolved = canonicalDirectory(dir);
          canonicalPaths.set(dir, resolved);
        }
        return resolved;
      };
      const hiddenDirectory = hiddenDirectoryPredicate(profiles, canonicalize);
      const hidden = sessions.filter(
        (s) => sessionProfileOwner(s, sidecar, profiles).owner === 'hidden',
      );
      const hiddenPaths = hidden.map((s) => canonicalize(s.projectPath));
      const remembered = (deps.repositoryStore?.list() ?? []).filter(({ repository }) => {
        if (hiddenDirectory(repository)) return false;
        const selection = deviceDefault(repository, profiles, deps.remiProfileEnv);
        if ('error' in selection || isProfileHidden(selection.id, profiles)) return false;
        const root = canonicalize(repository);
        return !hiddenPaths.some((dir) => isInside(root, dir));
      });
      const report = await recentRepositoriesReport(
        sessions.filter(
          (s) =>
            sessionProfileOwner(s, sidecar, profiles).owner !== 'hidden' &&
            !hiddenDirectory(s.projectPath),
        ),
        {
          limit: MAX_RECENT_REPOSITORIES,
          remembered,
          excludeRepository: hiddenDirectory,
        },
      );
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
        `[RecentRepositories] could not build the repository list: ${escapeUnsafeText(errorToString(err))}`,
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
