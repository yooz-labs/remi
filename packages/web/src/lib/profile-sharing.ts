import type { SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';
import type { SessionProfileRef } from '@remi/shared/types.ts';

export interface ProfileSharingSources {
  readonly sharedBySessions: boolean;
  readonly sharedByLookup: boolean;
}

export type ProfileSharingEvent =
  | { readonly type: 'reconnect'; readonly profile?: SessionProfileRef | undefined }
  | { readonly type: 'session-list'; readonly carriesProfile: boolean }
  | { readonly type: 'lookup'; readonly response: SessionProfilesResponseMessage };

export type ProfileDisplay = 'hidden' | 'header' | 'card';

export const EMPTY_PROFILE_SHARING_SOURCES: ProfileSharingSources = {
  sharedBySessions: false,
  sharedByLookup: false,
};

export function updateProfileSharingSources(
  current: ProfileSharingSources,
  event: ProfileSharingEvent,
): ProfileSharingSources {
  switch (event.type) {
    case 'reconnect':
      return {
        sharedBySessions: event.profile !== undefined,
        sharedByLookup: false,
      };
    case 'session-list':
      return { ...current, sharedBySessions: event.carriesProfile };
    case 'lookup':
      if (event.response.refused !== undefined) return current;
      return {
        ...current,
        sharedByLookup: event.response.profiles.some((profile) => profile.id !== 'default'),
      };
  }
}

export function hasSharedProfiles(sources: ProfileSharingSources): boolean {
  return sources.sharedBySessions || sources.sharedByLookup;
}

export function deriveProfileDisplay(
  sessionProfilesEnabled: boolean,
  sources: ProfileSharingSources,
): ProfileDisplay {
  if (!sessionProfilesEnabled) return 'hidden';
  return hasSharedProfiles(sources) ? 'card' : 'header';
}
