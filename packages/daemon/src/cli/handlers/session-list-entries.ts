/**
 * A daemon's session list (#1274): its own sessions, each named by its harness (#1179), and, when
 * asked, the Claude transcripts on disk that no session here manages.
 *
 * Every list uses this builder: the requested list, the live-sessions census and a changed
 * workspace read (#1285). Before #1274 only the requested list named the harness, so after a
 * broadcast a Codex session read as Claude until the next request.
 */

import { createSessionListResponse, errorToString, generateId } from '@remi/shared';
import type { DiscoverableSession, MachineDescriptor, ProtocolMessage, UUID } from '@remi/shared';
import type { Harness } from '../../harness/types.ts';
import type { Profiles } from '../../profiles/profile-config.ts';
import { type ProfileSidecar, sessionProfileOwner } from '../../profiles/session-owner.ts';
import { sessionProfileRef } from '../../profiles/session-profile-ref.ts';
import type { SessionBindingStore, SessionRegistry } from '../../session/index.ts';
import type { StoredSession } from '../../session/session-store.ts';
import { logError } from '../logger.ts';

export interface SessionListDeps {
  /**
   * Remote profile policy (#1749): the strict configuration, the sidecar and a session's record.
   * Required with no default, so a caller that forgets one fails to compile instead of listing
   * every session.
   */
  readonly profiles: () => Profiles;
  readonly sidecar: () => ProfileSidecar;
  readonly profileOfSession: (id: UUID) => StoredSession | null;
  readonly withholdTranscriptPaths: boolean;
  readonly sessionRegistry: Pick<SessionRegistry, 'listSessions' | 'getActiveSessionIds'>;
  readonly bindingStore: Pick<SessionBindingStore, 'getIdentity' | 'get'>;
  /**
   * Finds Claude transcripts on disk, leaving out the ids given. Typed by shape, so this
   * harness-neutral module imports nothing from `transcript/` (harness-boundary test).
   */
  readonly transcriptDiscovery: {
    discoverSessions(excludeSessionIds: Set<string>): DiscoverableSession[];
    profileOfTranscript?(id: string): string | undefined;
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

/** The same current list sent after an existing workspace read changes (#1285). */
export function broadcastWorkspaceChange(
  deps: Omit<SessionListDeps, 'sessionRegistry'> & {
    readonly sessionRegistry: SessionListDeps['sessionRegistry'] &
      Pick<SessionRegistry, 'getSession'>;
    readonly currentPort: () => number;
    readonly getLivePorts: () => readonly number[];
    readonly machine?: () => MachineDescriptor | undefined;
    readonly broadcast: (message: ProtocolMessage) => void;
  },
  directory: string,
): void {
  // A read may finish after its session closed. Do not push unrelated entries for that old read.
  if (
    !deps.sessionRegistry
      .getActiveSessionIds()
      .some((id) => deps.sessionRegistry.getSession(id)?.workingDirectory === directory)
  )
    return;
  const { own, external } = buildSessionList(deps, true);
  deps.broadcast(
    createSessionListResponse(
      [...own, ...external],
      generateId(),
      deps.getLivePorts().filter((port) => port !== deps.currentPort()),
      deps.machine?.(),
    ),
  );
}

/** The daemon's list: its own sessions, and the external transcripts when `includeExternal`. */
export function buildSessionList(deps: SessionListDeps, includeExternal: boolean): SessionList {
  const { sessionRegistry, bindingStore, transcriptDiscovery, harness } = deps;
  const profiles = deps.profiles();
  const sidecar = deps.sidecar();
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
  const own = sessionRegistry.listSessions().flatMap((s) => {
    let record: StoredSession | null = null;
    try {
      record = deps.profileOfSession(s.sessionId as UUID);
    } catch {
      return [];
    }
    const owner = sessionProfileOwner(
      record ?? { transcriptProfile: undefined },
      sidecar,
      profiles,
    );
    if (owner.owner === 'hidden') return [];
    const ref = sessionProfileRef(owner, record?.profileSnapshot, profiles);
    const decorated = ref ? { ...s, profile: ref } : s;
    try {
      // Null: no record, or a harness this build does not know. Neither is guessed at.
      const identity = bindingStore.getIdentity(s.sessionId as UUID);
      if (!identity) return [decorated];
      const { harness: harnessName, harnessSessionId } = identity;
      const named = {
        ...decorated,
        harness: harnessName,
        ...(harnessSessionId !== null && { harnessSessionId }),
      };
      if (harnessName !== 'claude' || harnessSessionId === null) return [named];
      const transcriptPath = harness.transcriptPath(s.projectPath, harnessSessionId);
      // No file to name (a harness without a transcript): decorate the id only.
      if (transcriptPath === null) return [{ ...named, claudeSessionId: harnessSessionId }];
      return [{ ...named, claudeSessionId: harnessSessionId, transcriptPath }];
    } catch (err) {
      logError(
        `[SessionList] Failed to decorate session ${s.sessionId.slice(0, 8)}; serving raw entry: ${errorToString(err)}`,
      );
      return [decorated];
    }
  });
  const stripPath = (session: DiscoverableSession): DiscoverableSession => {
    const { transcriptPath: _path, ...rest } = session;
    return rest;
  };
  const visibleOwn = deps.withholdTranscriptPaths ? own.map(stripPath) : own;
  if (!includeExternal) return { own: visibleOwn, external: [] };

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
  const external = transcriptDiscovery.discoverSessions(managedIds).flatMap((entry) => {
    const id = transcriptDiscovery.profileOfTranscript?.(entry.sessionId);
    const owner = sessionProfileOwner({ transcriptProfile: id }, sidecar, profiles);
    if (owner.owner === 'hidden') return [];
    const configured =
      owner.owner === 'profile' && 'entries' in profiles ? profiles.entries[owner.id] : undefined;
    const profile = sessionProfileRef(
      owner,
      configured ? { revision: configured.revision } : undefined,
      profiles,
    );
    return [
      {
        ...entry,
        ...(profile && { profile }),
      },
    ];
  });
  return {
    own: visibleOwn,
    external: deps.withholdTranscriptPaths ? external.map(stripPath) : external,
  };
}

/**
 * The live ports a device may be told about (design item 7): every live session's port, minus
 * those whose record resolves to a hidden owner. A record lookup that throws drops the port
 * (fail closed). Reads the policy once for the whole census.
 */
export function visibleLivePorts(deps: {
  readonly listLive: () => readonly { readonly sessionId: string; readonly wsPort: number }[];
  readonly profileOfSession: (id: UUID) => StoredSession | null;
  readonly profiles: () => Profiles;
  readonly sidecar: () => ProfileSidecar;
}): number[] {
  const profiles = deps.profiles();
  const sidecar = deps.sidecar();
  return [
    ...new Set(
      deps
        .listLive()
        .filter((entry) => {
          try {
            const record = deps.profileOfSession(entry.sessionId as UUID);
            return (
              sessionProfileOwner(record ?? { transcriptProfile: undefined }, sidecar, profiles)
                .owner !== 'hidden'
            );
          } catch {
            return false;
          }
        })
        .map((entry) => entry.wsPort),
    ),
  ];
}
