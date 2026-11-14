import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AWAKE_MAX_IDLE_GRACE_SECONDS,
  AWAKE_MAX_QUESTION_HOLD_MINUTES,
  AWAKE_MAX_STUCK_BUSY_MINUTES,
  AWAKE_MAX_TTL_MINUTES,
  DEFAULT_CONFIG,
  generateDefaultConfig,
  loadConfig,
} from '../../src/config/config.ts';

let directory: string;
let configPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'remi-awake-config-'));
  configPath = join(directory, 'config.toml');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('awake defaults are loaded and the generated config documents each option', () => {
  expect(loadConfig(configPath).awake).toEqual({
    level1: true,
    question_hold_minutes: 30,
    idle_grace_seconds: 120,
    stuck_busy_minutes: 15,
    ttl_minutes: 20,
  });
  expect(DEFAULT_CONFIG.awake).toEqual(loadConfig(configPath).awake);

  const generated = generateDefaultConfig();
  for (const option of [
    'level1 = true',
    'question_hold_minutes = 30',
    'idle_grace_seconds = 120',
    'stuck_busy_minutes = 15',
    'ttl_minutes = 20',
  ]) {
    expect(generated).toContain(option);
  }
  writeFileSync(configPath, generated);
  expect(loadConfig(configPath).awake).toEqual(DEFAULT_CONFIG.awake);
});

test('every awake setting accepts a valid override', () => {
  writeFileSync(
    configPath,
    '[awake]\nlevel1 = false\nquestion_hold_minutes = 45\nidle_grace_seconds = 240\nstuck_busy_minutes = 10\nttl_minutes = 25\n',
  );
  expect(loadConfig(configPath).awake).toEqual({
    level1: false,
    question_hold_minutes: 45,
    idle_grace_seconds: 240,
    stuck_busy_minutes: 10,
    ttl_minutes: 25,
  });
});

test('awake rejects wrong types and out-of-range numeric values', () => {
  const values = [
    ['level1', '1'],
    ['question_hold_minutes', '"30"'],
    ['idle_grace_seconds', 'true'],
    ['stuck_busy_minutes', '15.5'],
    ['ttl_minutes', '"20"'],
    ['question_hold_minutes', '0'],
    ['question_hold_minutes', String(AWAKE_MAX_QUESTION_HOLD_MINUTES + 1)],
    ['idle_grace_seconds', '0'],
    ['idle_grace_seconds', String(AWAKE_MAX_IDLE_GRACE_SECONDS + 1)],
    ['stuck_busy_minutes', '0'],
    ['stuck_busy_minutes', String(AWAKE_MAX_STUCK_BUSY_MINUTES + 1)],
    ['ttl_minutes', '0'],
    ['ttl_minutes', String(AWAKE_MAX_TTL_MINUTES + 1)],
  ] as const;
  for (const [key, value] of values) {
    writeFileSync(configPath, `[awake]\n${key} = ${value}\n`);
    expect(() => loadConfig(configPath)).toThrow(`Invalid awake.${key}`);
  }
});

test('level1_battery_floor_percent (ADR 0050) is rejected until the guard-rails slice ships it', () => {
  writeFileSync(configPath, '[awake]\nlevel1_battery_floor_percent = 20\n');
  expect(() => loadConfig(configPath)).toThrow('unsupported key(s): level1_battery_floor_percent');
  expect(generateDefaultConfig()).toContain('No battery floor yet');
});

test('awake rejects malformed tables and unknown options', () => {
  for (const text of ['awake = true', 'awake = []', '[awake]\nunknown = 1']) {
    writeFileSync(configPath, text);
    expect(() => loadConfig(configPath)).toThrow('Invalid awake');
  }
});
