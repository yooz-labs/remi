/**
 * CLI help text with grouped use cases and subtle ANSI color.
 *
 * Respects the NO_COLOR env var (https://no-color.org/) and disables
 * color when stdout is not a TTY (piped output).
 */

// ---------------------------------------------------------------------------
// Minimal ANSI color helpers
// ---------------------------------------------------------------------------

function supportsColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

const ESC = '\x1b[';

function bold(text: string): string {
  return supportsColor() ? `${ESC}1m${text}${ESC}0m` : text;
}

function dim(text: string): string {
  return supportsColor() ? `${ESC}2m${text}${ESC}0m` : text;
}

// ---------------------------------------------------------------------------
// Help text sections
// ---------------------------------------------------------------------------

/** Pad command to fixed width and dim the description. */
function entry(cmd: string, desc: string, width = 30): string {
  // A term at or past the column runs straight into its description
  // (`remi authorize <key> --label "name"Name ...`). `padEnd` cannot
  // separate them — it is a no-op once the string is already wide enough — so
  // guarantee one space rather than assuming every term fits.
  return `  ${cmd.padEnd(width)}${cmd.length >= width ? ' ' : ''}${dim(desc)}`;
}

// ---------------------------------------------------------------------------
// Per-command help
// ---------------------------------------------------------------------------

import { configPathForDisplay } from '../config/remi-home.ts';
import type { Subcommand } from './arg-parser.ts';

/** `~/.remi/config.toml`, or the real path under `REMI_HOME` (#1126). */
const CONFIG_HINT = configPathForDisplay();

const commandHelp: Record<Subcommand, string[]> = {
  ls: [
    'List running sessions from a Remi daemon.',
    '',
    bold('Usage:'),
    entry('remi ls', 'List sessions on local daemon'),
    entry('remi ls --host <ip>', 'List sessions on remote daemon'),
    entry('remi ls --network', 'Discover sessions across the network'),
    '',
    bold('Options:'),
    entry('--host HOST', 'Remote daemon host (default: localhost)'),
    entry('--port PORT', 'Daemon port (default: 18765)'),
    entry('--network', 'Use mDNS/VPN discovery'),
  ],
  attach: [
    'Attach your terminal to a running session.',
    '',
    bold('Usage:'),
    entry('remi attach', 'Attach to the most recent session'),
    entry('remi attach <name>', 'Attach to a session by name (prefix match)'),
    entry('remi attach host:port/name', 'Attach to a remote session'),
    entry('remi attach host:port', 'Auto-attach to session on that port'),
    '',
    bold('Options:'),
    entry('--host HOST', 'Remote daemon host'),
    entry('--port PORT', 'Daemon port'),
    '',
    dim('  Detach with Ctrl+B d (like tmux).'),
  ],
  kill: [
    'Kill a running session by name or ID.',
    '',
    bold('Usage:'),
    entry('remi kill <name>', 'Kill by session name (prefix match)'),
    entry('remi kill host:port/name', 'Kill a remote session'),
    entry('remi kill <name> --host <ip>', 'Kill on remote daemon'),
    '',
    bold('Options:'),
    entry('--host HOST', 'Remote daemon host'),
    entry('--port PORT', 'Daemon port'),
  ],
  new: [
    'Create a new Claude Code session.',
    '',
    bold('Usage:'),
    entry('remi new', 'Start session in current directory'),
    entry('remi new /path', 'Start session in directory'),
    entry('remi new --dir <path>', 'Start session in directory'),
    entry('remi new --recent', 'Pick from recent directories'),
    entry('remi new --host <ip>', 'Create on remote daemon (requires no active session)'),
    entry(
      'remi new --host <ip> --harness codex',
      'Create a Codex session there (it must list codex)',
    ),
    entry('remi new -- --resume', 'Pass flags to Claude Code'),
    '',
    bold('Options:'),
    entry('--dir PATH', 'Working directory (mutually exclusive with --recent)'),
    entry('--recent', 'Pick from recent project directories'),
    entry('--host HOST', 'Create session on remote daemon'),
    entry('--port PORT', 'Remote daemon port'),
  ],
  codex: [
    'Start a Codex session with monitoring (checked against Codex 0.160.0 on 2026-10-04; subagent requests not yet).',
    '',
    dim(
      '  Runs `codex --no-alt-screen` in a terminal session the phone can see: the session and its',
    ),
    dim(
      '  status (working, waiting, idle) show up, and so does a command Codex asks to run: answer',
    ),
    dim(
      '  it from the phone or in the terminal, the first answer wins. Other requests (file changes,',
    ),
    dim(
      '  extra permissions, questions) show up as a notice to answer in the terminal. With Codex',
    ),
    dim("  'Approve for me' Codex approves commands itself and remi sees no request."),
    dim('  Turn notifications do not reach the phone yet, and a message typed from the phone is'),
    dim('  refused: type in the terminal.'),
    dim(
      '  remi never starts or stops the shared Codex app-server; if it cannot be reached for 30 s',
    ),
    dim(
      '  it logs that and sends a system message (some clients, the web client today, do not show it).',
    ),
    '',
    bold('Usage:'),
    entry('remi codex', 'Start Codex in the current directory'),
    entry('remi codex "fix the tests"', 'Start Codex with a first prompt'),
    entry('remi codex -m <model>', 'Also allowed: -a, -s, --add-dir, -i, --yolo'),
    entry('', '(-i/--image cannot be combined with resume)'),
    entry('remi codex resume <thread id>', 'Resume a Codex thread (the whole id)'),
    entry('remi --sessions', 'Lists Codex sessions, with the id to resume'),
    entry('remi codex --host <ip> -- -m <model>', 'Start Codex on a remote remi instead'),
    '',
    bold('Options:'),
    entry('--dir PATH', 'Working directory (mutually exclusive with --recent)'),
    entry('--recent', 'Pick from recent project directories'),
    entry('--host HOST', 'Start the session on a remote remi (it must list codex)'),
    entry('--port PORT', 'WebSocket port'),
    '',
    dim('  With --host the words after `--` are not a prompt: the remote remi accepts only'),
    dim('  -m/--model <name>, -a untrusted, -s read-only and `resume <thread id>` (resume is'),
    dim(
      '  unverified headless), and refuses the request otherwise: a remote request may tighten the',
    ),
    dim("  host's approval and sandbox settings, never loosen them. The session has no terminal:"),
    dim('  Codex may wait at an Update or Trust prompt that only a terminal can answer; if it'),
    dim('  does not respond, run `remi attach` on that machine (unverified against a real Codex).'),
    '',
    dim('  remi reads its own flags (-h, --help, -v, --version, --dir, --port, --resume, ...)'),
    dim('  wherever they stand before a `--`, so a Codex flag with the same name cannot be passed'),
    dim('  through remi. Everything after `--` is the first prompt, as text, never a flag: put a'),
    dim('  prompt that starts with a dash there. Any other Codex flag, and every Codex subcommand'),
    dim('  but `resume`, is refused: run codex directly for those.'),
  ],
  recent: [
    'Browse recent project directories from session history.',
    '',
    bold('Usage:'),
    entry('remi recent', 'Show recent directories (local)'),
    entry('remi recent --host <ip>', 'Show recent directories on remote daemon'),
    '',
    bold('Options:'),
    entry('--host HOST', 'Remote daemon host'),
    entry('--port PORT', 'Daemon port'),
  ],
  config: [
    `Show or initialize the configuration file (${CONFIG_HINT}).`,
    '',
    bold('Usage:'),
    entry('remi config', 'Show effective configuration'),
    entry('remi config init', 'Create default config file'),
    entry('remi config path', 'Show config file path'),
    '',
    dim('  Config file provides defaults. CLI flags and env vars take precedence.'),
  ],
  code: [
    'Show or refresh the remote access connection code.',
    '',
    bold('Usage:'),
    entry('remi code', 'Show current connection code'),
    entry('remi code --refresh', 'Generate a new code'),
    '',
    dim('  Use the code in the Remi web/mobile app to connect remotely.'),
    dim('  Codes rotate by default. Use --permanent-code for a fixed code.'),
  ],
  reload: [
    'Reload configuration on all running daemons.',
    '',
    bold('Usage:'),
    entry('remi reload', 'Validate config on all running daemons'),
    '',
    dim(`  Hot-reloads settings from ${CONFIG_HINT}.`),
    dim('  Currently all settings require a daemon restart to take effect.'),
    dim('  Future versions will support hot-reloading select settings.'),
  ],
  model: [
    'Removed in #1125: remi no longer runs a local model to judge permissions.',
    '',
    dim('  Claude Code decides permissions itself now; remi relays what it still asks.'),
    dim('  `remi model` prints this notice and exits 2.'),
  ],
  'migrate-permissions': [
    'Print your old [auto_approve] allow/deny rules as Claude Code permissions.',
    '',
    bold('Usage:'),
    entry('remi migrate-permissions', `Read ${CONFIG_HINT}`),
    entry('remi migrate-permissions <file>', 'Read another config file (exit 1 if missing)'),
    '',
    dim('  remi no longer judges permissions (#1125); Claude Code decides them.'),
    dim('  Prints {"permissions":{"allow":[...],"deny":[...]}} to stdout. An allow'),
    dim('  command becomes Bash(<command>:*); a deny command becomes Bash(<command>*),'),
    dim('  which Claude Code matches only at the start of a command where remi'),
    dim('  matched it anywhere. Known tool names and Tool(...) rules pass through.'),
    dim('  Entries with no faithful form (bare Bash, shell operators, mid-command'),
    dim('  deny patterns like "push --force", groups, level, per-agent sections)'),
    dim('  are listed on stderr under "NOT carried over"; a mid-command allow entry'),
    dim('  is kept as a prefix rule and flagged, since it matches only commands'),
    dim('  that start with it. Never writes a file: paste the block into'),
    dim('  ~/.claude/settings.json yourself.'),
  ],
  unstick: [
    'Resolve and dismiss stuck permission cards on running daemons.',
    '',
    bold('Usage:'),
    entry('remi unstick', 'Unstick every running daemon'),
    entry('remi unstick <port>', 'Unstick only the daemon on <port>'),
    '',
    dim('  The "just get me out" lever when a card is stuck on a phone: every'),
    dim('  open permission card the daemon tracks is resolved and dismissed.'),
  ],
  start: [
    'Start the Remi hub in the background (session-less).',
    '',
    dim('  The hub hosts no Claude session of its own: no conversation appears'),
    dim('  in the app. Create sessions from the app or with `remi new`.'),
    '',
    bold('Usage:'),
    entry('remi start', 'Start hub (prefers port 18765)'),
    entry('remi start --port 9000', 'Start on specific port'),
    '',
    bold('Options:'),
    entry('--port PORT', 'WebSocket port'),
    entry('--bind HOST', 'Bind address (default: 127.0.0.1, loopback only)'),
    entry('--auth / --no-auth', 'Authentication control'),
    entry('--no-relay', 'Disable signaling relay'),
    entry('--no-mdns', 'Disable mDNS advertising'),
    entry('--push-secret SECRET', 'APNS push auth secret'),
    entry('--orphan-timeout SECS', 'Orphan session timeout (default: 300s)'),
    '',
    dim('  Logs: ~/.remi/daemon.log'),
  ],
  serve: [
    'Run the session-less hub in the foreground.',
    '',
    bold('Usage:'),
    entry('remi serve', 'Start the hub (auto-selects free port)'),
    entry('remi serve --port 9000', 'Start hub on specific port'),
    '',
    bold('Options:'),
    entry('--port PORT', 'WebSocket port'),
    entry('--bind HOST', 'Bind address (default: 127.0.0.1, loopback only)'),
    entry('--auth / --no-auth', 'Authentication control'),
    entry('--no-relay', 'Disable signaling relay'),
    entry('--no-mdns', 'Disable mDNS advertising'),
    '',
    dim('  Spawns no session of its own; sessions come from the app or `remi new`.'),
    dim('  `remi start` runs this in the background (the detached equivalent).'),
  ],
  stop: [
    'Stop the background hub.',
    '',
    dim('  Stops only the hub; running session daemons keep serving.'),
    '',
    bold('Usage:'),
    entry('remi stop', 'Stop the running hub'),
    entry('remi stop --all', 'Also stop every session daemon'),
  ],
  status: [
    'Show daemon status.',
    '',
    bold('Usage:'),
    entry('remi status', 'Show PID, port, connections, adapters'),
  ],
  logs: [
    'Show recent daemon logs.',
    '',
    bold('Usage:'),
    entry('remi logs', 'Tail ~/.remi/daemon.log'),
  ],
  keygen: [
    'Generate or manage an Ed25519 identity keypair.',
    '',
    bold('Usage:'),
    entry('remi keygen', 'Generate unencrypted keypair'),
    entry('remi keygen --passphrase', 'Generate keypair encrypted with passphrase'),
    entry('remi keygen --force', 'Overwrite existing identity'),
    entry('remi keygen --decrypt', 'Remove passphrase (keeps same keypair)'),
    entry('remi keygen --encrypt', 'Add passphrase to unencrypted identity'),
    '',
    dim('  Identity stored at ~/.remi/identity.json'),
  ],
  authorize: [
    'Add a client public key to authorized keys.',
    '',
    bold('Usage:'),
    entry('remi authorize <key-file>', 'Authorize a client'),
    entry('remi authorize <key> --label "name"', 'With a label'),
    entry('remi authorize --remove <fp>', 'Remove by fingerprint'),
  ],
  keys: [
    'List authorized client keys.',
    '',
    bold('Usage:'),
    entry('remi keys', 'Show fingerprints, labels, dates'),
  ],
  'export-key': [
    'Export your identity for sharing across devices.',
    '',
    bold('Usage:'),
    entry('remi export-key', 'Export full identity (encrypted)'),
    entry('remi export-key --public-only', 'Export only public key'),
  ],
  'import-key': [
    'Import an identity from a file or stdin.',
    '',
    bold('Usage:'),
    entry('remi import-key <file>', 'Import from file'),
    entry('remi import-key --force', 'Overwrite existing identity'),
    entry('cat key.json | remi import-key', 'Import from stdin'),
  ],
  detach: [
    'Detach from a session without killing it (tmux-style).',
    'The session remains alive and can be re-attached with `remi attach`.',
    '',
    bold('Usage:'),
    entry('remi detach <name>', 'Detach the named session'),
    entry('remi detach <host:port/name>', 'Detach a remote session'),
    '',
    dim('  When attached interactively, press Ctrl+B d to detach.'),
    dim('  Detached sessions show as "detached" in `remi ls`.'),
  ],
};

export function formatCommandHelp(command: string): string {
  if (!(command in commandHelp)) {
    return `No help available for '${command}'. Run 'remi --help' for all commands.`;
  }
  const lines = commandHelp[command as Subcommand];
  return ['', bold(`remi ${command}`), '', ...lines, ''].join('\n');
}

// ---------------------------------------------------------------------------
// Global help
// ---------------------------------------------------------------------------

export function formatHelp(version: string): string {
  const lines: string[] = [
    '',
    bold(`Remi v${version}`) + dim(' - Claude Code with remote monitoring'),
    '',
    bold('Quick Start:'),
    entry('remi', 'Start Claude with monitoring'),
    entry(
      'remi codex',
      'Start Codex with monitoring (command approvals reach the phone; checked live against Codex 0.160.0)',
    ),
    entry('remi ls', 'List running sessions'),
    entry('remi attach [name]', 'Attach to a session (Ctrl+B d to detach)'),
    '',
    bold('Remote Access:'),
    entry('remi ls --host <ip>', 'List sessions on remote machine'),
    entry('remi ls --network', 'Discover sessions across the network'),
    entry('remi new --host <ip>', 'Create session on remote daemon'),
    entry('remi attach host:port/name', 'Attach to remote session'),
    entry('remi kill host:port/name', 'Kill a remote session'),
    entry('remi code', 'Show connection code for phone/browser'),
    entry('remi code --refresh', 'Generate a new connection code'),
    '',
    bold('Session Management:'),
    entry('remi new --dir <path>', 'Start session in directory'),
    entry('remi new /path', 'Start session in directory (shorthand)'),
    entry('remi new --recent', 'Pick from recent directories'),
    entry('remi recent', 'Browse recent project directories'),
    entry('remi kill <name>', 'Kill a session'),
    entry('remi detach [name]', 'Detach from session'),
    entry('remi --resume [id]', 'Resume a previous session'),
    entry('remi codex resume <id>', 'Resume a Codex thread (the whole id)'),
    entry('remi --sessions', 'List running sessions'),
    entry('remi --sessions all', 'List all sessions (including exited)'),
    entry('remi --sessions exited', 'List exited sessions only'),
    '',
    bold('Configuration:'),
    entry('remi config', 'Show effective configuration'),
    entry('remi config init', 'Create default config file'),
    entry('remi reload', 'Hot-reload config on running daemons'),
    entry('remi migrate-permissions', 'Print old allow/deny rules as Claude Code JSON'),
    '',
    bold('Service:'),
    entry('remi start', 'Start the hub in the background'),
    entry('remi stop', 'Stop background daemon (--all: session daemons too)'),
    entry('remi status', 'Show daemon status'),
    entry('remi logs', 'Show daemon logs'),
    entry('remi serve', 'Run the session-less hub in the foreground'),
    entry('remi --daemon', 'Run in headless daemon mode'),
    entry('remi --install / --uninstall', 'Autostart service'),
    '',
    bold('Identity & Auth:'),
    entry('remi keygen', 'Generate Ed25519 keypair'),
    entry('remi authorize <key>', 'Add client public key'),
    entry('remi keys', 'List authorized keys'),
    entry('remi export-key', 'Export identity JSON'),
    entry('remi import-key [file]', 'Import identity from file or stdin'),
    '',
    bold('Options:'),
    entry('--port PORT', 'WebSocket port (default: 18765, env: REMI_PORT)'),
    entry('--host HOST', 'Remote daemon host (default: localhost)'),
    entry('--bind HOST', 'Bind address (default: 127.0.0.1, loopback only)'),
    entry('--local', 'Localhost-only mode'),
    entry('--auth / --no-auth', 'Authentication control'),
    entry('--no-relay', 'Disable relay'),
    entry('--permanent-code', 'Persistent connection code'),
    '',
    entry('--no-mdns', 'Disable mDNS advertising'),
    entry('--no-tofu', 'Reject unknown clients'),
    entry('--push-secret SECRET', 'APNS push auth (env: REMI_PUSH_SECRET)'),
    entry('--orphan-timeout SECS', 'Orphan session timeout (default: 300)'),
    entry('--max-bullet-length N', 'Truncate bullets (default: 500, 0=off)'),
    entry('--force', 'Overwrite identity (keygen/import-key)'),
    entry('--version, -v', 'Show version'),
    entry('--help, -h', 'Show this help'),
    '',
    dim('  Environment: REMI_PORT, REMI_PASSPHRASE, REMI_PUSH_SECRET, REMI_MAX_BULLET_LENGTH'),
    dim('  Pass -- to separate remi flags from Claude Code arguments.'),
    dim('  Unrecognized flags are passed through to Claude Code.'),
    dim("  remi codex: the words after -- are Codex's first prompt, not flags."),
    '',
  ];

  return lines.join('\n');
}
