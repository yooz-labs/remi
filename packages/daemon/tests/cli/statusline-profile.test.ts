import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installStatusLine,
  installStatusLineForLaunch,
  statusLineTarget,
} from '../../src/cli/statusline-installer.ts';

test('targets a profile safely and preserves existing settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-statusline-'));
  const remiHome = path.join(root, 'remi');
  const profile = path.join(remiHome, 'p', 'work', 'claude');
  const outside = path.join(root, 'outside');
  try {
    fs.mkdirSync(remiHome);
    fs.mkdirSync(outside);
    expect(statusLineTarget({ remiHome, remiHomeOverridden: false })).toEqual({ register: true });
    expect(statusLineTarget({ remiHome, remiHomeOverridden: true })).toEqual({ register: false });
    expect(
      statusLineTarget({ profileClaudeDir: profile, remiHome, remiHomeOverridden: true }),
    ).toEqual({ settingsPath: path.join(profile, 'settings.json'), register: true });
    expect(
      statusLineTarget({ profileClaudeDir: outside, remiHome, remiHomeOverridden: true }).register,
    ).toBe(false);
    expect(
      statusLineTarget({ profileClaudeDir: outside, remiHome, remiHomeOverridden: false }),
    ).toEqual({ settingsPath: path.join(outside, 'settings.json'), register: true });
    fs.symlinkSync(outside, path.join(remiHome, 'link'));
    expect(
      statusLineTarget({
        profileClaudeDir: path.join(remiHome, 'link', 'missing'),
        remiHome,
        remiHomeOverridden: true,
      }).register,
    ).toBe(false);
    const settings = path.join(profile, 'settings.json');
    installStatusLine(remiHome, settings, true);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.type).toBe('command');
    for (const old of ['{"statusLine":{"type":"custom"}}']) {
      fs.writeFileSync(settings, old);
      installStatusLine(remiHome, settings, true);
      expect(fs.readFileSync(settings, 'utf8')).toBe(old);
    }
    fs.writeFileSync(settings, '{"statusLine":null}');
    installStatusLine(remiHome, settings, true);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.type).toBe('command');
    fs.writeFileSync(
      path.join(remiHome, 'status-19999.json'),
      JSON.stringify({ pid: process.pid }),
    );
    const result = spawnSync('/bin/bash', [path.join(remiHome, 'statusline.sh')], {
      input: JSON.stringify({
        model: { display_name: 'Fixture' },
        context_window: { used_percentage: 42 },
      }),
      env: { PATH: process.env['PATH'], REMI_PORT: '19999' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('remi:19999');
    expect(result.stdout).toContain('[Fixture] 42% context');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launch helper targets a profile and honors the default override', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-launch-'));
  try {
    const profile = path.join(root, 'p', 'work', 'claude');
    installStatusLineForLaunch({ claude: { dir: profile } }, root, true);
    expect(
      JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).statusLine.type,
    ).toBe('command');
    installStatusLineForLaunch(undefined, root, true);
    expect(fs.existsSync(path.join(root, 'statusline.sh'))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scratch profile settings symlink cannot write outside the remi home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-symlink-'));
  const home = path.join(root, 'home');
  const profile = path.join(home, 'profile');
  const outside = path.join(root, 'outside.json');
  try {
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(outside, '{}\n');
    fs.symlinkSync(outside, path.join(profile, 'settings.json'));
    const target = statusLineTarget({
      profileClaudeDir: profile,
      remiHome: home,
      remiHomeOverridden: true,
    });
    expect(target.register).toBe(false);
    installStatusLineForLaunch({ claude: { dir: profile } }, home, true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('{}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
