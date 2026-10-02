/**
 * `REMI_HOME` relocates remi's whole state directory (#1126 prerequisite,
 * `config/remi-home.ts`). The unit tests pin the resolution rules; the
 * subprocess tests run the real `cli.ts` with a sandbox HOME and a separate
 * REMI_HOME and check that state lands only in REMI_HOME: a module that still
 * built `~/.remi` itself would write into the sandbox HOME instead.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRemiHomeOverridden, remiHome } from '../src/config/remi-home.ts';
import { CLI_TS, findTestPort, isolatedEnv, pollUntil } from './integration/hub-test-utils.ts';

describe('remiHome()', () => {
  test('defaults to <home>/.remi when REMI_HOME is unset or empty', () => {
    expect(remiHome({}, '/u/me')).toBe(path.join('/u/me', '.remi'));
    expect(remiHome({ REMI_HOME: '' }, '/u/me')).toBe(path.join('/u/me', '.remi'));
    expect(isRemiHomeOverridden({})).toBe(false);
    expect(isRemiHomeOverridden({ REMI_HOME: '' })).toBe(false);
  });

  test('an absolute REMI_HOME is the state directory, normalized', () => {
    expect(remiHome({ REMI_HOME: '/tmp/scratch/../state/' }, '/u/me')).toBe(
      path.normalize('/tmp/state/'),
    );
    expect(isRemiHomeOverridden({ REMI_HOME: '/tmp/state' })).toBe(true);
  });

  test('a relative REMI_HOME is refused, never resolved against the cwd', () => {
    expect(() => remiHome({ REMI_HOME: 'state' }, '/u/me')).toThrow(/absolute path/);
    expect(() => remiHome({ REMI_HOME: './state' }, '/u/me')).toThrow(/absolute path/);
  });
});

describe('REMI_HOME moves the state a real cli.ts writes', () => {
  let home: string;
  let state: string;
  let work: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-home-sandbox-'));
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-home-state-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-home-work-'));
  });

  afterEach(() => {
    for (const d of [home, state, work]) fs.rmSync(d, { recursive: true, force: true });
  });

  test('remi config path names the config inside REMI_HOME', async () => {
    const proc = Bun.spawn(['bun', CLI_TS, 'config', 'path'], {
      cwd: work,
      env: isolatedEnv(home, { REMI_HOME: state }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(path.join(state, 'config.toml'));
  });

  test('remi serve writes its status and pid files under REMI_HOME and nothing under ~/.remi', async () => {
    const port = await findTestPort();
    const proc = Bun.spawn(
      [
        'bun',
        CLI_TS,
        'serve',
        '--port',
        String(port),
        '--no-relay',
        '--no-telegram',
        '--no-mdns',
        '--no-auth',
      ],
      {
        cwd: work,
        env: isolatedEnv(home, { REMI_HOME: state }),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    try {
      const statusFile = path.join(state, 'daemon-status.json');
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
        'hub status file under REMI_HOME',
      );
      expect(fs.existsSync(path.join(state, 'daemon.pid'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.remi'))).toBe(false);
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  }, 30000);

  test('a relative REMI_HOME stops the CLI instead of writing anywhere', async () => {
    const proc = Bun.spawn(['bun', CLI_TS, 'config', 'path'], {
      cwd: work,
      env: isolatedEnv(home, { REMI_HOME: 'relative-state' }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(err).toContain('REMI_HOME must be an absolute path');
    expect(fs.existsSync(path.join(work, 'relative-state'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.remi'))).toBe(false);
  });
});
