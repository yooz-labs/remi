import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Profiles } from './profile-config.ts';
import { resolveProfile } from './resolve-profile.ts';

export function isProfileHidden(id: string, profiles: Profiles): boolean {
  if (id === 'default') return false;
  if ('error' in profiles) return true;
  return profiles.entries[id]?.remoteVisible !== true;
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

/** Resolve symlinks even when the final path does not exist yet. */
export function canonicalDirectory(dir: string): string {
  let ancestor = path.resolve(dir);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(ancestor), ...tail);
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.resolve(dir);
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function isInside(root: string, dir: string): boolean {
  const relative = path.relative(root, dir);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** Precompute hidden roots once for a directory listing walk. */
export function hiddenDirectoryPredicate(
  profiles: Profiles,
  canonicalize: (dir: string) => string = canonicalDirectory,
): (dir: string) => boolean {
  if ('error' in profiles) return () => true;
  const hidden = Object.values(profiles.entries).filter((profile) => !profile.remoteVisible);
  if (hidden.length === 0) return () => false;
  const roots = hidden.flatMap((profile) =>
    [...profile.folders, profile.claude?.dir, profile.codex?.dir]
      .filter((root): root is string => root !== undefined)
      .map(canonicalize),
  );
  return (dir) => {
    const resolved = canonicalize(dir);
    return roots.some((root) => isInside(root, resolved));
  };
}

/** Directory listings hide the configured roots of every hidden profile. */
export function hiddenDirectory(dir: string, profiles: Profiles): boolean {
  return hiddenDirectoryPredicate(profiles)(dir);
}
