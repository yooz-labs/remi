/**
 * Autostart-state detection for the `hub_status` census (#788).
 *
 * The macOS menu-bar app is sandboxed and cannot read `~/Library/LaunchAgents`
 * or `~/.remi` directly, so the hub must self-report whether `remi --install`
 * has been run. This is a cheap fs existence check against the exact artifact
 * `--install` writes (see `launchAgentPath`/`systemdUnitPath` in
 * service-templates.ts, the single source of truth for those paths) — no
 * launchctl/systemctl calls, just a stat.
 *
 * Pure function of (platform, home) so it is testable against a temp
 * directory standing in for HOME, without touching the real filesystem
 * outside the sandbox the test runs in.
 */

import fs from 'node:fs';
import type { HubAutostartState } from '@remi/shared';
import { launchAgentPath, systemdUnitPath } from './service-templates.ts';

/**
 * `'installed'` when the login-service artifact `remi --install` writes is
 * present, `'none'` otherwise (never installed, removed via `--uninstall`,
 * or a platform `--install` refuses to run on — there is no artifact that
 * could exist there).
 */
export function detectAutostartState(platform: NodeJS.Platform, home: string): HubAutostartState {
  switch (platform) {
    case 'darwin':
      return fs.existsSync(launchAgentPath(home)) ? 'installed' : 'none';
    case 'linux':
      return fs.existsSync(systemdUnitPath(home)) ? 'installed' : 'none';
    default:
      return 'none';
  }
}
