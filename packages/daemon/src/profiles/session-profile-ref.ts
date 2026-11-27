import type { SessionProfileRef } from '@remi/shared';
import type { ProfileSnapshot } from '../session/session-store.ts';
import type { Profiles } from './profile-config.ts';
import type { SessionOwner } from './session-owner.ts';

export function sessionProfileRef(
  owner: SessionOwner,
  snapshot: ProfileSnapshot | undefined,
  profiles: Profiles,
): SessionProfileRef | undefined {
  if (owner.owner !== 'profile' || 'error' in profiles) return undefined;
  const { id } = owner;
  const profile = 'entries' in profiles ? profiles.entries[id] : undefined;
  if (!profile) return { id, label: snapshot?.label ?? id, state: 'removed' };
  return {
    id,
    label: profile.label,
    state: snapshot?.revision === profile.revision ? 'current' : 'changed',
  };
}
