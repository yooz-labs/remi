import * as fs from 'node:fs';
import { logError } from '../cli/logger.ts';
import { CONFIG_PATH, parseConfigText } from '../config/config.ts';
import type { Profiles } from './profile-config.ts';

const cache = new Map<string, { signature: string; profiles: Profiles }>();

/** Re-read changed configuration without putting configuration contents in logs. */
export function currentProfiles(configPath = CONFIG_PATH): Profiles {
  let signature: string;
  try {
    const stat = fs.statSync(configPath);
    signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const prior = cache.get(configPath);
      if (prior?.signature === 'missing') return prior.profiles;
      const profiles: Profiles = { entries: {}, notices: [] };
      cache.set(configPath, { signature: 'missing', profiles });
      return profiles;
    }
    cache.delete(configPath);
    logError('[Profiles] Could not read configuration; profiles disabled');
    return { error: 'Could not read configuration; profiles disabled' };
  }
  const prior = cache.get(configPath);
  if (prior?.signature === signature) return prior.profiles;
  let profiles: Profiles;
  try {
    profiles = parseConfigText(fs.readFileSync(configPath, 'utf8'), configPath).config.profiles;
    if ('error' in profiles) logError('[Profiles] Invalid configuration; profiles disabled');
  } catch {
    profiles = { error: 'Could not read or parse configuration; profiles disabled' };
    logError('[Profiles] Could not read or parse configuration; profiles disabled');
  }
  cache.set(configPath, { signature, profiles });
  return profiles;
}
