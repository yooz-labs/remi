/**
 * User-facing notices for the auto-approve removal (#1125, ADR 0030).
 *
 * remi used to judge permissions itself, with a local model (served by the
 * Yooz engine or `llama-server`) and a rule layer configured under
 * `[auto_approve]`. Both were deleted; the harness's own permission settings
 * decide now and remi only relays what is still asked. These strings are
 * what a user with an old config, an old script or an old habit sees.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { remiHome } from '../config/remi-home.ts';

/** Printed (to stderr) by `remi model`, which then exits 2. One line. */
export const MODEL_COMMAND_REMOVED_MESSAGE =
  'remi model was removed: remi no longer runs a local model to judge permissions; Claude Code decides them now (run `remi migrate-permissions` to carry your allow/deny rules over).';

/** How to move a legacy `auto_approve.subagent_alert` that is still honored.
 *  Shared by the boot notice and `remi migrate-permissions`. */
export const SUBAGENT_ALERT_MOVE_HINT =
  'auto_approve.subagent_alert is deprecated and still honored for now: move it to [notifications] subagent_alert in config.toml (it is a remi notification setting, not a Claude Code permission).';

/** Prefix of every removed `REMI_AUTO_APPROVE*` environment variable. */
const REMOVED_ENV_PREFIX = 'REMI_AUTO_APPROVE';

/** Removed `REMI_AUTO_APPROVE*` variables set in `env`, sorted. */
export function removedAutoApproveEnvVars(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith(REMOVED_ENV_PREFIX) && env[k] !== undefined)
    .sort();
}

/** What the boot notice reports. Every field is a plain fact the caller
 *  gathered; this module only words it. */
export interface RemovedAutoApproveFacts {
  readonly configPath: string;
  /** Keys found under the removed `[auto_approve]` table that are ignored
   *  (a still-honored `subagent_alert` is not among them). */
  readonly removedConfigKeys: readonly string[];
  /** The legacy `auto_approve.subagent_alert` list is in use. */
  readonly subagentAlertFromLegacy: boolean;
  /** Removed `--auto-approve*` flags given on the command line. */
  readonly removedFlags: readonly string[];
  /** Removed `REMI_AUTO_APPROVE*` environment variables that are set. */
  readonly removedEnvVars: readonly string[];
  /** `~/.remi/engine` when it exists (the old engine install), else null. */
  readonly engineDir: string | null;
  /** `~/.remi/engine.pid` when it exists (an engine an older remi may have
   *  left running), else null. */
  readonly enginePidFile: string | null;
}

/** Where an older remi installed and tracked the local model engine, inside
 *  the state directory (`remiHome()`, `~/.remi` by default). */
export function legacyEnginePaths(stateDir: string = remiHome()): {
  engineDir: string | null;
  enginePidFile: string | null;
} {
  const dir = path.join(stateDir, 'engine');
  const pid = path.join(stateDir, 'engine.pid');
  return {
    engineDir: fs.existsSync(dir) ? dir : null,
    enginePidFile: fs.existsSync(pid) ? pid : null,
  };
}

/**
 * The one-time boot notice, as lines; empty when nothing removed is in use.
 * Never deletes or stops anything: user files and processes are the user's.
 */
export function removedAutoApproveNotice(f: RemovedAutoApproveFacts): string[] {
  const lines: string[] = [];
  if (f.removedConfigKeys.length > 0) {
    lines.push(
      `[remi] ${f.configPath} still has an [auto_approve] table (${f.removedConfigKeys.join(', ')}). remi no longer judges permissions (ADR 0030); Claude Code decides them, so these settings are ignored. Run \`remi migrate-permissions\` to print your allow/deny rules as Claude Code permissions JSON, then delete the table.`,
    );
  }
  if (f.subagentAlertFromLegacy) {
    lines.push(`[remi] ${SUBAGENT_ALERT_MOVE_HINT}`);
  }
  if (f.removedFlags.length > 0) {
    lines.push(
      `[remi] Ignoring removed flag(s) ${[...new Set(f.removedFlags)].join(', ')}: remi no longer judges permissions.`,
    );
  }
  if (f.removedEnvVars.length > 0) {
    lines.push(`[remi] Ignoring removed environment variable(s) ${f.removedEnvVars.join(', ')}.`);
  }
  if (lines.length > 0 && (f.engineDir !== null || f.enginePidFile !== null)) {
    const parts: string[] = [];
    if (f.engineDir !== null) {
      parts.push(
        `${f.engineDir} (the old local model engine) is no longer used; delete it by hand to reclaim the space`,
      );
    }
    if (f.enginePidFile !== null) {
      parts.push(
        `An engine started by an older remi may still be running (pid in ${f.enginePidFile}); stop it by hand`,
      );
    }
    lines.push(`[remi] ${parts.join('. ')}.`);
  }
  return lines;
}

/**
 * The boot notice for one invocation. The full notice is for the commands
 * that boot a daemon or show the config (the session daemon or wrapper,
 * `remi serve`, `remi config`); `remi start` only launches the hub, which
 * prints the full notice into its own log, so it reports just the removed
 * flags the user typed. A session daemon the hub spawned
 * (`REMI_SPAWNED_CHILD=1`) prints nothing: the hub already did.
 */
export function bootNoticeLines(
  subcommand: string | undefined,
  facts: RemovedAutoApproveFacts,
  env: NodeJS.ProcessEnv,
): string[] {
  if (env['REMI_SPAWNED_CHILD'] === '1') return [];
  if (subcommand === undefined || subcommand === 'serve' || subcommand === 'config') {
    return removedAutoApproveNotice(facts);
  }
  if (subcommand === 'start') {
    return removedAutoApproveNotice({
      ...facts,
      removedConfigKeys: [],
      subagentAlertFromLegacy: false,
      removedEnvVars: [],
    });
  }
  return [];
}
