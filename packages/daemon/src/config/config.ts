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
import {
  AUTO_APPROVE_LEVELS,
  DEFAULT_AUTO_APPROVE_LEVEL,
  isAutoApproveLevel,
  resolveApproveGroups,
} from '../auto-approve/levels.ts';
import { KNOWN_TOOL_NAMES, looksLikeToolName } from '../auto-approve/pattern-matcher.ts';
import { isKnownGroup, knownGroupNames } from '../auto-approve/permission-groups.ts';
import { DEFAULT_ALWAYS_ESCALATE_TOOLS } from '../auto-approve/types.ts';
import type { AutoApproveConfig } from '../auto-approve/types.ts';

const REMI_DIR = path.join(os.homedir(), '.remi');
export const CONFIG_PATH = path.join(REMI_DIR, 'config.toml');

/**
 * Which local-LLM backend can actually run here (#822).
 *
 * The supported targets carry DIFFERENT backends, so a single hardcoded default
 * is wrong on half of them:
 *
 *   - Apple Silicon -> the Yooz engine. MLX, so `darwin-arm64` only; an Intel
 *     Mac cannot run it however much it looks like "macOS".
 *   - Linux -> a thin `llama-server`, which speaks the OpenAI-compatible shape
 *     and therefore reuses the existing transport unchanged.
 *   - Anything else (notably `darwin-x64`) -> neither. Reported as such rather
 *     than defaulted to a backend that cannot exist there, because the failure
 *     would otherwise be a 30s startup timeout followed by escalate-everything
 *     — indistinguishable from a bug.
 *
 * Both backends listen on remi's reserved port 19924, and only one can run per
 * machine by construction, so the platform decides which without negotiation.
 */
export type LocalLLMPlatform = 'yooz' | 'llamacpp' | 'unsupported';

export function detectLocalLLMPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): LocalLLMPlatform {
  if (platform === 'darwin') return arch === 'arm64' ? 'yooz' : 'unsupported';
  if (platform === 'linux') return 'llamacpp';
  return 'unsupported';
}

/**
 * The `auto_approve.provider` default for THIS machine. An unsupported target
 * still gets `'yooz'` so the config shape and error messages stay stable; what
 * changes there is that the daemon says so at boot (see `cli.ts`) instead of
 * silently waiting on an engine that can never appear.
 */
function defaultProvider(): string {
  const detected = detectLocalLLMPlatform();
  return detected === 'unsupported' ? 'yooz' : detected;
}

/**
 * The engine's MLX build of the default evaluator model, and the llama.cpp
 * GGUF build of the SAME weights. Same QAT-lean Qwen3.5-4B that #809 Phase D
 * measured at 38/38 on the permission grid — only the container differs, so
 * the Linux path inherits that evidence rather than needing its own.
 *
 * The GGUF value is deliberately written in `-hf` argument form
 * (`<user>/<repo>:<quant>`) so it can be pasted straight into the
 * `llama-server` command remi prints at boot.
 *
 * The quant suffix is explicit rather than load-bearing. `-hf` with no tag
 * prefers `Q4_K_M` then `Q8_0`, and FALLS BACK to the first `.gguf` in the
 * repo (llama.cpp `common/download.cpp`, `find_best_model`; its own `-hf`
 * help says so), so the bare id does resolve today -- these repos publish
 * exactly one file each, `Q4_0`, verified against the HF API. Naming the
 * quant keeps that deterministic if a second one is ever published, since
 * the fallback is order-dependent. An earlier draft of this comment claimed
 * the bare id "fails to resolve a file"; that was wrong and unattributed.
 */
const DEFAULT_EVAL_MODEL_MLX = 'YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx';
const DEFAULT_EVAL_MODEL_GGUF = 'YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0';

/**
 * The `auto_approve.model` default for THIS machine (#822). An MLX id cannot
 * be loaded by llama.cpp and a GGUF id means nothing to the engine, so a
 * single hardcoded default is wrong on one of the two supported targets —
 * exactly the reasoning `defaultProvider` already applies to the transport.
 *
 * An `unsupported` target follows `defaultProvider` and keeps the engine's
 * value, so the config shape stays stable and the boot warning (see `cli.ts`)
 * is what tells the user their machine has no local backend at all.
 */
export function defaultModel(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return detectLocalLLMPlatform(platform, arch) === 'llamacpp'
    ? DEFAULT_EVAL_MODEL_GGUF
    : DEFAULT_EVAL_MODEL_MLX;
}

/** The `llama-server` invocation remi tells a Linux user to run (#822). Built
 *  from the same constant as the config default so the two can never drift.
 *  Verified against llama.cpp's server README: `-hf <user>/<repo>[:quant]`,
 *  `--port`, `--host`. */
export function llamaServerCommand(model: string = DEFAULT_EVAL_MODEL_GGUF, port = 19924): string {
  // `provider = "llamacpp"` on Apple Silicon is a real setup, and nothing
  // validates provider/model consistency -- so `model` can be the MLX default,
  // or empty. Printing `-hf <something>-mlx` hands the user a command that
  // cannot load, which is worse than handing them none: the whole point of
  // this string is that it is the lever that works. Fall back to the GGUF
  // default unless the id actually looks like one.
  const looksGguf = model.includes('GGUF') || model.includes('gguf');
  const usable = looksGguf ? model : DEFAULT_EVAL_MODEL_GGUF;
  const cmd = `llama-server -hf ${usable} --host 127.0.0.1 --port ${port}`;
  // Disclose the swap. A fix for a silent substitution must not introduce one:
  // handing someone `-hf <a model they never configured>` with remi's own
  // message as the source is worse than the unrunnable command it replaced.
  return looksGguf
    ? cmd
    : `${cmd}\n  (auto_approve.model = "${model}" is not a GGUF id, so this shows remi's default)`;
}

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
  readonly auto_approve: AutoApproveConfig;
  readonly features: FeaturesConfig;
  readonly notifications: NotificationsConfig;
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
  auto_approve: {
    enabled: false,
    // Resolved by PLATFORM, not hardcoded (#822): the Yooz engine on Apple
    // Silicon, a thin llama.cpp server on Linux. Both listen on remi's reserved
    // port 19924 and only one can exist per machine, so nothing has to
    // negotiate. See `detectLocalLLMPlatform`.
    provider: defaultProvider(),
    // Fast small default: with synchronous decisions (#496) the eval blocks
    // Claude, so the default must be quick + RAM-light across platforms (incl.
    // MacBook Air). Heavier models go in `escalate_model` (second opinion,
    // would-escalate cases only).
    //
    // #809 Phase D measured the 38-case permission grid against a real engine.
    // This untuned QAT-lean KD base scored 38/38 with zero unsafe approvals,
    // zero unparsable responses, and p95 2.26s. The engine's two TouchUp tiers
    // are NOT substitutes: `yooz-quality-v3` (same base, grammar-tuned) also
    // reads 38/38, but six of those are responses carrying no verdict at all --
    // it echoes the input back, a proofreader doing its job -- and they "pass"
    // only because an unparsable response is treated as escalate. Those six are
    // `rm -rf /`, the `dd` disk wipe, `chmod 777 /etc`, `base64 | bash`,
    // `eval $X`, and a reverse shell: safety by accident, not by judgment.
    // `yooz-light-v3` scores 22/38 outright.
    //
    // Requires yooz-engine#303 (catalogue-backed model selection). Engines
    // predating it serve only the two TouchUp tiers and reject this id with
    // 400 `invalid_model`; auto-approve is off by default, so that surfaces as
    // "every question escalates" rather than as a broken daemon.
    //
    // #822: resolved by platform, like `provider` above -- an MLX id simply
    // cannot be loaded by llama.cpp. The measurement above is MLX-only; see
    // `defaultModel` for why the Linux path does not yet inherit it.
    model: defaultModel(),
    api_key: '',
    base_url: 'http://127.0.0.1:19924',
    timeout: 30,
    log_decisions: true,
    // Safe read-only TOOLS, fast-pathed without an LLM call. These are
    // tool-name matches: `Read` matches the Read tool and is never tested
    // against a Bash command string (#536 — until that fix it was, so this
    // very list approved `rm -rf Readme`). A Bash entry added here is matched
    // per compound segment with a shell-control veto, so an approved segment
    // cannot carry an unapproved one. Bash git/gh commands are still not
    // defaulted; the LLM prompt evaluates those in full.
    allow: ['Read', 'Glob', 'Grep'],
    deny: [],
    // Background-agent commands worth a heads-up even though they ran (#807).
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
    // Built-in read-by-definition groups, fast-pathed without an LLM call
    // using compound-segment-aware matching (epic #494). All three on by
    // default so enabling auto-approve immediately stops paying LLM latency
    // for reads / VCS queries / read-only build+test runs.
    approve_groups: ['read-only', 'vcs-read', 'build-test'],
    // Strictness preset (#963). `strict` reproduces exactly the
    // `approve_groups` line above, so an install that never sets this behaves
    // as it always has. Raising it to "balanced"/"trusted" swaps in the
    // write-side groups (#959).
    level: DEFAULT_AUTO_APPROVE_LEVEL,
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    // Second-opinion model on a primary 'escalate' (main context only). Empty =
    // no second opinion. Put a heavy model here to honor a broad approve
    // policy without paying its latency on every permission.
    escalate_model: '',
    // Dedicated timeout (seconds) for the heavy escalate_model. 0 = use
    // `timeout`. Set higher (e.g. 90) when escalate_model is a large, often-cold
    // model so its first-call load penalty does not abort into an error.
    escalate_timeout: 0,
    // Max seconds a permission eval may wait in the serialization queue before
    // escalating (#551). Concurrent evals run one at a time; a deep burst could
    // otherwise wait long enough to risk the ~600s hook budget. 0 = no bound.
    queue_timeout: 240,
    // Seconds of inactivity before remi drops the model's prompt-KV cache
    // while keeping its weights resident (#820 stage 1) -- cheap and
    // recomputable, unlike a full unload. 300 (5 min) mirrors ollama's old
    // server-side keep_alive default. 0 = never drop the cache; keep_alive
    // (stage 2, below) is unaffected either way.
    cache_idle: 300,
    // Seconds a model stays resident after the last evaluation before remi
    // unloads it (#820 stage 2). The engine has no keep-alive of its own, so
    // without this a daemon pins the weights forever; 1800 matches what
    // ollama's keep_alive gave us. 0 = never unload.
    keep_alive: 1800,
    // #818: who owns the engine process on remi's port. 'owned' (default) =
    // remi starts and supervises its own helper and may load/unload/delete
    // models. 'shared' = a super-yooz host owns it; remi reads and evaluates
    // but never spawns, unloads or deletes, because another module may be
    // mid-generate on the same weights.
    engine: 'owned',
    // Absolute path to the helper executable remi starts in 'owned' mode.
    // Empty = nothing to start: remi still attaches to an engine already on
    // the port, and otherwise reports the gap rather than failing silently.
    engine_path: '',
    // Where the engine downloads model weights. Empty = the engine's own
    // default (~/.cache/huggingface/hub, or its sandbox container). Set this
    // to keep multi-GB weights off the boot volume, e.g. an external disk.
    model_cache: '',
    // Reasoning OFF by default (owner decision 2026-07-25). The earlier
    // "reasoning is load-bearing" finding came from ollama-era testing with
    // models large enough to afford it. On the QAT-lean tiers this is now
    // measured as fatal, not merely slow: served through mlx_lm, the 0.8B
    // spent an entire 600-token budget thinking about a trivial prompt and
    // emitted NO content at all, so every evaluation degraded to an error.
    // A permission classify wants a short JSON verdict, not an essay.
    disable_thinking: true,
    // Always escalate these to the user; never auto-decided by the LLM (#572):
    // AskUserQuestion + plan-mode. Extend with custom question-posing tools.
    always_escalate_tools: [...DEFAULT_ALWAYS_ESCALATE_TOOLS],
    // Reuse an answer the user already gave THIS SESSION for the identical
    // operation (#976). Session-scoped, in-memory, cleared on rotation -- a
    // durable rule is what `allow` is for. The deny-direction half (an earlier
    // "no" downgrades a model approve to escalate) is a TIGHTENING and stays
    // on regardless of this flag.
    //
    // OFF by default, deliberately, and not because the mechanism is unfinished.
    // Four review rounds on #1017 each found the same defect class -- the
    // signature used as the authorization key drops something that changes what
    // the operation does (Write's `content`, Read's extent, `cmd` vs `command`,
    // collapsed indentation). Each was closed. One instance is KNOWN and still
    // OPEN: a Bash signature carries no `cwd` (#1019), so `git push origin
    // feature/x` approved in one worktree silently authorizes the identical
    // command in another -- and worktrees are this project's own documented
    // workflow. Closing it needs the signature to carry more than
    // `Question.text` can (#990).
    //
    // Shipping a privilege-GRANTING path on by default with a known-unfixed
    // escalation is the wrong trade. Flip this to true once #1019 lands; until
    // then it is opt-in for anyone who wants the convenience and understands
    // the boundary.
    session_precedent: false,
    // Hold a binary main-context PermissionRequest hook open until the user
    // answers (Model B, #573). Large + human-paced; on expiry it fails open to
    // the native prompt. 0 disables holding (escalate -> passthrough as before).
    hold_timeout: 1800,
    // Push + hold early if a binary main-context eval is still running after
    // this many seconds (Part B, #573). 0 disables Part B (A+C only).
    push_hold_timeout: 60,
    // Wait this long for a held escalation's notification to be confirmed
    // delivered before treating the hold as undeliverable (epic #603 Phase 1).
    // On no confirmation, fail open fast instead of blocking for hold_timeout.
    // 0 disables delivery gating (legacy: always hold to hold_timeout).
    delivery_confirm_timeout: 6,
    // Keep holding an undeliverable escalation for this short secondary window
    // instead of failing open immediately (epic #603 Phase 1, D2). 0 = fail
    // open fast (the hybrid default); > 0 = hold-always-no-phone mode.
    hold_unconfirmed_timeout: 0,
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
    notifications: mergeSection(
      base.notifications,
      partial['notifications'] as Record<string, unknown> | undefined,
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
    // Apply the level preset AFTER merge, but decide from the RAW parsed
    // table (#963). By this point `merged.approve_groups` is populated either
    // way, so it cannot answer "did the user write this?" — reading it here
    // would make every install look explicit and no level would ever apply.
    const rawAutoApprove = parsed['auto_approve'] as Record<string, unknown> | undefined;
    const levelled = applyLevel(merged, rawAutoApprove, configPath);
    validateTerminal(merged.terminal, configPath);
    validateDaemon(merged.daemon, configPath);
    validateNotifications(merged.notifications, configPath);
    return levelled;
  } catch (err) {
    throw new Error(
      `Invalid TOML in ${configPath}: ${errorToString(err)}. Fix the syntax or delete the file to use defaults.`,
    );
  }
}

/**
 * Apply the `[auto_approve] level` preset to the merged config (#963).
 *
 * Separated from `deepMerge` because the decision needs something the merged
 * value cannot express: whether `approve_groups` was WRITTEN by the user or
 * filled in by the default. Both look identical afterwards, so this reads the
 * raw parsed table instead.
 *
 * An explicit `approve_groups` wins over the preset, and the daemon says so —
 * a user who set groups before levels existed keeps exactly their behavior,
 * and learns from one log line why their level appears to have no effect.
 */
function applyLevel(
  merged: RemiConfig,
  rawAutoApprove: Record<string, unknown> | undefined,
  configPath: string,
): RemiConfig {
  const rawLevel = rawAutoApprove?.['level'];
  if (rawLevel !== undefined && !isAutoApproveLevel(rawLevel)) {
    throw new Error(
      `Invalid auto_approve.level in ${configPath}: got ${JSON.stringify(rawLevel)}. Valid levels: ${AUTO_APPROVE_LEVELS.join(', ')}. Example: level = "balanced"`,
    );
  }
  const level = isAutoApproveLevel(rawLevel) ? rawLevel : DEFAULT_AUTO_APPROVE_LEVEL;

  const explicitGroups =
    rawAutoApprove !== undefined && 'approve_groups' in rawAutoApprove
      ? merged.auto_approve.approve_groups
      : undefined;
  const resolved = resolveApproveGroups(level, explicitGroups);

  if (resolved.source === 'explicit' && rawLevel !== undefined) {
    console.warn(
      `[AutoApprove] Warning: both level = "${level}" and an explicit approve_groups are set in ${configPath}; approve_groups wins. Remove it to use the level preset.`,
    );
  }

  // Validate the RESOLVED list, not just the user's (#964 review). The
  // unknown-group warning in `validateAutoApprove` already ran, against the
  // pre-preset value — so a typo in `LEVEL_GROUPS` (`vcs-writ`) would reach
  // `matchGroups`, which ignores unknown names, and the level would silently
  // approve nothing while appearing to work. A user's own typo warns; the
  // shipped preset's would not have. `levels.test.ts` covers this, but a test
  // is not the runtime, and this epic has already produced three defects in
  // code written to fix the previous one.
  if (resolved.source === 'level') {
    const unknown = resolved.groups.filter((g) => !isKnownGroup(g));
    if (unknown.length > 0) {
      throw new Error(
        `Internal error: auto_approve.level "${level}" names unknown permission group(s) ${unknown.map((g) => `"${g}"`).join(', ')}. Known groups: ${knownGroupNames().join(', ')}. This is a bug in the shipped level presets, not in ${configPath}.`,
      );
    }
  }

  return {
    ...merged,
    auto_approve: { ...merged.auto_approve, level, approve_groups: resolved.groups },
  };
}

/**
 * Validate auto_approve config has correct runtime types.
 *
 * TOML doesn't enforce TypeScript types. A user writing `allow = "git"` (string
 * instead of string[]) would produce a runtime value the matchers would iterate
 * character-by-character, auto-approving almost every command. This validator
 * refuses to start with such misconfigurations.
 *
 * Also warns about dangerously short patterns that would match too broadly.
 */
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
  // #809: ollama support was removed outright (no compatibility shim, no
  // silent fallback to a different provider) -- a config that still names it
  // must fail loudly with an actionable next step.
  if (cfg.provider === 'ollama') {
    throw new Error(
      `Invalid auto_approve.provider "ollama" in ${configPath}: ollama support was removed (#809). Switch to provider = "yooz" (the Yooz engine's local LLM module, loopback :19924 on macOS) or provider = "llamacpp" (a thin llama.cpp server, also loopback :19924, elsewhere), and set model to an id the chosen backend serves (e.g. "${DEFAULT_EVAL_MODEL_MLX}" for the engine, "${DEFAULT_EVAL_MODEL_GGUF}" for llama.cpp). Note "llamacpp" currently expects you to run llama-server yourself (remi does not download or supervise it yet, #822): ${llamaServerCommand()}`,
    );
  }
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

  if (cfg.engine !== 'owned' && cfg.engine !== 'shared') {
    throw new Error(
      `Invalid auto_approve.engine in ${configPath}: must be "owned" (remi starts its own engine) or "shared" (a super-yooz host owns it), got ${JSON.stringify(cfg.engine)}. Example: engine = "owned"`,
    );
  }

  if (typeof cfg.model_cache !== 'string') {
    throw new Error(
      `Invalid auto_approve.model_cache in ${configPath}: must be a directory path (empty = the engine's default). Example: model_cache = "/Volumes/S1/huggingface/hub"`,
    );
  }

  if (typeof cfg.engine_path !== 'string') {
    throw new Error(
      `Invalid auto_approve.engine_path in ${configPath}: must be a string path to the engine helper (empty = none bundled). Example: engine_path = "/Applications/Yooz Engine.app/Contents/MacOS/YoozEngine"`,
    );
  }

  if (
    typeof cfg.cache_idle !== 'number' ||
    !Number.isFinite(cfg.cache_idle) ||
    cfg.cache_idle < 0
  ) {
    throw new Error(
      `Invalid auto_approve.cache_idle in ${configPath}: must be a non-negative number (seconds; 0 = never drop the cache), got ${typeof cfg.cache_idle === 'string' ? `string "${cfg.cache_idle}"` : typeof cfg.cache_idle}. Example: cache_idle = 300`,
    );
  }

  if (
    typeof cfg.keep_alive !== 'number' ||
    !Number.isFinite(cfg.keep_alive) ||
    cfg.keep_alive < 0
  ) {
    throw new Error(
      `Invalid auto_approve.keep_alive in ${configPath}: must be a non-negative number (seconds; 0 = never unload), got ${typeof cfg.keep_alive === 'string' ? `string "${cfg.keep_alive}"` : typeof cfg.keep_alive}. Example: keep_alive = 1800`,
    );
  }

  if (
    typeof cfg.hold_timeout !== 'number' ||
    !Number.isFinite(cfg.hold_timeout) ||
    cfg.hold_timeout < 0
  ) {
    throw new Error(
      `Invalid auto_approve.hold_timeout in ${configPath}: must be a non-negative number (seconds; 0 = disable holding), got ${typeof cfg.hold_timeout === 'string' ? `string "${cfg.hold_timeout}"` : typeof cfg.hold_timeout}. Example: hold_timeout = 1800`,
    );
  }

  if (
    typeof cfg.push_hold_timeout !== 'number' ||
    !Number.isFinite(cfg.push_hold_timeout) ||
    cfg.push_hold_timeout < 0
  ) {
    throw new Error(
      `Invalid auto_approve.push_hold_timeout in ${configPath}: must be a non-negative number (seconds; 0 = disable slow-eval push), got ${typeof cfg.push_hold_timeout === 'string' ? `string "${cfg.push_hold_timeout}"` : typeof cfg.push_hold_timeout}. Example: push_hold_timeout = 60`,
    );
  }

  if (
    typeof cfg.delivery_confirm_timeout !== 'number' ||
    !Number.isFinite(cfg.delivery_confirm_timeout) ||
    cfg.delivery_confirm_timeout < 0
  ) {
    throw new Error(
      `Invalid auto_approve.delivery_confirm_timeout in ${configPath}: must be a non-negative number (seconds; 0 = disable delivery gating), got ${typeof cfg.delivery_confirm_timeout === 'string' ? `string "${cfg.delivery_confirm_timeout}"` : typeof cfg.delivery_confirm_timeout}. Example: delivery_confirm_timeout = 6`,
    );
  }

  if (
    typeof cfg.hold_unconfirmed_timeout !== 'number' ||
    !Number.isFinite(cfg.hold_unconfirmed_timeout) ||
    cfg.hold_unconfirmed_timeout < 0
  ) {
    throw new Error(
      `Invalid auto_approve.hold_unconfirmed_timeout in ${configPath}: must be a non-negative number (seconds; 0 = fail open fast when delivery unconfirmed), got ${typeof cfg.hold_unconfirmed_timeout === 'string' ? `string "${cfg.hold_unconfirmed_timeout}"` : typeof cfg.hold_unconfirmed_timeout}. Example: hold_unconfirmed_timeout = 180`,
    );
  }

  // Contradictory pairing: Part B pushes + holds early on a slow eval, but with
  // holding disabled the held hook immediately falls through to passthrough, so
  // the early push buys nothing. Warn (not throw) so the daemon still starts.
  if (cfg.push_hold_timeout > 0 && cfg.hold_timeout === 0) {
    console.warn(
      `[AutoApprove] Warning: push_hold_timeout (${cfg.push_hold_timeout}s) > 0 but hold_timeout = 0 in ${configPath}: the slow-eval early push cannot hold the hook (holding is disabled), so it falls through to passthrough immediately. Set hold_timeout > 0 to actually hold, or push_hold_timeout = 0 to disable the early push.`,
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
  if (!isStringArray(cfg.subagent_alert)) {
    throw new Error(
      `Invalid auto_approve.subagent_alert in ${configPath}: must be an array of strings. Example: subagent_alert = ["rm -rf", "push --force"]`,
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
  if (typeof cfg.session_precedent !== 'boolean') {
    throw new Error(
      `Invalid auto_approve.session_precedent in ${configPath}: must be true or false, got ${typeof cfg.session_precedent}.`,
    );
  }
  for (const t of cfg.always_escalate_tools) {
    if (t.trim().length === 0) {
      console.warn(
        `[AutoApprove] Warning: always_escalate_tools entry "${t}" in ${configPath} is empty/whitespace and will never match a tool name.`,
      );
    }
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

  // An allow entry shaped like a tool name matches that TOOL and is never
  // tested against a Bash command (#536). That is the point of the fix, but it
  // silently changes what a capitalized real binary does: `Rscript`, `MSBuild`
  // and friends look like tool names and stop covering their own commands. The
  // entry keeps working for a tool of that name, so this is a warning rather
  // than an error, but it must not be silent.
  for (const p of cfg.allow) {
    if (looksLikeToolName(p) && !KNOWN_TOOL_NAMES.has(p)) {
      console.warn(
        `[AutoApprove] Warning: allow entry "${p}" is shaped like a tool name, so it matches the ${p} TOOL and never a Bash command containing it. If you meant the shell command, lowercase it or give a longer prefix (e.g. "${p} " with an argument).`,
      );
    }
  }
}

/** Validate `[notifications]` has correct runtime types (#914). */
function validateNotifications(cfg: NotificationsConfig, configPath: string): void {
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
    const tools = env['REMI_AUTO_APPROVE_ALWAYS_ESCALATE']
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (tools.length === 0) {
      console.warn(
        '[AutoApprove] REMI_AUTO_APPROVE_ALWAYS_ESCALATE resolved to an empty list; ' +
          'AskUserQuestion and ExitPlanMode will no longer be structurally escalated. ' +
          'Set it to "AskUserQuestion,ExitPlanMode" to keep the default safety net.',
      );
    }
    (auto_approve as { always_escalate_tools: readonly string[] }).always_escalate_tools = tools;
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
  if (env['REMI_AUTO_APPROVE_HOLD_TIMEOUT']) {
    const parsed = Number.parseInt(env['REMI_AUTO_APPROVE_HOLD_TIMEOUT'], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      (auto_approve as { hold_timeout: number }).hold_timeout = parsed;
    }
  }
  if (env['REMI_AUTO_APPROVE_PUSH_HOLD_TIMEOUT']) {
    const parsed = Number.parseInt(env['REMI_AUTO_APPROVE_PUSH_HOLD_TIMEOUT'], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      (auto_approve as { push_hold_timeout: number }).push_hold_timeout = parsed;
    }
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

# [auto_approve]
# enabled = false
# provider = "${DEFAULT_CONFIG.auto_approve.provider}"
                                # "yooz" (engine, Apple Silicon) | "llamacpp"
                                # (thin llama.cpp server, Linux) | "openrouter"
                                # | custom base URL. Defaulted by platform.
# model = "${DEFAULT_CONFIG.auto_approve.model}"
                                # Fast small default; the eval blocks Claude (#496).
                                # 38/38 on the permission grid, p95 2.26s. The
                                # TouchUp tiers are proofreaders, not classifiers.
                                # "remi model ls" lists what this engine serves;
                                # "remi model use <id>" sets this line for you.
# api_key = ""                  # Required for OpenRouter, empty for the local engine/llama.cpp
# base_url = "http://127.0.0.1:19924"
# timeout = 30                  # Seconds; falls through to user if exceeded
                                # (covers cold model load on the local engine)
# log_decisions = true
#
# User-defined rules, checked BEFORE the LLM. Deny is checked first and wins.
#
# Allow and deny do NOT match the same way, on purpose (#536). Allow is precise:
# a Bash command is split on ; && || | and every segment must either match one
# of your prefixes or be a neutral no-op (cd, pwd, echo, true, :), and anything
# with shell control (backticks, $(), redirects, -exec) is refused even when a
# prefix matches. An entry shaped like a tool name
# ("Read") matches that TOOL and never a command containing the word. Deny stays
# a broad substring match, because a rule meant to stop something should
# over-reach rather than under-reach.
#
# So "Read" here does not allow 'cat file | sh', and "git status" does not allow
# 'git status && rm -rf /'.
# allow = ["git status", "bun test", "bunx biome", "Read", "Glob", "Grep"]
# deny = ["rm -rf /", "sudo ", "curl | sh", "| bash"]
#
# Permission groups: curated, deterministic sets approved with no LLM call.
# Read groups are on by default; the write-side groups are opt-in.
#
#   read-only   Read/Glob/Grep/NotebookRead + cat, grep, ls, jq, ...
#   vcs-read    git status/log/diff/show, gh pr view/list, ...
#   build-test  bun test, tsc --noEmit, biome check, pytest, ...
#   fs-write    Write/Edit/NotebookEdit + mkdir, touch, tee, cp, mv
#   vcs-write   git add/commit/checkout/switch/merge, stash push, worktree add
#   scratch     touch/cp/mv/tee/mkdir/rm/rmdir + output redirection, ONLY when
#               every target resolves under /tmp, /private/tmp, or $TMPDIR
#
# The write groups refuse sensitive destinations regardless of prefix: system
# trees (/etc, /usr, /System, ...), credentials (~/.ssh, ~/.aws, .env, id_rsa),
# .git internals and ~/.gitconfig (a hook write, or core.hooksPath, is code
# execution on the next commit), .github workflows (they execute on push),
# ~/.remi + ~/.claude -- config that governs this very mechanism, which an
# auto-approved write must never be able to widen -- and the BUILD SURFACE
# (package.json, tsconfig.json, lockfiles, Makefile, ...), because build-test
# is enabled by DEFAULT and executes what those files say. scratch instead
# gets its safety entirely from the destination being confined to a scratch
# root, which is why it is the one group allowed to cover deletion and output
# redirection -- rm/rmdir and >/>> are excluded from every OTHER group.
#
# Matching is case-insensitive (macOS filesystems are) and resolves dot-dot.
#
# rm, package installs, git push, and any --force are in NO group EXCEPT
# scratch's own deletion coverage, which stays confined to scratch roots.
# Remote mutation and arbitrary install scripts stay escalations everywhere.
# Strictness preset. Selects which of the groups above are auto-approved:
#
#   strict     read-only + vcs-read + build-test   (the default; today's behavior)
#   balanced   strict   + fs-write + scratch
#   trusted    balanced + vcs-write
#
# An explicit approve_groups below OVERRIDES the preset entirely, and the
# daemon logs that it did -- so a config written before levels existed keeps
# behaving exactly as it always has.
# level = "strict"
# approve_groups = ["read-only", "vcs-read", "build-test"]
# deny_groups = []
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
#                                  # to honor a broad approve policy without
#                                  # its latency on every prompt.
# escalate_timeout = 0             # Seconds for escalate_model; 0 = use timeout.
#                                  # Raise (e.g. 90) for a large, often-cold
#                                  # second-opinion model so its first-call load
#                                  # does not abort into an error->escalate.
# model_cache = ""                # Where the engine downloads weights.
                                   # Empty = its default (~/.cache/huggingface).
                                   # Point at an external disk to keep several
                                   # GB off the boot volume. Applies to an
                                   # engine remi STARTS; an already-running one
                                   # keeps the cache it was started with.
# cache_idle = 300                 # Seconds before remi drops the model's
                                   # prompt cache while keeping it loaded
                                   # (#820 stage 1). Cheap; no cold reload,
                                   # just a recomputed prefix. 0 = never.
# keep_alive = 1800                # Seconds a model stays resident after the
                                   # last eval before remi unloads it (stage
                                   # 2). The engine never evicts on its own.
                                   # 0 = never.
# queue_timeout = 240              # Max seconds an eval waits in the serial
#                                  # queue before escalating. Concurrent evals
#                                  # run one at a time; a deep burst could risk
#                                  # the ~600s hook budget. 0 = no bound.
# hold_timeout = 1800              # Seconds to HOLD a binary permission hook
#                                  # open after escalating, so the user answers
#                                  # it via the hook response (Model B, #573) —
#                                  # no native prompt, no warm-connection race.
#                                  # Large + human-paced; fails open to the
#                                  # native prompt on expiry. 0 = no hold
#                                  # (escalate -> passthrough as before).
# push_hold_timeout = 60           # Push + hold early if a binary main-context
#                                  # eval is still running after this many
#                                  # seconds, so the user can step in while the
#                                  # model keeps thinking (Part B, #573). A late
#                                  # verdict resolves the held hook. 0 = off.
# disable_thinking = true          # Suppress model reasoning. ON by default: a
#                                  # permission classify wants a short JSON
#                                  # verdict, and small models can spend their
#                                  # whole token budget thinking and return
#                                  # nothing at all. Set false to let the model
#                                  # reason (slower, sometimes better on broad
#                                  # custom instructions).
# always_escalate_tools = ["AskUserQuestion", "ExitPlanMode"]
#                                  # Tools that ALWAYS go to the user, never
#                                  # auto-decided by the LLM (design / plan-mode
#                                  # / long-form questions). Add custom MCP tools
#                                  # that solicit user intent.
# session_precedent = false        # Reuse an answer you already gave THIS
#                                  # session for the byte-identical operation,
#                                  # so the third "git push origin feature/x"
#                                  # does not ask a third time. Bounded by risk
#                                  # band: a catastrophic operation still asks
#                                  # every time. Session-scoped and in-memory --
#                                  # for a durable rule use "allow". Setting
#                                  # false does NOT discard an earlier "no";
#                                  # that half always applies. OFF by default
#                                  # until #1019 (a signature carries no cwd).
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
    // Show the RESOLVED list, not the preset name alone (#963). The whole
    // point of `remi config` is that the effective policy is inspectable
    // without reading source, and "level = trusted" does not tell you which
    // groups that is.
    `  level = "${config.auto_approve.level}"`,
  );
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
  lines.push(`  engine = "${config.auto_approve.engine}"`);
  lines.push(`  cache_idle = ${config.auto_approve.cache_idle}`);
  lines.push(`  keep_alive = ${config.auto_approve.keep_alive}`);
  lines.push(`  queue_timeout = ${config.auto_approve.queue_timeout}`);
  lines.push(`  hold_timeout = ${config.auto_approve.hold_timeout}`);
  lines.push(`  push_hold_timeout = ${config.auto_approve.push_hold_timeout}`);
  lines.push(`  delivery_confirm_timeout = ${config.auto_approve.delivery_confirm_timeout}`);
  lines.push(`  hold_unconfirmed_timeout = ${config.auto_approve.hold_unconfirmed_timeout}`);
  lines.push(`  disable_thinking = ${config.auto_approve.disable_thinking}`);
  lines.push(
    `  always_escalate_tools = [${config.auto_approve.always_escalate_tools.map((s) => `"${s}"`).join(', ')}]`,
  );
  lines.push(`  session_precedent = ${config.auto_approve.session_precedent}`);
  lines.push('');
  lines.push('# transcript_binder_enabled is a deprecated kill-switch (#470); flip = restart.');
  lines.push('[features]');
  lines.push(`  transcript_binder_enabled = ${config.features.transcript_binder_enabled}`);
  lines.push('');
  lines.push('[notifications]');
  lines.push(`  on_turn_complete = ${config.notifications.on_turn_complete}`);
  lines.push(`  turn_complete_min_seconds = ${config.notifications.turn_complete_min_seconds}`);

  return lines.join('\n');
}
