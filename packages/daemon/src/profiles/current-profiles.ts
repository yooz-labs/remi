import * as fs from 'node:fs';
import { logError } from '../cli/logger.ts';
import { CONFIG_PATH, parseConfigText } from '../config/config.ts';
import type { Profiles } from './profile-config.ts';

const cache = new Map<string, { signature: string; profiles: Profiles }>();
const failures = new Set<string>();
const failureMessage = '[Profiles] Could not read or parse configuration';

/** Re-read changed configuration without putting configuration contents in logs. */
export function currentProfiles(configPath = CONFIG_PATH): Profiles {
  const prior = cache.get(configPath);
  let signature: string;
  try {
    const stat = fs.statSync(configPath);
    signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    if (code === 'ENOENT' && !prior) return { entries: {}, notices: [] };
    if (!failures.has(`stat:${code}`)) {
      failures.add(`stat:${code}`);
      logError(failureMessage);
    }
    return prior?.profiles ?? { error: 'Could not read or parse configuration' };
  }
  if (prior?.signature === signature) return prior.profiles;
  try {
    const profiles = parseConfigText(fs.readFileSync(configPath, 'utf8'), configPath).config
      .profiles;
    if ('error' in profiles) throw new Error('Invalid profiles');
    cache.set(configPath, { signature, profiles });
    return profiles;
  } catch {
    const key = `parse:${configPath}:${signature}`;
    if (!failures.has(key)) {
      failures.add(key);
      logError(failureMessage);
    }
    return prior?.profiles ?? { error: 'Could not read or parse configuration' };
  }
}
