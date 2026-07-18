/**
 * Real-fs tests for autostart-state detection (#788): the hub reports
 * whether `remi --install`'s login-service artifact is on disk so the
 * sandboxed macOS app (which cannot read `~/Library/LaunchAgents` itself)
 * can surface it. Uses a temp dir as a fake HOME, injected directly — no
 * mocking of `fs` or `os`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectAutostartState } from '../../src/cli/autostart-state.ts';
import { launchAgentPath, systemdUnitPath } from '../../src/cli/service-templates.ts';

describe('detectAutostartState (#788)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-autostart-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('darwin: none when no LaunchAgent plist exists', () => {
    expect(detectAutostartState('darwin', home)).toBe('none');
  });

  test('darwin: installed once the LaunchAgent plist exists', () => {
    const plist = launchAgentPath(home);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');
    expect(detectAutostartState('darwin', home)).toBe('installed');
  });

  test('darwin: back to none after the plist is removed (uninstall)', () => {
    const plist = launchAgentPath(home);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');
    expect(detectAutostartState('darwin', home)).toBe('installed');

    fs.unlinkSync(plist);
    expect(detectAutostartState('darwin', home)).toBe('none');
  });

  test('darwin: an unrelated file under LaunchAgents does not count', () => {
    const plistDir = path.dirname(launchAgentPath(home));
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(path.join(plistDir, 'com.other.app.plist'), '<plist/>');
    expect(detectAutostartState('darwin', home)).toBe('none');
  });

  test('linux: none when no systemd unit exists', () => {
    expect(detectAutostartState('linux', home)).toBe('none');
  });

  test('linux: installed once the systemd user unit exists', () => {
    const unit = systemdUnitPath(home);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Unit]\n');
    expect(detectAutostartState('linux', home)).toBe('installed');
  });

  test('linux: darwin artifacts under the same fake HOME do not leak across platforms', () => {
    const plist = launchAgentPath(home);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');
    expect(detectAutostartState('linux', home)).toBe('none');
  });

  test('unsupported platforms (e.g. win32) always report none', () => {
    expect(detectAutostartState('win32', home)).toBe('none');
  });
});
