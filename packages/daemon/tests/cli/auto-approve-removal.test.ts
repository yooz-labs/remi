/**
 * What a user with an old habit, script or config sees after the
 * auto-approve removal (#1125, ADR 0030). Spawns the REAL cli.ts in an
 * isolated $HOME so the exit code and stderr are the ones a shell sees.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MODEL_COMMAND_REMOVED_MESSAGE,
  legacyEnginePaths,
  removedAutoApproveEnvVars,
  removedAutoApproveNotice,
} from '../../src/cli/auto-approve-removal.ts';
import { CLI_TS, findTestPort, isolatedEnv, pollUntil } from '../integration/hub-test-utils.ts';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-aa-removal-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function runCli(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI_TS, ...args], {
    cwd: home,
    env: isolatedEnv(home),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe('remi model (removed)', () => {
  test('explains the removal on one line and exits 2, whatever the verb', async () => {
    for (const args of [['model'], ['model', 'pull', 'YoozLabs/x'], ['model', 'ls', '--all']]) {
      const { code, stderr } = await runCli(args);
      expect(code).toBe(2);
      expect(stderr.trim()).toBe(MODEL_COMMAND_REMOVED_MESSAGE);
    }
  });

  test('the message is a single line', () => {
    expect(MODEL_COMMAND_REMOVED_MESSAGE.includes('\n')).toBe(false);
  });
});

describe('removedAutoApproveNotice', () => {
  const base = {
    configPath: '/home/u/.remi/config.toml',
    removedConfigKeys: [] as string[],
    subagentAlertFromLegacy: false,
    removedFlags: [] as string[],
    removedEnvVars: [] as string[],
    engineDir: null,
    enginePidFile: null,
  };

  test('nothing removed in use: no notice at all', () => {
    expect(removedAutoApproveNotice(base)).toEqual([]);
  });

  test('an engine dir alone is not worth a notice (only alongside a real one)', () => {
    expect(removedAutoApproveNotice({ ...base, engineDir: '/home/u/.remi/engine' })).toEqual([]);
  });

  test('names the config file and every removed key', () => {
    const lines = removedAutoApproveNotice({ ...base, removedConfigKeys: ['allow', 'level'] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/home/u/.remi/config.toml');
    expect(lines[0]).toContain('[auto_approve] table (allow, level)');
    expect(lines[0]).toContain('ignored');
  });

  test('flags are de-duplicated; env vars and the legacy alert list each get a line', () => {
    const lines = removedAutoApproveNotice({
      ...base,
      removedFlags: ['--auto-approve', '--auto-approve-allow', '--auto-approve-allow'],
      removedEnvVars: ['REMI_AUTO_APPROVE'],
      subagentAlertFromLegacy: true,
    });
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('--auto-approve, --auto-approve-allow:');
    expect(lines.join('\n')).toContain('REMI_AUTO_APPROVE');
    expect(lines.join('\n')).toContain('[notifications] subagent_alert');
  });

  test('mentions the old engine dir and pid file, and never claims to remove them', () => {
    const lines = removedAutoApproveNotice({
      ...base,
      removedConfigKeys: ['enabled'],
      engineDir: '/home/u/.remi/engine',
      enginePidFile: '/home/u/.remi/engine.pid',
    });
    const last = lines.at(-1) ?? '';
    expect(last).toContain('/home/u/.remi/engine (the old local model engine)');
    expect(last).toContain('delete it by hand');
    expect(last).toContain('/home/u/.remi/engine.pid');
    expect(last).toContain('stop it by hand');
  });

  test('removedAutoApproveEnvVars picks only the removed prefix, sorted', () => {
    expect(
      removedAutoApproveEnvVars({
        REMI_PORT: '1',
        REMI_AUTO_APPROVE_MODEL: 'x',
        REMI_AUTO_APPROVE: 'true',
      }),
    ).toEqual(['REMI_AUTO_APPROVE', 'REMI_AUTO_APPROVE_MODEL']);
  });

  test('legacyEnginePaths reports only what exists, and touches nothing', () => {
    expect(legacyEnginePaths(home)).toEqual({ engineDir: null, enginePidFile: null });
    fs.mkdirSync(path.join(home, '.remi', 'engine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.remi', 'engine.pid'), '123');
    expect(legacyEnginePaths(home)).toEqual({
      engineDir: path.join(home, '.remi', 'engine'),
      enginePidFile: path.join(home, '.remi', 'engine.pid'),
    });
    expect(fs.existsSync(path.join(home, '.remi', 'engine'))).toBe(true);
  });
});

describe('an old config and an old LaunchAgent still start the hub (#1125)', () => {
  test('remi serve with an [auto_approve] table and --auto-approve boots and warns once', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-aa-removal-work-'));
    fs.mkdirSync(path.join(home, '.remi', 'engine'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.remi', 'config.toml'),
      [
        '[auto_approve]',
        'enabled = true',
        'provider = "ollama"', // refused at load before #1125
        'allow = "git"', // a type error before #1125
        'level = "bogus"',
        '',
      ].join('\n'),
    );
    const port = await findTestPort();
    const proc = Bun.spawn(
      [
        'bun',
        CLI_TS,
        'serve',
        '--auto-approve', // what a pre-hub LaunchAgent plist may still pass
        '--auto-approve-model',
        'some-model',
        '--port',
        String(port),
        '--no-relay',
        '--no-telegram',
        '--no-mdns',
        '--no-auth',
      ],
      { cwd: work, env: isolatedEnv(home), stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const statusFile = path.join(home, '.remi', 'daemon-status.json');
      await pollUntil(
        () => {
          if (proc.exitCode !== null) throw new Error(`hub exited early (${proc.exitCode})`);
          try {
            return JSON.parse(fs.readFileSync(statusFile, 'utf-8')).wsPort === port;
          } catch {
            return false;
          }
        },
        15000,
        'hub status file',
      );
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
      fs.rmSync(work, { recursive: true, force: true });
    }
    const stderr = await new Response(proc.stderr).text();
    expect(stderr.split('still has an [auto_approve] table').length - 1).toBe(1);
    expect(stderr).toContain('(allow, enabled, level, provider)');
    expect(stderr).toContain('Ignoring removed flag(s) --auto-approve, --auto-approve-model');
    expect(stderr).toContain('(the old local model engine) is no longer used');
    // Never deletes user files.
    expect(fs.existsSync(path.join(home, '.remi', 'engine'))).toBe(true);
  }, 30_000);
});
