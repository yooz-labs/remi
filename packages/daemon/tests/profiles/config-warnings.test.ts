import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configWarnings } from '../../src/profiles/config-warnings.ts';

test('warnings name sources and keys, never settings values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-warning-'));
  try {
    const anthropicDir = path.join(root, 'anthropic');
    const managedDir = path.join(root, 'managed');
    const claudeDir = path.join(root, 'claude');
    const cwd = path.join(root, 'project');
    for (const dir of [
      path.join(anthropicDir, 'configs'),
      path.join(managedDir, 'managed-settings.d'),
      claudeDir,
      path.join(cwd, '.claude'),
    ])
      fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(anthropicDir, 'active_config'), 'PLANTED');
    fs.writeFileSync(path.join(anthropicDir, 'configs', 'one'), 'PLANTED');
    fs.writeFileSync(
      path.join(managedDir, 'managed-settings.d', 'one.json'),
      JSON.stringify({
        forceLoginOrgUUID: 'PLANTED',
        forceLoginMethod: 'PLANTED',
        apiKeyHelper: 'PLANTED',
        env: { CUSTOM_TOKEN: 'PLANTED' },
      }),
    );
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ apiKeyHelper: 'PLANTED' }),
    );
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CONFIG_DIR: 'PLANTED', ANTHROPIC_BASE_URL: 'PLANTED' } }),
    );
    const input = { anthropicDir, managedDir, claudeDir, cwd, expects: 'subscription' };
    const warnings = configWarnings(input);
    for (const warning of [
      { source: 'anthropic_profile', key: 'active_config' },
      { source: 'anthropic_profile', key: 'configs' },
      { source: 'managed_settings', key: 'forceLoginOrgUUID' },
      { source: 'managed_settings', key: 'forceLoginMethod' },
      { source: 'managed_settings', key: 'apiKeyHelper' },
      { source: 'managed_settings', key: 'env' },
      { source: 'user_settings', key: 'apiKeyHelper' },
      { source: 'project_settings', key: 'env' },
    ] as const)
      expect(warnings).toContainEqual(warning);
    expect(JSON.stringify(warnings)).not.toContain('PLANTED');
    expect(configWarnings({ ...input, expects: 'api_key' })).not.toContainEqual({
      source: 'user_settings',
      key: 'apiKeyHelper',
    });
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'bad JSON PLANTED');
    expect(configWarnings(input)).toContainEqual({ source: 'project_settings', key: 'unreadable' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
