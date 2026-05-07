/**
 * Shell PATH resolution for environments where the inherited PATH is minimal
 * (LaunchAgents, systemd user services, Xcode schemes). Extracted from cli.ts.
 *
 * Strategy:
 * 1. Run both login shell (`zsh -l`) and interactive login shell (`zsh -l -i`)
 *    to pick up .zprofile AND .zshrc additions (Homebrew, nvm, ~/.bun/bin).
 * 2. Merge all discovered PATH entries with the inherited entries.
 * 3. Fall back to well-known Homebrew / user-bin directories if no shell run
 *    succeeded.
 * 4. Verify `claude` is findable after resolution; warn if not.
 *
 * `resolveShellPath` mutates `process.env.PATH` in place — same behavior as
 * the original inline version.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { errorToString } from '@remi/shared';

/** Logger shape the resolver needs. Accepts anything compatible with console.log. */
export interface ShellPathLogger {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Resolve the user's full PATH by probing their login shell and merging
 * well-known directories. Mutates `process.env.PATH`.
 *
 * Never throws — shell spawn failures and missing `which` are logged but
 * swallowed; PATH resolution is best-effort.
 */
export function resolveShellPath(logger: ShellPathLogger): void {
  const shell = process.env['SHELL'] || '/bin/zsh';
  const currentEntries = (process.env['PATH'] || '').split(':').filter(Boolean);
  const allEntries = new Set(currentEntries);

  // Run both shells and merge all discovered PATH entries.
  // Login shell sources .zprofile; interactive login shell also sources .zshrc.
  const attempts: Array<{ flags: string[]; label: string }> = [
    { flags: ['-l', '-c', 'echo $PATH'], label: 'login' },
    { flags: ['-l', '-i', '-c', 'echo $PATH'], label: 'interactive login' },
  ];

  let anyShellSucceeded = false;
  for (const { flags, label } of attempts) {
    try {
      const result = Bun.spawnSync([shell, ...flags], {
        env: process.env,
        timeout: 5000,
      });
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.toString().trim() || '(no stderr)';
        logger.log(`[PATH] ${label} shell exited with code ${result.exitCode}: ${stderr}`);
        continue;
      }
      const shellPath = result.stdout?.toString().trim();
      if (!shellPath) {
        logger.log(`[PATH] ${label} shell returned empty PATH`);
        continue;
      }

      anyShellSucceeded = true;
      for (const entry of shellPath.split(':')) {
        if (entry) allEntries.add(entry);
      }
    } catch (err) {
      logger.error(`[PATH] ${label} shell failed: ${errorToString(err)}`);
    }
  }

  // Fallback: merge well-known directories if no shell succeeded
  if (!anyShellSucceeded) {
    const home = os.homedir();
    const wellKnownDirs = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      `${home}/.bun/bin`,
      `${home}/.local/bin`,
      '/usr/local/bin',
    ];
    for (const d of wellKnownDirs) {
      if (!allEntries.has(d) && fs.existsSync(d)) allEntries.add(d);
    }
    logger.log('[PATH] Shell resolution failed, merged well-known directories');
  }

  const merged = [...allEntries].join(':');
  if (merged !== (process.env['PATH'] || '')) {
    process.env['PATH'] = merged;
    logger.log(`[PATH] Resolved ${allEntries.size} entries (was ${currentEntries.length})`);
  }

  // Verify claude is findable after PATH resolution
  try {
    const which = Bun.spawnSync(['which', 'claude'], { env: process.env, timeout: 2000 });
    if (which.exitCode !== 0) {
      logger.error(
        '[PATH] WARNING: "claude" not found in PATH after resolution. ' +
          'Session creation will fail. Ensure claude is installed and in PATH.',
      );
    }
  } catch {
    // which command itself failed; non-fatal
  }
}
