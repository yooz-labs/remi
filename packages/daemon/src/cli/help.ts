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
    entry('remi --sessions', 'List stored sessions'),
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
