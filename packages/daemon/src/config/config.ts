/**
 * Config file system for Remi.
 *
 * Reads ~/.remi/config.toml and provides merged configuration with
 * priority: CLI flags > env vars > config file > built-in defaults.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DAEMON_BASE_PORT, DAEMON_PORT_RANGE, errorToString } from '@remi/shared';
import { parse as parseToml } from 'smol-toml';
import { remiHome } from './remi-home.ts';

const REMI_DIR = remiHome();
export const CONFIG_PATH = path.join(REMI_DIR, 'config.toml');

/** Daemon settings (restart required to apply changes) */
export interface DaemonConfig {
  readonly base_port: number;
  readonly port_range: number;
  readonly bind: string;
  readonly orphan_timeout: number;
  /**
   * Keep sessions alive after the last client disconnects (tmux-style), so a
   * session created remotely survives until Claude exits or it is explicitly
   * stopped. When true (default), the orphan timeout never reaps a session;
   * set false to restore the old `orphan_timeout`-based reaping.
   */
  readonly persist_sessions: boolean;
  /**
   * Extra browser origins allowed to open a WebSocket or POST an answer (#535).
   *
   * Empty by default. remi's own clients are already covered: native clients
   * (CLI, iOS, macOS) send no `Origin` at all, the iOS WebView sends
   * `capacitor://localhost`, a dev server sends a loopback origin, and the
   * hosted client sends `https://remi.yooz.live`. This is for a web client you
   * host yourself; the daemon logs the exact line to add when it refuses one.
   */
  readonly allowed_origins: readonly string[];
  /**
   * Retire the blanket loopback auth exemption (#869).
   *
   * With it false (today's default), any process on this machine can open the
   * daemon's WebSocket and answer a permission prompt: it sends no `Origin`,
   * which makes it indistinguishable from the CLI. With it true, a loopback
   * peer must present the capability token from `~/.remi/capability.key` or
   * complete the Ed25519 challenge, exactly like a remote client.
   *
   * Default false ONLY because the macOS app cannot yet do either: it is
   * sandboxed away from `~/.remi` by design (#649/#651) and has no identity of
   * its own yet. Turning this on before that ships locks it out. The CLI
   * already sends the token, so a machine that only uses the CLI and the web
   * client can turn this on today.
   */
  readonly require_local_auth: boolean;
}

/** Network settings */
export interface NetworkConfig {
  readonly mdns: boolean;
  readonly relay: boolean;
  readonly signaling_url: string;
}

/** Authentication settings (restart required) */
export interface AuthConfig {
  /**
   * `true` = always require auth, `false` = never.
   *
   * `"auto"` is the DEFAULT and currently resolves to `false` on every bind
   * address, including `0.0.0.0`: `cli.ts` computes `isLocalhostBind` on the
   * line above the decision and then does not consult it
   * (`cliAuth ?? (configAuth === 'auto' ? false : configAuth)`). This comment
   * used to claim "auto = based on bind address", which is what the name
   * suggests and what the code does not do; #880 tracks whether the code or the
   * name is wrong. Until that is settled, read `"auto"` as "off", and do not
   * assume exposing the daemon on a network turns authentication on.
   *
   * This is now load-bearing in the other direction. `daemon.bind` defaults to
   * LOOPBACK precisely because this resolves off (#880): together, the previous
   * `0.0.0.0` default and this one admitted unauthenticated `answer` /
   * `user_input` from any host on the LAN. So anyone WIDENING the bind -- in
   * config or in the default -- is turning that exposure back on, and owes the
   * auth story first. Note that "turn auth on" is not by itself enough either:
   * TOFU is auto-accept unless `--no-tofu` is passed -- decided at the CALL
   * SITE in `cli.ts`, not by `Authenticator`, whose own default is `'reject'`.
   * Do not "correct" this by checking `authenticator.ts` alone; it says the
   * opposite and the call site wins. So an authenticator on a network bind
   * admits any freshly-generated key on first sight, and persists it.
   */
  readonly enabled: 'auto' | boolean;
}

/** Display settings */
export interface DisplayConfig {
  readonly max_bullet_length: number;
}

/**
 * Turn-complete notification settings (#914). `Stop.last_assistant_message`
 * is present on the already-registered `Stop` hook (no new registration),
 * but `Stop` fires on every turn including two-second interactive ones -- a
 * push on every one is worse than nothing (the user mutes it). Gated on turn
 * DURATION so it only fires when the user plausibly walked away.
 */
export interface NotificationsConfig {
  /** Master on/off for the turn-complete push. */
  readonly on_turn_complete: boolean;
  /**
   * Minimum turn duration (seconds, measured from the earliest hook event
   * remi saw for the turn's `prompt_id` to `Stop`) before a turn-complete
   * push fires. The right value is personal -- how long before "still
   * watching" becomes "probably walked away" -- so it is configurable rather
   * than fixed.
   */
  readonly turn_complete_min_seconds: number;
  /**
   * Background-agent commands worth an informational push when Claude ran
   * them without asking (its own allow rules permitted them), sent when the
   * call finishes (#807, #1155, `auto-approve/subagent-alert.ts`). A call
   * that prompts gets its prompt's notice or card instead, never this too.
   * Matched as substrings of the command (or the bare tool name for a
   * non-command tool). Moved here from `[auto_approve]` in #1125; a config
   * that still sets only `auto_approve.subagent_alert` keeps working, with a
   * deprecation notice.
   */
  readonly subagent_alert: readonly string[];
}

/**
 * Permission prompt relay settings (#1126). A main-agent permission prompt
 * holds its `PermissionRequest` hook while the card is on the phone, so the
 * phone's answer becomes the hook's response; Claude's own dialog stays on
 * screen the whole time and either answer wins.
 */
export interface PromptsConfig {
  /**
   * Seconds remi holds a permission hook for a phone answer before letting
   * go (an empty response, so Claude's dialog simply stays and the card says
   * "answer at the terminal"). 5 to 110: below the 2:00 auto-deny of Claude's
   * auto-mode fallback prompts, which counts during a hold, and below the
   * hook's registered 600 s timeout.
   */
  readonly hold_seconds: number;
  /**
   * The same hold for a daemon or hub session (#1126 lead decision), which
   * has no terminal of its own: after the deadline only `remi attach` could
   * answer, so the phone keeps the prompt much longer. 5 to 3540, below the
   * 3600 s PermissionRequest registration such sessions use. An auto-mode
   * fallback prompt still auto-denies at 2:00 on Claude's side; that arrives
   * as a `PermissionDenied` hook (measured), which dismisses the card.
   */
  readonly daemon_hold_seconds: number;
}

/** Bounds for `prompts.hold_seconds` (#1126). */
export const HOLD_SECONDS_MIN = 5;
export const HOLD_SECONDS_MAX = 110;
/** Bounds for `prompts.daemon_hold_seconds` (#1126). */
export const DAEMON_HOLD_SECONDS_MAX = 3540;

/**
 * Terminal settings. `notify` and `status_cue` configured the auto-approve
 * terminal cue (#513); nothing has read them since #560 replaced the title
 * cue, and the auto-approve evaluator itself was removed in #1125. They are
 * still parsed so existing config files load. `status_bar` is live.
 */
export interface TerminalConfig {
  /** Unused (see the interface doc). 'osc9' | 'osc777' | 'bell' | 'off'. */
  readonly notify: 'osc9' | 'osc777' | 'bell' | 'off';
  /** Unused (see the interface doc). */
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
 * defaults ON and is the only flag left: the binder is the unconditional driver
 * of session binding (#503), and the old hook-binding path + shadow-mode compare
 * it used to select between were deleted in #470.
 */
export interface FeaturesConfig {
  /**
   * Deprecated kill-switch (#470): used to restore the pre-#453 hook-binding
   * path when false. That path no longer exists, so `false` now only logs a
   * deprecation warning at boot; the TranscriptBinder always drives.
   */
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
  readonly features: FeaturesConfig;
  readonly notifications: NotificationsConfig;
  readonly prompts: PromptsConfig;
}

/** Built-in defaults used when no config file or CLI flags are provided */
export const DEFAULT_CONFIG: RemiConfig = {
  daemon: {
    base_port: DAEMON_BASE_PORT,
    port_range: DAEMON_PORT_RANGE,
    // #880: LOOPBACK, not 0.0.0.0. The pairing of this default with
    // `auth.enabled = "auto"` -- which resolves to `false` on every bind (see
    // AuthConfig.enabled) -- meant every default install accepted UNAUTHENTICATED
    // control from any host on the LAN. Traced end to end: no authenticator
    // means the connection never enters `authenticating` and routes messages
    // straight to the handler map (`connection.ts`); the Origin gate admits a
    // null/absent Origin, which is exactly what a non-browser client sends
    // (`origin-policy.ts`); and mDNS advertises the port by default. A LAN peer
    // could send `answer` (approve any pending permission -- i.e. arbitrary tool
    // execution) or `user_input` (type into the live Claude session).
    //
    // Loopback is the correct default for a tool whose whole job is answering
    // permission prompts. Remote access is now an explicit opt-in: set `bind`
    // and read the auth warning that comes with it.
    //
    // SCOPE, stated so this does not read as more than it is: this closes the
    // unauthenticated LAN path. It does NOT touch the relay path -- default-on,
    // dials outward, unaffected by the bind, and still plaintext through the
    // worker in rotating-code mode (#881) -- nor the local-process path, where
    // any process on this machine is exempted from auth while
    // `require_local_auth` is false (#869).
    //
    // NAME THE DIRECTION on the relay -- an earlier draft of this comment said
    // "the same `answer`/`user_input` power the LAN peer had", which conflates
    // the two halves, the exact error AGENTS.md records a previous draft making.
    // Traced: outbound `sendRaw` REFUSES without `sessionKeys`
    // (`relay-adapter.ts`), which rotating-code mode never derives; inbound
    // falls through to `handleRelayMessage(rawPayload)` in plaintext. So it is
    // inbound INJECTION, not the LAN peer's bidirectional control -- the daemon
    // cannot answer back at all (#881).
    //
    // It also does not reach an install that already MATERIALIZED the old
    // default: `remi config init` writes `bind = "${DEFAULT_CONFIG.daemon.bind}"`
    // into config.toml (see initConfigFile below), and a value on disk beats a
    // changed default. Those users keep the exposure and get no breakage to
    // notice it by -- hence the boot warning in cli.ts, which is the only signal
    // they will get.
    //
    // Deliberately NOT fixed by making `"auto"` bind-aware, which is what #880's
    // title asks for. That alone is insufficient: `cli.ts` constructs the
    // Authenticator with `tofuMode: 'auto-accept'` unless `--no-tofu` is passed
    // (the Authenticator class itself defaults to `'reject'`, so checking only
    // authenticator.ts would say this claim is wrong -- the call site is what
    // decides), and an auto-accept TOFU admits any freshly-generated key on
    // first sight AND persists it as authorized. Auth-on-network without a real
    // pairing flow is first-comer-wins, which reads as "handled" while it is
    // not. The `"auto"` semantics + TOFU belong in one tested change with the
    // phone pairing flow; this one closes the LAN path without depending on it.
    bind: '127.0.0.1',
    orphan_timeout: 300,
    persist_sessions: true,
    allowed_origins: [],
    require_local_auth: false,
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
  features: {
    // The TranscriptBinder is the unconditional session-binding driver (epic
    // #499 / #503) and is the single source of truth for the live session.
    // `REMI_TRANSCRIPT_BINDER_ENABLED=false` no longer restores an alternate
    // path (deleted in #470); it only logs a deprecation warning at boot.
    transcript_binder_enabled: true,
  },
  notifications: {
    on_turn_complete: true,
    // 60s: long enough that a normal interactive turn (seconds) never fires
    // it, short enough to still be useful for "went to get coffee" absences.
    // Personal preference varies a lot here, hence configurable.
    turn_complete_min_seconds: 60,
    // Background-agent commands worth a heads-up when Claude ran them without
    // asking (#807, #1155; a call that prompts is shown as its prompt).
    // Irreversible-only by default: these are things you cannot undo, so a
    // banner is warranted even at the cost of an occasional false positive.
    // Broad-but-common patterns (curl, wget, ssh, scp) are deliberately NOT
    // defaulted — on a session driving many agents they fire on benign traffic
    // and a banner nobody reads is worse than no banner. Add them per machine.
    subagent_alert: [
      'rm -rf',
      'rm -f',
      'push --force',
      'push -f ',
      'reset --hard',
      'DROP TABLE',
      'TRUNCATE',
      'sudo ',
      'chmod 777',
    ],
  },
  prompts: {
    // 90 s: long enough to reach a phone in a pocket, short enough to stay
    // under the 2:00 auto-deny of auto-mode fallback prompts (#1126).
    hold_seconds: 90,
    // 59 min: a daemon or hub session has no terminal, so the phone is the
    // way to answer; below the 3600 s hook registration (#1126).
    daemon_hold_seconds: 3540,
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
    features: mergeSection(
      base.features,
      partial['features'] as Record<string, unknown> | undefined,
    ),
    notifications: mergeSection(
      base.notifications,
      partial['notifications'] as Record<string, unknown> | undefined,
    ),
    prompts: mergeSection(base.prompts, partial['prompts'] as Record<string, unknown> | undefined),
  };
}

/**
 * A loaded config plus what a boot notice must say about settings that no
 * longer exist (#1125, ADR 0030). The notice itself is built and printed by
 * the caller (`cli/auto-approve-removal.ts`), once, at boot; loading never
 * fails because of these keys.
 */
export interface LoadedConfig {
  readonly config: RemiConfig;
  /** Top-level keys present in the removed `[auto_approve]` table, sorted.
   *  Empty when the file has no such table. */
  readonly removedAutoApproveKeys: readonly string[];
  /** True when `[notifications] subagent_alert` was absent and the legacy
   *  `auto_approve.subagent_alert` list was used in its place. */
  readonly subagentAlertFromLegacy: boolean;
}

/**
 * Load config from ~/.remi/config.toml, merged with defaults.
 * Returns DEFAULT_CONFIG if no config file exists.
 * Throws if the file exists but cannot be read or has invalid TOML.
 */
export function loadConfig(configPath: string = CONFIG_PATH): RemiConfig {
  return loadConfigWithNotices(configPath).config;
}

/** `loadConfig`, plus the removed-settings facts a boot notice needs. */
export function loadConfigWithNotices(configPath: string = CONFIG_PATH): LoadedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        config: deepMerge(DEFAULT_CONFIG, {}),
        removedAutoApproveKeys: [],
        subagentAlertFromLegacy: false,
      };
    }
    throw new Error(
      `Cannot read config file ${configPath}: ${errorToString(err)}. Fix file permissions or remove the file to use defaults.`,
    );
  }

  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    const merged = deepMerge(DEFAULT_CONFIG, parsed);
    const legacy = legacyAutoApprove(parsed);
    const config = legacy.subagentAlert
      ? {
          ...merged,
          notifications: { ...merged.notifications, subagent_alert: legacy.subagentAlert },
        }
      : merged;
    validateTerminal(config.terminal, configPath);
    validateDaemon(config.daemon, configPath);
    validateNotifications(config.notifications, configPath);
    validatePrompts(config.prompts, configPath);
    return {
      config,
      removedAutoApproveKeys: legacy.keys,
      subagentAlertFromLegacy: legacy.subagentAlert !== undefined,
    };
  } catch (err) {
    throw new Error(
      `Invalid TOML in ${configPath}: ${errorToString(err)}. Fix the syntax or delete the file to use defaults.`,
    );
  }
}

/**
 * What survives of a removed `[auto_approve]` table (#1125). Its keys are
 * reported, never validated: a stale value of any shape must not stop the
 * daemon from starting. The one setting that moved, `subagent_alert`, is
 * honored from here only when `[notifications] subagent_alert` is unset and
 * the legacy value is a list of strings.
 */
function legacyAutoApprove(parsed: Record<string, unknown>): {
  keys: readonly string[];
  subagentAlert: readonly string[] | undefined;
} {
  if (!('auto_approve' in parsed)) return { keys: [], subagentAlert: undefined };
  const table = parsed['auto_approve'];
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return { keys: ['auto_approve'], subagentAlert: undefined };
  }
  const t = table as Record<string, unknown>;
  const notifications = parsed['notifications'] as Record<string, unknown> | undefined;
  const legacyAlert = t['subagent_alert'];
  const subagentAlert =
    (notifications === undefined || !('subagent_alert' in notifications)) &&
    Array.isArray(legacyAlert) &&
    legacyAlert.every((p) => typeof p === 'string')
      ? (legacyAlert as readonly string[])
      : undefined;
  // A legacy subagent_alert that is still honored is not "ignored": it gets
  // its own "move it" line in the boot notice instead.
  const keys = Object.keys(t)
    .filter((k) => !(k === 'subagent_alert' && subagentAlert !== undefined))
    .sort();
  return { keys, subagentAlert };
}

/**
 * Validate `[daemon]` entries whose runtime type is load-bearing (#535).
 *
 * `allowed_origins` widens who may answer a permission prompt, so a wrong type
 * must stop the daemon rather than degrade quietly. Written as a string
 * (`allowed_origins = "https://x"`) it would still be truthy and `.includes()`
 * would then substring-match origins against it, which is not what anyone meant.
 */
function validateDaemon(cfg: DaemonConfig, configPath: string): void {
  const v: unknown = cfg.allowed_origins;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
    throw new Error(
      `Invalid daemon.allowed_origins in ${configPath}: must be an array of origin strings, got ${typeof v === 'string' ? `string "${v}"` : typeof v}. Example: allowed_origins = ["https://remi.example.com"]`,
    );
  }
  for (const origin of v) {
    // An origin is scheme + host + optional port. A path, a query, or a
    // trailing slash never appears in an `Origin` header, so an entry carrying
    // one can never match and is a silent no-op: refuse it instead.
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        `Invalid daemon.allowed_origins entry "${origin}" in ${configPath}: not a URL. Use scheme://host[:port], e.g. "https://remi.example.com".`,
      );
    }
    if (parsed.origin !== origin) {
      throw new Error(
        `Invalid daemon.allowed_origins entry "${origin}" in ${configPath}: an Origin header carries no path, query, or trailing slash, so this entry would never match. Use "${parsed.origin}".`,
      );
    }
  }
}

/** Validate `[notifications]` has correct runtime types (#914). */
function validateNotifications(cfg: NotificationsConfig, configPath: string): void {
  if (
    !Array.isArray(cfg.subagent_alert) ||
    !cfg.subagent_alert.every((p: unknown) => typeof p === 'string')
  ) {
    throw new Error(
      `Invalid notifications.subagent_alert in ${configPath}: must be an array of strings. Example: subagent_alert = ["rm -rf", "push --force"]`,
    );
  }
  if (typeof cfg.on_turn_complete !== 'boolean') {
    throw new Error(
      `Invalid notifications.on_turn_complete in ${configPath}: must be a boolean (true/false), got ${typeof cfg.on_turn_complete === 'string' ? `string "${cfg.on_turn_complete}"` : typeof cfg.on_turn_complete}. Example: on_turn_complete = true`,
    );
  }
  if (
    typeof cfg.turn_complete_min_seconds !== 'number' ||
    !Number.isFinite(cfg.turn_complete_min_seconds) ||
    cfg.turn_complete_min_seconds < 0
  ) {
    throw new Error(
      `Invalid notifications.turn_complete_min_seconds in ${configPath}: must be a non-negative number (seconds), got ${typeof cfg.turn_complete_min_seconds === 'string' ? `string "${cfg.turn_complete_min_seconds}"` : typeof cfg.turn_complete_min_seconds}. Example: turn_complete_min_seconds = 60`,
    );
  }
}

/**
 * Validate `[prompts]` (#1126). An out-of-range hold is refused rather than
 * clamped: above 110 s an auto-mode fallback prompt can auto-deny while remi
 * still holds it, and below 5 s the card would be released before it can
 * reach a phone.
 */
function validatePrompts(cfg: PromptsConfig, configPath: string): void {
  const check = (key: string, v: unknown, max: number, example: number): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < HOLD_SECONDS_MIN || v > max) {
      throw new Error(
        `Invalid prompts.${key} in ${configPath}: must be a number of seconds from ${HOLD_SECONDS_MIN} to ${max}, got ${typeof v === 'string' ? `string "${v}"` : String(v)}. Example: ${key} = ${example}`,
      );
    }
  };
  check('hold_seconds', cfg.hold_seconds, HOLD_SECONDS_MAX, 90);
  check('daemon_hold_seconds', cfg.daemon_hold_seconds, DAEMON_HOLD_SECONDS_MAX, 3540);
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

  // Deprecated kill-switch (#470/#503): the TranscriptBinder drives session
  // binding unconditionally now, so this flag has no effect on behavior; it is
  // read only so an operator's existing env var doesn't silently vanish.
  const features = { ...config.features };
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
orphan_timeout = ${DEFAULT_CONFIG.daemon.orphan_timeout}  # seconds (ignored when persist_sessions = true)
persist_sessions = ${DEFAULT_CONFIG.daemon.persist_sessions}  # keep sessions alive after disconnect (tmux-style)
# Extra browser origins allowed to connect (#535). remi's own clients need no
# entry here: native clients send no Origin, the iOS app sends
# capacitor://localhost, and the hosted client sends https://remi.yooz.live.
# Only a web client you host yourself does. Example:
#   allowed_origins = ["https://remi.example.com"]
allowed_origins = []
# Require loopback clients to prove themselves (#869). Off by default until
# the macOS app ships its own identity; safe to turn on if you only use the
# CLI and the web client.
require_local_auth = false

[network]
mdns = ${DEFAULT_CONFIG.network.mdns}
relay = ${DEFAULT_CONFIG.network.relay}
signaling_url = "${DEFAULT_CONFIG.network.signaling_url}"

[auth]
enabled = "${DEFAULT_CONFIG.auth.enabled}"  # "auto" | true | false

[display]
max_bullet_length = ${DEFAULT_CONFIG.display.max_bullet_length}  # 0 = disabled

[terminal]
notify = "${DEFAULT_CONFIG.terminal.notify}"        # unused; kept so older configs load
status_cue = ${DEFAULT_CONFIG.terminal.status_cue}     # unused; kept so older configs load
status_bar = ${DEFAULT_CONFIG.terminal.status_bar}     # reserve the last terminal row for a remi status bar (#565)

[telegram]
enabled = ${DEFAULT_CONFIG.telegram.enabled}
bot_token = ""
authorized_chat_ids = []
authorized_user_ids = []

[notifications]
# Push "<session>: turn complete" with Claude's actual last message when a
# turn runs long (#914). Stop fires on EVERY turn, including two-second
# interactive ones, so this is gated on duration: below the threshold you are
# presumably still watching and a push would just be noise you learn to
# ignore. Above it, you plausibly walked away and a lock-screen ping is the
# whole point of remi. Never fires on a stop-hook re-entry (the turn is not
# actually done yet) or with no device registered.
on_turn_complete = ${DEFAULT_CONFIG.notifications.on_turn_complete}
turn_complete_min_seconds = ${DEFAULT_CONFIG.notifications.turn_complete_min_seconds}  # tune to taste; there is no "right" value
# Background-agent commands worth an informational push when Claude ran them
# without asking (your allow rules permitted them); sent when the command
# finishes (#807). A command that asks for permission shows as its prompt
# instead. Substring match on the command. Irreversible-only by default; add
# broad ones (curl, ssh) per machine if you want them.
subagent_alert = [${DEFAULT_CONFIG.notifications.subagent_alert.map((p) => `"${p}"`).join(', ')}]

[prompts]
# How long remi holds a Claude permission prompt for your phone's answer
# (#1126). Claude's own dialog stays in the terminal the whole time, and
# whichever answer comes first wins. After this many seconds the phone card
# says "answer at the terminal" and the terminal dialog stays up. 5 to 110.
hold_seconds = ${DEFAULT_CONFIG.prompts.hold_seconds}
# The same for a daemon or hub session, which has no terminal of its own
# (after the deadline only remi attach reaches the prompt). 5 to 3540.
daemon_hold_seconds = ${DEFAULT_CONFIG.prompts.daemon_hold_seconds}
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
  lines.push(`  persist_sessions = ${config.daemon.persist_sessions}`);
  lines.push(`  allowed_origins = ${JSON.stringify(config.daemon.allowed_origins)}`);
  lines.push(`  require_local_auth = ${config.daemon.require_local_auth}`);
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
  lines.push('# transcript_binder_enabled is a deprecated kill-switch (#470); flip = restart.');
  lines.push('[features]');
  lines.push(`  transcript_binder_enabled = ${config.features.transcript_binder_enabled}`);
  lines.push('');
  lines.push('[notifications]');
  lines.push(`  on_turn_complete = ${config.notifications.on_turn_complete}`);
  lines.push(`  turn_complete_min_seconds = ${config.notifications.turn_complete_min_seconds}`);
  lines.push(
    `  subagent_alert = [${config.notifications.subagent_alert.map((s) => `"${s}"`).join(', ')}]`,
  );
  lines.push('');
  lines.push('[prompts]');
  lines.push(`  hold_seconds = ${config.prompts.hold_seconds}`);
  lines.push(`  daemon_hold_seconds = ${config.prompts.daemon_hold_seconds}`);

  return lines.join('\n');
}
