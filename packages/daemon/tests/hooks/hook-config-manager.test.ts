import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookConfigManager } from '../../src/hooks/hook-config-manager.ts';
import { HOOK_EVENT_NAMES, REMI_REGISTERED_HOOK_EVENTS } from '../../src/hooks/hook-types.ts';

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

  it('creates .claude directory if it does not exist', async () => {
    await manager.install();
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(true);
  });

  it('writes hook config only for events remi consumes (issue #203)', async () => {
    await manager.install();
    const settings = readSettings() as { hooks: Record<string, unknown[]> };

    expect(settings.hooks).toBeDefined();
    const events = Object.keys(settings.hooks);

    // The narrowed list — registering every HOOK_EVENT_NAMES entry would
    // make every Claude Code action (worktree create, prompt submit, etc.)
    // gate on a synchronous HTTP call to a possibly-dead remi.
    for (const event of REMI_REGISTERED_HOOK_EVENTS) {
      expect(events).toContain(event);
    }
    expect(events.length).toBe(REMI_REGISTERED_HOOK_EVENTS.length);
    // None of the explicitly-skipped events should appear:
    expect(events).not.toContain('WorktreeCreate');
    expect(events).not.toContain('WorktreeRemove');
    expect(events).not.toContain('UserPromptSubmit');
    expect(events).not.toContain('PreCompact');
  });

  it('each registered event has an HTTP hook entry with the correct URL', async () => {
    await manager.install();
    const settings = readSettings() as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ type: string; url: string; timeout: number }> }>
      >;
    };

    for (const event of REMI_REGISTERED_HOOK_EVENTS) {
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
      // PermissionRequest must outlast the synchronous auto-approve eval (#537);
      // every other hook keeps the short fail-fast timeout (#203).
      expect(hooks?.[0]?.timeout).toBe(event === 'PermissionRequest' ? 300 : 5);
    }
  });

  it('#537: PermissionRequest gets a long timeout; other hooks stay short', async () => {
    await manager.install();
    const settings = readSettings() as {
      hooks: Record<string, Array<{ hooks: Array<{ url: string; timeout: number }> }>>;
    };
    const permHook = settings.hooks['PermissionRequest']
      ?.find((m) => m.hooks.some((h) => h.url === hookUrl))
      ?.hooks.find((h) => h.url === hookUrl);
    expect(permHook?.timeout).toBe(300);
    // A representative non-permission hook keeps the short timeout.
    const stopHook = settings.hooks['Stop']
      ?.find((m) => m.hooks.some((h) => h.url === hookUrl))
      ?.hooks.find((h) => h.url === hookUrl);
    expect(stopHook?.timeout).toBe(5);
  });

  it('#537: install() reconciles a stale 5s PermissionRequest hook up to the long timeout', async () => {
    // Simulate a settings file from a pre-#537 remi: PermissionRequest registered
    // with the old blanket 5s. install() must update it in place, not duplicate.
    const stale = {
      hooks: { PermissionRequest: [{ hooks: [{ type: 'http', url: hookUrl, timeout: 5 }] }] },
    };
    writeSettings(stale);
    expect(manager.isInstalled()).toBe(false); // stale timeout reports not-installed

    await manager.install();
    const settings = readSettings() as {
      hooks: Record<string, Array<{ hooks: Array<{ url: string; timeout: number }> }>>;
    };
    const permMatchers = settings.hooks['PermissionRequest'];
    const remiHooks = permMatchers?.flatMap((m) => m.hooks.filter((h) => h.url === hookUrl)) ?? [];
    expect(remiHooks.length).toBe(1); // reconciled in place, not duplicated
    expect(remiHooks[0]?.timeout).toBe(300);
    expect(manager.isInstalled()).toBe(true);
  });

  it('regression #203: install() drops legacy remi entries for events it no longer registers', async () => {
    // Simulate a settings file written by an older remi that registered the
    // full HOOK_EVENT_NAMES list (which still includes WorktreeCreate). Our
    // own URL on a non-registered event should be pruned on next install
    // so Claude Code stops gating worktree creation on us.
    const legacyHooks: Record<
      string,
      Array<{ hooks: Array<{ type: string; url: string; timeout: number }> }>
    > = {};
    for (const event of HOOK_EVENT_NAMES) {
      legacyHooks[event] = [{ hooks: [{ type: 'http', url: hookUrl, timeout: 5 }] }];
    }
    // Plus a user hook on WorktreeCreate to make sure we DON'T touch it.
    legacyHooks['WorktreeCreate'] = [
      { hooks: [{ type: 'http', url: hookUrl, timeout: 5 }] },
      { hooks: [{ type: 'http', url: 'http://user-tool.example.com/wt', timeout: 5 }] },
    ];
    writeSettings({ hooks: legacyHooks });

    await manager.install();

    const settings = readSettings() as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ type: string; url: string; timeout: number }> }>
      >;
    };

    // Our URL is gone from WorktreeCreate; the user hook stays.
    const wt = settings.hooks['WorktreeCreate'];
    expect(wt).toBeDefined();
    const wtHookUrls = wt?.flatMap((m) => m.hooks.map((h) => h.url)) ?? [];
    expect(wtHookUrls).not.toContain(hookUrl);
    expect(wtHookUrls).toContain('http://user-tool.example.com/wt');

    // WorktreeRemove had only our entry → key removed entirely.
    expect(settings.hooks['WorktreeRemove']).toBeUndefined();
    expect(settings.hooks['UserPromptSubmit']).toBeUndefined();
    expect(settings.hooks['PreCompact']).toBeUndefined();

    // Registered events keep their entry.
    for (const event of REMI_REGISTERED_HOOK_EVENTS) {
      expect(settings.hooks[event]).toBeDefined();
    }
  });

  it('uninstallSync() removes our entries and never throws', () => {
    // No prior install → uninstallSync must be a no-op.
    expect(() => manager.uninstallSync()).not.toThrow();
  });

  it('does not duplicate hooks on repeated install', async () => {
    await manager.install();
    await manager.install();
    const settings = readSettings() as { hooks: Record<string, unknown[]> };

    for (const event of REMI_REGISTERED_HOOK_EVENTS) {
      expect(settings.hooks[event]?.length).toBe(1);
    }
  });

  it('preserves existing user hooks', async () => {
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

    await manager.install();
    const settings = readSettings() as {
      hooks: Record<string, unknown[]>;
      someOtherSetting: string;
    };

    // User's hook preserved
    expect(settings.hooks['PreToolUse']?.length).toBe(2);
    expect(settings.someOtherSetting).toBe('value');
  });

  it('uninstall removes only Remi hooks', async () => {
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

    await manager.install();
    manager.uninstall();

    const settings = readSettings() as { hooks: Record<string, unknown[]> };
    // User's hook remains
    expect(settings.hooks['PreToolUse']?.length).toBe(1);
    // Remi's events that had no user hooks are removed
    expect(settings.hooks['PostToolUse']).toBeUndefined();
  });

  it('uninstall removes settings file if empty', async () => {
    await manager.install();
    manager.uninstall();

    const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it('uninstall is safe when file does not exist', () => {
    // No install happened, but hasWritten is false so it should be a no-op
    expect(() => manager.uninstall()).not.toThrow();
  });

  it('isInstalled returns true after install', async () => {
    expect(manager.isInstalled()).toBe(false);
    await manager.install();
    expect(manager.isInstalled()).toBe(true);
  });

  it('isInstalled returns false after uninstall', async () => {
    await manager.install();
    manager.uninstall();
    expect(manager.isInstalled()).toBe(false);
  });

  it('purges stale hooks from dead ports on install', async () => {
    // Pre-seed settings with a hook pointing to a dead port
    writeSettings({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'http', url: 'http://127.0.0.1:19999/hooks', timeout: 5 }] },
        ],
        PostToolUse: [
          { hooks: [{ type: 'http', url: 'http://127.0.0.1:19999/hooks', timeout: 5 }] },
        ],
      },
    });

    await manager.install();
    const settings = readSettings() as { hooks: Record<string, unknown[]> };

    // Dead hook should be purged, only our hook remains
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(settings.hooks[event]?.length).toBe(1);
    }
  });

  it('preserves hooks on reachable ports during purge', async () => {
    // Start a real TCP server on a port
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data() {},
        open() {},
        close() {},
      },
    });

    const liveUrl = `http://127.0.0.1:${server.port}/hooks`;
    writeSettings({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'http', url: liveUrl, timeout: 5 }] }],
      },
    });

    await manager.install();
    const settings = readSettings() as {
      hooks: Record<string, Array<{ hooks: Array<{ url: string }> }>>;
    };

    // Live hook should be preserved alongside our hook
    expect(settings.hooks['PreToolUse']?.length).toBe(2);
    const urls = settings.hooks['PreToolUse']!.flatMap((m) => m.hooks.map((h) => h.url));
    expect(urls).toContain(liveUrl);
    expect(urls).toContain(hookUrl);

    server.stop();
  });

  it('purges dead hooks while preserving live ones in mixed scenario', async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open() {}, close() {} },
    });

    const liveUrl = `http://127.0.0.1:${server.port}/hooks`;
    const deadUrl = 'http://127.0.0.1:19998/hooks';
    writeSettings({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'http', url: deadUrl, timeout: 5 }] },
          { hooks: [{ type: 'http', url: liveUrl, timeout: 5 }] },
        ],
        PostToolUse: [{ hooks: [{ type: 'http', url: deadUrl, timeout: 5 }] }],
      },
    });

    await manager.install();
    const settings = readSettings() as {
      hooks: Record<string, Array<{ hooks: Array<{ url: string }> }>>;
    };

    // PreToolUse: dead removed, live preserved, ours added = 2
    const preUrls = settings.hooks['PreToolUse']!.flatMap((m) => m.hooks.map((h) => h.url));
    expect(preUrls).toContain(liveUrl);
    expect(preUrls).toContain(hookUrl);
    expect(preUrls).not.toContain(deadUrl);

    // PostToolUse: dead removed, ours added = 1
    const postUrls = settings.hooks['PostToolUse']!.flatMap((m) => m.hooks.map((h) => h.url));
    expect(postUrls).toContain(hookUrl);
    expect(postUrls).not.toContain(deadUrl);

    server.stop();
  });

  it('preserves non-localhost and non-HTTP hooks during purge', async () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'http', url: 'http://10.0.0.5:9999/hooks', timeout: 5 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo blocked' }] },
        ],
      },
    });

    await manager.install();
    const settings = readSettings() as {
      hooks: Record<string, Array<{ hooks: Array<{ url?: string; command?: string }> }>>;
    };

    // Both non-localhost HTTP and command hooks preserved, plus ours = 3
    expect(settings.hooks['PreToolUse']?.length).toBe(3);
  });

  it('removes invalid event names left by older remi versions', async () => {
    // Simulate stale settings with events Claude Code no longer recognizes
    writeSettings({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'http', url: 'http://127.0.0.1:12345/hooks', timeout: 5 }] },
        ],
        CwdChanged: [
          { hooks: [{ type: 'http', url: 'http://127.0.0.1:12345/hooks', timeout: 5 }] },
        ],
        FileChanged: [
          { hooks: [{ type: 'http', url: 'http://127.0.0.1:12345/hooks', timeout: 5 }] },
        ],
        TaskCreated: [
          { hooks: [{ type: 'http', url: 'http://127.0.0.1:12345/hooks', timeout: 5 }] },
        ],
      },
    });

    await manager.install();
    const settings = readSettings() as { hooks: Record<string, unknown[]> };

    // Invalid events should be removed
    expect(settings.hooks['CwdChanged']).toBeUndefined();
    expect(settings.hooks['FileChanged']).toBeUndefined();
    expect(settings.hooks['TaskCreated']).toBeUndefined();

    // Valid events should remain (PreToolUse with stale + ours)
    expect(settings.hooks['PreToolUse']).toBeDefined();
  });

  it('preserves non-remi hooks on invalid event names', async () => {
    // If someone has a custom command hook on an unknown event, leave it alone
    writeSettings({
      hooks: {
        CwdChanged: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hello' }] }],
      },
    });

    await manager.install();
    const settings = readSettings() as { hooks: Record<string, unknown[]> };

    // Custom command hook preserved (not remi-style)
    expect(settings.hooks['CwdChanged']).toBeDefined();
  });
});
