/**
 * The daemon's single authoritative "current owned session" accessor (epic #499).
 *
 * One source of truth, read by BOTH the connect path (to stamp hello_ack with the
 * live binding) and the transcript-request handler (to redirect a stale request to
 * the current session instead of dead-ending on NOT_FOUND). Derived from the
 * primary Remi session id + the persisted binding, which the rotation handler /
 * TranscriptBinder keeps current — so it follows /clear rotations.
 */

import type { HarnessId, SessionIdentity, SessionProfileRef, UUID } from '@remi/shared';
import type { Harness } from '../harness/types.ts';
import type { Profiles } from '../profiles/profile-config.ts';
import { type ProfileSidecar, sessionProfileOwner } from '../profiles/session-owner.ts';
import { sessionProfileRef } from '../profiles/session-profile-ref.ts';
import { type SessionStore, identityOfRecord } from '../session/session-store.ts';

/** The daemon's current owned session, resolved on demand. */
export interface CurrentOwnedSession {
  readonly profile?: SessionProfileRef | undefined;
  /** The primary Remi session id (stable across /clear). */
  readonly sessionId: UUID;
  /** The current Claude session id (rotates on /clear); null if unbound. */
  readonly claudeSessionId: UUID | null;
  /**
   * The current transcript file path; null when the Claude id or project is
   * unknown, or the harness has no transcript file to name.
   */
  readonly transcriptPath: string | null;
  /**
   * Who the session is for every harness (#1179): Claude's id is
   * `claudeSessionId`, another harness's is its own, null until learned.
   */
  readonly identity: SessionIdentity;
}

export interface CurrentSessionResolverDeps {
  profiles?: () => Profiles;
  sidecar?: () => ProfileSidecar;
  /** Reads the primary Remi session id (the per-process global). */
  getPrimarySessionId: () => UUID | null;
  sessionStore: Pick<SessionStore, 'findByRemiSessionId'>;
  /** Derives the transcript path from the stored project path and harness session id. */
  harness: Pick<Harness, 'transcriptPath'>;
  /** The harness this daemon hosts: the identity of a session whose record is missing or names none this build knows. */
  harnessId: HarnessId;
  withholdTranscriptPath: boolean;
}

/**
 * Build the resolver. Returns null when the daemon has no primary session.
 * The transcript path comes from `harness.transcriptPath` (Claude:
 * `<projectTranscriptDir>/<claudeSessionId>.jsonl`), the one derivation every
 * transcript-path site shares, so all hello_ack bindings agree on one scheme.
 */
export function makeCurrentSessionResolver(
  deps: CurrentSessionResolverDeps,
): () => CurrentOwnedSession | null {
  const { getPrimarySessionId, sessionStore, harness, harnessId } = deps;
  return () => {
    // Must never throw: this runs in the void transcript-load handler's
    // NOT_FOUND path, which is not wrapped — a disk hiccup on the store read
    // would otherwise escape and leave the client with no response.
    try {
      const sessionId = getPrimarySessionId();
      if (!sessionId) return null;
      const stored = sessionStore.findByRemiSessionId(sessionId);
      const profiles = deps.profiles?.() ?? { entries: {}, notices: [] };
      const owner = sessionProfileOwner(
        stored ?? { transcriptProfile: undefined },
        deps.sidecar?.() ?? { ok: false },
        profiles,
      );
      const claudeSessionId = (stored?.claudeSessionId ?? null) as UUID | null;
      const projectPath = stored?.projectPath ?? null;
      // `harness.transcriptPath` may itself be null (a harness with no file),
      // which reads as "no file", the same as an unknown id or project.
      const transcriptPath =
        owner.owner !== 'hidden' && !deps.withholdTranscriptPath && claudeSessionId && projectPath
          ? harness.transcriptPath(projectPath, claudeSessionId)
          : null;
      const identity = (stored ? identityOfRecord(stored) : null) ?? {
        harness: harnessId,
        harnessSessionId: null,
      };
      const profile = sessionProfileRef(owner, stored?.profileSnapshot, profiles);
      return { sessionId, claudeSessionId, transcriptPath, identity, ...(profile && { profile }) };
    } catch {
      return null;
    }
  };
}
