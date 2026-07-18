/**
 * Content tests for the --install service templates (#542): the LaunchAgent
 * must run `remi serve` (never a session daemon) with crash-only restart
 * semantics, and the systemd unit must match.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildLaunchAgentPlist,
  buildSystemdUnit,
  launchAgentPath,
  systemdUnitPath,
} from '../../src/cli/service-templates.ts';

describe('buildLaunchAgentPlist', () => {
  const binary = '/opt/homebrew/bin/remi';
  const home = '/Users/testuser';
  const plist = buildLaunchAgentPlist(binary, home);

  test('runs `<binary> serve`, not --daemon', () => {
    expect(plist).toContain(`<string>${binary}</string>\n        <string>serve</string>`);
    expect(plist).not.toContain('--daemon');
  });

  test('crash-only restart: KeepAlive.SuccessfulExit=false, not bare true', () => {
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  test('starts at login and logs under ~/.remi', () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain(`<string>${home}/.remi/remi-stdout.log</string>`);
    expect(plist).toContain(`<string>${home}/.remi/remi-stderr.log</string>`);
  });

  test('stable label, no leftover placeholders', () => {
    expect(plist).toContain('<string>com.yooz.remi</string>');
    expect(plist).not.toContain('__REMI_BINARY__');
    expect(plist).not.toContain('__HOME__');
  });
});

describe('buildSystemdUnit', () => {
  const binary = '/usr/local/bin/remi';
  const unit = buildSystemdUnit(binary);

  test('runs `<binary> serve` with on-failure restart', () => {
    expect(unit).toContain(`ExecStart=${binary} serve`);
    expect(unit).not.toContain('--daemon');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });
});

// Single source of truth for the paths --install writes and the
// autostart-state detector (#788) reads, so they can never drift apart.
describe('launchAgentPath / systemdUnitPath (#788)', () => {
  const home = '/Users/testuser';

  test('launchAgentPath matches the plist --install writes', () => {
    expect(launchAgentPath(home)).toBe(`${home}/Library/LaunchAgents/com.yooz.remi.plist`);
  });

  test('systemdUnitPath matches the unit --install writes', () => {
    expect(systemdUnitPath(home)).toBe(`${home}/.config/systemd/user/remi.service`);
  });
});
