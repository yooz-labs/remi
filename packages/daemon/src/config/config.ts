/**
 * Config file system for Remi.
 *
 * Reads ~/.remi/config.toml and provides merged configuration with
 * priority: CLI flags > env vars > config file > built-in defaults.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DAEMON_BASE_PORT, DAEMON_PORT_RANGE, errorToString } from '@remi/shared';
import { parse as parseToml } from 'smol-toml';
import { isKnownGroup, knownGroupNames } from '../auto-approve/permission-groups.ts';
import { DEFAULT_ALWAYS_ESCALATE_TOOLS } from '../auto-approve/types.ts';
import type { AutoApproveConfig } from '../auto-approve/types.ts';

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

/**
 * Terminal cue settings (#513): out-of-band feedback drawn on the wrapper's
 * real terminal during the auto-approve lifecycle. Only fires when auto-approve
 * is enabled (it is driven by the gate). Inert in headless/daemon mode.
 */
export interface TerminalConfig {
  /**
   * Desktop notification fired when auto-approve escalates a permission to the
   * user. 'osc9' (iTerm2/Ghostty), 'osc777' (kitty/wezterm), 'bell', or 'off'.
   */
  readonly notify: 'osc9' | 'osc777' | 'bell' | 'off';
  /**
   * Animate the terminal title during evaluation (spinner -> check / warning).
   * The title bar is the only cue channel that does not fight Claude's renderer.
   */
  readonly status_cue: boolean;
  /**
   * Reserve the wrapper terminal's last row for a persistent remi status bar
   * (#565). remi reports `rows - 1` to Claude so Claude never touches the last
   * row, which remi then owns — visible even while Claude shows a prompt (when
   * the native statusLine cue is hidden). Wrapper mode + a real TTY only;
   * inert otherwise. Default on; set false to keep the full height for Claude.
   */
  readonly status_bar: boolean;
}

/** Telegram settings */
export interface TelegramConfig {
  readonly enabled: boolean;
  readonly bot_token: string;
  readonly authorized_chat_ids: readonly number[];
  readonly authorized_user_ids: readonly number[];
}

/**
 * TranscriptBinder feature flags (epic #453/#499). `transcript_binder_enabled`
 * defaults ON (the binder is the default driver, #503); `transcript_binder_shadow`
 * defaults OFF. Snapshotted into a const at daemon boot and treated as immutable
 * for the process lifetime — never re-read per session (a mid-process flip would
 * split sessions across the old/new code paths, which share the transcriptWatchers
 * map).
 */
export interface FeaturesConfig {
  /** Phase 3: run the TranscriptBinder in compute-only shadow mode alongside the old
   *  path and log decision disagreements. No side effects; observation only. */
  readonly transcript_binder_shadow: boolean;
  /** Phase 3: the TranscriptBinder DRIVES the session-binding/watcher/rotation; the
   *  old initFromHookEvent/onSessionInfo path is skipped. */
  readonly transcript_binder_enabled: boolean;
}

/** Complete Remi configuration */
export interface RemiConfig {
  readonly daemon: DaemonConfig;
  readonly network: NetworkConfig;
  readonly auth: AuthConfig;
  readonly display: DisplayConfig;
  readonly terminal: TerminalConfig;
  readonly telegram: TelegramConfig;
  readonly auto_approve: AutoApproveConfig;
  readonly features: FeaturesConfig;
}

/** Built-in defaults used when no config file or CLI flags are provided */
export const DEFAULT_CONFIG: RemiConfig = {
  daemon: {
    base_port: DAEMON_BASE_PORT,
    port_range: DAEMON_PORT_RANGE,
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
  terminal: {
    // Fires only when auto-approve is enabled and escalates; osc9 reaches
    // iTerm2/Ghostty. The animated title is a subtle in-terminal cue.
    notify: 'osc9',
    status_cue: true,
    // Reserve the last terminal row for an always-visible remi status bar in
    // wrapper mode (#565). Default on; off-able for users who want every row.
    status_bar: true,
  },
  telegram: {
    enabled: false,
    bot_token: '',
    authorized_chat_ids: [],
    authorized_user_ids: [],
  },
  auto_approve: {
    enabled: false,
    provider: 'ollama',
    // Fast small default: with synchronous decisions (#496) the eval blocks
    // Claude, so the default must be quick + RAM-light across platforms (incl.
    // MacBook Air). qwen3.5:4b is benchmarked safe (38/38). Heavier models go in
    // `escalate_model` (second opinion only on would-escalate cases).
    model: 'qwen3.5:4b',
    api_key: '',
    base_url: 'http://localhost:11434/v1',
    timeout: 30,
    log_decisions: true,
    // Safe read-only TOOLS, fast-pathed without an LLM call. These are
    // tool-name matches (not Bash substrings), so a compound command cannot
    // bypass them — `Read` matches the Read tool, never a `Bash` string. Bash
    // git/gh commands are intentionally NOT defaulted here (substring matching
    // is compound-command-unsafe); the LLM prompt evaluates those in full.
    allow: ['Read', 'Glob', 'Grep'],
    deny: [],
    // Built-in read-by-definition groups, fast-pathed without an LLM call
    // using compound-segment-aware matching (epic #494). All three on by
    // default so enabling auto-approve immediately stops paying LLM latency
    // for reads / VCS queries / read-only build+test runs.
    approve_groups: ['read-only', 'vcs-read', 'build-test'],
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    // Second-opinion model on a primary 'escalate' (main context only). Empty =
    // no second opinion. Put a heavy model here (e.g. qwen3.5:35b) to honor a
    // broad approve policy without paying its latency on every permission.
    escalate_model: '',
    // Dedicated timeout (seconds) for the heavy escalate_model. 0 = use
    // `timeout`. Set higher (e.g. 90) when escalate_model is a large, often-cold
    // model so its first-call load penalty does not abort into an error.
    escalate_timeout: 0,
    // Max seconds a permission eval may wait in the serialization queue before
    // escalating (#551). Concurrent evals run one at a time; a deep burst could
    // otherwise wait long enough to risk the ~600s hook budget. 0 = no bound.
    queue_timeout: 240,
    // Keep the model's reasoning ON by default: live testing showed it is
    // load-bearing for following broad user instructions. Opt in (Ollama only)
    // for raw speed over decision nuance.
    disable_thinking: false,
    // Always escalate these to the user; never auto-decided by the LLM (#572):
    // AskUserQuestion + plan-mode. Extend with custom question-posing tools.
    always_escalate_tools: [...DEFAULT_ALWAYS_ESCALATE_TOOLS],
  },
  features: {
    transcript_binder_shadow: false,
    // The TranscriptBinder is now the DEFAULT session-binding driver (epic
    // #499 / #503 step 1). It was shadow- and real-Claude-e2e-validated as
    // equivalent to the old path, and is the single source of truth for the
    // live session. Kept as a flag so `REMI_TRANSCRIPT_BINDER_ENABLED=false`
    // is a kill-switch back to the old path until that path is deleted (#503
    // step 2, after this default soaks). Setting `transcript_binder_shadow`
    // alone no longer yields shadow-only — drive wins; for compare-only set
    // `transcript_binder_enabled=false` too.
    transcript_binder_enabled: true,
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
    terminal: mergeSection(
      base.terminal,
      partial['terminal'] as Record<string, unknown> | undefined,
    ),
    telegram: mergeSection(
      base.telegram,
      partial['telegram'] as Record<string, unknown> | undefined,
    ),
    auto_approve: mergeSection(
      base.auto_approve,
      partial['auto_approve'] as Record<string, unknown> | undefined,
    ),
    features: mergeSection(
      base.features,
      partial['features'] as Record<string, unknown> | undefined,
    ),
  };
}

/**
 * Load config from ~/.remi/config.toml, merged with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 * Returns DEFAULT_CONFIG if no config file exists.
 * Throws if the file exists but cannot be read or has invalid TOML.
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
    throw new Error(
      `Cannot read config file ${configPath}: ${errorToString(err)}. Fix file permissions or remove the file to use defaults.`,
    );
  }

  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    const merged = deepMerge(DEFAULT_CONFIG, parsed);
    validateAutoApprove(merged.auto_approve, configPath);
    validateTerminal(merged.terminal, configPath);
    return merged;
  } catch (err) {
    throw new Error(
      `Invalid TOML in ${configPath}: ${errorToString(err)}. Fix the syntax or delete the file to use defaults.`,
    );
  }
}

/**
 * Validate auto_approve config has correct runtime types.
 *
 * TOML doesn't enforce TypeScript types. A user writing `allow = "git"` (string
 * instead of string[]) would produce a runtime value that matchPattern would
 * iterate character-by-character, auto-approving almost every command. This
 * validator refuses to start with such misconfigurations.
 *
 * Also warns about dangerously short patterns that would match too broadly.
 */
function validateAutoApprove(cfg: AutoApproveConfig, configPath: string): void {
  const isStringArray = (v: unknown): v is readonly string[] =>
    Array.isArray(v) && v.every((s) => typeof s === 'string');

  const expectBool = (key: string, v: unknown): void => {
    if (typeof v !== 'boolean') {
      throw new Error(
        `Invalid auto_approve.${key} in ${configPath}: must be a boolean (true/false), got ${typeof v === 'string' ? `string "${v}"` : typeof v}. Example: ${key} = ${key === 'enabled' ? 'true' : 'false'}`,
      );
    }
  };
  const expectString = (key: string, v: unknown): void => {
    if (typeof v !== 'string') {
      throw new Error(
        `Invalid auto_approve.${key} in ${configPath}: must be a string, got ${typeof v}.`,
      );
    }
  };

  expectBool('enabled', cfg.enabled);
  expectBool('log_decisions', cfg.log_decisions);
  expectBool('disable_thinking', cfg.disable_thinking);
  expectString('provider', cfg.provider);
  expectString('model', cfg.model);
  expectString('api_key', cfg.api_key);
  expectString('base_url', cfg.base_url);

  if (typeof cfg.timeout !== 'number' || !Number.isFinite(cfg.timeout) || cfg.timeout <= 0) {
    throw new Error(
      `Invalid auto_approve.timeout in ${configPath}: must be a positive number (seconds), got ${typeof cfg.timeout === 'string' ? `string "${cfg.timeout}"` : typeof cfg.timeout}. Example: timeout = 10`,
    );
  }

  if (
    typeof cfg.escalate_timeout !== 'number' ||
    !Number.isFinite(cfg.escalate_timeout) ||
    cfg.escalate_timeout < 0
  ) {
    throw new Error(
      `Invalid auto_approve.escalate_timeout in ${configPath}: must be a non-negative number (seconds; 0 = use timeout), got ${typeof cfg.escalate_timeout === 'string' ? `string "${cfg.escalate_timeout}"` : typeof cfg.escalate_timeout}. Example: escalate_timeout = 90`,
    );
  }

  if (
    typeof cfg.queue_timeout !== 'number' ||
    !Number.isFinite(cfg.queue_timeout) ||
    cfg.queue_timeout < 0
  ) {
    throw new Error(
      `Invalid auto_approve.queue_timeout in ${configPath}: must be a non-negative number (seconds; 0 = no bound), got ${typeof cfg.queue_timeout === 'string' ? `string "${cfg.queue_timeout}"` : typeof cfg.queue_timeout}. Example: queue_timeout = 240`,
    );
  }

  if (!isStringArray(cfg.allow)) {
    throw new Error(
      `Invalid auto_approve.allow in ${configPath}: must be an array of strings. Example: allow = ["git status", "bun test"]`,
    );
  }
  if (!isStringArray(cfg.deny)) {
    throw new Error(
      `Invalid auto_approve.deny in ${configPath}: must be an array of strings. Example: deny = ["rm -rf /", "sudo "]`,
    );
  }
  if (!isStringArray(cfg.approve_groups)) {
    throw new Error(
      `Invalid auto_approve.approve_groups in ${configPath}: must be an array of group names. Known groups: ${knownGroupNames().join(', ')}. Example: approve_groups = ["read-only", "vcs-read"]`,
    );
  }
  if (!isStringArray(cfg.deny_groups)) {
    throw new Error(
      `Invalid auto_approve.deny_groups in ${configPath}: must be an array of group names. Known groups: ${knownGroupNames().join(', ')}.`,
    );
  }
  for (const g of [...cfg.approve_groups, ...cfg.deny_groups]) {
    if (!isKnownGroup(g)) {
      console.warn(
        `[AutoApprove] Warning: unknown permission group "${g}" in ${configPath}; ignored. Known groups: ${knownGroupNames().join(', ')}.`,
      );
    }
  }
  if (typeof cfg.instructions !== 'string') {
    throw new Error(
      `Invalid auto_approve.instructions in ${configPath}: must be a string (use triple-quoted """ for multiline).`,
    );
  }

  if (cfg.multichoice !== 'skip' && cfg.multichoice !== 'evaluate') {
    throw new Error(
      `Invalid auto_approve.multichoice in ${configPath}: must be "skip" or "evaluate", got ${typeof cfg.multichoice === 'string' ? `"${cfg.multichoice}"` : typeof cfg.multichoice}.`,
    );
  }
  expectString('multichoice_model', cfg.multichoice_model);
  expectString('escalate_model', cfg.escalate_model);
  if (!isStringArray(cfg.always_escalate_tools)) {
    throw new Error(
      `Invalid auto_approve.always_escalate_tools in ${configPath}: must be an array of tool names. Example: always_escalate_tools = ["AskUserQuestion", "ExitPlanMode"]`,
    );
  }

  // Warn about dangerously short patterns that would match too broadly.
  const MIN_PATTERN_LENGTH = 2;
  for (const p of cfg.allow) {
    if (p.trim().length < MIN_PATTERN_LENGTH) {
      console.warn(
        `[AutoApprove] Warning: allow pattern "${p}" is shorter than ${MIN_PATTERN_LENGTH} chars and will match many commands. Use a more specific pattern.`,
      );
    }
  }
  for (const p of cfg.deny) {
    if (p.trim().length < MIN_PATTERN_LENGTH) {
      console.warn(
        `[AutoApprove] Warning: deny pattern "${p}" is shorter than ${MIN_PATTERN_LENGTH} chars and will block many commands. Use a more specific pattern.`,
      );
    }
  }
}

/** Validate the terminal cue section has correct runtime types. */
function validateTerminal(cfg: TerminalConfig, configPath: string): void {
  const channels = ['osc9', 'osc777', 'bell', 'off'];
  if (!channels.includes(cfg.notify)) {
    throw new Error(
      `Invalid terminal.notify in ${configPath}: must be one of ${channels.map((c) => `"${c}"`).join(', ')}, got ${typeof cfg.notify === 'string' ? `"${cfg.notify}"` : typeof cfg.notify}.`,
    );
  }
  if (typeof cfg.status_cue !== 'boolean') {
    throw new Error(
      `Invalid terminal.status_cue in ${configPath}: must be a boolean (true/false), got ${typeof cfg.status_cue === 'string' ? `string "${cfg.status_cue}"` : typeof cfg.status_cue}.`,
    );
  }
  if (typeof cfg.status_bar !== 'boolean') {
    throw new Error(
      `Invalid terminal.status_bar in ${configPath}: must be a boolean (true/false), got ${typeof cfg.status_bar === 'string' ? `string "${cfg.status_bar}"` : typeof cfg.status_bar}.`,
    );
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
  const terminal = { ...config.terminal };
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

  // Terminal cue env vars
  const tn = env['REMI_TERMINAL_NOTIFY'];
  if (tn === 'osc9' || tn === 'osc777' || tn === 'bell' || tn === 'off') {
    (terminal as { notify: TerminalConfig['notify'] }).notify = tn;
  }
  if (env['REMI_TERMINAL_STATUS_CUE'] === 'true') {
    (terminal as { status_cue: boolean }).status_cue = true;
  } else if (env['REMI_TERMINAL_STATUS_CUE'] === 'false') {
    (terminal as { status_cue: boolean }).status_cue = false;
  }
  if (env['REMI_TERMINAL_STATUS_BAR'] === 'true') {
    (terminal as { status_bar: boolean }).status_bar = true;
  } else if (env['REMI_TERMINAL_STATUS_BAR'] === 'false') {
    (terminal as { status_bar: boolean }).status_bar = false;
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

  // Auto-approve env vars
  const auto_approve = { ...config.auto_approve };
  if (env['REMI_AUTO_APPROVE'] === 'true') {
    (auto_approve as { enabled: boolean }).enabled = true;
  } else if (env['REMI_AUTO_APPROVE'] === 'false') {
    (auto_approve as { enabled: boolean }).enabled = false;
  }
  if (env['REMI_AUTO_APPROVE_MODEL']) {
    (auto_approve as { model: string }).model = env['REMI_AUTO_APPROVE_MODEL'];
  }
  if (env['REMI_AUTO_APPROVE_PROVIDER']) {
    (auto_approve as { provider: string }).provider = env['REMI_AUTO_APPROVE_PROVIDER'];
  }
  if (env['REMI_AUTO_APPROVE_API_KEY']) {
    (auto_approve as { api_key: string }).api_key = env['REMI_AUTO_APPROVE_API_KEY'];
  }
  if (env['REMI_AUTO_APPROVE_BASE_URL']) {
    (auto_approve as { base_url: string }).base_url = env['REMI_AUTO_APPROVE_BASE_URL'];
  }
  if (env['REMI_AUTO_APPROVE_INSTRUCTIONS']) {
    (auto_approve as { instructions: string }).instructions = env['REMI_AUTO_APPROVE_INSTRUCTIONS'];
  }
  // Comma- or newline-separated patterns. Env vars override (not append to) config.
  if (env['REMI_AUTO_APPROVE_ALLOW']) {
    (auto_approve as { allow: readonly string[] }).allow = env['REMI_AUTO_APPROVE_ALLOW']
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (env['REMI_AUTO_APPROVE_DENY']) {
    (auto_approve as { deny: readonly string[] }).deny = env['REMI_AUTO_APPROVE_DENY']
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (env['REMI_AUTO_APPROVE_ALWAYS_ESCALATE']) {
    (auto_approve as { always_escalate_tools: readonly string[] }).always_escalate_tools = env[
      'REMI_AUTO_APPROVE_ALWAYS_ESCALATE'
    ]
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const mc = env['REMI_AUTO_APPROVE_MULTICHOICE'];
  if (mc === 'skip' || mc === 'evaluate') {
    (auto_approve as { multichoice: 'skip' | 'evaluate' }).multichoice = mc;
  }
  if (env['REMI_AUTO_APPROVE_MULTICHOICE_MODEL']) {
    (auto_approve as { multichoice_model: string }).multichoice_model =
      env['REMI_AUTO_APPROVE_MULTICHOICE_MODEL'];
  }
  if (env['REMI_AUTO_APPROVE_ESCALATE_MODEL']) {
    (auto_approve as { escalate_model: string }).escalate_model =
      env['REMI_AUTO_APPROVE_ESCALATE_MODEL'];
  }
  if (env['REMI_AUTO_APPROVE_ESCALATE_TIMEOUT']) {
    const parsed = Number.parseInt(env['REMI_AUTO_APPROVE_ESCALATE_TIMEOUT'], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      (auto_approve as { escalate_timeout: number }).escalate_timeout = parsed;
    }
  }
  if (env['REMI_AUTO_APPROVE_QUEUE_TIMEOUT']) {
    const parsed = Number.parseInt(env['REMI_AUTO_APPROVE_QUEUE_TIMEOUT'], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      (auto_approve as { queue_timeout: number }).queue_timeout = parsed;
    }
  }

  // Experimental feature flags (#453 phase 3). Default OFF; env opt-in only.
  const features = { ...config.features };
  if (env['REMI_TRANSCRIPT_BINDER_SHADOW'] === 'true') {
    (features as { transcript_binder_shadow: boolean }).transcript_binder_shadow = true;
  } else if (env['REMI_TRANSCRIPT_BINDER_SHADOW'] === 'false') {
    (features as { transcript_binder_shadow: boolean }).transcript_binder_shadow = false;
  }
  if (env['REMI_TRANSCRIPT_BINDER_ENABLED'] === 'true') {
    (features as { transcript_binder_enabled: boolean }).transcript_binder_enabled = true;
  } else if (env['REMI_TRANSCRIPT_BINDER_ENABLED'] === 'false') {
    (features as { transcript_binder_enabled: boolean }).transcript_binder_enabled = false;
  }

  return {
    ...config,
    daemon,
    network,
    display,
    terminal,
    telegram,
    auto_approve,
    features,
  };
}

/**
 * Generate the default config file content as TOML.
 */
export function generateDefaultConfig(): string {
  return `# Remi configuration
# Priority: CLI flags > environment variables > this file > built-in defaults
# Run 'remi reload' to validate changes. Restart the daemon to apply.

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

[terminal]
# Out-of-band cue on the wrapper terminal during auto-approve (only active when
# auto_approve is enabled). notify fires when a permission ESCALATES to you.
notify = "${DEFAULT_CONFIG.terminal.notify}"        # osc9 | osc777 | bell | off
status_cue = ${DEFAULT_CONFIG.terminal.status_cue}     # animate the title: evaluating -> done/needs-you
status_bar = ${DEFAULT_CONFIG.terminal.status_bar}     # reserve the last terminal row for a remi status bar (#565)

[telegram]
enabled = ${DEFAULT_CONFIG.telegram.enabled}
bot_token = ""
authorized_chat_ids = []
authorized_user_ids = []

# [auto_approve]
# enabled = false
# provider = "ollama"           # "ollama" | "openrouter" | custom base URL
# model = "qwen3.5:4b"          # Fast small default; the eval blocks Claude (#496)
# api_key = ""                  # Required for OpenRouter, empty for Ollama
# base_url = "http://localhost:11434/v1"
# timeout = 30                  # Seconds; falls through to user if exceeded
                                # (covers cold model load on local Ollama)
# log_decisions = true
#
# User-defined rules. Substring matching for Bash, tool-name match for others.
# Checked BEFORE the LLM. Deny is checked first and always wins.
# allow = ["git status", "bun test", "bunx biome", "Read", "Glob", "Grep"]
# deny = ["rm -rf /", "sudo ", "curl | sh", "| bash"]
#
# Natural-language guidance appended to the LLM system prompt:
# instructions = """
# Approve all bun test and biome runs.
# Escalate anything touching .env or secrets/.
# Deny any git push to main.
# """
#
# Multi-choice prompts (plan-mode questions, tools with 4+ choices, or any
# permission_suggestions outside the standard Yes/Yes-always/No trio):
# multichoice = "skip"             # "skip" (default; always escalate to user)
#                                  # | "evaluate" (call LLM to pick an index)
# multichoice_model = ""           # Optional alt-model for multi-choice; empty
#                                  # falls back to the main \`model\`. Useful
#                                  # for routing planning prompts to a smarter
#                                  # model without paying its latency for
#                                  # every binary permission. Ignored unless
#                                  # multichoice = "evaluate".
# escalate_model = ""              # Second opinion on a primary 'escalate'
#                                  # (main context only). Put a heavy model here
#                                  # (e.g. qwen3.5:35b) to honor a broad approve
#                                  # policy without its latency on every prompt.
# escalate_timeout = 0             # Seconds for escalate_model; 0 = use timeout.
#                                  # Raise (e.g. 90) for a large, often-cold
#                                  # second-opinion model so its first-call load
#                                  # does not abort into an error->escalate.
# queue_timeout = 240              # Max seconds an eval waits in the serial
#                                  # queue before escalating. Concurrent evals
#                                  # run one at a time; a deep burst could risk
#                                  # the ~600s hook budget. 0 = no bound.
# disable_thinking = false         # Ollama only: native /api/chat with
#                                  # think:false (no reasoning). Faster but
#                                  # lowers decision quality (reasoning helps
#                                  # the model follow broad instructions), so
#                                  # default off. Opt in for raw speed.
# always_escalate_tools = ["AskUserQuestion", "ExitPlanMode"]
#                                  # Tools that ALWAYS go to the user, never
#                                  # auto-decided by the LLM (design / plan-mode
#                                  # / long-form questions). Add custom MCP tools
#                                  # that solicit user intent.
`;
}

/**
 * Write the default config file to disk.
 * Returns the path written to.
 */
export function initConfigFile(configPath: string = CONFIG_PATH): string {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  try {
    fs.writeFileSync(configPath, generateDefaultConfig(), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
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
  lines.push('[terminal]');
  lines.push(`  notify = "${config.terminal.notify}"`);
  lines.push(`  status_cue = ${config.terminal.status_cue}`);
  lines.push(`  status_bar = ${config.terminal.status_bar}`);
  lines.push('');
  lines.push('[telegram]');
  lines.push(`  enabled = ${config.telegram.enabled}`);
  lines.push(`  bot_token = "${config.telegram.bot_token ? '***' : ''}"`);
  lines.push(`  authorized_chat_ids = [${config.telegram.authorized_chat_ids.join(', ')}]`);
  lines.push(`  authorized_user_ids = [${config.telegram.authorized_user_ids.join(', ')}]`);
  lines.push('');
  lines.push('[auto_approve]');
  lines.push(`  enabled = ${config.auto_approve.enabled}`);
  lines.push(`  provider = "${config.auto_approve.provider}"`);
  lines.push(`  model = "${config.auto_approve.model}"`);
  lines.push(`  api_key = "${config.auto_approve.api_key ? '***' : ''}"`);
  lines.push(`  base_url = "${config.auto_approve.base_url}"`);
  lines.push(`  timeout = ${config.auto_approve.timeout}`);
  lines.push(`  log_decisions = ${config.auto_approve.log_decisions}`);
  lines.push(`  allow = [${config.auto_approve.allow.map((s) => `"${s}"`).join(', ')}]`);
  lines.push(`  deny = [${config.auto_approve.deny.map((s) => `"${s}"`).join(', ')}]`);
  lines.push(
    `  approve_groups = [${config.auto_approve.approve_groups.map((s) => `"${s}"`).join(', ')}]`,
  );
  lines.push(
    `  deny_groups = [${config.auto_approve.deny_groups.map((s) => `"${s}"`).join(', ')}]`,
  );
  const instr = config.auto_approve.instructions;
  const instrDisplay = instr ? `"${instr.slice(0, 40)}${instr.length > 40 ? '...' : ''}"` : '""';
  lines.push(`  instructions = ${instrDisplay}`);
  lines.push(`  multichoice = "${config.auto_approve.multichoice}"`);
  lines.push(`  multichoice_model = "${config.auto_approve.multichoice_model}"`);
  lines.push(`  escalate_model = "${config.auto_approve.escalate_model}"`);
  lines.push(`  escalate_timeout = ${config.auto_approve.escalate_timeout}`);
  lines.push(`  queue_timeout = ${config.auto_approve.queue_timeout}`);
  lines.push(`  disable_thinking = ${config.auto_approve.disable_thinking}`);
  lines.push(
    `  always_escalate_tools = [${config.auto_approve.always_escalate_tools.map((s) => `"${s}"`).join(', ')}]`,
  );
  lines.push('');
  lines.push('# Experimental (epic #453). Default off; flip = restart (no hot reload).');
  lines.push('[features]');
  lines.push(`  transcript_binder_shadow = ${config.features.transcript_binder_shadow}`);
  lines.push(`  transcript_binder_enabled = ${config.features.transcript_binder_enabled}`);

  return lines.join('\n');
}
