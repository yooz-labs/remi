/**
 * Handler for the `remi config [init|path|show]` subcommand.
 *
 * - `remi config` or `remi config show`: print the active, merged config
 * - `remi config init`: create `~/.remi/config.toml` if absent
 * - `remi config path`: print the config file path
 *
 * Returns a process exit code; the caller is responsible for `process.exit`.
 */

import { errorToString } from '@remi/shared';
import type { RemiConfig } from '../config/index.ts';
import { CONFIG_PATH, formatConfig, initConfigFile } from '../config/index.ts';

export interface ConfigCommandIO {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

const defaultIO: ConfigCommandIO = {
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
};

/** Optional path overrides; exposed for tests to avoid touching ~/.remi/config.toml. */
export interface ConfigCommandPaths {
  /** Path for `config init` / `config path`. Defaults to `CONFIG_PATH`. */
  readonly configPath?: string;
}

/**
 * Run `remi config` with a resolved config.
 *
 * @param configArg - the argument after `config` (undefined, 'init', 'path', 'show')
 * @param remiConfig - the already-loaded, already-env-overridden config object
 * @param io - IO for tests; defaults to console
 * @param paths - path overrides for tests; defaults to production CONFIG_PATH
 * @returns exit code (0 on success, 1 on error)
 */
export function runConfigCommand(
  configArg: string | undefined,
  remiConfig: RemiConfig,
  io: ConfigCommandIO = defaultIO,
  paths: ConfigCommandPaths = {},
): number {
  const configPath = paths.configPath ?? CONFIG_PATH;
  if (configArg === 'init') {
    try {
      const created = initConfigFile(configPath);
      io.out(`Config file created: ${created}`);
      return 0;
    } catch (err) {
      io.err(errorToString(err));
      return 1;
    }
  }
  if (configArg === 'path') {
    io.out(configPath);
    return 0;
  }
  io.out(formatConfig(remiConfig));
  return 0;
}
