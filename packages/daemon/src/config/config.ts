/**
 * Config file system for Remi.
 *
 * Reads ~/.remi/config.toml and provides merged configuration with
 * priority: CLI flags > env vars > config file > built-in defaults.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';

const REMI_DIR = path.join(os.homedir(), '.remi');
export const CONFIG_PATH = path.join(REMI_DIR, 'config.toml');

/** Daemon settings (restart required to apply changes) */
export interface DaemonConfig {
  readonly base_port: number;
  readonly port_range: number;
  readonly bind: string;
  readonly orphan_timeout: number;
}

/** Network settings */
export interface NetworkConfig {
  readonly mdns: boolean;
  readonly relay: boolean;
  readonly signaling_url: string;
}

/** Authentication settings (restart required) */
export interface AuthConfig {
  /** "auto" = based on bind address, true = always, false = never */
  readonly enabled: 'auto' | boolean;
}

/** Display settings */
export interface DisplayConfig {
  readonly max_bullet_length: number;
}

/** Telegram settings */
export interface TelegramConfig {
  readonly enabled: boolean;
  readonly bot_token: string;
  readonly authorized_chat_ids: readonly number[];
  readonly authorized_user_ids: readonly number[];
}

/** Complete Remi configuration */
export interface RemiConfig {
  readonly daemon: DaemonConfig;
  readonly network: NetworkConfig;
  readonly auth: AuthConfig;
  readonly display: DisplayConfig;
  readonly telegram: TelegramConfig;
}

/** Built-in defaults used when no config file or CLI flags are provided */
export const DEFAULT_CONFIG: RemiConfig = {
  daemon: {
    base_port: 18765,
    port_range: 20,
    bind: '0.0.0.0',
    orphan_timeout: 300,
  },
  network: {
    mdns: true,
    relay: true,
    signaling_url: 'wss://remi-signaling.yooz.workers.dev/connect',
  },
  auth: {
    enabled: 'auto',
  },
  display: {
    max_bullet_length: 500,
  },
  telegram: {
    enabled: false,
    bot_token: '',
    authorized_chat_ids: [],
    authorized_user_ids: [],
  },
};

/**
 * Deep merge a partial config into a base config.
 * Only applies values that are present in the partial; preserves defaults for the rest.
 */
function deepMerge(base: RemiConfig, partial: Record<string, unknown>): RemiConfig {
  // biome-ignore lint/suspicious/noExplicitAny: generic merge utility
  function mergeSection(defaults: any, overrides: Record<string, unknown> | undefined): any {
    if (!overrides) return defaults;
    const result = { ...defaults };
    for (const key of Object.keys(defaults)) {
      if (key in overrides) {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  return {
    daemon: mergeSection(base.daemon, partial['daemon'] as Record<string, unknown> | undefined),
    network: mergeSection(base.network, partial['network'] as Record<string, unknown> | undefined),
    auth: mergeSection(base.auth, partial['auth'] as Record<string, unknown> | undefined),
    display: mergeSection(base.display, partial['display'] as Record<string, unknown> | undefined),
    telegram: mergeSection(
      base.telegram,
      partial['telegram'] as Record<string, unknown> | undefined,
    ),
  };
}

/**
 * Load config from ~/.remi/config.toml, merged with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 * Logs a warning if the file exists but is invalid.
 */
export function loadConfig(configPath: string = CONFIG_PATH): RemiConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return deepMerge(DEFAULT_CONFIG, {});
    }
    console.error(
      `[config] Cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return deepMerge(DEFAULT_CONFIG, {});
  }

  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch (err) {
    console.error(
      `[config] Invalid TOML in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return deepMerge(DEFAULT_CONFIG, {});
  }
}

/**
 * Apply environment variable overrides to a config.
 * Env vars take precedence over config file values.
 */
export function applyEnvOverrides(config: RemiConfig): RemiConfig {
  const env = process.env;

  const daemon = { ...config.daemon };
  const network = { ...config.network };
  const display = { ...config.display };
  const telegram = { ...config.telegram };

  // REMI_PORT overrides base_port
  if (env['REMI_PORT']) {
    const port = Number.parseInt(env['REMI_PORT'], 10);
    if (!Number.isNaN(port) && port > 0) {
      (daemon as { base_port: number }).base_port = port;
    }
  }

  // REMI_MAX_BULLET_LENGTH overrides max_bullet_length
  if (env['REMI_MAX_BULLET_LENGTH']) {
    const len = Number.parseInt(env['REMI_MAX_BULLET_LENGTH'], 10);
    if (!Number.isNaN(len) && len >= 0) {
      (display as { max_bullet_length: number }).max_bullet_length = len;
    }
  }

  // Telegram env vars
  if (env['TELEGRAM_BOT_TOKEN']) {
    (telegram as { bot_token: string }).bot_token = env['TELEGRAM_BOT_TOKEN'];
    // Having a token implies enabled, unless explicitly disabled
    if (env['TELEGRAM_ENABLED'] !== 'false') {
      (telegram as { enabled: boolean }).enabled = true;
    }
  }
  if (env['TELEGRAM_ENABLED'] === 'false') {
    (telegram as { enabled: boolean }).enabled = false;
  }
  if (env['TELEGRAM_AUTHORIZED_CHAT_IDS']) {
    // biome-ignore lint/suspicious/noExplicitAny: overriding readonly property
    (telegram as any).authorized_chat_ids = env['TELEGRAM_AUTHORIZED_CHAT_IDS']
      .split(',')
      .map(Number)
      .filter((n) => !Number.isNaN(n));
  }
  if (env['TELEGRAM_AUTHORIZED_USER_IDS']) {
    // biome-ignore lint/suspicious/noExplicitAny: overriding readonly property
    (telegram as any).authorized_user_ids = env['TELEGRAM_AUTHORIZED_USER_IDS']
      .split(',')
      .map(Number)
      .filter((n) => !Number.isNaN(n));
  }

  return {
    ...config,
    daemon,
    network,
    display,
    telegram,
  };
}

/**
 * Generate the default config file content as TOML.
 */
export function generateDefaultConfig(): string {
  return `# Remi configuration
# Priority: CLI flags > environment variables > this file > built-in defaults
# Run 'remi reload' to apply changes to a running daemon (hot-reloadable settings only).

[daemon]
base_port = ${DEFAULT_CONFIG.daemon.base_port}
port_range = ${DEFAULT_CONFIG.daemon.port_range}
bind = "${DEFAULT_CONFIG.daemon.bind}"
orphan_timeout = ${DEFAULT_CONFIG.daemon.orphan_timeout}  # seconds

[network]
mdns = ${DEFAULT_CONFIG.network.mdns}
relay = ${DEFAULT_CONFIG.network.relay}
signaling_url = "${DEFAULT_CONFIG.network.signaling_url}"

[auth]
enabled = "${DEFAULT_CONFIG.auth.enabled}"  # "auto" | true | false

[display]
max_bullet_length = ${DEFAULT_CONFIG.display.max_bullet_length}  # 0 = disabled

[telegram]
enabled = ${DEFAULT_CONFIG.telegram.enabled}
bot_token = ""
authorized_chat_ids = []
authorized_user_ids = []
`;
}

/**
 * Write the default config file to disk.
 * Returns the path written to.
 */
export function initConfigFile(configPath: string = CONFIG_PATH): string {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  try {
    fs.writeFileSync(configPath, generateDefaultConfig(), { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Config file already exists: ${configPath}`);
    }
    throw err;
  }
  return configPath;
}

/**
 * Format a RemiConfig as a readable string for display.
 */
export function formatConfig(config: RemiConfig, configPath: string = CONFIG_PATH): string {
  const fileExists = fs.existsSync(configPath);
  const lines: string[] = [];

  lines.push(`Config file: ${configPath} (${fileExists ? 'loaded' : 'not found, using defaults'})`);
  lines.push('');
  lines.push('[daemon]');
  lines.push(`  base_port = ${config.daemon.base_port}`);
  lines.push(`  port_range = ${config.daemon.port_range}`);
  lines.push(`  bind = "${config.daemon.bind}"`);
  lines.push(`  orphan_timeout = ${config.daemon.orphan_timeout}`);
  lines.push('');
  lines.push('[network]');
  lines.push(`  mdns = ${config.network.mdns}`);
  lines.push(`  relay = ${config.network.relay}`);
  lines.push(`  signaling_url = "${config.network.signaling_url}"`);
  lines.push('');
  lines.push('[auth]');
  lines.push(`  enabled = "${config.auth.enabled}"`);
  lines.push('');
  lines.push('[display]');
  lines.push(`  max_bullet_length = ${config.display.max_bullet_length}`);
  lines.push('');
  lines.push('[telegram]');
  lines.push(`  enabled = ${config.telegram.enabled}`);
  lines.push(`  bot_token = "${config.telegram.bot_token ? '***' : ''}"`);
  lines.push(`  authorized_chat_ids = [${config.telegram.authorized_chat_ids.join(', ')}]`);
  lines.push(`  authorized_user_ids = [${config.telegram.authorized_user_ids.join(', ')}]`);

  return lines.join('\n');
}
