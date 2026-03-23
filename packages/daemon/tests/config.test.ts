/**
 * Tests for config file system.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  applyEnvOverrides,
  formatConfig,
  generateDefaultConfig,
  initConfigFile,
  loadConfig,
} from '../src/config/config.ts';

const TEST_DIR = path.join(os.tmpdir(), `remi-config-test-${process.pid}`);
const TEST_CONFIG = path.join(TEST_DIR, 'config.toml');

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadConfig', () => {
  test('returns defaults when no file exists', () => {
    const config = loadConfig(path.join(TEST_DIR, 'nonexistent.toml'));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('parses valid TOML config', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[daemon]
base_port = 19000
port_range = 10

[telegram]
enabled = true
bot_token = "test-token"
authorized_chat_ids = [123, 456]
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.daemon.base_port).toBe(19000);
    expect(config.daemon.port_range).toBe(10);
    expect(config.daemon.bind).toBe('0.0.0.0'); // default preserved
    expect(config.telegram.enabled).toBe(true);
    expect(config.telegram.bot_token).toBe('test-token');
    expect(config.telegram.authorized_chat_ids).toEqual([123, 456]);
  });

  test('preserves defaults for missing sections', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[display]
max_bullet_length = 200
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.display.max_bullet_length).toBe(200);
    expect(config.daemon).toEqual(DEFAULT_CONFIG.daemon);
    expect(config.network).toEqual(DEFAULT_CONFIG.network);
    expect(config.auth).toEqual(DEFAULT_CONFIG.auth);
    expect(config.telegram).toEqual(DEFAULT_CONFIG.telegram);
  });

  test('throws on invalid TOML', () => {
    fs.writeFileSync(TEST_CONFIG, 'this is not valid toml ][}{');

    expect(() => loadConfig(TEST_CONFIG)).toThrow('Invalid TOML');
  });

  test('returns defaults for nonexistent file', () => {
    const config = loadConfig(path.join(TEST_DIR, 'nonexistent.toml'));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test('handles partial sections', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[daemon]
bind = "localhost"
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.daemon.bind).toBe('localhost');
    expect(config.daemon.base_port).toBe(18765); // default preserved
    expect(config.daemon.port_range).toBe(20); // default preserved
  });

  test('handles auth enabled as string or boolean', () => {
    fs.writeFileSync(
      TEST_CONFIG,
      `
[auth]
enabled = true
`,
    );

    const config = loadConfig(TEST_CONFIG);
    expect(config.auth.enabled).toBe(true);
  });
});

describe('applyEnvOverrides', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        process.env[key] = undefined;
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  test('REMI_PORT overrides base_port', () => {
    process.env['REMI_PORT'] = '19999';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.daemon.base_port).toBe(19999);
  });

  test('REMI_MAX_BULLET_LENGTH overrides max_bullet_length', () => {
    process.env['REMI_MAX_BULLET_LENGTH'] = '100';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.display.max_bullet_length).toBe(100);
  });

  test('TELEGRAM_BOT_TOKEN enables telegram', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token-123';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.telegram.bot_token).toBe('test-token-123');
    expect(config.telegram.enabled).toBe(true);
  });

  test('TELEGRAM_ENABLED=false disables even with token', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token-123';
    process.env['TELEGRAM_ENABLED'] = 'false';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.telegram.bot_token).toBe('test-token-123');
    expect(config.telegram.enabled).toBe(false);
  });

  test('TELEGRAM_AUTHORIZED_CHAT_IDS parsed as number array', () => {
    process.env['TELEGRAM_AUTHORIZED_CHAT_IDS'] = '123,456,789';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.telegram.authorized_chat_ids).toEqual([123, 456, 789]);
  });

  test('invalid env values are ignored', () => {
    process.env['REMI_PORT'] = 'not-a-number';
    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config.daemon.base_port).toBe(DEFAULT_CONFIG.daemon.base_port);
  });

  test('does not modify config when relevant env vars are absent', () => {
    // Clear all remi/telegram env vars
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_PORT'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['REMI_MAX_BULLET_LENGTH'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_BOT_TOKEN'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_ENABLED'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_AUTHORIZED_CHAT_IDS'];
    // biome-ignore lint/performance/noDelete: test isolation
    delete process.env['TELEGRAM_AUTHORIZED_USER_IDS'];

    const config = applyEnvOverrides(DEFAULT_CONFIG);
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe('initConfigFile', () => {
  test('creates config file with defaults', () => {
    const configPath = path.join(TEST_DIR, 'new-config.toml');
    const result = initConfigFile(configPath);
    expect(result).toBe(configPath);
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('[daemon]');
    expect(content).toContain('base_port = 18765');
    expect(content).toContain('[telegram]');
  });

  test('throws if file already exists', () => {
    fs.writeFileSync(TEST_CONFIG, '# existing');
    expect(() => initConfigFile(TEST_CONFIG)).toThrow('already exists');
  });
});

describe('generateDefaultConfig', () => {
  test('generates valid TOML that can be parsed back', () => {
    const toml = generateDefaultConfig();
    const config = loadConfig(
      (() => {
        const p = path.join(TEST_DIR, 'roundtrip.toml');
        fs.writeFileSync(p, toml);
        return p;
      })(),
    );
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});

describe('formatConfig', () => {
  test('formats config as readable string', () => {
    const output = formatConfig(DEFAULT_CONFIG, path.join(TEST_DIR, 'nonexistent.toml'));
    expect(output).toContain('not found, using defaults');
    expect(output).toContain('base_port = 18765');
    expect(output).toContain('[telegram]');
  });

  test('masks bot token', () => {
    const config = {
      ...DEFAULT_CONFIG,
      telegram: { ...DEFAULT_CONFIG.telegram, bot_token: 'secret-token' },
    };
    const output = formatConfig(config);
    expect(output).toContain('***');
    expect(output).not.toContain('secret-token');
  });
});
