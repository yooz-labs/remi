import type { SessionProfilesFile } from '../session/session-profiles-file.ts';
import { AmbiguousSessionIdentityError, type SessionStore } from '../session/session-store.ts';
import type { Profiles } from './profile-config.ts';
import { resumeProfile } from './resume-profile.ts';
import { readProfileSidecar, sessionProfileOwner } from './session-owner.ts';
import { isProfileSelectable } from './visibility.ts';

/** Check that an in-process resume cannot cross profile boundaries. */
export function inProcessResumeRefusal(
  store: Pick<SessionStore, 'findResumableByClaudeSessionId'>,
  sidecar: SessionProfilesFile,
  profiles: Profiles,
  currentProfiles: Profiles,
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
    const owner = sessionProfileOwner(record, readProfileSidecar(sidecar), currentProfiles);
    if (owner.owner === 'hidden') return 'That session was not found on this machine.';
    const id = owner.owner === 'profile' ? owner.id : 'default';
    if (
      id !== 'default' &&
      'entries' in currentProfiles &&
      currentProfiles.entries[id] &&
      !isProfileSelectable(id, currentProfiles)
    )
      return `This session's profile ${id} does not accept sessions from your devices. Resume it on that machine with remi --resume, or add remote_selectable = true to [profiles.${id}] in config.toml there.`;
    const validationProfiles =
      id !== 'default' && 'entries' in currentProfiles && !currentProfiles.entries[id]
        ? currentProfiles
        : profiles;
    const checked = resumeProfile(record, validationProfiles, sidecar);
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
