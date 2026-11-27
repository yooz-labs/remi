import * as path from 'node:path';
import type { Profiles } from './profile-config.ts';
import { canonicalPath, resolveProfile } from './resolve-profile.ts';

export function isProfileHidden(id: string, profiles: Profiles): boolean {
  if (id === 'default') return false;
  if ('error' in profiles) return true;
  return profiles.entries[id]?.remoteVisible === false;
}

export function isProfileSelectable(id: string, profiles: Profiles): boolean {
  if (id === 'default') return true;
  if ('error' in profiles) return false;
  const profile = profiles.entries[id];
  return profile?.remoteVisible === true && profile.remoteSelectable;
}

/** Limit discovery before its result cap, using strict policy for visibility. */
export function visibleProfileRoots(profiles: Profiles, policy: Profiles) {
  if ('error' in profiles) return [];
  return Object.entries(profiles.entries).flatMap(([profile, entry]) =>
    entry.claude && !isProfileHidden(profile, policy)
      ? [{ profile, projectsDir: path.join(entry.claude.dir, 'projects') }]
      : [],
  );
}

export function deviceDefault(directory: string, profiles: Profiles, remiProfileEnv?: string) {
  if ('error' in profiles) return profiles;
  const result = resolveProfile({
    cwd: directory,
    profiles,
    ...(remiProfileEnv !== undefined && { envValue: remiProfileEnv }),
  });
  if ('error' in result) return result;
  return {
    id: result.id,
    source:
      result.source === 'folder'
        ? ('folder' as const)
        : result.source === 'built_in'
          ? ('built_in' as const)
          : ('machine_default' as const),
  };
}

/** Directory listings hide the configured roots of every hidden profile. */
export function hiddenDirectory(dir: string, profiles: Profiles): boolean {
  if ('error' in profiles) return true;
  const resolved = canonicalPath(dir);
  return Object.entries(profiles.entries).some(([id, profile]) => {
    if (!isProfileHidden(id, profiles)) return false;
    const roots = [...profile.folders, profile.claude?.dir, profile.codex?.dir];
    return roots.some((root) => {
      if (root === undefined) return false;
      const relative = path.relative(canonicalPath(root), resolved);
      return (
        relative === '' ||
        (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
      );
    });
  });
}
