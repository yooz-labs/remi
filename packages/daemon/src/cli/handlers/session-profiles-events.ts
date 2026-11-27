import { type HarnessId, type UUID, createSessionProfilesResponse } from '@remi/shared';
import type { Profiles } from '../../profiles/profile-config.ts';
import { deviceDefault, isProfileSelectable } from '../../profiles/visibility.ts';
import { resolveRequestedSessionDirectory } from '../path-resolver.ts';
import { directoryRefusal } from './create-session-events.ts';
import type { SendToConnection } from './trivial-events.ts';

export function createSessionProfilesHandlers(deps: {
  profiles: () => Profiles;
  remiProfileEnv?: string | undefined;
  send: SendToConnection;
}) {
  return {
    onSessionProfilesRequest: (
      connectionId: UUID,
      requestId: UUID,
      directory: string | undefined,
    ) => {
      if (directoryRefusal(directory) !== null) {
        deps.send(
          connectionId,
          createSessionProfilesResponse(requestId, [], undefined, 'directory_invalid'),
        );
        return;
      }
      const profiles = deps.profiles();
      const resolved = deviceDefault(
        resolveRequestedSessionDirectory(directory),
        profiles,
        deps.remiProfileEnv,
      );
      if ('error' in resolved) {
        deps.send(
          connectionId,
          createSessionProfilesResponse(requestId, [], undefined, 'profiles_invalid'),
        );
        return;
      }
      const available: { id: string; label: string; harnesses: HarnessId[] }[] = [
        { id: 'default', label: 'Default sign-in', harnesses: ['claude', 'codex'] },
      ];
      if ('entries' in profiles) {
        for (const [id, profile] of Object.entries(profiles.entries)) {
          if (!isProfileSelectable(id, profiles)) continue;
          const harnesses: HarnessId[] = [];
          if (profile.claude) harnesses.push('claude');
          if (profile.codex) harnesses.push('codex');
          available.push({ id, label: profile.label, harnesses });
        }
      }
      deps.send(
        connectionId,
        createSessionProfilesResponse(
          requestId,
          available,
          isProfileSelectable(resolved.id, profiles) ? resolved : undefined,
        ),
      );
    },
  };
}
