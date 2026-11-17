import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Profiles } from './profile-config.ts';

export type ProfileSource = 'flag' | 'env' | 'folder' | 'machine_default' | 'built_in';
export type Resolution =
  | { readonly id: string; readonly source: ProfileSource }
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
  if ('error' in profiles) return { error: profiles.error };
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
