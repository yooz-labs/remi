import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Profiles } from './profile-config.ts';

export type ProfileSource = 'flag' | 'env' | 'folder' | 'machine_default' | 'built_in';
export type Resolution =
  | { readonly id: string; readonly source: ProfileSource; readonly warning?: string }
  | { readonly error: string };

export function canonicalPath(
  value: string,
  realpath: (value: string) => string = fs.realpathSync,
): string {
  try {
    return realpath(value);
  } catch {
    return path.resolve(value);
  }
}
export function resolveProfile(input: {
  flag?: string;
  envValue?: string;
  cwd: string;
  profiles: Profiles;
  realpath?: (value: string) => string;
}): Resolution {
  const { profiles } = input;
  const selected =
    input.flag !== undefined
      ? { id: input.flag, source: 'flag' as const }
      : input.envValue !== undefined
        ? { id: input.envValue, source: 'env' as const }
        : undefined;
  if (selected?.id === 'default') return selected;
  if ('error' in profiles) {
    if (selected) return { error: profiles.error };
    const key = profiles.error.split(/[ :]/, 1)[0];
    const cwd = canonicalPath(input.cwd, input.realpath);
    const raw = profiles.rawSelection;
    const folderMatches = raw?.folders.some((folder) => {
      const expanded = folder.startsWith('~/') ? path.join(os.homedir(), folder.slice(2)) : folder;
      const relative = path.relative(canonicalPath(expanded, input.realpath), cwd);
      return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      );
    });
    if ((raw?.machineDefault && raw.machineDefault !== 'default') || folderMatches)
      return {
        error: `This folder or machine default selects a profile, but [profiles] has an error: ${key}`,
      };
    return {
      id: 'default',
      source: 'built_in',
      warning: `Profiles are disabled by a configuration error (${key}); this session uses your default sign-in. Run remi profile ls.`,
    };
  }
  if (selected)
    return Object.hasOwn(profiles.entries, selected.id)
      ? selected
      : { error: `Unknown profile ${selected.id}. Run remi profile ls.` };
  const cwd = canonicalPath(input.cwd, input.realpath);
  let match: { id: string; length: number } | undefined;
  for (const [id, profile] of Object.entries(profiles.entries))
    for (const folder of profile.folders) {
      const resolved = canonicalPath(folder, input.realpath);
      const relative = path.relative(resolved, cwd);
      if (
        (relative === '' ||
          (!relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative))) &&
        (!match || resolved.length > match.length)
      )
        match = { id, length: resolved.length };
    }
  if (match) return { id: match.id, source: 'folder' };
  if (profiles.default) return { id: profiles.default, source: 'machine_default' };
  return { id: 'default', source: 'built_in' };
}
