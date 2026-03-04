import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookConfigManager } from '../../src/hooks/hook-config-manager.ts';

describe('HookConfigManager', () => {
  let tmpDir: string;
  let manager: HookConfigManager;
  const hookUrl = 'http://127.0.0.1:28766/hooks';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hook-config-'));
    manager = new HookConfigManager(tmpDir, hookUrl);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readSettings(): Record<string, unknown> {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    if (!fs.existsSync(settingsPath)) return {};
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  }

  function writeSettings(settings: Record<string, unknown>): void {
    const dir = path.join(tmpDir, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.local.json'), JSON.stringify(settings, null, 2));
  }

  it('creates .claude directory if it does not exist', () => {
    manager.install();
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(true);
  });

  it('writes hook config with all required events', () => {
    manager.install();
    const settings = readSettings() as { hooks: Record<string, unknown[]> };

    expect(settings.hooks).toBeDefined();
    const events = Object.keys(settings.hooks);
    expect(events).toContain('PreToolUse');
    expect(events).toContain('PostToolUse');
    expect(events).toContain('Notification');
    expect(events).toContain('Stop');
    expect(events).toContain('SessionStart');
  });

  it('each event has an HTTP hook entry with the correct URL', () => {
    manager.install();
    const settings = readSettings() as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ type: string; url: string; timeout: number }> }>
      >;
    };

    for (const event of ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionStart']) {
      const matchers = settings.hooks[event] as Array<{
        hooks: Array<{ type: string; url: string; timeout: number }>;
      }>;
      expect(matchers.length).toBeGreaterThanOrEqual(1);
      const lastMatcher = matchers[matchers.length - 1];
      expect(lastMatcher).toBeDefined();
      const hooks = lastMatcher?.hooks;
      expect(hooks?.length).toBe(1);
      expect(hooks?.[0]?.type).toBe('http');
      expect(hooks?.[0]?.url).toBe(hookUrl);
      expect(hooks?.[0]?.timeout).toBe(5);
    }
  });

  it('does not duplicate hooks on repeated install', () => {
    manager.install();
    manager.install();
    const settings = readSettings() as { hooks: Record<string, unknown[]> };

    for (const event of ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionStart']) {
      expect(settings.hooks[event]?.length).toBe(1);
    }
  });

  it('preserves existing user hooks', () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo blocked' }],
          },
        ],
      },
      someOtherSetting: 'value',
    });

    manager.install();
    const settings = readSettings() as {
      hooks: Record<string, unknown[]>;
      someOtherSetting: string;
    };

    // User's hook preserved
    expect(settings.hooks['PreToolUse']?.length).toBe(2);
    expect(settings.someOtherSetting).toBe('value');
  });

  it('uninstall removes only Remi hooks', () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo user-hook' }],
          },
        ],
      },
    });

    manager.install();
    manager.uninstall();

    const settings = readSettings() as { hooks: Record<string, unknown[]> };
    // User's hook remains
    expect(settings.hooks['PreToolUse']?.length).toBe(1);
    // Remi's events that had no user hooks are removed
    expect(settings.hooks['PostToolUse']).toBeUndefined();
  });

  it('uninstall removes settings file if empty', () => {
    manager.install();
    manager.uninstall();

    const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('uninstall is safe when file does not exist', () => {
    // No install happened, but hasWritten is false so it should be a no-op
    expect(() => manager.uninstall()).not.toThrow();
  });

  it('isInstalled returns true after install', () => {
    expect(manager.isInstalled()).toBe(false);
    manager.install();
    expect(manager.isInstalled()).toBe(true);
  });

  it('isInstalled returns false after uninstall', () => {
    manager.install();
    manager.uninstall();
    expect(manager.isInstalled()).toBe(false);
  });
});
