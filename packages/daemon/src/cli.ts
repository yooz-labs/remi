#!/usr/bin/env bun
/**
 * Remi CLI entry point.
 *
 * Routes subcommands (ls, attach, kill, start, stop, status, logs, new)
 * and wraps Claude Code in the default mode. See --help for full usage.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Version constant - read once at startup with fallback for compiled binaries
const REMI_VERSION = (() => {
  const pkgPath = path.resolve(import.meta.dir, '..', '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (typeof pkg.version !== 'string') {
      console.error('[remi] package.json missing "version" field');
      return '0.3.13'; // REMI_COMPILED_VERSION
    }
    return pkg.version;
  } catch (err) {
    // REMI_COMPILED_VERSION is updated by scripts/bump-version.sh at release time.
    // This fallback is used in compiled binaries where package.json is unavailable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'MODULE_NOT_FOUND') {
      console.error(`[remi] Failed to read version: ${(err as Error).message}`);
    }
    return '0.3.13'; // REMI_COMPILED_VERSION
  }
})();

// ---------------------------------------------------------------------------
// Paths and utilities for log file and status file (used in wrapper mode)
// ---------------------------------------------------------------------------
const REMI_DIR = path.join(os.homedir(), '.remi');
const LOG_FILE = path.join(REMI_DIR, 'remi.log');
const DAEMON_STATUS_FILE = path.join(REMI_DIR, 'daemon-status.json');
// Status file is per-port so multiple wrapper sessions don't overwrite each other.
// The statusline script uses $REMI_PORT to read the correct file.
let STATUS_FILE = path.join(REMI_DIR, 'status.json'); // Updated after PORT is resolved
let logFd: number | null = null;

// In wrapper mode, we save the real stdout file descriptor before overriding.
// Raw PTY bytes are written directly via fs.writeSync to avoid decode/encode.
let ptyStdoutFd: number | null = null;

function ensureRemiDir(): void {
  fs.mkdirSync(REMI_DIR, { recursive: true });
}

function openLogFile(): number {
  ensureRemiDir();
  const fd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(fd, `\n--- Remi session started at ${new Date().toISOString()} ---\n`);
  return fd;
}

function writeToLog(msg: string): void {
  if (logFd === null) return;
  try {
    fs.writeSync(logFd, `${msg}\n`);
  } catch {
    // Silently drop: in wrapper mode, terminal cleanliness is non-negotiable
  }
}

// ---------------------------------------------------------------------------
// Status file for status line integration
// Guard: only writes in wrapper mode (wrapperMode is set during arg parsing)
// ---------------------------------------------------------------------------
type RemiSessionStatus = AgentStatus | 'starting';

interface RemiStatus {
  pid: number;
  connections: number;
  sessionStatus: RemiSessionStatus;
  adapters: string[];
  wsPort: number;
  sessionId: UUID | null;
  repo: string;
  branch: string;
}

function detectGitInfo(): { repo: string; branch: string } {
  try {
    const cwd = process.cwd();
    const repo = path.basename(cwd);
    const headFile = path.join(cwd, '.git', 'HEAD');
    if (fs.existsSync(headFile)) {
      const head = fs.readFileSync(headFile, 'utf-8').trim();
      const branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 8);
      return { repo, branch };
    }
    return { repo, branch: '?' };
  } catch {
    return { repo: path.basename(process.cwd()), branch: '?' };
  }
}

const gitInfo = detectGitInfo();

const remiStatus: RemiStatus = {
  pid: process.pid,
  connections: 0,
  sessionStatus: 'starting',
  adapters: [],
  wsPort: 0,
  sessionId: null,
  repo: gitInfo.repo,
  branch: gitInfo.branch,
};

let statusWriteErrorLogged = false;
let statusWriteTimer: ReturnType<typeof setTimeout> | null = null;

function updateRemiStatus(patch: Partial<RemiStatus>): void {
  Object.assign(remiStatus, patch);
  scheduleStatusWrite();
}

function scheduleStatusWrite(): void {
  if (statusWriteTimer) return;
  statusWriteTimer = setTimeout(() => {
    statusWriteTimer = null;
    writeStatus();
  }, 300);
}

function writeStatus(): void {
  if (!wrapperMode && !cliDaemonMode) return;
  // Daemon mode writes to daemon-status.json; wrapper writes to status.json
  const targetFile = cliDaemonMode ? DAEMON_STATUS_FILE : STATUS_FILE;
  // Atomic write: write to temp file then rename to avoid readers seeing partial JSON
  const tmpFile = `${targetFile}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(remiStatus));
    fs.renameSync(tmpFile, targetFile);
    statusWriteErrorLogged = false;
  } catch (err) {
    if (!statusWriteErrorLogged) {
      writeToLog(`[error] Failed to write status file: ${err}`);
      statusWriteErrorLogged = true;
    }
  }
}

function cleanupStatusFile(): void {
  const targetFile = cliDaemonMode ? DAEMON_STATUS_FILE : STATUS_FILE;
  try {
    fs.unlinkSync(targetFile);
  } catch {
    // File may not exist during cleanup
  }
}

// ---------------------------------------------------------------------------
// Status line script (embedded, written to ~/.remi/statusline.sh)
// Requires 'jq' to be installed on the host system.
// ---------------------------------------------------------------------------
const STATUSLINE_SCRIPT = `#!/bin/bash
input=$(cat)
REMI=""
# REMI_PORT is set by remi when spawning Claude; status file is per-port
REMI_STATUS_FILE="${REMI_DIR}/status-\$REMI_PORT.json"
if [ -n "\$REMI_PORT" ] && [ -f "\$REMI_STATUS_FILE" ]; then
  IFS=\$'\\t' read -r S_PID S_CONNS S_STATUS S_REPO S_BRANCH < <(jq -r '[.pid // 0, .connections // 0, .sessionStatus // "unknown", .repo // "", .branch // ""] | @tsv' "\$REMI_STATUS_FILE" 2>/dev/null)
  if [ -n "\$S_PID" ] && kill -0 "\$S_PID" 2>/dev/null; then
    CLIENT_INFO="no clients"
    [ "\$S_CONNS" != "0" ] && CLIENT_INFO="\${S_CONNS} client(s)"
    REMI="remi :\$REMI_PORT \${S_REPO}:\${S_BRANCH} | \${CLIENT_INFO} | \${S_STATUS}"
  fi
fi
IFS=\$'\\t' read -r C_PCT C_MODEL < <(echo "$input" | jq -r '[(.context_window.used_percentage // 0 | floor), (.model.display_name // "?")] | @tsv' 2>/dev/null)
echo "\${REMI:+\$REMI | }[\${C_MODEL:-?}] \${C_PCT:-0}% context"
`;

function installStatusLine(): void {
  try {
    ensureRemiDir();
    const scriptPath = path.join(REMI_DIR, 'statusline.sh');
    fs.writeFileSync(scriptPath, STATUSLINE_SCRIPT, { mode: 0o755 });

    // Auto-configure Claude Code settings if no statusLine key exists in
    // ~/.claude/settings.json. Preserves all other settings but rewrites the file.
    const claudeSettingsFile = path.join(os.homedir(), '.claude', 'settings.json');
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(claudeSettingsFile)) {
      settings = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf-8'));
    }
    if (!settings['statusLine']) {
      fs.mkdirSync(path.dirname(claudeSettingsFile), { recursive: true });
      settings['statusLine'] = { type: 'command', command: scriptPath };
      fs.writeFileSync(claudeSettingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    }
  } catch (err) {
    writeToLog(`[warn] Failed to install status line: ${err}`);
  }
}

// Load .env file if present
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

import {
  createBulletExpandResponse,
  createCreateSessionResponse,
  createError,
  createHelloAck,
  createKillSessionResponse,
  createRawPtyOutput,
  createReplayBatch,
  createSessionListResponse,
  createTranscriptLoadComplete,
  generateId,
  now,
} from '@remi/shared';
import type {
  AgentStatus,
  DiscoverableSession,
  ProtocolMessage,
  UUID,
  UnlockedIdentity,
} from '@remi/shared';
import { isEncrypted, unlockIdentity } from '@remi/shared';
import {
  type AdapterMetadata,
  AdapterRegistry,
  TelegramAdapter,
  WebSocketAdapter,
} from './adapters/index.ts';
import { MessageAPI } from './api/index.ts';
import { Authenticator } from './auth/authenticator.ts';
import { IdentityStore } from './auth/identity-store.ts';
import { DetachScanner } from './cli/detach-scanner.ts';
import { HookConfigManager, HookEventBridge, HookServer } from './hooks/index.ts';
import { PTYManager, PTYSession } from './pty/index.ts';
import {
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
  SessionRegistry,
  SessionRegistryFile,
  SessionStore,
  type StoredSession,
} from './session/index.ts';
import {
  TranscriptDiscovery,
  TranscriptMessageBridge,
  TranscriptWatcher,
} from './transcript/index.ts';
import type { AssistantEntry } from './transcript/index.ts';

// ---------------------------------------------------------------------------
// Logging: In wrapper mode, all daemon logs go to ~/.remi/remi.log
// ---------------------------------------------------------------------------
let wrapperMode = true; // Default to wrapper mode
let wrapperDetached = false; // Set when local terminal is detached (SIGHUP or Ctrl+B d)

function log(...args: unknown[]): void {
  if (wrapperMode) {
    writeToLog(args.map(String).join(' '));
  } else {
    console.log(...args);
  }
}

function logError(...args: unknown[]): void {
  if (wrapperMode) {
    writeToLog(`[error] ${args.map(String).join(' ')}`);
  } else {
    console.error(...args);
  }
}

// ---------------------------------------------------------------------------
// Resolve directory helper
// ---------------------------------------------------------------------------
function resolveDirectory(
  inputPath: string | null | undefined,
): { resolved: string } | { error: string } {
  if (!inputPath) {
    return { resolved: process.cwd() };
  }

  let resolved = inputPath;
  if (resolved.startsWith('~/')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  } else if (resolved === '~') {
    resolved = os.homedir();
  }
  resolved = path.resolve(resolved);
  if (!fs.existsSync(resolved)) {
    return { error: `Directory not found: ${resolved}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${resolved}` };
  }
  return { resolved };
}

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let cliPort: number | undefined;
let cliNoTelegram = false;
let cliMaxBulletLength: number | undefined;
let cliDaemonMode = false;
let cliSignalingUrl: string | undefined;
let cliNoRelay = false;
let cliResume: string | true | undefined; // true = resume most recent, string = session ID
let cliShowSessions = false;
let cliInstall = false;
let cliUninstall = false;
let cliSubcommand:
  | 'ls'
  | 'attach'
  | 'code'
  | 'keygen'
  | 'export-key'
  | 'import-key'
  | 'authorize'
  | 'keys'
  | 'new'
  | 'kill'
  | 'detach'
  | 'start'
  | 'stop'
  | 'status'
  | 'logs'
  | undefined;
let cliSubcommandArg: string | undefined;
let cliCodeRefresh = false;
let cliPermanentCode = false;
let cliForce = false;
let cliUsePassphrase = false;
let cliNoTofu = false;
let cliAuth: boolean | undefined; // undefined = auto (auth when bind != localhost)
let cliLabel: string | undefined;
let cliPublicOnly = false;
let cliBindHost: string | undefined;
let cliRemoveFingerprint: string | undefined;
let cliNoMdns = false;
let cliNetwork = false;
let cliHost: string | undefined;
const claudeArgs: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const nextArg = args[i + 1];

  if (arg === '--daemon') {
    cliDaemonMode = true;
    wrapperMode = false;
  } else if (arg === '--resume') {
    if (nextArg && !nextArg.startsWith('-')) {
      cliResume = nextArg;
      i++;
    } else {
      cliResume = true;
    }
  } else if (arg === '--sessions') {
    cliShowSessions = true;
  } else if (arg === '--port' && nextArg) {
    cliPort = Number.parseInt(nextArg);
    i++;
  } else if (arg === '--max-bullet-length' && nextArg) {
    cliMaxBulletLength = Number.parseInt(nextArg);
    i++;
  } else if (arg === '--no-telegram') {
    cliNoTelegram = true;
  } else if (arg === '--no-relay') {
    cliNoRelay = true;
  } else if (arg === '--permanent-code') {
    cliPermanentCode = true;
  } else if (arg === '--signaling-url' && nextArg) {
    cliSignalingUrl = nextArg;
    i++;
  } else if (arg === '--install') {
    cliInstall = true;
  } else if (arg === '--uninstall') {
    cliUninstall = true;
  } else if (arg === '--force') {
    cliForce = true;
  } else if (arg === '--passphrase') {
    cliUsePassphrase = true;
  } else if (arg === '--no-tofu') {
    cliNoTofu = true;
  } else if (arg === '--auth') {
    cliAuth = true;
  } else if (arg === '--no-auth') {
    cliAuth = false;
  } else if (arg === '--label' && nextArg) {
    cliLabel = nextArg;
    i++;
  } else if (arg === '--public-only') {
    cliPublicOnly = true;
  } else if (arg === '--bind' && nextArg) {
    cliBindHost = nextArg;
    i++;
  } else if (arg === '--remove' && nextArg) {
    cliRemoveFingerprint = nextArg;
    i++;
  } else if (arg === '--local') {
    cliBindHost = 'localhost';
    // Don't set cliAuth; auto-detection disables auth for localhost already
    cliNoMdns = true;
  } else if (arg === '--no-mdns') {
    cliNoMdns = true;
  } else if (arg === '--network') {
    cliNetwork = true;
  } else if (arg === '--host' && nextArg) {
    cliHost = nextArg;
    i++;
  } else if (arg === '--version' || arg === '-v') {
    console.log(`remi ${REMI_VERSION}`);
    process.exit(0);
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Remi - Claude Code with remote monitoring

Usage:
  remi [claude-args...]          Start Claude with WebSocket monitoring
  remi new [-- claude-args...]   Explicit session creation (alias for remi [args])
  remi kill <name>               Kill a session by name or ID
  remi detach [name]             Detach from current or named session
  remi start                     Start daemon in background
  remi stop                      Stop background daemon
  remi status                    Show daemon status
  remi logs                      Show recent daemon logs
  remi ls                        List live sessions from running daemon
  remi ls --network              Discover and list sessions across the network
  remi attach [session-id]       Attach to a session (detach: Ctrl+B d)
  remi attach host:port/id       Attach to a remote session
  remi code                      Show remote access connection code
  remi code --refresh            Generate a new connection code
  remi keygen                    Generate Ed25519 identity keypair
  remi export-key                Export identity JSON (for sharing across devices)
  remi import-key [file]         Import identity from file or stdin
  remi authorize <key-file>      Add a client's public key to authorized keys
  remi keys                      List authorized keys
  remi --resume [session-id]     Resume a previous session
  remi --sessions                List stored sessions
  remi --daemon                  Daemon mode (headless server, prefer remi start)

Options:
  --port PORT              WebSocket port (default: 18765, env: REMI_PORT)
  --max-bullet-length N    Truncate bullets longer than N chars (default: 500, 0=disabled)
  --no-telegram            Disable Telegram adapter
  --no-relay               Disable signaling relay (no remote access via connection code)
  --permanent-code         Use a persistent connection code (requires Ed25519 auth over relay)
  --signaling-url URL      Signaling server URL (default: wss://remi-signaling.dev-941.workers.dev/connect)
  --bind HOST              Bind WebSocket to HOST (default: 0.0.0.0; use --local for localhost-only)
  --force                  Overwrite existing identity (keygen/import-key)
  --passphrase             Encrypt identity with a passphrase (keygen)
  --auth                   Force enable authentication (default: auto based on --bind)
  --no-auth                Disable authentication (even when binding to all interfaces)
  --no-tofu                Reject unknown clients (disable Trust On First Use)
  --local                  Localhost-only mode (--bind localhost --no-mdns)
  --no-mdns                Disable mDNS network advertising
  --host HOST              Connect to daemon at HOST (for ls/attach; default: localhost)
  --label NAME             Label for authorized key (authorize)
  --public-only            Export only public key (export-key)
  --remove FINGERPRINT     Remove authorized key by fingerprint (authorize)
  --install                Install as autostart service
  --uninstall              Remove autostart service
  --version, -v            Show version
  --help, -h               Show this help

Environment:
  REMI_PORT                WebSocket port
  REMI_MAX_BULLET_LENGTH   Max bullet length before truncation (default: 500, 0=disabled)
  TELEGRAM_BOT_TOKEN       Telegram bot token (enables Telegram adapter)
  REMI_PASSPHRASE              Passphrase for identity operations (avoids interactive prompt)
  TELEGRAM_ENABLED              Set to 'false' to disable Telegram
  TELEGRAM_AUTHORIZED_CHAT_IDS  Comma-separated authorized chat IDs
  TELEGRAM_AUTHORIZED_USER_IDS  Comma-separated authorized user IDs

Any other arguments are passed through to Claude Code.
`);
    process.exit(0);
  } else if (
    arg === 'ls' ||
    arg === 'attach' ||
    arg === 'code' ||
    arg === 'keygen' ||
    arg === 'export-key' ||
    arg === 'import-key' ||
    arg === 'authorize' ||
    arg === 'keys' ||
    arg === 'new' ||
    arg === 'kill' ||
    arg === 'detach' ||
    arg === 'start' ||
    arg === 'stop' ||
    arg === 'status' ||
    arg === 'logs'
  ) {
    cliSubcommand = arg;
    if (
      (arg === 'attach' ||
        arg === 'import-key' ||
        arg === 'authorize' ||
        arg === 'kill' ||
        arg === 'detach') &&
      nextArg &&
      !nextArg.startsWith('-')
    ) {
      cliSubcommandArg = nextArg;
      i++;
    }
    if (arg === 'code' && nextArg === '--refresh') {
      cliCodeRefresh = true;
      i++;
    }
    // For 'new', collect remaining args after '--' as claude args
    if (arg === 'new') {
      for (let j = i + 1; j < args.length; j++) {
        const nextA = args[j];
        if (nextA === '--') continue; // skip bare '--'
        if (nextA) claudeArgs.push(nextA);
      }
      break; // stop processing args
    }
  } else if (
    cliSubcommand &&
    (cliSubcommand === 'import-key' ||
      cliSubcommand === 'authorize' ||
      cliSubcommand === 'attach' ||
      cliSubcommand === 'kill' ||
      cliSubcommand === 'detach') &&
    !cliSubcommandArg &&
    arg &&
    !arg.startsWith('-')
  ) {
    // Positional arg for subcommand (supports flags before or after)
    cliSubcommandArg = arg;
  } else {
    // Pass through to Claude
    if (arg) claudeArgs.push(arg);
  }
}

// Handle --install / --uninstall
if (cliInstall || cliUninstall) {
  const platform = process.platform;
  const home = os.homedir();
  const binaryPath = process.execPath;

  if (platform === 'darwin') {
    const plistName = 'com.yooz.remi.plist';
    const dest = path.join(home, 'Library', 'LaunchAgents', plistName);

    if (cliInstall) {
      const template = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yooz.remi</string>
    <key>ProgramArguments</key>
    <array>
        <string>__REMI_BINARY__</string>
        <string>--daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>__HOME__/.remi/remi-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>__HOME__/.remi/remi-stderr.log</string>
</dict>
</plist>`;
      const content = template.replace(/__REMI_BINARY__/g, binaryPath).replace(/__HOME__/g, home);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
      fs.writeFileSync(dest, content);
      const uid = process.getuid?.() ?? 501;
      const result = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, dest]);
      if (result.exitCode === 0) {
        console.log(`Installed LaunchAgent: ${dest}`);
        console.log('Remi will start automatically on login.');
      } else {
        console.error(`Failed to load LaunchAgent: ${result.stderr.toString()}`);
        process.exit(1);
      }
    } else {
      if (fs.existsSync(dest)) {
        const uid = process.getuid?.() ?? 501;
        Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}`, dest]);
        fs.unlinkSync(dest);
        console.log(`Removed LaunchAgent: ${dest}`);
      } else {
        console.log('No LaunchAgent installed.');
      }
    }
  } else if (platform === 'linux') {
    const serviceDir = path.join(home, '.config', 'systemd', 'user');
    const dest = path.join(serviceDir, 'remi.service');

    if (cliInstall) {
      const template = `[Unit]
Description=Remi - Claude Code Monitor
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath} --daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.writeFileSync(dest, template);
      Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
      const result = Bun.spawnSync(['systemctl', '--user', 'enable', '--now', 'remi.service']);
      if (result.exitCode === 0) {
        console.log(`Installed systemd user service: ${dest}`);
        console.log('Remi will start automatically on login.');
      } else {
        console.error(`Failed to enable service: ${result.stderr.toString()}`);
        process.exit(1);
      }
    } else {
      if (fs.existsSync(dest)) {
        Bun.spawnSync(['systemctl', '--user', 'disable', '--now', 'remi.service']);
        fs.unlinkSync(dest);
        Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
        console.log(`Removed systemd user service: ${dest}`);
      } else {
        console.log('No systemd service installed.');
      }
    }
  } else {
    console.error(`Autostart not supported on ${platform}. Run remi --daemon manually.`);
    process.exit(1);
  }
  process.exit(0);
}

// Handle key management subcommands
if (cliSubcommand === 'keygen') {
  const { runKeygen } = await import('./cli/keygen.ts');
  await runKeygen({
    passphrase: process.env['REMI_PASSPHRASE'],
    usePassphrase: cliUsePassphrase,
    force: cliForce,
  });
  process.exit(0);
}

if (cliSubcommand === 'export-key') {
  const { runKeyExport } = await import('./cli/key-export.ts');
  runKeyExport({ publicOnly: cliPublicOnly });
  process.exit(0);
}

if (cliSubcommand === 'import-key') {
  const { runKeyImport } = await import('./cli/key-import.ts');
  await runKeyImport({ file: cliSubcommandArg, force: cliForce });
  process.exit(0);
}

if (cliSubcommand === 'authorize') {
  const { runAuthorize } = await import('./cli/authorize.ts');
  await runAuthorize({
    input: cliSubcommandArg,
    label: cliLabel,
    remove: cliRemoveFingerprint,
  });
  process.exit(0);
}

if (cliSubcommand === 'keys') {
  const { runListKeys } = await import('./cli/authorize.ts');
  runListKeys();
  process.exit(0);
}

// Handle 'code' subcommand: show or refresh the persistent connection code
if (cliSubcommand === 'code') {
  const { CodeStore } = await import('./remote/code-store.ts');
  const codeStore = new CodeStore();
  if (cliCodeRefresh) {
    const newCode = codeStore.refresh();
    console.log(`New permanent connection code: ${newCode}`);
    console.log('Restart the daemon for the new code to take effect.');
  } else {
    const code = codeStore.load();
    if (code) {
      console.log(`Permanent connection code: ${code}`);
      console.log('Use --permanent-code flag when starting daemon to enable this code.');
    } else {
      const newCode = codeStore.refresh();
      console.log(`Permanent connection code: ${newCode} (newly generated)`);
      console.log('Use --permanent-code flag when starting daemon to enable this code.');
    }
  }
  console.log('\nNote: By default, codes rotate on each reconnect. Use --permanent-code to');
  console.log('persist a fixed code (requires Ed25519 authentication for relay connections).');
  process.exit(0);
}

// Handle daemon lifecycle commands: start, stop, status, logs
if (
  cliSubcommand === 'start' ||
  cliSubcommand === 'stop' ||
  cliSubcommand === 'status' ||
  cliSubcommand === 'logs'
) {
  const dm = await import('./cli/daemon-manager.ts');

  if (cliSubcommand === 'start') {
    const resolvedPort =
      cliPort ?? (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : 18765);
    const extraArgs: string[] = [];
    if (cliBindHost) extraArgs.push('--bind', cliBindHost);
    if (cliAuth === true) extraArgs.push('--auth');
    if (cliAuth === false) extraArgs.push('--no-auth');
    if (cliNoMdns) extraArgs.push('--no-mdns');
    if (cliNoRelay) extraArgs.push('--no-relay');
    if (cliNoTelegram) extraArgs.push('--no-telegram');
    if (cliPermanentCode) extraArgs.push('--permanent-code');
    if (cliSignalingUrl) extraArgs.push('--signaling-url', cliSignalingUrl);
    dm.startDaemon({ port: resolvedPort, extraArgs });
  } else if (cliSubcommand === 'stop') {
    dm.stopDaemon();
  } else if (cliSubcommand === 'status') {
    dm.showDaemonStatus();
  } else {
    dm.showDaemonLogs();
  }

  process.exit(0);
}

// Live sessions registry: shared by subcommands and daemon/wrapper mode.
// Instantiated early so subcommand handlers (ls, attach, kill) can use it.
const liveSessionsRegistry = new SessionRegistryFile();

// Handle 'ls' subcommand: query live sessions from running daemon(s)
if (cliSubcommand === 'ls') {
  const explicitPort =
    cliPort ?? (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : undefined);
  if (cliNetwork) {
    const { runNetworkLs } = await import('./cli/ls-client.ts');
    try {
      await runNetworkLs({
        localPort: explicitPort ?? DEFAULT_BASE_PORT,
        localPorts: liveSessionsRegistry.getLivePorts(),
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (explicitPort || cliHost) {
    // Explicit host/port: query single daemon (original behavior)
    const { runLsClient } = await import('./cli/ls-client.ts');
    try {
      await runLsClient({ host: cliHost ?? 'localhost', port: explicitPort ?? DEFAULT_BASE_PORT });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    // No explicit port: discover all local remi sessions via live registry
    const { runMultiPortLs } = await import('./cli/ls-client.ts');
    try {
      await runMultiPortLs({ registry: liveSessionsRegistry });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
  process.exit(0);
}

// Handle 'kill' subcommand: kill a session by name or ID
if (cliSubcommand === 'kill') {
  if (!cliSubcommandArg) {
    console.error('Usage: remi kill <session-name-or-id>');
    console.error('Run `remi ls` to see live sessions.');
    process.exit(1);
  }
  let resolvedPort =
    cliPort ??
    (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : DEFAULT_BASE_PORT);
  const resolvedHost = cliHost ?? 'localhost';

  // Resolve port from live registry if target matches a known session
  if (!cliPort && !cliHost) {
    const liveMatch =
      liveSessionsRegistry.findByName(cliSubcommandArg) ??
      liveSessionsRegistry.findBySessionId(cliSubcommandArg);
    if (liveMatch) {
      resolvedPort = liveMatch.wsPort;
    }
  }

  const { runKillClient } = await import('./cli/kill-client.ts');
  try {
    await runKillClient({
      host: resolvedHost,
      port: resolvedPort,
      target: cliSubcommandArg,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  process.exit(0);
}

// Handle 'detach' subcommand: detach from a session
if (cliSubcommand === 'detach') {
  // Without args: not meaningful from CLI (Ctrl+B d handles interactive detach)
  // With name: informational only; there's no remote detach protocol yet
  if (!cliSubcommandArg) {
    console.log('To detach from a session interactively, press Ctrl+B d.');
    console.log('To detach a specific session by name: remi detach <session-name>');
    console.log('(Remote detach is not yet implemented; use Ctrl+B d in the attached terminal.)');
  } else {
    console.log('Remote detach of named sessions is not yet implemented.');
    console.log('To detach, press Ctrl+B d in the attached terminal.');
  }
  process.exit(0);
}

// Handle 'attach' subcommand: attach terminal to an orphaned session
if (cliSubcommand === 'attach') {
  const store = new SessionStore();
  let targetSessionId = cliSubcommandArg;
  let resolvedPort =
    cliPort ?? (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : 18765);
  let resolvedHost = cliHost ?? 'localhost';

  // Check for remote attach formats:
  //   host:port/session-id  (e.g., 192.168.0.83:18765/name)
  //   host:port             (e.g., 192.168.0.83:18767 - auto-attach to session on that port)
  // Remote targets have a numeric port between the last colon and first slash (or end of string).
  // Session names (hostname:dir/branch) have a non-numeric directory segment there.
  // Note: a purely numeric directory name (e.g., "8765") would be misidentified as a port.
  const firstSlash = targetSessionId?.indexOf('/') ?? -1;
  const colonIdx = firstSlash > 0 ? targetSessionId?.lastIndexOf(':', firstSlash - 1) : -1;
  const hasRemoteFormat =
    colonIdx != null &&
    colonIdx > 0 &&
    /^\d+$/.test(targetSessionId?.slice(colonIdx + 1, firstSlash) ?? '');

  // Also check for host:port without slash (e.g., 100.79.39.98:18767)
  // Detect trailing copy-paste garbage (e.g., 100.79.39.98:18767idle) and suggest correction
  const { parseHostPort } = await import('./cli/ls-client.ts');
  const hostPortParsed = targetSessionId ? parseHostPort(targetSessionId) : null;
  if (hostPortParsed?.cleaned && targetSessionId) {
    const corrected = `${hostPortParsed.host}:${hostPortParsed.port}`;
    console.error(`Invalid target "${targetSessionId}". Did you mean "${corrected}"?`);
    console.error(`  Run: remi attach ${corrected}`);
    process.exit(1);
  }
  const isHostPort = !hasRemoteFormat && hostPortParsed != null && !hostPortParsed.cleaned;

  if (targetSessionId && hasRemoteFormat) {
    try {
      const { parseRemoteTarget } = await import('./cli/ls-client.ts');
      const remote = parseRemoteTarget(targetSessionId, resolvedPort);
      resolvedHost = remote.host;
      resolvedPort = remote.port;
      targetSessionId = remote.sessionId;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (targetSessionId && isHostPort && hostPortParsed) {
    // Direct host:port attach - auto-attach to the session on that specific port
    resolvedHost = hostPortParsed.host;
    resolvedPort = hostPortParsed.port;
    targetSessionId = undefined; // will be resolved by fetching sessions from that port
    try {
      const { fetchSessions } = await import('./cli/ls-client.ts');
      const sessions = await fetchSessions(resolvedHost, resolvedPort, 5000);
      if (sessions.length === 0) {
        console.error(`No sessions found at ${resolvedHost}:${resolvedPort}.`);
        process.exit(1);
      } else if (sessions.length === 1) {
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        targetSessionId = sessions[0]!.sessionId;
      } else {
        // Multiple sessions on this port; pick the one with canAttach or most recent
        const attachable = sessions.filter((s) => s.canAttach);
        if (attachable.length === 1) {
          // biome-ignore lint/style/noNonNullAssertion: length checked above
          targetSessionId = attachable[0]!.sessionId;
        } else {
          console.error(`Multiple sessions at ${resolvedHost}:${resolvedPort}:`);
          for (const s of sessions) {
            console.error(`  ${s.name ?? s.sessionId.slice(0, 8)}`);
          }
          console.error(
            `Specify the session: remi attach ${resolvedHost}:${resolvedPort}/${sessions[0]?.name ?? sessions[0]?.sessionId.slice(0, 8)}`,
          );
          process.exit(1);
        }
      }
    } catch (err) {
      console.error(
        `Cannot connect to ${resolvedHost}:${resolvedPort}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  } else if (!targetSessionId) {
    // Auto-attach: prefer live registry, fall back to session store
    const liveSessions = liveSessionsRegistry.listLive();
    if (liveSessions.length > 0) {
      // Pick most recent live session
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      const latest = liveSessions[0]!; // Already sorted by startedAt desc
      targetSessionId = latest.sessionId;
      resolvedPort = cliPort ?? latest.wsPort;
    } else {
      // Fall back to session store (for backward compat)
      const sessions = store.list();
      const active = sessions.filter((s) => s.exitedAt === null);
      if (active.length === 0) {
        console.error('No active sessions found. Run `remi ls` to see live sessions.');
        process.exit(1);
      }
      const latest = active.reduce((a, b) =>
        new Date(b.startedAt).getTime() > new Date(a.startedAt).getTime() ? b : a,
      );
      targetSessionId = latest.remiSessionId;
      resolvedPort = cliPort ?? latest.port;
    }
  } else {
    // Try name-based resolution: first check live registry for port, then query daemon(s)
    let resolvedByName = false;

    // Check live registry for name match (fast, no network)
    const liveMatch = liveSessionsRegistry.findByName(targetSessionId);
    if (liveMatch) {
      resolvedPort = cliPort ?? liveMatch.wsPort;
    }

    // Query all live ports (or single port if explicitly set) for session name resolution
    const portsToQuery = cliPort || cliHost ? [resolvedPort] : liveSessionsRegistry.getLivePorts();

    if (portsToQuery.length === 0) {
      portsToQuery.push(resolvedPort); // fall back to default
    }

    try {
      const { fetchSessions } = await import('./cli/ls-client.ts');
      const allSessions: Array<{ session: DiscoverableSession; port: number }> = [];

      const results = await Promise.allSettled(
        portsToQuery.map(async (port) => {
          const sessions = await fetchSessions(resolvedHost, port, 3000);
          return sessions.map((s) => ({ session: s, port }));
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result?.status === 'fulfilled') {
          allSessions.push(...result.value);
        } else if (result?.status === 'rejected') {
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          if (!reason.includes('Cannot connect') && !reason.includes('closed unexpectedly')) {
            const isExpected =
              reason.includes('not found') ||
              reason.includes('ENOENT') ||
              reason.includes('SESSION_CREATE_FAILED');
            if (isExpected) {
              console.error(`\x1b[2m[attach] local port ${portsToQuery[i]}: ${reason}\x1b[0m`);
            } else {
              console.error(`[attach] Failed to query port ${portsToQuery[i]}: ${reason}`);
            }
          }
        }
      }

      const nameMatches = allSessions.filter(
        (entry) =>
          entry.session.name === targetSessionId ||
          entry.session.name?.startsWith(targetSessionId as string),
      );
      if (nameMatches.length === 1) {
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        const match = nameMatches[0]!;
        targetSessionId = match.session.sessionId;
        resolvedPort = cliPort ?? match.port;
        resolvedByName = true;
      } else if (nameMatches.length > 1) {
        console.error(
          `Ambiguous session name "${targetSessionId}" matches ${nameMatches.length} sessions:`,
        );
        for (const m of nameMatches) {
          console.error(`  ${m.session.name ?? m.session.sessionId.slice(0, 8)} (port ${m.port})`);
        }
        console.error('Provide a longer name to disambiguate.');
        process.exit(1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('connect') && !msg.includes('timeout') && !msg.includes('ECONNREFUSED')) {
        log(`[Attach] Failed to query daemon for name resolution: ${msg}`);
      }
    }

    if (!resolvedByName) {
      // Prefix-match session ID from local store
      const all = store.list();
      const matches = all.filter(
        (s) =>
          s.remiSessionId === targetSessionId ||
          s.remiSessionId.startsWith(targetSessionId as string),
      );
      if (matches.length === 1) {
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        const match = matches[0]!;
        resolvedPort = cliPort ?? match.port;
        targetSessionId = match.remiSessionId;
      } else if (matches.length > 1) {
        console.error(
          `Ambiguous session ID "${targetSessionId}" matches ${matches.length} sessions:`,
        );
        for (const m of matches) {
          console.error(`  ${m.remiSessionId.slice(0, 8)}  port=${m.port}`);
        }
        console.error('Provide a longer prefix to disambiguate.');
        process.exit(1);
      } else if (!cliHost) {
        // Not found locally; discover via mDNS + VPN (Tailscale, etc.).
        // Session names are "hostname:dir/branch" (possibly with ":N" dedup suffix).
        // The first colon always separates the hostname.
        const target = targetSessionId as string;
        let foundRemote = false;
        const nameColonIdx = target.indexOf(':');
        if (nameColonIdx > 0) {
          const targetHostname = target.slice(0, nameColonIdx);
          try {
            const { discoverDaemons } = await import('./mdns/mdns-browser.ts');
            const { discoverVpnPeers } = await import('./mdns/vpn-discovery.ts');
            const { fetchSessions } = await import('./cli/ls-client.ts');
            console.error(`Resolving "${target}" via network discovery...`);

            // Run mDNS and VPN discovery in parallel
            const [daemons, vpnPeers] = await Promise.all([
              discoverDaemons({ timeoutMs: 3000 }),
              discoverVpnPeers({ port: resolvedPort, probeTimeoutMs: 2000 }).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                log(`[Attach] VPN discovery failed: ${msg}`);
                return [] as {
                  peer: import('./mdns/vpn-discovery.ts').VpnPeer;
                  host: string;
                  port: number;
                }[];
              }),
            ]);

            // Try mDNS first, fall back to VPN peers
            const mdnsMatch = daemons.find(
              (d: { hostname: string }) => d.hostname === targetHostname,
            );
            const vpnMatch = mdnsMatch
              ? null
              : vpnPeers.find((v) => v.peer.hostname === targetHostname);

            const resolvedDaemon = mdnsMatch
              ? { host: mdnsMatch.host, port: mdnsMatch.port, hostname: mdnsMatch.hostname }
              : vpnMatch
                ? { host: vpnMatch.host, port: vpnMatch.port, hostname: vpnMatch.peer.hostname }
                : null;

            if (resolvedDaemon) {
              // Query all ports on this host (the host may have multiple remi instances)
              const hostPorts = vpnPeers
                .filter((v) => v.host === resolvedDaemon.host)
                .map((v) => v.port);
              const mdnsPorts = daemons
                .filter((d: { host: string }) => d.host === resolvedDaemon.host)
                .map((d: { port: number }) => d.port);
              const allHostPorts = [...new Set([...mdnsPorts, ...hostPorts])].sort((a, b) => a - b);
              if (allHostPorts.length === 0) allHostPorts.push(resolvedDaemon.port);

              // Fetch sessions from all ports on this host
              const portResults = await Promise.allSettled(
                allHostPorts.map(async (port) => {
                  const sessions = await fetchSessions(resolvedDaemon.host, port, 3000);
                  return { port, sessions };
                }),
              );
              const allRemoteSessions: Array<{
                session: DiscoverableSession;
                port: number;
              }> = [];
              let remoteRejections = 0;
              for (const r of portResults) {
                if (r.status === 'fulfilled') {
                  for (const s of r.value.sessions) {
                    allRemoteSessions.push({ session: s, port: r.value.port });
                  }
                } else {
                  remoteRejections++;
                  const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
                  if (
                    !reason.includes('Cannot connect') &&
                    !reason.includes('closed unexpectedly')
                  ) {
                    log(`[attach] remote port query failed: ${reason}`);
                  }
                }
              }
              if (remoteRejections === portResults.length) {
                console.error(
                  `Daemon found on ${resolvedDaemon.hostname} but could not query any port. Check connectivity to ${resolvedDaemon.host}.`,
                );
                process.exit(1);
              }

              const remoteMatches = allRemoteSessions.filter(
                (entry) => entry.session.name === target || entry.session.name?.startsWith(target),
              );
              if (remoteMatches.length === 1) {
                // biome-ignore lint/style/noNonNullAssertion: length checked above
                const match = remoteMatches[0]!;
                targetSessionId = match.session.sessionId;
                resolvedHost = resolvedDaemon.host;
                resolvedPort = match.port;
                foundRemote = true;
                console.error(
                  `Found on ${resolvedDaemon.hostname} (${resolvedDaemon.host}:${match.port})`,
                );
              } else if (remoteMatches.length > 1) {
                console.error(
                  `Ambiguous: ${remoteMatches.length} sessions match on ${resolvedDaemon.hostname}`,
                );
                for (const m of remoteMatches) {
                  console.error(
                    `  ${m.session.name ?? m.session.sessionId.slice(0, 8)} (port ${m.port})`,
                  );
                }
                process.exit(1);
              } else {
                console.error(
                  `Daemon found on ${resolvedDaemon.hostname} but no session matches "${target}".`,
                );
                const available = allRemoteSessions
                  .map((e) => e.session.name ?? e.session.sessionId.slice(0, 8))
                  .join(', ');
                if (available) console.error(`  Available sessions: ${available}`);
              }
            } else {
              console.error(
                `No daemon found for hostname "${targetHostname}" on the network or VPN.`,
              );
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            log(`[Attach] Network discovery error for "${targetHostname}": ${reason}`);
            console.error(`Network discovery failed: ${reason}`);
          }
        }
        if (!foundRemote) {
          console.error(
            `No session found matching "${target}". Run \`remi ls --network\` to see available sessions.`,
          );
          process.exit(1);
        }
      } else {
        console.error(
          `No session found matching "${targetSessionId}". Run \`remi ls\` to see live sessions.`,
        );
        process.exit(1);
      }
    }
  }

  if (!targetSessionId) {
    console.error('No session to attach to. Run `remi ls` to see live sessions.');
    process.exit(1);
  }

  const { runAttachClient } = await import('./cli/attach-client.ts');
  try {
    const result = await runAttachClient({
      host: resolvedHost,
      port: resolvedPort,
      sessionId: targetSessionId,
    });
    process.exit(result.exitCode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Handle --sessions quickly
if (cliShowSessions) {
  const store = new SessionStore();
  const sessions = store.list();
  if (sessions.length === 0) {
    console.log('No stored sessions.');
  } else {
    console.log('Stored sessions:');
    for (const s of sessions) {
      const status = s.exitedAt ? `exited (${s.exitCode})` : 'running';
      const claudeId = s.claudeSessionId ? ` claude:${s.claudeSessionId.slice(0, 8)}` : '';
      console.log(
        `  ${s.remiSessionId.slice(0, 8)}  ${status}  ${s.projectPath}${claudeId}  ${s.startedAt}`,
      );
    }
  }
  process.exit(0);
}

// Handle --resume: look up session and inject claude --resume args
if (cliResume !== undefined) {
  const store = new SessionStore();
  let session: StoredSession | null = null;

  if (cliResume === true) {
    session = store.getMostRecent();
    if (!session) {
      console.error('No sessions to resume. Run `remi --sessions` to see stored sessions.');
      process.exit(1);
    }
  } else {
    // Try exact match first, then prefix match
    session = store.findByRemiSessionId(cliResume as UUID);
    if (!session) {
      const all = store.list();
      session = all.find((s) => s.remiSessionId.startsWith(cliResume as string)) ?? null;
    }
    if (!session) {
      session = store.findByClaudeSessionId(cliResume as string);
    }
    if (!session) {
      console.error(`Session not found: ${cliResume}`);
      console.error('Run `remi --sessions` to see stored sessions.');
      process.exit(1);
    }
  }

  if (!session.claudeSessionId) {
    console.error(
      `Session ${session.remiSessionId.slice(0, 8)} has no Claude session ID (was it too short-lived?).`,
    );
    process.exit(1);
  }

  // Inject --resume into Claude args
  claudeArgs.unshift('--resume', session.claudeSessionId);
  log(
    `Resuming session ${session.remiSessionId.slice(0, 8)} (claude: ${session.claudeSessionId.slice(0, 8)}) in ${session.projectPath}`,
  );

  // Change to stored project path
  try {
    process.chdir(session.projectPath);
  } catch {
    logError(`Cannot change to stored project path: ${session.projectPath}`);
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const portExplicitlySet = !!(cliPort || process.env['REMI_PORT']);
let PORT = cliPort || (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : 0);

// Auto-select port if not explicitly set
if (!portExplicitlySet) {
  const autoPort = liveSessionsRegistry.findAvailablePort(DEFAULT_BASE_PORT, DEFAULT_PORT_RANGE);
  if (autoPort === null) {
    console.error(
      `All remi ports in range ${DEFAULT_BASE_PORT}-${DEFAULT_BASE_PORT + DEFAULT_PORT_RANGE - 1} are in use.`,
    );
    console.error('Use --port to specify a different port, or stop an existing remi session.');
    process.exit(1);
  }
  PORT = autoPort;
}
// Update per-port status file path now that PORT is finalized
STATUS_FILE = path.join(REMI_DIR, `status-${PORT}.json`);

const MAX_BULLET_LENGTH =
  cliMaxBulletLength ??
  (process.env['REMI_MAX_BULLET_LENGTH']
    ? Number.parseInt(process.env['REMI_MAX_BULLET_LENGTH'])
    : 500);
const TELEGRAM_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
const TELEGRAM_ENABLED =
  !cliNoTelegram && process.env['TELEGRAM_ENABLED'] !== 'false' && !!TELEGRAM_TOKEN;
const TELEGRAM_AUTHORIZED_CHAT_IDS = process.env['TELEGRAM_AUTHORIZED_CHAT_IDS']
  ? process.env['TELEGRAM_AUTHORIZED_CHAT_IDS'].split(',').map(Number).filter(Boolean)
  : [];
const TELEGRAM_AUTHORIZED_USER_IDS = process.env['TELEGRAM_AUTHORIZED_USER_IDS']
  ? process.env['TELEGRAM_AUTHORIZED_USER_IDS'].split(',').map(Number).filter(Boolean)
  : [];

// ---------------------------------------------------------------------------
// Core components
// ---------------------------------------------------------------------------
const _ptyManager = new PTYManager();
const transcriptDiscovery = new TranscriptDiscovery();
const transcriptWatchers: Map<UUID, TranscriptWatcher> = new Map();
const sessionStore = new SessionStore();

const sessionRegistry = new SessionRegistry(
  {
    orphanTimeoutMs: 5 * 60 * 1000,
    maxReplayHistory: 1000,
  },
  {
    onSessionCreated: (sessionId) => {
      log(`Session created: ${sessionId}`);
    },
    onSessionClosed: (sessionId, reason) => {
      log(`Session closed: ${sessionId} (reason: ${reason})`);
      const watcher = transcriptWatchers.get(sessionId);
      if (watcher) {
        watcher.stop();
        transcriptWatchers.delete(sessionId);
      }
    },
    onSessionOrphaned: (sessionId) => {
      log(`Session orphaned: ${sessionId} (will timeout in 5 minutes)`);
    },
    onSessionResumed: (sessionId, connectionId) => {
      log(`Session resumed: ${sessionId} by connection ${connectionId}`);
    },
  },
);

// The primary session ID (in wrapper mode, this is the one running in the terminal)
let primarySessionId: UUID | null = null;

// Hook infrastructure (initialized in wrapper mode when hooks are enabled)
let HOOK_PORT = PORT + 100; // Offset by 100 to avoid collisions with other remi WS ports
let hookServer: HookServer | null = null;
let hookConfigManager: HookConfigManager | null = null;

// mDNS publisher (initialized when daemon is network-accessible)
let mdnsPublisher: import('./mdns/mdns-publisher.ts').MdnsPublisher | null = null;

async function startMdnsIfNeeded(
  logFn: (msg: string) => void,
): Promise<import('./mdns/mdns-publisher.ts').MdnsPublisher | null> {
  if (cliNoMdns || isLocalhostBind) return null;
  try {
    const { MdnsPublisher } = await import('./mdns/mdns-publisher.ts');
    const publisher = new MdnsPublisher({
      port: PORT,
      version: REMI_VERSION,
      authEnabled,
      fingerprint: serverFingerprint,
    });
    await publisher.start();
    logFn('[mDNS] Advertising on local network');
    return publisher;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logFn(`[mDNS] Failed to start: ${msg}. Network discovery disabled.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Create session helper (shared between wrapper and daemon modes)
// ---------------------------------------------------------------------------
async function createNewSession(
  sessionId: UUID,
  workingDirectory: string,
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void,
  extraArgs: string[] = [],
  passThrough = false,
): Promise<PTYSession> {
  const sendAndRecord = (message: ProtocolMessage) => {
    sendMessage(sessionId, message);
    sessionRegistry.recordOutgoingMessage(sessionId, message);
  };

  const messageApi = new MessageAPI(
    {
      sessionId: sessionId,
      initialBulletId: 1,
      maxBulletLength: MAX_BULLET_LENGTH,
    },
    {
      onMessageFinalized: (msgId) => {
        log(`Message ${msgId} finalized`);
      },
      onQuestion: (question) => {
        log(`Question detected: ${question.text.substring(0, 50)}...`);
        const msg: ProtocolMessage = {
          type: 'question',
          id: generateId(),
          timestamp: now(),
          question: question,
          sessionId,
        };
        sendAndRecord(msg);
        sessionRegistry.updateQuestion(sessionId, question);
      },
      onStatusChange: (status: AgentStatus, context?: string) => {
        log(`Status: ${status}${context ? ` (${context})` : ''}`);
        const msg: ProtocolMessage = {
          type: 'session_update',
          id: generateId(),
          timestamp: now(),
          session: {
            id: sessionId,
            name: '',
            startedAt: now(),
            status,
            isActive: status !== 'idle',
          },
        };
        sendAndRecord(msg);
        sessionRegistry.updateStatus(sessionId, status);
        updateRemiStatus({ sessionStatus: status });

        const watcher = transcriptWatchers.get(sessionId);
        if (watcher) {
          watcher.forceRead().catch((err) => {
            logError(`[Transcript] forceRead failed for session ${sessionId}:`, err);
          });
        }
      },
    },
  );

  // Hook-based event bridge for status/question detection
  if (hookServer) {
    // Track the Claude session ID so we can filter hook events by session.
    // Before SessionStart fires, we let events through (claudeSessionId is null).
    let claudeSessionId: string | null = null;

    const hookBridge = new HookEventBridge(sessionId, {
      onStatusChange: (status: AgentStatus, context?: string) => {
        messageApi.handleStatusChange(status, context);
      },
      onQuestion: (question) => {
        messageApi.handleQuestion(question);
      },
      onSessionInfo: (hookClaudeSessionId: string, transcriptPath: string) => {
        claudeSessionId = hookClaudeSessionId;
        log(`[Hooks] SessionStart: claude=${hookClaudeSessionId}, transcript=${transcriptPath}`);
        sessionStore.updateClaudeSessionId(sessionId, hookClaudeSessionId);

        // Start transcript watcher immediately using the path from the hook
        if (!transcriptWatchers.has(sessionId) && sessionRegistry.hasSession(sessionId)) {
          startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
        }
      },
    });

    const handlers = hookBridge.hookHandlers();
    hookServer.on('SessionStart', (input) => handlers.onSessionStart?.(input));
    hookServer.on('PreToolUse', (input) => {
      if (claudeSessionId && input.session_id !== claudeSessionId) return;
      handlers.onPreToolUse?.(input);
    });
    hookServer.on('PostToolUse', (input) => {
      if (claudeSessionId && input.session_id !== claudeSessionId) return;
      handlers.onPostToolUse?.(input);
    });
    hookServer.on('Notification', (input) => {
      if (claudeSessionId && input.session_id !== claudeSessionId) return;
      handlers.onNotification?.(input);
    });
    hookServer.on('Stop', (input) => {
      if (claudeSessionId && input.session_id !== claudeSessionId) return;
      handlers.onStop?.(input);
    });

    log(`[Hooks] Event bridge active for session ${sessionId}`);
  }

  // Determine terminal size
  const termSize = passThrough
    ? {
        cols: process.stdout.columns || 120,
        rows: process.stdout.rows || 40,
      }
    : { cols: 120, rows: 40 };

  const ptySession = new PTYSession(
    {
      command: 'claude',
      args: extraArgs,
      cwd: workingDirectory,
      size: termSize,
      env: passThrough ? { REMI_PORT: String(remiStatus.wsPort) } : {},
    },
    {
      onRawData: (data: Uint8Array) => {
        // Write to local terminal (wrapper pass-through mode)
        if (passThrough && ptyStdoutFd !== null && !wrapperDetached) {
          try {
            fs.writeSync(ptyStdoutFd, data);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EPIPE' || code === 'EIO') {
              logError(`Terminal write failed (${code}), initiating shutdown`);
              cleanup().then(() => process.exit(1));
            }
          }
        }

        // Send raw PTY bytes to the actively attached CLI client (if any)
        const session = sessionRegistry.getSession(sessionId);
        if (session?.activeConnectionId) {
          const base64Data = Buffer.from(data).toString('base64');
          const msg = createRawPtyOutput(base64Data, sessionId);
          sendMessage(sessionId, msg);
        }
      },
      onData: (_output: string) => {
        // No PTY output parsing; hooks handle status/questions, transcript handles content
      },
      onExit: (code: number | null) => {
        log(`PTY ${ptySession.id} exited with code ${code}`);
        sessionRegistry.handlePTYExit(sessionId);
        sessionStore.markExited(sessionId, code);

        if (passThrough) {
          cleanup().then(() => {
            process.exit(code ?? 0);
          });
        }
      },
      onError: (error: Error) => {
        logError(`PTY ${ptySession.id} error:`, error);
      },
    },
  );

  sessionRegistry.registerSession(sessionId, workingDirectory, ptySession, messageApi);
  await ptySession.start();

  sessionStore.save({
    remiSessionId: sessionId,
    claudeSessionId: null,
    projectPath: workingDirectory,
    port: PORT,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });

  // Transcript watcher: started by SessionStart hook (provides path directly).
  // Safety net: if hook doesn't fire within 5s, fall back to filesystem discovery.
  setTimeout(() => {
    if (transcriptWatchers.has(sessionId)) return;
    if (!sessionRegistry.hasSession(sessionId)) return;
    logError('[Hooks] SessionStart hook not received, falling back to transcript discovery');
    const transcriptPath = transcriptDiscovery.findLatestTranscript(workingDirectory);
    if (transcriptPath) {
      startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
      extractClaudeSessionId(transcriptPath, sessionId);
    } else {
      logError(
        `[Hooks] Transcript discovery failed for session ${sessionId}. No transcript content available.`,
      );
    }
  }, 5000);

  return ptySession;
}

/** Extract Claude session ID from transcript filename and persist it. */
function extractClaudeSessionId(transcriptPath: string, sessionId: UUID): void {
  // Transcript filenames look like: <encoded-path>_<timestamp>_<claude-session-id>.jsonl
  const basename = path.basename(transcriptPath, '.jsonl');
  const parts = basename.split('_');
  // The Claude session ID is typically the last segment
  if (parts.length >= 2) {
    const candidateId = parts[parts.length - 1];
    // Claude session IDs are UUIDs or similar identifiers
    if (candidateId && candidateId.length >= 8) {
      sessionStore.updateClaudeSessionId(sessionId, candidateId);
      log(`Claude session ID: ${candidateId}`);
    }
  }
}

/** Start watching a transcript file for a session. */
function startTranscriptWatcher(
  sessionId: UUID,
  transcriptPath: string,
  messageApi: MessageAPI,
  sendAndRecord: (message: ProtocolMessage) => void,
): void {
  log(`Watching transcript: ${transcriptPath}`);

  const bridge = new TranscriptMessageBridge({ sessionId }, messageApi, {
    onTranscriptContent: (message) => {
      sendAndRecord(message);
    },
  });

  const watcher = new TranscriptWatcher(
    {
      filePath: transcriptPath,
      readExisting: true,
      pollIntervalMs: 1000,
    },
    {
      onAssistantMessage: (entry: AssistantEntry) => {
        bridge.handleAssistantEntry(entry);
      },
      onUserMessage: (entry) => {
        bridge.handleUserEntry(entry);
      },
      onError: (error) => {
        logError(`[Transcript] Error for session ${sessionId}:`, error.message);
      },
    },
  );

  transcriptWatchers.set(sessionId, watcher);
  watcher.start().catch((error) => {
    logError(`[Transcript] Failed to start watcher for session ${sessionId}:`, error);
  });
}

// ---------------------------------------------------------------------------
// Adapter registry and shared event handlers
// ---------------------------------------------------------------------------
const registry = new AdapterRegistry({
  onAdapterStart: (type) => {
    log(`Adapter '${type}' started`);
    if (!remiStatus.adapters.includes(type)) {
      updateRemiStatus({ adapters: [...remiStatus.adapters, type] });
    }
  },
  onAdapterStop: (type) => {
    log(`Adapter '${type}' stopped`);
    updateRemiStatus({ adapters: remiStatus.adapters.filter((a) => a !== type) });
  },
});

const sendToConnection = (connectionId: UUID, message: ProtocolMessage): void => {
  registry.sendRaw(connectionId, message);
};

const sharedEvents = {
  onConnect: async (connectionId: UUID, metadata: AdapterMetadata) => {
    log(`Client connected: ${connectionId} (${metadata.adapterType})`);

    registry.trackConnection(connectionId, metadata.adapterType);
    updateRemiStatus({ connections: remiStatus.connections + 1 });

    const resumeSessionId = metadata.platformData?.['resumeSessionId'] as UUID | undefined;

    // In wrapper mode, try to attach to the primary session first
    if (wrapperMode && primarySessionId && !resumeSessionId) {
      const session = sessionRegistry.getSession(primarySessionId);
      if (session) {
        const result = sessionRegistry.attachConnection(primarySessionId, connectionId);
        if (result.success) {
          sendToConnection(
            connectionId,
            createHelloAck('1.0.0', primarySessionId, {
              isResume: result.replayMessages.length > 0,
              replayCount: result.replayMessages.length,
              nextBulletId: result.nextBulletId,
            }),
          );
          if (result.replayMessages.length > 0) {
            sendToConnection(
              connectionId,
              createReplayBatch(primarySessionId, result.replayMessages, true),
            );
          }
          log(`Attached connection ${connectionId} to primary session ${primarySessionId}`);
          return;
        }
      }

      // Auto-attach failed (session busy or missing); send hello_ack anyway
      // so utility clients (ls, kill) can proceed with requests
      sendToConnection(connectionId, createHelloAck('1.0.0', primarySessionId));
      log(`Connection ${connectionId} connected without attach (session busy or query client)`);
      return;
    }

    if (resumeSessionId && sessionRegistry.canResume(resumeSessionId)) {
      log(`Resuming session ${resumeSessionId}...`);
      const result = sessionRegistry.attachConnection(resumeSessionId, connectionId);

      if (result.success) {
        sendToConnection(
          connectionId,
          createHelloAck('1.0.0', resumeSessionId, {
            isResume: true,
            replayCount: result.replayMessages.length,
            nextBulletId: result.nextBulletId,
          }),
        );

        if (result.replayMessages.length > 0) {
          sendToConnection(
            connectionId,
            createReplayBatch(resumeSessionId, result.replayMessages, true),
          );
        }

        log(
          `Session ${resumeSessionId} resumed with ${result.replayMessages.length} messages replayed`,
        );
        return;
      }

      log(`Resume failed: ${result.error}, creating new session`);
      sendToConnection(
        connectionId,
        createError(
          'RESUME_FAILED',
          `Could not resume session ${resumeSessionId}: ${result.error}. Creating new session.`,
        ),
      );
    }

    // In daemon mode, accept connection without auto-creating a session.
    // Clients use create_session_request to explicitly create sessions.
    // This avoids spawning unwanted Claude processes when utility clients
    // (ls, kill, attach probes) connect.
    if (!wrapperMode) {
      sendToConnection(connectionId, createHelloAck('1.0.0', '' as UUID));
      log(`Connection ${connectionId} accepted in daemon mode (no auto-session)`);
    } else if (wrapperMode && primarySessionId) {
      // Wrapper mode: resume failed but session exists; send hello_ack
      // so the client can still send queries (ls, kill, etc.)
      sendToConnection(connectionId, createHelloAck('1.0.0', primarySessionId));
      log(`Connection ${connectionId} connected without attach in wrapper mode`);
    } else {
      sendToConnection(connectionId, createError('NO_SESSION', 'No active session available'));
    }
  },

  onDisconnect: async (connectionId: UUID, reason: string) => {
    log(`Client disconnected: ${connectionId}`);
    log(`   Reason: ${reason}`);

    sessionRegistry.detachConnection(connectionId);
    registry.untrackConnection(connectionId);
    updateRemiStatus({ connections: Math.max(0, remiStatus.connections - 1) });
  },

  onUserInput: async (connectionId: UUID, _sessionId: UUID, content: string, raw?: boolean) => {
    log(`User input from ${connectionId}${raw ? ' (raw)' : ''}: ${content}`);

    const session = sessionRegistry.getSessionForConnection(connectionId);
    if (session) {
      if (raw) {
        // Raw terminal input from attach client: write directly without Enter
        try {
          session.pty.write(content);
        } catch (err) {
          log(`[PTY] raw write failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // Structured input from web/mobile client: append Enter
        await session.pty.submitInput(content);
      }
    } else {
      log(`No session found for connection ${connectionId}`);
    }
  },

  onAnswer: async (connectionId: UUID, _questionId: UUID, answer: string) => {
    log(`Answer from ${connectionId}: ${answer}`);

    const session = sessionRegistry.getSessionForConnection(connectionId);
    if (session) {
      await session.pty.submitInput(answer);
      sessionRegistry.updateQuestion(session.sessionId, null);
    } else {
      log(`No session found for connection ${connectionId}`);
    }
  },

  onBulletExpandRequest: (
    connectionId: UUID,
    sessionId: UUID,
    bulletId: number,
    requestId: UUID,
  ) => {
    const session = sessionRegistry.getSession(sessionId);
    if (!session) {
      sendToConnection(connectionId, createError('NOT_FOUND', `Session ${sessionId} not found`));
      return;
    }

    const fullContent = session.messageApi.getFullBulletContent(bulletId);
    if (fullContent === null) {
      sendToConnection(
        connectionId,
        createError('CONTENT_EXPIRED', `Content for bullet ${bulletId} not found or expired`),
      );
      return;
    }

    sendToConnection(connectionId, createBulletExpandResponse(bulletId, fullContent, requestId));
  },

  onSessionListRequest: (connectionId: UUID, requestId: UUID, includeExternal: boolean) => {
    const daemonSessions = sessionRegistry.listSessions();

    let allSessions = [...daemonSessions];

    if (includeExternal) {
      const managedIds = new Set(sessionRegistry.getActiveSessionIds());
      const externalSessions = transcriptDiscovery.discoverSessions(managedIds);
      allSessions = [...daemonSessions, ...externalSessions];
    }

    log(
      `Session list request from ${connectionId}: ${allSessions.length} sessions ` +
        `(${daemonSessions.length} daemon, ${allSessions.length - daemonSessions.length} external)`,
    );
    sendToConnection(connectionId, createSessionListResponse(allSessions, requestId));
  },

  onTranscriptLoadRequest: (connectionId: UUID, sessionId: string, requestId: UUID) => {
    log(`Transcript load request from ${connectionId} for session ${sessionId}`);

    const filePath = transcriptDiscovery.findTranscriptBySessionId(sessionId);
    if (!filePath) {
      sendToConnection(
        connectionId,
        createError('NOT_FOUND', `Transcript for session ${sessionId} not found`),
      );
      return;
    }

    // Create a temporary MessageAPI and bridge to read the transcript
    const messageApi = new MessageAPI({ sessionId: sessionId as UUID });
    let messageCount = 0;

    const bridge = new TranscriptMessageBridge({ sessionId: sessionId as UUID }, messageApi, {
      onTranscriptContent: (message) => {
        messageCount++;
        sendToConnection(connectionId, message);
      },
    });

    const watcher = new TranscriptWatcher(
      {
        filePath,
        readExisting: true,
        pollIntervalMs: 0, // We only want to read existing, not watch
      },
      {
        onAssistantMessage: (entry: AssistantEntry) => {
          bridge.handleAssistantEntry(entry);
        },
        onUserMessage: (entry) => {
          bridge.handleUserEntry(entry);
        },
        onError: (error) => {
          logError(`[TranscriptLoad] Error reading ${sessionId}:`, error.message);
        },
      },
    );

    // Read the transcript file, then send completion
    watcher
      .start()
      .then(() => {
        // Stop the watcher immediately since we only needed to read existing entries
        watcher.stop();
        log(`Transcript load complete for ${sessionId}: ${messageCount} messages`);
        sendToConnection(
          connectionId,
          createTranscriptLoadComplete(sessionId, messageCount, requestId),
        );
      })
      .catch((error) => {
        logError(`[TranscriptLoad] Failed to read ${sessionId}:`, error);
        sendToConnection(
          connectionId,
          createError('LOAD_FAILED', `Failed to load transcript: ${error.message}`),
        );
      });
  },

  onCreateSessionRequest: async (
    connectionId: UUID,
    directory: string | undefined,
    requestId: UUID,
  ) => {
    log(`Create session request from ${connectionId}, directory: ${directory || '(default)'}`);

    const dirResult = resolveDirectory(directory);
    if ('error' in dirResult) {
      logError(`Directory error: ${dirResult.error}`);
      sendToConnection(
        connectionId,
        createCreateSessionResponse(false, requestId, undefined, dirResult.error),
      );
      return;
    }

    const workingDirectory = dirResult.resolved;
    const sessionId = sessionRegistry.createSessionId();

    log(`Creating new session ${sessionId} in ${workingDirectory}...`);

    try {
      await createNewSession(sessionId, workingDirectory, (sid, msg) => {
        const session = sessionRegistry.getSession(sid);
        if (session?.activeConnectionId) {
          sendToConnection(session.activeConnectionId, msg);
        }
      });

      // Attach requesting connection to the new session
      const result = sessionRegistry.attachConnection(sessionId, connectionId);

      if (result.success) {
        sendToConnection(connectionId, createCreateSessionResponse(true, requestId, sessionId));
        // Also send hello_ack so client knows about the new session
        sendToConnection(
          connectionId,
          createHelloAck('1.0.0', sessionId, {
            isResume: false,
            replayCount: 0,
            nextBulletId: 1,
          }),
        );
        log(`Session ${sessionId} created via create_session_request`);
      } else {
        // Clean up the orphaned session to avoid resource leak
        sessionRegistry.closeSession(sessionId, 'forced');
        sendToConnection(
          connectionId,
          createCreateSessionResponse(false, requestId, undefined, result.error),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError('Failed to create session:', msg);
      sendToConnection(connectionId, createCreateSessionResponse(false, requestId, undefined, msg));
    }
  },

  onKillSessionRequest: (connectionId: UUID, sessionId: UUID, requestId: UUID) => {
    log(`Kill session request from ${connectionId} for session ${sessionId}`);

    const session = sessionRegistry.getSession(sessionId);
    if (!session) {
      sendToConnection(
        connectionId,
        createKillSessionResponse(false, requestId, `Session ${sessionId} not found`),
      );
      return;
    }

    const sessionName = session.name;
    log(`Killing session: ${sessionName} (${sessionId})`);

    // Notify attached client before destroying the session
    if (session.activeConnectionId && session.activeConnectionId !== connectionId) {
      sendToConnection(
        session.activeConnectionId,
        createError('SESSION_ENDED', 'Session killed by remote request'),
      );
    }

    sessionRegistry.closeSession(sessionId, 'forced');
    sendToConnection(connectionId, createKillSessionResponse(true, requestId));
    log(`Session killed: ${sessionName}`);
  },

  onTerminalResize: (connectionId: UUID, cols: number, rows: number) => {
    const session = sessionRegistry.getSessionForConnection(connectionId);
    if (session) {
      try {
        session.pty.resize({ cols, rows });
      } catch (err) {
        log(
          `Failed to resize PTY for connection ${connectionId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else {
      log(`Terminal resize ignored: no session for connection ${connectionId}`);
    }
  },

  onError: (connectionId: UUID, error: Error) => {
    logError(`Error from ${connectionId}:`, error);
  },
};

// ---------------------------------------------------------------------------
// Auth setup: auto based on bind host (default 0.0.0.0=on, localhost=off), --auth/--no-auth override
// ---------------------------------------------------------------------------
const bindHost = cliBindHost ?? '0.0.0.0';
const isLocalhostBind = bindHost === 'localhost' || bindHost === '127.0.0.1' || bindHost === '::1';

// Determine whether auth should be enabled
// Default: auth off for localhost, auth on for 0.0.0.0/network binds
// Explicit --auth/--no-auth overrides the default
const authEnabled = cliAuth ?? !isLocalhostBind;

let authenticator: Authenticator | undefined;
let serverFingerprint: string | undefined;

if (authEnabled) {
  const identityStore = new IdentityStore();

  if (!identityStore.exists()) {
    console.log('No identity found. Generating new Ed25519 keypair...');
    try {
      const newIdentity = await identityStore.generate();
      console.log(`Identity created (fingerprint: ${newIdentity.fingerprint})`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Failed to auto-generate identity: ${detail}`);
      console.error('Check permissions on ~/.remi or generate manually with "remi keygen".');
      process.exit(1);
    }
  }

  const storedIdentity = identityStore.load();
  if (!storedIdentity) {
    console.error('Identity file is empty. Run "remi keygen --force" to regenerate.');
    process.exit(1);
  }

  let unlockedIdentity: UnlockedIdentity;

  if (isEncrypted(storedIdentity)) {
    // Encrypted identity: use REMI_PASSPHRASE env var or prompt
    const envPassphrase = process.env['REMI_PASSPHRASE'];
    let passphrase: string;

    if (envPassphrase) {
      passphrase = envPassphrase;
    } else {
      const { promptPassphrase } = await import('./cli/prompt-passphrase.ts');
      passphrase = await promptPassphrase('Passphrase to unlock identity');
    }

    try {
      unlockedIdentity = await unlockIdentity(storedIdentity, passphrase);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Failed to unlock identity: ${detail}`);
      console.error('Wrong passphrase?');
      process.exit(1);
    }
  } else {
    // Unencrypted identity: unlock instantly
    try {
      unlockedIdentity = await unlockIdentity(storedIdentity);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Failed to unlock identity: ${detail}`);
      console.error('Identity file may be corrupt. Run "remi keygen --force" to regenerate.');
      process.exit(1);
    }
  }

  const tofuMode = cliNoTofu ? ('reject' as const) : ('auto-accept' as const);
  authenticator = new Authenticator({ identity: unlockedIdentity, identityStore, tofuMode });
  serverFingerprint = storedIdentity.fingerprint;
  console.log(`Authentication enabled (fingerprint: ${serverFingerprint}, TOFU: ${tofuMode})`);
} else {
  if (!isLocalhostBind) {
    console.warn(
      'WARNING: Authentication disabled on non-localhost bind. ' +
        'The daemon is accessible without authentication on the network.',
    );
  } else {
    console.log('Authentication disabled (localhost binding)');
  }
}

// ---------------------------------------------------------------------------
// Create and register adapters
// ---------------------------------------------------------------------------
const wsAdapter = new WebSocketAdapter(
  {
    port: PORT,
    host: bindHost,
    authenticator,
  },
  sharedEvents,
);
registry.register(wsAdapter);

if (TELEGRAM_ENABLED && TELEGRAM_TOKEN) {
  const telegramAdapter = new TelegramAdapter(
    {
      token: TELEGRAM_TOKEN,
      defaultDirectory: process.cwd(),
      authorizedChatIds: TELEGRAM_AUTHORIZED_CHAT_IDS.length
        ? TELEGRAM_AUTHORIZED_CHAT_IDS
        : undefined,
      authorizedUserIds: TELEGRAM_AUTHORIZED_USER_IDS.length
        ? TELEGRAM_AUTHORIZED_USER_IDS
        : undefined,
    },
    sharedEvents,
  );
  registry.register(telegramAdapter);
}

if (!cliNoRelay) {
  const { RelayAdapter } = await import('./remote/relay-adapter.ts');
  const { generateConnectionCode } = await import('./remote/signaling-client.ts');
  const signalingUrl = cliSignalingUrl ?? 'wss://remi-signaling.dev-941.workers.dev/connect';

  let relayAdapter: InstanceType<typeof RelayAdapter>;

  if (cliPermanentCode) {
    // Permanent code mode: persist code to disk, require Ed25519 auth over relay
    if (!authenticator) {
      console.error(
        'Permanent connection codes require authentication (--auth or non-localhost bind).',
      );
      process.exit(1);
    }
    const { CodeStore } = await import('./remote/code-store.ts');
    const codeStore = new CodeStore();
    const code = codeStore.load() ?? codeStore.refresh();
    relayAdapter = new RelayAdapter(
      { enabled: true, signalingUrl, code, rotateCode: false as const, authenticator },
      sharedEvents,
    );
  } else {
    // Rotating code mode (default): ephemeral code, no Ed25519 auth
    const code = generateConnectionCode();
    relayAdapter = new RelayAdapter(
      { enabled: true, signalingUrl, code, rotateCode: true as const },
      sharedEvents,
    );
  }

  registry.register(relayAdapter);
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------
async function cleanup(): Promise<void> {
  // Restore terminal state before shutting down
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // May already be restored
    }
  }
  process.stdin.pause();

  // Clean up hook infrastructure
  if (hookServer) {
    hookServer.stop();
    hookServer = null;
  }
  if (hookConfigManager) {
    try {
      hookConfigManager.uninstall();
    } catch (err) {
      logError(
        `[Hooks] Failed to uninstall hook config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    hookConfigManager = null;
  }

  if (mdnsPublisher) {
    try {
      await mdnsPublisher.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[mDNS] Error during cleanup: ${msg}`);
    }
    mdnsPublisher = null;
  }

  for (const watcher of transcriptWatchers.values()) {
    watcher.stop();
  }
  transcriptWatchers.clear();
  await registry.stopAll();
  await sessionRegistry.shutdown();
  cleanupStatusFile();

  // Remove from live sessions directory
  if (primarySessionId) {
    liveSessionsRegistry.unregister(primarySessionId);
  }
}

// ---------------------------------------------------------------------------
// Main: Start in wrapper or daemon mode
// ---------------------------------------------------------------------------
if (cliDaemonMode) {
  // Daemon mode: headless server, spawns Claude on WebSocket connect
  console.log('Starting Remi daemon...');
  await registry.startAll();

  mdnsPublisher = await startMdnsIfNeeded(console.log);

  // Write status.json so remi status/start can detect running daemon
  updateRemiStatus({ wsPort: PORT, sessionStatus: 'starting' });

  console.log('');
  console.log('Remi daemon ready!');
  console.log(`  WebSocket: ws://${bindHost}:${PORT}/ws`);
  console.log(`  Port: ${PORT} (use --port to change)`);
  console.log(
    `  Bullet truncation: ${MAX_BULLET_LENGTH > 0 ? `${MAX_BULLET_LENGTH} chars` : 'disabled'}`,
  );
  if (mdnsPublisher?.isRunning) {
    console.log('  mDNS: Advertising on local network');
  }
  if (TELEGRAM_ENABLED) {
    console.log('  Telegram: Bot is running');
  }
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    cleanupStatusFile();
    await cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...');
    cleanupStatusFile();
    await cleanup();
    process.exit(0);
  });
} else {
  // Wrapper mode: spawn Claude immediately, pass through terminal I/O
  // Block ALL output paths to the terminal. In Bun compiled binaries,
  // console.log uses a native path that bypasses process.stdout.write,
  // so we must override both layers. Only the PTY raw byte pass-through
  // (via fs.writeSync to stdout fd) can reach the actual terminal.
  ptyStdoutFd = 1; // stdout file descriptor

  try {
    logFd = openLogFile();
  } catch {
    // Cannot open log file; all output will be silently dropped
  }

  // Layer 1: Override console methods (catches Bun's native console path)
  const toLog = (...args: unknown[]) => writeToLog(args.map(String).join(' '));
  const toLogPrefixed =
    (prefix: string) =>
    (...args: unknown[]) =>
      writeToLog(`[${prefix}] ${args.map(String).join(' ')}`);
  console.log = toLog;
  console.info = toLog;
  console.error = toLogPrefixed('error');
  console.warn = toLogPrefixed('warn');
  console.debug = toLog;

  // Layer 2: Override streams (catches anything that writes directly to streams)
  const streamToLog = (chunk: unknown) => {
    writeToLog(String(chunk).replace(/\n$/, ''));
    return true;
  };
  process.stdout.write = streamToLog as typeof process.stdout.write;
  process.stderr.write = streamToLog as typeof process.stderr.write;

  // Close log fd as the very last thing on process exit
  process.on('exit', () => {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // ignore
      }
      logFd = null;
    }
  });

  // Install status line script (~/.remi/statusline.sh) and auto-configure Claude Code settings
  installStatusLine();
  const workingDirectory = process.cwd();
  const sessionId = sessionRegistry.createSessionId();
  primarySessionId = sessionId;

  updateRemiStatus({ wsPort: PORT, sessionId, sessionStatus: 'starting' });

  // Start WebSocket server silently in the background
  // With auto-port: retry on EADDRINUSE (race condition with another remi starting simultaneously)
  let wsStarted = false;
  const maxPortRetries = portExplicitlySet ? 1 : 3;
  for (let attempt = 0; attempt < maxPortRetries; attempt++) {
    try {
      await registry.startAll();
      log(`WebSocket server listening on ws://${bindHost}:${PORT}/ws`);
      mdnsPublisher = await startMdnsIfNeeded(log);
      wsStarted = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAddrInUse = msg.includes('EADDRINUSE') || msg.includes('in use');

      if (isAddrInUse && !portExplicitlySet && attempt < maxPortRetries - 1) {
        // Auto-port race: another remi grabbed this port. Try next available.
        const nextPort = liveSessionsRegistry.findAvailablePort(
          PORT + 1,
          DEFAULT_PORT_RANGE - (PORT - DEFAULT_BASE_PORT + 1),
        );
        if (nextPort !== null) {
          log(`Port ${PORT} taken, retrying with ${nextPort}`);
          // Tear down old adapter before rebinding
          try {
            await registry.unregister('websocket');
          } catch (teardownErr) {
            const teardownMsg =
              teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
            logError(`Failed to tear down WebSocket adapter on port ${PORT}: ${teardownMsg}`);
          }
          PORT = nextPort;
          STATUS_FILE = path.join(REMI_DIR, `status-${PORT}.json`);
          HOOK_PORT = PORT + 100;
          // Create new WS adapter with updated port
          const retryWsAdapter = new WebSocketAdapter(
            { port: PORT, host: bindHost, authenticator },
            sharedEvents,
          );
          registry.register(retryWsAdapter);
          continue;
        }
      }

      if (isAddrInUse) {
        logError(
          `Port ${PORT} is in use. Remote monitoring disabled. Use --port to specify a different port.`,
        );
      } else {
        logError(`WebSocket server failed to start: ${msg}. Remote monitoring disabled.`);
      }
      break;
    }
  }

  // After port retry, update status with finalized port values
  if (wsStarted) {
    updateRemiStatus({ wsPort: PORT });
    liveSessionsRegistry.register({
      sessionId,
      pid: process.pid,
      wsPort: PORT,
      hookPort: HOOK_PORT,
      projectPath: workingDirectory,
      name: path.basename(workingDirectory),
      startedAt: new Date().toISOString(),
    });
  }

  // Start hook server for Claude Code event detection
  try {
    hookServer = new HookServer(
      { port: HOOK_PORT },
      {
        onError: (err) => logError(`[HookServer] ${err.message}`),
      },
    );
    hookServer.start();
    log(`Hook server listening on ${hookServer.url}`);

    // Configure Claude Code hooks to POST to our server
    hookConfigManager = new HookConfigManager(workingDirectory, hookServer.url);
    hookConfigManager.install();
    log('[Hooks] Claude Code hooks configured');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(
      `Hook server failed to start on port ${HOOK_PORT}: ${msg}. Status detection and question forwarding disabled.`,
    );
    hookServer = null;
    hookConfigManager = null;
  }

  // Create and start the primary PTY session
  const ptySession = await createNewSession(
    sessionId,
    workingDirectory,
    (sid, msg) => {
      const session = sessionRegistry.getSession(sid);
      if (session?.activeConnectionId) {
        sendToConnection(session.activeConnectionId, msg);
      }
      // Raw PTY output is high-volume; only send to attached CLI client, not all viewers
      if (msg.type !== 'raw_pty_output') {
        registry.broadcast(msg);
      }
    },
    claudeArgs,
    true, // pass-through mode
  );

  // Print session name to terminal (useful for 'remi new' and general awareness)
  if (ptyStdoutFd !== null) {
    const managedSession = sessionRegistry.getSession(sessionId);
    if (managedSession) {
      try {
        fs.writeSync(ptyStdoutFd, `Session: ${managedSession.name}\r\n`);
      } catch (err) {
        log(
          `[Wrapper] Failed to write session name: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Set up raw stdin pass-through to PTY with Ctrl+B d detach detection.
  // Uses the extracted DetachScanner module for byte-level scanning.
  function writeToPty(text: string): void {
    if (ptySession.isRunning) {
      try {
        ptySession.write(text);
      } catch (err) {
        log(`[PTY] write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const detachScanner = new DetachScanner({
    onDetach: () => {
      if (ptyStdoutFd !== null) {
        try {
          fs.writeSync(ptyStdoutFd, '\r\n[detached]\r\n');
        } catch (err) {
          log(
            `[Detach] Failed to write detach message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      detachLocalTerminal('keybinding');
    },
    onData: (data) => {
      writeToPty(data.toString());
    },
    timeoutMs: 1000,
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', (chunk: Buffer) => {
    detachScanner.write(chunk);
  });

  // Handle terminal resize
  process.stdout.on('resize', () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    try {
      if (ptySession.isRunning) {
        ptySession.resize({ cols, rows });
      }
    } catch (err) {
      log(`[PTY] resize failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Detach local terminal.
  // SIGHUP (terminal closed): keep PTY + WebSocket alive as background daemon.
  // Ctrl+B d (keybinding): cleanly exit and return the shell to the user.
  function detachLocalTerminal(reason: 'sighup' | 'keybinding'): void {
    if (wrapperDetached) return;
    wrapperDetached = true;

    // Stop reading from stdin
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch (err) {
        log(
          `[Detach] setRawMode restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    process.stdin.pause();
    process.stdin.removeAllListeners('data');

    if (reason === 'sighup') {
      // Terminal closed: keep running as orphaned process
      process.stdin.unref();
      ptyStdoutFd = null;
      log('Local terminal detached (SIGHUP), PTY and WebSocket server still running');
    } else {
      // Ctrl+B d: cleanly shut down and return shell to user
      log('Ctrl+B d pressed, shutting down');
      cleanup().then(() => process.exit(0));
    }
  }

  // SIGHUP: terminal closed (e.g. window closed, SSH disconnect).
  // Detach the local terminal but keep the PTY and server alive.
  process.on('SIGHUP', () => {
    detachLocalTerminal('sighup');
    // Do NOT exit; the event loop keeps running for remote clients and PTY.
  });

  // Forward SIGINT/SIGTERM to PTY instead of exiting
  process.on('SIGINT', () => {
    if (wrapperDetached) return; // No local terminal to forward from
    if (ptySession.isRunning) {
      try {
        // Send Ctrl+C (0x03) to the PTY
        ptySession.write('\x03');
      } catch {
        // PTY may have exited
      }
    }
  });

  process.on('SIGTERM', async () => {
    if (ptySession.isRunning) {
      try {
        ptySession.signal('SIGTERM');
      } catch {
        // ignore
      }
    }
    await cleanup();
    process.exit(0);
  });
}
