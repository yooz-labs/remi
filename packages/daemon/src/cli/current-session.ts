/**
 * The daemon's single authoritative "current owned session" accessor (epic #499).
 *
 * One source of truth, read by BOTH the connect path (to stamp hello_ack with the
 * live binding) and the transcript-request handler (to redirect a stale request to
 * the current session instead of dead-ending on NOT_FOUND). Derived from the
 * primary Remi session id + the persisted binding, which the rotation handler /
 * TranscriptBinder keeps current — so it follows /clear rotations.
 */

import type { UUID } from '@remi/shared';
import type { SessionStore } from '../session/session-store.ts';
import type { TranscriptDiscovery } from '../transcript/index.ts';

/** The daemon's current owned session, resolved on demand. */
export interface CurrentOwnedSession {
  /** The primary Remi session id (stable across /clear). */
  readonly sessionId: UUID;
  /** The current Claude session id (rotates on /clear); null if unbound. */
  readonly claudeSessionId: UUID | null;
  /** The current transcript file path; null if the Claude id/project is unknown. */
  readonly transcriptPath: string | null;
}

export interface CurrentSessionResolverDeps {
  /** Reads the primary Remi session id (the per-process global). */
  getPrimarySessionId: () => UUID | null;
  sessionStore: Pick<SessionStore, 'findByRemiSessionId'>;
  transcriptDiscovery: Pick<TranscriptDiscovery, 'getProjectTranscriptDir'>;
}

/**
 * Build the resolver. Returns null when the daemon has no primary session.
 * Mirrors the transcript-path derivation used by the connection promote path
 * (`<projectTranscriptDir>/<claudeSessionId>.jsonl`) so all hello_ack bindings
 * agree on one path scheme.
 */
export function makeCurrentSessionResolver(
  deps: CurrentSessionResolverDeps,
): () => CurrentOwnedSession | null {
  const { getPrimarySessionId, sessionStore, transcriptDiscovery } = deps;
  return () => {
    const sessionId = getPrimarySessionId();
    if (!sessionId) return null;
    const stored = sessionStore.findByRemiSessionId(sessionId);
    const claudeSessionId = (stored?.claudeSessionId ?? null) as UUID | null;
    const projectPath = stored?.projectPath ?? null;
    const transcriptPath =
      claudeSessionId && projectPath
        ? `${transcriptDiscovery.getProjectTranscriptDir(projectPath)}/${claudeSessionId}.jsonl`
        : null;
    return { sessionId, claudeSessionId, transcriptPath };
  };
}
