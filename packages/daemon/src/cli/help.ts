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
  return `  ${cmd.padEnd(width)}${dim(desc)}`;
}

// ---------------------------------------------------------------------------
// Per-command help
// ---------------------------------------------------------------------------

import type { Subcommand } from './arg-parser.ts';

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
    entry('remi new -- --resume', 'Pass flags to Claude Code'),
    '',
    bold('Options:'),
    entry('--dir PATH', 'Working directory (mutually exclusive with --recent)'),
    entry('--recent', 'Pick from recent project directories'),
    entry('--host HOST', 'Create session on remote daemon'),
    entry('--port PORT', 'Remote daemon port'),
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
    'Show or initialize the configuration file (~/.remi/config.toml).',
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
    dim('  Hot-reloads settings from ~/.remi/config.toml.'),
    dim('  Currently all settings require a daemon restart to take effect.'),
    dim('  Future versions will support hot-reloading select settings.'),
  ],
  start: [
    'Start the Remi daemon in the background.',
    '',
    bold('Usage:'),
    entry('remi start', 'Start daemon (auto-selects free port)'),
    entry('remi start --port 9000', 'Start on specific port'),
    '',
    bold('Options:'),
    entry('--port PORT', 'WebSocket port'),
    entry('--bind HOST', 'Bind address (default: 0.0.0.0)'),
    entry('--auth / --no-auth', 'Authentication control'),
    entry('--no-relay', 'Disable signaling relay'),
    entry('--no-mdns', 'Disable mDNS advertising'),
    entry('--orphan-timeout SECS', 'Orphan session timeout (default: 300s)'),
    '',
    dim('  Logs: ~/.remi/daemon.log'),
  ],
  stop: [
    'Stop the background daemon.',
    '',
    bold('Usage:'),
    entry('remi stop', 'Stop the running daemon'),
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
    entry('remi --sessions', 'List running sessions'),
    entry('remi --sessions all', 'List all sessions (including exited)'),
    entry('remi --sessions exited', 'List exited sessions only'),
    '',
    bold('Configuration:'),
    entry('remi config', 'Show effective configuration'),
    entry('remi config init', 'Create default config file'),
    entry('remi reload', 'Hot-reload config on running daemons'),
    '',
    bold('Service:'),
    entry('remi start', 'Start daemon in background'),
    entry('remi stop', 'Stop background daemon'),
    entry('remi status', 'Show daemon status'),
    entry('remi logs', 'Show daemon logs'),
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
    entry('--bind HOST', 'Bind address (default: 0.0.0.0)'),
    entry('--local', 'Localhost-only mode'),
    entry('--auth / --no-auth', 'Authentication control'),
    entry('--no-relay', 'Disable relay'),
    entry('--permanent-code', 'Persistent connection code'),
    '',
    entry('--no-mdns', 'Disable mDNS advertising'),
    entry('--no-tofu', 'Reject unknown clients'),
    entry('--orphan-timeout SECS', 'Orphan session timeout (default: 300)'),
    entry('--max-bullet-length N', 'Truncate bullets (default: 500, 0=off)'),
    entry('--force', 'Overwrite identity (keygen/import-key)'),
    entry('--version, -v', 'Show version'),
    entry('--help, -h', 'Show this help'),
    '',
    dim('  Environment: REMI_PORT, REMI_PASSPHRASE, REMI_MAX_BULLET_LENGTH'),
    dim('  Pass -- to separate remi flags from Claude Code arguments.'),
    dim('  Unrecognized flags are passed through to Claude Code.'),
    '',
  ];

  return lines.join('\n');
}
