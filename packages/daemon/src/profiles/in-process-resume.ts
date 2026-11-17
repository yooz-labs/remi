import type { SessionProfilesFile } from '../session/session-profiles-file.ts';
import { AmbiguousSessionIdentityError, type SessionStore } from '../session/session-store.ts';
import type { Profiles } from './profile-config.ts';
import { resumeProfile } from './resume-profile.ts';

/** Check that an in-process resume cannot cross profile boundaries. */
export function inProcessResumeRefusal(
  store: Pick<SessionStore, 'findResumableByClaudeSessionId'>,
  sidecar: SessionProfilesFile,
  profiles: Profiles,
  ownProfile: string,
  claudeId: string,
  log: (message: string) => void,
): string | null {
  try {
    const record = store.findResumableByClaudeSessionId(claudeId.toLowerCase());
    if (!record)
      return ownProfile === 'default'
        ? null
        : 'This session has no remi record, so its profile cannot be confirmed. Resume it through the hub or with remi --resume on the machine.';
    const checked = resumeProfile(record, profiles, sidecar);
    if ('error' in checked) return checked.error;
    return checked.id === ownProfile
      ? null
      : `This session belongs to profile ${checked.id}, and this remi runs a different one. Resume it through the hub or with remi --resume on the machine.`;
  } catch (error) {
    if (error instanceof AmbiguousSessionIdentityError) return error.message;
    log(
      `Could not read session records: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "This session's profile could not be checked: the host's session records could not be read.";
  }
}
