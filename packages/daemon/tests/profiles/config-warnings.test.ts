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

test('each settings location and warning trigger is independently detected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-warning-matrix-'));
  try {
    const managedDir = path.join(root, 'managed');
    const claudeDir = path.join(root, 'claude');
    const cwd = path.join(root, 'project');
    const anthropicDir = path.join(root, 'anthropic');
    for (const dir of [
      managedDir,
      claudeDir,
      path.join(cwd, '.claude'),
      anthropicDir,
      path.join(managedDir, 'managed-settings.d'),
    ])
      fs.mkdirSync(dir, { recursive: true });
    const input = { managedDir, claudeDir, cwd, anthropicDir, expects: 'subscription' };
    fs.writeFileSync(path.join(anthropicDir, 'active_config'), 'PRIVATE_VALUE');
    expect(configWarnings(input)).toEqual([{ source: 'anthropic_profile', key: 'active_config' }]);
    fs.unlinkSync(path.join(anthropicDir, 'active_config'));
    fs.mkdirSync(path.join(anthropicDir, 'configs'));
    fs.writeFileSync(path.join(anthropicDir, 'configs', 'active'), 'PRIVATE_VALUE');
    expect(configWarnings(input)).toEqual([{ source: 'anthropic_profile', key: 'configs' }]);
    fs.rmSync(path.join(anthropicDir, 'configs'), { recursive: true });
    const cases = [
      [
        path.join(managedDir, 'managed-settings.json'),
        { forceLoginMethod: 'PRIVATE_VALUE' },
        'managed_settings',
        'forceLoginMethod',
      ],
      [
        path.join(managedDir, 'managed-settings.d', 'policy.json'),
        { forceLoginOrgUUID: 'PRIVATE_VALUE' },
        'managed_settings',
        'forceLoginOrgUUID',
      ],
      [
        path.join(managedDir, 'managed-settings.json'),
        { apiKeyHelper: 'PRIVATE_VALUE' },
        'managed_settings',
        'apiKeyHelper',
      ],
      [
        path.join(managedDir, 'managed-settings.json'),
        { env: { CUSTOM_TOKEN: 'PRIVATE_VALUE' } },
        'managed_settings',
        'env',
      ],
      [
        path.join(claudeDir, 'settings.json'),
        { apiKeyHelper: 'PRIVATE_VALUE' },
        'user_settings',
        'apiKeyHelper',
      ],
      [
        path.join(claudeDir, 'settings.json'),
        { env: { ANTHROPIC_CONFIG_DIR: 'PRIVATE_VALUE' } },
        'user_settings',
        'env',
      ],
      [
        path.join(cwd, '.claude', 'settings.json'),
        { apiKeyHelper: 'PRIVATE_VALUE' },
        'project_settings',
        'apiKeyHelper',
      ],
      [
        path.join(cwd, '.claude', 'settings.local.json'),
        { env: { CLAUDE_CONFIG_DIR: 'PRIVATE_VALUE' } },
        'project_settings',
        'env',
      ],
      [
        path.join(cwd, '.claude', 'settings.local.json'),
        { env: { ANTHROPIC_BASE_URL: 'PRIVATE_VALUE' } },
        'project_settings',
        'env',
      ],
    ] as const;
    for (const [file, data, source, key] of cases) {
      fs.writeFileSync(file, JSON.stringify(data));
      const result = configWarnings(input);
      expect(result).toEqual([{ source, key }]);
      expect(result.map((w) => `${w.source}: ${w.key}`).join('\n')).toBe(`${source}: ${key}`);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
      fs.unlinkSync(file);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
