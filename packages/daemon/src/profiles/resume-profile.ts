import type { SessionProfilesFile } from '../session/session-profiles-file.ts';
import type { StoredSession } from '../session/session-store.ts';
import type { Profiles } from './profile-config.ts';

/** Validate both independent ownership records before choosing a profile. */
export function resumeProfile(
  record: StoredSession,
  profiles: Profiles,
  sidecarFile: Pick<SessionProfilesFile, 'get'>,
): { id: string } | { error: string } {
  const changed =
    "This session's profile information was changed by another remi process. Start a new session.";
  if (
    !record.profile &&
    !record.profileSnapshot &&
    ('error' in profiles || Object.keys(profiles.entries).length === 0)
  )
    return { id: 'default' };
  let sidecar: ReturnType<SessionProfilesFile['get']>;
  try {
    sidecar = sidecarFile.get(record.remiSessionId);
  } catch {
    return { error: changed };
  }
  if (!record.profile && !record.profileSnapshot && !sidecar) return { id: 'default' };
  if (
    !record.profile ||
    !record.profileSnapshot ||
    !sidecar ||
    sidecar.profile !== record.profile ||
    sidecar.revision !== record.profileSnapshot.revision
  )
    return { error: changed };
  if ('error' in profiles || !profiles.entries[record.profile])
    return {
      error: `This session was started in profile ${record.profile}, which no longer exists. Start a new session.`,
    };
  if (profiles.entries[record.profile]?.revision !== record.profileSnapshot.revision)
    return {
      error: `Profile ${record.profile} changed after this session started. Start a new session.`,
    };
  return { id: record.profile };
}
