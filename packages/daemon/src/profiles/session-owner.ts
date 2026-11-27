import type { SessionProfileEntry, SessionProfilesFile } from '../session/session-profiles-file.ts';
import type { StoredSession } from '../session/session-store.ts';
import type { Profiles } from './profile-config.ts';
import { isProfileHidden } from './visibility.ts';

export type SessionOwner =
  | { owner: 'default' }
  | { owner: 'profile'; id: string; configured: boolean }
  | { owner: 'hidden' };

export type ProfileSidecar =
  | { ok: true; entries: Readonly<Record<string, SessionProfileEntry>> }
  | { ok: false };

export function readProfileSidecar(file: Pick<SessionProfilesFile, 'snapshot'>): ProfileSidecar {
  let cached: ProfileSidecar | undefined;
  const read = (): ProfileSidecar => {
    if (cached) return cached;
    try {
      cached = { ok: true, entries: file.snapshot() };
    } catch {
      cached = { ok: false };
    }
    return cached;
  };
  // The no-table, profile-free record rule returns before touching either getter.
  // Other readers share the same snapshot for the lifetime of this request.
  return {
    get ok() {
      return read().ok;
    },
    get entries() {
      const result = read();
      return result.ok ? result.entries : {};
    },
  } as ProfileSidecar;
}

/** Resolve remote ownership without trusting fields an older writer could strip. */
export function sessionProfileOwner(
  input: StoredSession | { transcriptProfile: string | undefined },
  sidecar: ProfileSidecar,
  profiles: Profiles,
): SessionOwner {
  let id: string;
  if ('transcriptProfile' in input) {
    id = input.transcriptProfile ?? 'default';
  } else {
    const bare = !input.profile && !input.profileSnapshot;
    if (bare && 'entries' in profiles && Object.keys(profiles.entries).length === 0)
      return { owner: 'default' };
    if (!sidecar.ok) return { owner: 'hidden' };
    const entry = sidecar.entries[input.remiSessionId];
    if (entry && input.profile && entry.profile !== input.profile) return { owner: 'hidden' };
    if (!entry && (input.profile || input.profileSnapshot)) return { owner: 'hidden' };
    id = entry?.profile ?? 'default';
  }
  if (id === 'default') return { owner: 'default' };
  if (isProfileHidden(id, profiles)) return { owner: 'hidden' };
  return { owner: 'profile', id, configured: 'entries' in profiles && !!profiles.entries[id] };
}
