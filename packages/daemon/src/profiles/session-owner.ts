import type { SessionProfileEntry, SessionProfilesFile } from '../session/session-profiles-file.ts';
import type { StoredSession } from '../session/session-store.ts';
import type { Profiles } from './profile-config.ts';
import { isProfileHidden } from './visibility.ts';

export type SessionOwner =
  | { owner: 'default' }
  | { owner: 'profile'; id: string; configured: boolean }
  | { owner: 'hidden' };

export type ProfileSidecarResult =
  | { ok: true; entries: Readonly<Record<string, SessionProfileEntry>> }
  | { ok: false };

export type ProfileSidecar = ProfileSidecarResult | { read(): ProfileSidecarResult };

/** Lazily take one consistent snapshot. No-table bare records never read the sidecar. */
export class ProfileSidecarSnapshot {
  private cached: ProfileSidecarResult | undefined;

  constructor(private readonly file: Pick<SessionProfilesFile, 'snapshot'>) {}

  read(): ProfileSidecarResult {
    if (this.cached) return this.cached;
    try {
      this.cached = { ok: true, entries: this.file.snapshot() };
    } catch {
      this.cached = { ok: false };
    }
    return this.cached;
  }
}

export function readProfileSidecar(file: Pick<SessionProfilesFile, 'snapshot'>): ProfileSidecar {
  return new ProfileSidecarSnapshot(file);
}

function snapshotResult(sidecar: ProfileSidecar): ProfileSidecarResult {
  return 'read' in sidecar ? sidecar.read() : sidecar;
}

/** Adapt the request's snapshot to the launch-time ownership validator. */
export function sidecarGetter(sidecar: ProfileSidecar): Pick<SessionProfilesFile, 'get'> {
  return {
    get(id) {
      const result = snapshotResult(sidecar);
      if (!result.ok) throw new Error('Session profile snapshot unavailable');
      return result.entries[id];
    },
  };
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
    const snapshot = snapshotResult(sidecar);
    if (!snapshot.ok) return { owner: 'hidden' };
    const entry = snapshot.entries[input.remiSessionId];
    if (entry && input.profile && entry.profile !== input.profile) return { owner: 'hidden' };
    if (!entry && (input.profile || input.profileSnapshot)) return { owner: 'hidden' };
    id = entry?.profile ?? 'default';
  }
  if (id === 'default') return { owner: 'default' };
  if (isProfileHidden(id, profiles)) return { owner: 'hidden' };
  return { owner: 'profile', id, configured: 'entries' in profiles && !!profiles.entries[id] };
}
