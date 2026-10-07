/**
 * A daemon's session list (#1274): its own sessions, each named by its harness (#1179), and, when
 * asked, the Claude transcripts on disk that no session here manages.
 *
 * Both ways a daemon sends its list build it here: the answer to `session_list_request`
 * (`session-events.ts`) and the live-sessions broadcast sent when the set of sessions on the
 * machine changes while another daemon runs (`collectLiveSessionsUpdate` in `cli.ts`). Before
 * #1274 only the first named the harness, so after a broadcast a Codex session read as Claude
 * until the next request.
 */

import { errorToString } from '@remi/shared';
import type { DiscoverableSession, UUID } from '@remi/shared';
import type { Harness } from '../../harness/types.ts';
import type { SessionBindingStore, SessionRegistry } from '../../session/index.ts';
import { logError } from '../logger.ts';

export interface SessionListDeps {
  readonly sessionRegistry: Pick<SessionRegistry, 'listSessions' | 'getActiveSessionIds'>;
  readonly bindingStore: Pick<SessionBindingStore, 'getIdentity' | 'get'>;
  /**
   * Finds Claude transcripts on disk, leaving out the ids given. Typed by shape, so this
   * harness-neutral module imports nothing from `transcript/` (harness-boundary test).
   */
  readonly transcriptDiscovery: {
    discoverSessions(excludeSessionIds: Set<string>): DiscoverableSession[];
  };
  /** How a listed Claude session's transcript path is derived. */
  readonly harness: Pick<Harness, 'transcriptPath'>;
}

export interface SessionList {
  /** The sessions this daemon hosts, named by harness. */
  readonly own: DiscoverableSession[];
  /** Claude transcripts on disk that no session here manages; empty unless asked for. */
  readonly external: DiscoverableSession[];
}

/** The daemon's list: its own sessions, and the external transcripts when `includeExternal`. */
export function buildSessionList(deps: SessionListDeps, includeExternal: boolean): SessionList {
  const { sessionRegistry, bindingStore, transcriptDiscovery, harness } = deps;
  // Decorate daemon-sourced sessions with their harness identity (#1179) and,
  // for a Claude session, its pre-assigned binding (#429): `harness` always,
  // `harnessSessionId` once known (for Claude it equals `claudeSessionId`).
  // transcriptPath comes from the harness, the same derivation every other
  // transcript-path site uses, so the client can show "you are talking to
  // port X / claude <short-uuid>" without round-tripping.
  // A failed lookup on any one entry must not nuke the entire list: a request
  // would hang waiting for a reply, and a broadcast would send nothing, losing
  // the sibling ports with it. Fall back to the undecorated entry on per-entry
  // failure; the cost on a broadcast is that a Codex entry reads as Claude
  // until the store answers again, which the log line records.
  const own = sessionRegistry.listSessions().map((s) => {
    try {
      // Null: no record, or a harness this build does not know. Neither is guessed at.
      const identity = bindingStore.getIdentity(s.sessionId as UUID);
      if (!identity) return s;
      const { harness: harnessName, harnessSessionId } = identity;
      const named = {
        ...s,
        harness: harnessName,
        ...(harnessSessionId !== null && { harnessSessionId }),
      };
      if (harnessName !== 'claude' || harnessSessionId === null) return named;
      const transcriptPath = harness.transcriptPath(s.projectPath, harnessSessionId);
      // No file to name (a harness without a transcript): decorate the id only.
      if (transcriptPath === null) return { ...named, claudeSessionId: harnessSessionId };
      return { ...named, claudeSessionId: harnessSessionId, transcriptPath };
    } catch (err) {
      logError(
        `[SessionList] Failed to decorate session ${s.sessionId.slice(0, 8)}; serving raw entry: ${errorToString(err)}`,
      );
      return s;
    }
  });
  if (!includeExternal) return { own, external: [] };

  const managedIds = new Set<string>(sessionRegistry.getActiveSessionIds());
  // Also exclude by Claude session ID (JSONL filename UUID is a different namespace from remi IDs).
  // Per-entry try/catch (as above): a disk hiccup on one lookup must not throw out of the list and
  // hang a request; degrade to a possibly-incomplete exclude set.
  for (const remiId of [...managedIds]) {
    try {
      const binding = bindingStore.get(remiId as UUID);
      if (binding?.claudeSessionId) managedIds.add(binding.claudeSessionId);
    } catch (err) {
      logError(
        `[SessionList] binding lookup failed for ${remiId.slice(0, 8)}; external exclusion may be incomplete: ${errorToString(err)}`,
      );
    }
  }
  return { own, external: transcriptDiscovery.discoverSessions(managedIds) };
}
