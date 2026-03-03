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

/** Marker in the URL that identifies Remi-managed hooks */
const REMI_HOOK_URL_MARKER = '/hooks';

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
   * Merges with existing user hooks; does not overwrite them.
   */
  install(): void {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

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
        (m) =>
          !m.hooks.some(
            (h) =>
              h.type === 'http' && h.url === this.hookUrl && h.url.includes(REMI_HOOK_URL_MARKER),
          ),
      );
      if (filtered.length !== matchers.length) {
        hooks[event] = filtered;
        modified = true;
      }
    }

    // Clean up empty event arrays
    for (const event of Object.keys(hooks)) {
      if (hooks[event]?.length === 0) {
        delete hooks[event];
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
        } catch {
          // ignore
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

  private readSettings(): ClaudeSettings {
    if (!fs.existsSync(this.settingsPath)) return {};

    try {
      const content = fs.readFileSync(this.settingsPath, 'utf-8');
      return JSON.parse(content) as ClaudeSettings;
    } catch {
      return {};
    }
  }

  private writeSettings(settings: ClaudeSettings): void {
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  }
}
