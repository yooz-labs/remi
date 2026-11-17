import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isCredentialName } from './profile-config.ts';
import { PROFILE_CREDENTIAL_ENV } from './profile-env.ts';

export interface ProfileWarning {
  readonly source: 'anthropic_profile' | 'managed_settings' | 'user_settings' | 'project_settings';
  readonly key:
    | 'active_config'
    | 'configs'
    | 'forceLoginOrgUUID'
    | 'forceLoginMethod'
    | 'apiKeyHelper'
    | 'env'
    | 'unreadable';
}

/**
 * File-based managed settings paths and drop-ins:
 * https://code.claude.com/docs/en/managed-settings
 * macOS managed preferences are not inspected.
 */
export function configWarnings(input: {
  claudeDir: string;
  expects: string;
  cwd: string;
  anthropicDir?: string;
  managedDir?: string;
}): ProfileWarning[] {
  const warnings: ProfileWarning[] = [];
  const anthropic =
    input.anthropicDir ??
    path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'anthropic');
  const managed =
    input.managedDir ??
    (process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : '/etc/claude-code');
  const add = (source: ProfileWarning['source'], key: ProfileWarning['key']) => {
    if (!warnings.some((w) => w.source === source && w.key === key)) warnings.push({ source, key });
  };
  try {
    if (fs.existsSync(path.join(anthropic, 'active_config')))
      add('anthropic_profile', 'active_config');
  } catch {
    add('anthropic_profile', 'unreadable');
  }
  try {
    if (fs.readdirSync(path.join(anthropic, 'configs')).length > 0)
      add('anthropic_profile', 'configs');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') add('anthropic_profile', 'unreadable');
  }
  const read = (
    filename: string,
    origin: ProfileWarning['source'],
    managedFile: boolean,
    userFile: boolean,
  ) => {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') add(origin, 'unreadable');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      add(origin, 'unreadable');
      return;
    }
    const record = data as Record<string, unknown>;
    if (managedFile)
      for (const key of ['forceLoginOrgUUID', 'forceLoginMethod'] as const)
        if (Object.hasOwn(record, key)) add(origin, key);
    if (Object.hasOwn(record, 'apiKeyHelper') && !(userFile && input.expects === 'api_key'))
      add(origin, 'apiKeyHelper');
    const env = record['env'];
    if (
      env &&
      typeof env === 'object' &&
      !Array.isArray(env) &&
      Object.keys(env).some(
        (key) =>
          PROFILE_CREDENTIAL_ENV.includes(key) ||
          isCredentialName(key) ||
          key === 'CLAUDE_CONFIG_DIR' ||
          key === 'ANTHROPIC_BASE_URL',
      )
    )
      add(origin, 'env');
  };
  read(path.join(managed, 'managed-settings.json'), 'managed_settings', true, false);
  try {
    for (const name of fs.readdirSync(path.join(managed, 'managed-settings.d')))
      if (!name.startsWith('.') && name.endsWith('.json'))
        read(path.join(managed, 'managed-settings.d', name), 'managed_settings', true, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') add('managed_settings', 'unreadable');
  }
  read(path.join(input.claudeDir, 'settings.json'), 'user_settings', false, true);
  read(path.join(input.cwd, '.claude', 'settings.json'), 'project_settings', false, false);
  read(path.join(input.cwd, '.claude', 'settings.local.json'), 'project_settings', false, false);
  return warnings;
}
