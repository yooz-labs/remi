/**
 * The remi state directory: every file remi writes about itself (config,
 * sessions, live-sessions, logs, status files, device tokens, keys, the
 * statusline script, diagnostic traces) lives under this one directory.
 *
 * `REMI_HOME` (an absolute path) relocates the whole directory; unset or
 * empty means `~/.remi`. It exists so a live check of remi can run against a
 * scratch directory instead of the owner's real state (#1126: an earlier
 * spike left stale `sessions.json` entries in `~/.remi`). Every builder of a
 * state path routes through `remiHome()`, so one variable moves all of them;
 * a module that joined `os.homedir()` and `.remi` itself would quietly write
 * into the real directory under a scratch `REMI_HOME`.
 *
 * A relative `REMI_HOME` is refused rather than resolved: the hub and the
 * session daemons it spawns may run from different working directories, so a
 * relative path would split one remi's state across several places.
 *
 * What it does not move: `remi --install` writes a LaunchAgent / systemd unit
 * whose log paths and process environment are the default `~/.remi`, because
 * the service starts outside the shell that set the variable. So `--install`
 * and `--uninstall` refuse to run under an override
 * (`serviceCommandRefusal`) rather than act on a state directory the caller
 * did not mean. Claude Code's
 * own files (`~/.claude`, project `.claude/settings.local.json`) are not
 * remi state and are not moved either.
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** The environment variable that relocates the state directory. */
export const REMI_HOME_ENV = 'REMI_HOME';

/**
 * The state directory: `REMI_HOME` when set (must be absolute), else
 * `<home>/.remi`. Throws on a relative `REMI_HOME`. `env` and `home` are
 * parameters for tests; production callers pass neither.
 */
export function remiHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = os.homedir(),
): string {
  const raw = env[REMI_HOME_ENV];
  if (raw === undefined || raw === '') return path.join(home, '.remi');
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `${REMI_HOME_ENV} must be an absolute path, got "${raw}". Unset it to use ~/.remi.`,
    );
  }
  return path.normalize(raw);
}

/**
 * The one-line refusal for `remi --install` / `--uninstall` under a
 * `REMI_HOME` override (#1126 review), or null when the command may run. The
 * service always uses `~/.remi`, so installing it from a shell that relocated
 * the state would split remi's state between two directories.
 */
export function serviceCommandRefusal(
  flag: '--install' | '--uninstall',
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!isRemiHomeOverridden(env)) return null;
  return `remi ${flag} does not run with ${REMI_HOME_ENV} set: the service always uses ~/.remi. Unset ${REMI_HOME_ENV} and run it again.`;
}

/** True when `REMI_HOME` relocates the state directory away from `~/.remi`. */
export function isRemiHomeOverridden(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[REMI_HOME_ENV];
  return raw !== undefined && raw !== '';
}
