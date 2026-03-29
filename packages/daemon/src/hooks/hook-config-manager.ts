/**
 * Manages Claude Code hook configuration for Remi.
 *
 * Before spawning Claude Code, writes HTTP hook entries to
 * .claude/settings.local.json (project-scoped, gitignored).
 * On cleanup, removes only Remi's hook entries.
 *
 * Important: Claude Code snapshots hooks at startup, so config
 * must be written BEFORE spawning the process.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { HOOK_EVENT_NAMES } from './hook-types.ts';

interface HookEntry {
  type: 'http';
  url: string;
  timeout: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

export class HookConfigManager {
  private readonly settingsPath: string;
  private readonly hookUrl: string;
  private hasWritten = false;

  constructor(projectDir: string, hookServerUrl: string) {
    this.settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
    this.hookUrl = hookServerUrl;
  }

  /**
   * Write Remi hook configuration into Claude settings.
   * Purges stale hooks from dead daemons first, then adds ours.
   */
  async install(): Promise<void> {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Purge stale hooks from dead daemons before adding ours
    await this.purgeStaleHooks();

    const settings = this.readSettings();
    if (!settings.hooks) {
      settings.hooks = {};
    }

    const remiHookEntry: HookEntry = {
      type: 'http',
      url: this.hookUrl,
      timeout: 5,
    };

    for (const event of HOOK_EVENT_NAMES) {
      if (!settings.hooks[event]) {
        settings.hooks[event] = [];
      }

      const matchers = settings.hooks[event];
      const alreadyInstalled = matchers.some((m) =>
        m.hooks.some((h) => h.type === 'http' && h.url === this.hookUrl),
      );

      if (!alreadyInstalled) {
        matchers.push({ hooks: [{ ...remiHookEntry }] });
      }
    }

    this.writeSettings(settings);
    this.hasWritten = true;
  }

  /**
   * Remove Remi hook entries from Claude settings.
   * Preserves all user-configured hooks.
   */
  uninstall(): void {
    if (!this.hasWritten || !fs.existsSync(this.settingsPath)) return;

    const settings = this.readSettings();
    if (!settings.hooks) return;

    let modified = false;
    const hooks = settings.hooks;
    for (const event of Object.keys(hooks)) {
      const matchers = hooks[event];
      if (!matchers) continue;
      const filtered = matchers.filter(
        (m) => !m.hooks.some((h) => h.type === 'http' && h.url === this.hookUrl),
      );
      if (filtered.length !== matchers.length) {
        hooks[event] = filtered;
        modified = true;
      }
    }

    // Clean up empty event arrays
    for (const event of Object.keys(hooks)) {
      if (hooks[event]?.length === 0) {
        Reflect.deleteProperty(hooks, event);
      }
    }

    // Remove hooks key if empty
    let hooksEmpty = false;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      hooksEmpty = true;
    }

    if (modified) {
      // Build clean settings without empty hooks
      const cleanSettings: ClaudeSettings = {};
      for (const [key, value] of Object.entries(settings)) {
        if (key === 'hooks' && hooksEmpty) continue;
        cleanSettings[key] = value;
      }

      if (Object.keys(cleanSettings).length === 0) {
        // Settings file is empty; remove it
        try {
          fs.unlinkSync(this.settingsPath);
        } catch (err) {
          console.error(
            `Warning: failed to remove ${this.settingsPath}; stale hooks may remain: ${err}`,
          );
        }
      } else {
        this.writeSettings(cleanSettings);
      }
    }
  }

  /** Check if Remi hooks are currently installed */
  isInstalled(): boolean {
    if (!fs.existsSync(this.settingsPath)) return false;

    const settings = this.readSettings();
    if (!settings.hooks) return false;

    return HOOK_EVENT_NAMES.every((event) => {
      const matchers = settings.hooks?.[event];
      return matchers?.some((m) =>
        m.hooks.some((h) => h.type === 'http' && h.url === this.hookUrl),
      );
    });
  }

  /**
   * Remove hook entries whose HTTP servers are no longer reachable.
   * Probes each localhost HTTP hook URL with a TCP connect.
   * Only removes localhost HTTP hooks (the kind Remi installs).
   */
  private async purgeStaleHooks(): Promise<void> {
    if (!fs.existsSync(this.settingsPath)) return;

    const settings = this.readSettings();
    if (!settings.hooks) return;

    // Collect all unique localhost HTTP hook URLs (excluding our own)
    const localhostUrls = new Set<string>();
    for (const matchers of Object.values(settings.hooks)) {
      if (!matchers) continue;
      for (const m of matchers) {
        for (const h of m.hooks) {
          if (h.type !== 'http') continue;
          if (h.url === this.hookUrl) continue;
          try {
            const parsed = new URL(h.url);
            if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
              localhostUrls.add(h.url);
            }
          } catch {
            // Skip malformed URLs
          }
        }
      }
    }

    if (localhostUrls.size === 0) return;

    // Probe all URLs in parallel
    const probeResults = await Promise.all(
      [...localhostUrls].map(async (url) => {
        const parsed = new URL(url);
        const port = Number.parseInt(parsed.port, 10);
        if (!port) return { url, alive: true }; // Skip if no port
        const alive = await isPortReachable(port);
        return { url, alive };
      }),
    );

    const deadUrls = new Set(probeResults.filter((r) => !r.alive).map((r) => r.url));
    if (deadUrls.size === 0) return;

    // Remove dead hook entries
    let modified = false;
    for (const event of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[event];
      if (!matchers) continue;
      const filtered = matchers.filter(
        (m) => !m.hooks.some((h) => h.type === 'http' && deadUrls.has(h.url)),
      );
      if (filtered.length !== matchers.length) {
        settings.hooks[event] = filtered;
        modified = true;
      }
    }

    if (modified) {
      // Clean up empty event arrays
      for (const event of Object.keys(settings.hooks)) {
        if (settings.hooks[event]?.length === 0) {
          Reflect.deleteProperty(settings.hooks, event);
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        Reflect.deleteProperty(settings, 'hooks');
      }
      this.writeSettings(settings);
    }
  }

  private readSettings(): ClaudeSettings {
    let content: string;
    try {
      content = fs.readFileSync(this.settingsPath, 'utf-8');
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return {};
      }
      throw err;
    }

    try {
      return JSON.parse(content) as ClaudeSettings;
    } catch (err) {
      throw new Error(
        `Corrupted settings file at ${this.settingsPath}: ${err}. Fix or remove the file before running Remi.`,
      );
    }
  }

  private writeSettings(settings: ClaudeSettings): void {
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  }
}

/** TCP connect probe with 500ms timeout. */
function isPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}
