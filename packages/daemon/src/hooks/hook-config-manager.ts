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
import { errorToString } from '@remi/shared';
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
   * Purges stale hooks from dead daemons and removes invalid event
   * names first, then merges ours alongside any existing user hooks
   * without overwriting them.
   */
  async install(): Promise<void> {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      await this.purgeStaleHooks();
    } catch (err) {
      console.warn(`Failed to purge stale hooks: ${errorToString(err)}. Continuing with install.`);
    }

    try {
      this.purgeInvalidEventNames();
    } catch (err) {
      console.warn(
        `Failed to purge invalid event names: ${errorToString(err)}. Continuing with install.`,
      );
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
      const alreadyInstalled = matchers.some(
        (m) =>
          Array.isArray(m.hooks) &&
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

    const modified = this.removeHooksWhere(
      settings,
      (h) => h.type === 'http' && h.url === this.hookUrl,
    );

    if (modified) {
      if (
        Object.keys(settings).length === 0 ||
        (Object.keys(settings).length === 1 && !settings.hooks)
      ) {
        // Settings effectively empty after removing hooks
        const remaining = { ...settings };
        Reflect.deleteProperty(remaining, 'hooks');
        if (Object.keys(remaining).length === 0) {
          try {
            fs.unlinkSync(this.settingsPath);
          } catch (err) {
            console.error(
              `Warning: failed to remove ${this.settingsPath}; stale hooks may remain: ${err}`,
            );
          }
          return;
        }
      }
      this.writeSettings(settings);
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
   * Only probes localhost HTTP hooks; non-localhost or non-HTTP hooks are never touched.
   */
  private async purgeStaleHooks(): Promise<void> {
    if (!fs.existsSync(this.settingsPath)) return;

    const settings = this.readSettings();
    if (!settings.hooks) return;

    // Collect all unique localhost HTTP hook URLs with their ports (excluding our own)
    const localhostHooks = new Map<string, number>();
    for (const matchers of Object.values(settings.hooks)) {
      if (!matchers) continue;
      for (const m of matchers) {
        if (!Array.isArray(m.hooks)) continue;
        for (const h of m.hooks) {
          if (h.type !== 'http') continue;
          if (h.url === this.hookUrl) continue;
          try {
            const parsed = new URL(h.url);
            if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
              const port = Number(parsed.port);
              if (port) localhostHooks.set(h.url, port);
            }
          } catch {
            // Malformed URL; leave it alone (not our concern)
          }
        }
      }
    }

    if (localhostHooks.size === 0) return;

    // Probe all URLs in parallel
    const probeResults = await Promise.all(
      [...localhostHooks.entries()].map(async ([url, port]) => {
        const alive = await isPortReachable(port);
        return { url, alive };
      }),
    );

    const deadUrls = new Set(probeResults.filter((r) => !r.alive).map((r) => r.url));
    if (deadUrls.size === 0) return;

    const modified = this.removeHooksWhere(
      settings,
      (h) => h.type === 'http' && deadUrls.has(h.url),
    );
    if (modified) {
      this.writeSettings(settings);
    }
  }

  /**
   * Remove hook event keys that Claude Code no longer recognizes.
   * Claude Code rejects the entire settings file if any hook key is
   * invalid, so stale event names from older remi versions break
   * all hooks. This method removes any event name not in the current
   * HOOK_EVENT_NAMES list (only removes entries that look like remi's
   * HTTP hooks, not user-configured hooks with matchers or other types).
   */
  private purgeInvalidEventNames(): void {
    if (!fs.existsSync(this.settingsPath)) return;

    const settings = this.readSettings();
    if (!settings.hooks) return;

    const validNames = new Set<string>(HOOK_EVENT_NAMES);
    let modified = false;

    for (const event of Object.keys(settings.hooks)) {
      if (validNames.has(event)) continue;

      // Only remove if all matchers in this event are remi-style HTTP hooks
      // (no matcher field, single http hook pointing to localhost).
      // This avoids removing user-configured hooks for custom events.
      const matchers = settings.hooks[event];
      if (!matchers || matchers.length === 0) {
        Reflect.deleteProperty(settings.hooks, event);
        modified = true;
        continue;
      }

      const allRemiStyle = matchers.every((m) => {
        const h = Array.isArray(m.hooks) && m.hooks.length === 1 ? m.hooks[0] : undefined;
        return (
          !m.matcher &&
          h !== undefined &&
          h.type === 'http' &&
          (h.url.startsWith('http://127.0.0.1') || h.url.startsWith('http://localhost'))
        );
      });

      if (allRemiStyle) {
        Reflect.deleteProperty(settings.hooks, event);
        modified = true;
      }
    }

    if (modified) {
      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        Reflect.deleteProperty(settings, 'hooks');
      }
      this.writeSettings(settings);
    }
  }

  /**
   * Remove hook matchers where any hook entry matches the predicate.
   * Cleans up empty event arrays and the hooks key itself.
   * Returns true if any matchers were removed.
   */
  private removeHooksWhere(
    settings: ClaudeSettings,
    predicate: (h: HookEntry) => boolean,
  ): boolean {
    if (!settings.hooks) return false;

    let modified = false;
    for (const event of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[event];
      if (!matchers) continue;
      const filtered = matchers.filter((m) => !Array.isArray(m.hooks) || !m.hooks.some(predicate));
      if (filtered.length !== matchers.length) {
        settings.hooks[event] = filtered;
        modified = true;
      }
    }

    if (modified) {
      for (const event of Object.keys(settings.hooks)) {
        if (settings.hooks[event]?.length === 0) {
          Reflect.deleteProperty(settings.hooks, event);
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        Reflect.deleteProperty(settings, 'hooks');
      }
    }

    return modified;
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

/** TCP connect probe; resolves false on connection failure or timeout. */
function isPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    function done(reachable: boolean): void {
      socket.destroy();
      resolve(reachable);
    }
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}
