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
      return '0.4.16-dev.1'; // REMI_COMPILED_VERSION
    }
    return pkg.version;
  } catch (err) {
    // REMI_COMPILED_VERSION is updated by scripts/bump-version.sh at release time.
    // This fallback is used in compiled binaries where package.json is unavailable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'MODULE_NOT_FOUND') {
      console.error(`[remi] Failed to read version: ${(err as Error).message}`);
    }
    return '0.4.16-dev.1'; // REMI_COMPILED_VERSION
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
      try {
        settings = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf-8'));
      } catch {
        console.error(`[warn] Claude settings file is corrupted: ${claudeSettingsFile}`);
        return;
      }
    }
    if (!settings['statusLine']) {
      fs.mkdirSync(path.dirname(claudeSettingsFile), { recursive: true });
      settings['statusLine'] = { type: 'command', command: scriptPath };
      fs.writeFileSync(claudeSettingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    }
  } catch (err) {
    // console.error works in both wrapper and daemon mode
    console.error(`[warn] Failed to install status line: ${err}`);
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
  createResumeSessionResponse,
  createSessionHistoryResponse,
  createSessionListResponse,
  createStructuredAgentOutput,
  createTranscriptLoadComplete,
  generateId,
  now,
} from '@remi/shared';
import type {
  AgentStatus,
  ProtocolMessage,
  RecentDirectory,
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
import {
  CONFIG_PATH,
  applyEnvOverrides,
  formatConfig,
  initConfigFile,
  loadConfig,
} from './config/index.ts';
import type { RemiConfig } from './config/index.ts';
import { HookConfigManager, HookEventBridge, HookServer } from './hooks/index.ts';
import { OutputProcessor } from './parser/output-processor.ts';
import { PTYManager, PTYSession } from './pty/index.ts';
import {
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
  SessionRegistry,
  SessionRegistryFile,
  SessionStore,
  type StoredSession,
} from './session/index.ts';
import { findAvailableTcpPort } from './session/port-utils.ts';
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
let sighupTimeoutId: ReturnType<typeof setTimeout> | null = null; // Orphan shutdown timer after SIGHUP

/** Cancel the SIGHUP orphan timeout when a remote client attaches. */
function cancelOrphanTimeout(): void {
  if (sighupTimeoutId !== null) {
    clearTimeout(sighupTimeoutId);
    sighupTimeoutId = null;
    log('[SIGHUP] Orphan timeout cancelled: remote client attached');
  }
}

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
// Shell PATH resolution (for LaunchAgent/systemd where PATH is minimal)
// ---------------------------------------------------------------------------

/**
 * Resolve the user's full PATH from their login shell.
 * LaunchAgents and systemd services inherit a minimal PATH that doesn't
 * include user-installed tools (e.g. ~/.local/bin, Homebrew, ~/.bun/bin).
 *
 * Strategy:
 * 1. Run both login shell (`zsh -l`) and interactive login shell (`zsh -l -i`)
 * 2. Merge all discovered entries (login shell may have .zprofile paths,
 *    interactive may have .zshrc paths like Homebrew or nvm)
 * 3. Merge well-known tool directories as a final fallback
 * 4. Verify `claude` is findable; warn if not
 */
function resolveShellPath(): void {
  const shell = process.env['SHELL'] || '/bin/zsh';
  const currentEntries = (process.env['PATH'] || '').split(':').filter(Boolean);
  const allEntries = new Set(currentEntries);

  // Run both shells and merge all discovered PATH entries.
  // Login shell sources .zprofile; interactive login shell also sources .zshrc.
  const attempts: Array<{ flags: string[]; label: string }> = [
    { flags: ['-l', '-c', 'echo $PATH'], label: 'login' },
    { flags: ['-l', '-i', '-c', 'echo $PATH'], label: 'interactive login' },
  ];

  let anyShellSucceeded = false;
  for (const { flags, label } of attempts) {
    try {
      const result = Bun.spawnSync([shell, ...flags], {
        env: process.env,
        timeout: 5000,
      });
      if (result.exitCode !== 0) {
        const stderr = result.stderr?.toString().trim() || '(no stderr)';
        log(`[PATH] ${label} shell exited with code ${result.exitCode}: ${stderr}`);
        continue;
      }
      const shellPath = result.stdout?.toString().trim();
      if (!shellPath) {
        log(`[PATH] ${label} shell returned empty PATH`);
        continue;
      }

      anyShellSucceeded = true;
      for (const entry of shellPath.split(':')) {
        if (entry) allEntries.add(entry);
      }
    } catch (err) {
      logError(`[PATH] ${label} shell failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: merge well-known directories if no shell succeeded
  if (!anyShellSucceeded) {
    const home = os.homedir();
    const wellKnownDirs = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      `${home}/.bun/bin`,
      `${home}/.local/bin`,
      '/usr/local/bin',
    ];
    for (const d of wellKnownDirs) {
      if (!allEntries.has(d) && fs.existsSync(d)) allEntries.add(d);
    }
    log('[PATH] Shell resolution failed, merged well-known directories');
  }

  const merged = [...allEntries].join(':');
  if (merged !== (process.env['PATH'] || '')) {
    process.env['PATH'] = merged;
    log(`[PATH] Resolved ${allEntries.size} entries (was ${currentEntries.length})`);
  }

  // Verify claude is findable after PATH resolution
  try {
    const which = Bun.spawnSync(['which', 'claude'], { env: process.env, timeout: 2000 });
    if (which.exitCode !== 0) {
      logError(
        '[PATH] WARNING: "claude" not found in PATH after resolution. ' +
          'Session creation will fail. Ensure claude is installed and in PATH.',
      );
    }
  } catch {
    // which command itself failed; non-fatal
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
import { parseArgs, parseHostPath } from './cli/arg-parser.ts';
import { formatCommandHelp, formatHelp } from './cli/help.ts';

const parsedArgs = parseArgs(process.argv.slice(2));

if (parsedArgs.error) {
  console.error(parsedArgs.error);
  process.exit(1);
}
if (parsedArgs.showVersion) {
  console.log(`remi ${REMI_VERSION}`);
  // Show binary location to help diagnose PATH conflicts (e.g., old binary shadowing new install).
  // In compiled binaries, argv[0] is the binary itself. When running from source via
  // `bun packages/daemon/src/cli.ts`, argv[0] is the bun runtime and argv[1] is the script.
  const binaryPath =
    typeof Bun !== 'undefined' ? Bun.argv[0] : (process.argv[1] ?? process.argv[0]);
  console.log(`binary: ${binaryPath}`);
  process.exit(0);
}
if (parsedArgs.showHelp) {
  if (parsedArgs.subcommand) {
    console.log(formatCommandHelp(parsedArgs.subcommand));
  } else {
    console.log(formatHelp(REMI_VERSION));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Load config file (before consuming parsed args, so config provides defaults)
// ---------------------------------------------------------------------------
let remiConfig: RemiConfig;
try {
  remiConfig = applyEnvOverrides(loadConfig());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Handle 'config' subcommand
if (parsedArgs.subcommand === 'config') {
  const configArg = parsedArgs.subcommandArg;
  if (configArg === 'init') {
    try {
      const created = initConfigFile();
      console.log(`Config file created: ${created}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (configArg === 'path') {
    console.log(CONFIG_PATH);
  } else {
    console.log(formatConfig(remiConfig));
  }
  process.exit(0);
}

// Handle 'reload' subcommand
if (parsedArgs.subcommand === 'reload') {
  const liveSessions = new SessionRegistryFile().listLive();
  if (liveSessions.length === 0) {
    console.error('No running daemons found.');
    process.exit(1);
  }
  let reloaded = 0;
  for (const entry of liveSessions) {
    try {
      process.kill(entry.pid, 'SIGUSR1');
      console.log(`Sent reload signal to ${entry.name} (PID ${entry.pid}, port ${entry.wsPort})`);
      reloaded++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        console.error(`Process ${entry.pid} not found (stale session entry)`);
      } else {
        console.error(
          `Failed to signal PID ${entry.pid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (reloaded > 0) {
    console.log(`Reloaded ${reloaded} daemon(s).`);
    process.exit(0);
  } else {
    console.error('Failed to reload any daemons (all session entries appear stale).');
    process.exit(1);
  }
}

// Destructure into existing variable names for zero downstream changes
const cliPort = parsedArgs.port;
const cliNoTelegram = parsedArgs.noTelegram;
const cliMaxBulletLength = parsedArgs.maxBulletLength;
const cliDaemonMode = parsedArgs.daemonMode;
const cliSignalingUrl = parsedArgs.signalingUrl;
const cliNoRelay = parsedArgs.noRelay;
const cliResume = parsedArgs.resume;
const cliShowSessions = parsedArgs.showSessions;
const cliInstall = parsedArgs.install;
const cliUninstall = parsedArgs.uninstall;
const cliSubcommand = parsedArgs.subcommand;
const cliSubcommandArg = parsedArgs.subcommandArg;
const cliCodeRefresh = parsedArgs.codeRefresh;
const cliPermanentCode = parsedArgs.permanentCode;
const cliForce = parsedArgs.force;
const cliUsePassphrase = parsedArgs.usePassphrase;
const cliNoTofu = parsedArgs.noTofu;
const cliAuth = parsedArgs.auth;
const cliLabel = parsedArgs.label;
const cliPublicOnly = parsedArgs.publicOnly;
const cliBindHost = parsedArgs.bindHost;
const cliRemoveFingerprint = parsedArgs.removeFingerprint;
const cliNoMdns = parsedArgs.noMdns;
const cliNetwork = parsedArgs.network;
const cliHost = parsedArgs.host;
const cliDir = parsedArgs.dir;
const cliRecent = parsedArgs.recent;
const cliOrphanTimeout = parsedArgs.orphanTimeout;
const claudeArgs = [...parsedArgs.claudeArgs];

if (cliDaemonMode) {
  wrapperMode = false;
}

// ---------------------------------------------------------------------------
// Resolve remote target from positional arg (host:port/session format)
// Runs once for subcommands that accept session targets (attach, kill, detach)
// ---------------------------------------------------------------------------
import { type ResolvedTarget, TargetParseError, resolveTarget } from './cli/target-resolver.ts';

const envPort = process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : undefined;
let resolved: ResolvedTarget = {
  host: cliHost ?? 'localhost',
  port: cliPort ?? envPort ?? DEFAULT_BASE_PORT,
  targetId: cliSubcommandArg,
};
if (cliSubcommand === 'attach' || cliSubcommand === 'kill' || cliSubcommand === 'detach') {
  try {
    resolved = resolveTarget({
      subcommandArg: cliSubcommandArg,
      cliHost,
      cliPort: cliPort ?? envPort,
      defaultPort: DEFAULT_BASE_PORT,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    if (err instanceof TargetParseError && err.suggestion) {
      console.error(`  Run: remi ${cliSubcommand} ${err.suggestion}`);
    }
    process.exit(1);
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
    // Only pass port if user explicitly set --port flag.
    // Do NOT inherit REMI_PORT from env (it's set by wrapper sessions and
    // would conflict). The daemon finds its own free port.
    const explicitPort = cliPort;
    const extraArgs: string[] = [];
    if (cliBindHost) extraArgs.push('--bind', cliBindHost);
    if (cliAuth === true) extraArgs.push('--auth');
    if (cliAuth === false) extraArgs.push('--no-auth');
    if (cliNoMdns) extraArgs.push('--no-mdns');
    if (cliNoRelay) extraArgs.push('--no-relay');
    if (cliNoTelegram) extraArgs.push('--no-telegram');
    if (cliPermanentCode) extraArgs.push('--permanent-code');
    if (cliSignalingUrl) extraArgs.push('--signaling-url', cliSignalingUrl);
    if (cliOrphanTimeout !== undefined)
      extraArgs.push('--orphan-timeout', String(cliOrphanTimeout));
    await dm.startDaemon({ port: explicitPort, extraArgs });
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
  } else if (explicitPort) {
    // Explicit port: query single daemon on given (or default) host
    const { runLsClient } = await import('./cli/ls-client.ts');
    try {
      await runLsClient({ host: cliHost ?? 'localhost', port: explicitPort });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (cliHost) {
    // Host without port: probe the standard port range on that host
    const { runHostLs, getDefaultPortRange } = await import('./cli/ls-client.ts');
    try {
      await runHostLs({ host: cliHost, ports: getDefaultPortRange() });
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

// Handle 'recent' subcommand: browse recent project directories
if (cliSubcommand === 'recent') {
  const explicitPort =
    cliPort ?? (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : undefined);

  if (cliHost || explicitPort) {
    // Remote mode: query a daemon via WebSocket
    const { runRecentClient } = await import('./cli/recent-client.ts');
    try {
      await runRecentClient({
        host: cliHost ?? 'localhost',
        port: explicitPort ?? DEFAULT_BASE_PORT,
      });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    // Local mode: read SessionStore directly
    const store = new SessionStore();
    const { renderRecentDirectories } = await import('./cli/recent-client.ts');
    const directories = getRecentDirectories(store, 20);
    renderRecentDirectories(directories);
  }
  process.exit(0);
}

// Handle 'kill' subcommand: kill a session by name or ID
if (cliSubcommand === 'kill') {
  if (!resolved.targetId) {
    console.error('Usage: remi kill <session-name-or-id>');
    console.error('  Examples: remi kill my-session');
    console.error('            remi kill host:port/session-name');
    console.error('            remi kill my-session --host 192.168.1.1');
    console.error('Run `remi ls` to see live sessions.');
    process.exit(1);
  }
  let resolvedPort = resolved.port;

  // Resolve port from live registry if target matches a known local session
  if (!cliPort && resolved.host === 'localhost') {
    const liveMatch =
      liveSessionsRegistry.findByName(resolved.targetId) ??
      liveSessionsRegistry.findBySessionId(resolved.targetId);
    if (liveMatch) {
      resolvedPort = liveMatch.wsPort;
    }
  }

  const { runKillClient } = await import('./cli/kill-client.ts');
  try {
    await runKillClient({
      host: resolved.host,
      port: resolvedPort,
      target: resolved.targetId,
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
  if (!resolved.targetId) {
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
  let targetSessionId = resolved.targetId;
  let resolvedPort = resolved.port;
  let resolvedHost = resolved.host;

  const hasExplicitRemoteTarget =
    resolvedHost !== 'localhost' ||
    (resolvedHost === 'localhost' && cliSubcommandArg?.includes(':'));
  if (!targetSessionId && hasExplicitRemoteTarget) {
    // host:port without session ID (auto-attach to session on that port)
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
    const {
      AmbiguousSessionError,
      FETCH_SESSIONS_TIMEOUT_MS,
      discoverNetworkDaemons,
      findEndpointsByHostname,
      queryMultiplePorts,
      resolveSession,
    } = await import('./cli/session-resolver.ts');

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
      const queryResults = await queryMultiplePorts({
        host: resolvedHost,
        ports: portsToQuery,
        timeoutMs: FETCH_SESSIONS_TIMEOUT_MS,
        logLabel: 'attach',
      });

      const resolved = resolveSession(queryResults, targetSessionId as string);
      if (resolved) {
        targetSessionId = resolved.session.sessionId;
        resolvedPort = cliPort ?? resolved.port;
        resolvedByName = true;
      }
    } catch (err) {
      if (err instanceof AmbiguousSessionError) {
        console.error(err.message);
        process.exit(1);
      }
      const msg = err instanceof Error ? err.message : String(err);
      const { classifyQueryError } = await import('./cli/session-resolver.ts');
      if (classifyQueryError(msg) === 'unexpected') {
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
            console.error(`Resolving "${target}" via network discovery...`);

            const discovery = await discoverNetworkDaemons({
              defaultPort: resolvedPort,
              logLabel: 'attach',
            });

            // Log discovery results for diagnostics
            if (discovery.endpoints.length > 0) {
              const hosts = [...new Set(discovery.endpoints.map((e) => e.hostname))];
              console.error(
                `\x1b[2mFound ${discovery.endpoints.length} daemon(s); ` +
                  `hosts: [${hosts.join(', ')}]\x1b[0m`,
              );
            } else {
              console.error('No daemons discovered (0 mDNS, 0 VPN). Is Tailscale running?');
            }

            const hostEndpoints = findEndpointsByHostname(discovery, targetHostname);

            if (hostEndpoints.length > 0) {
              // Scan default range plus any non-default ports discovery reported
              const { getDefaultPortRange } = await import('./cli/ls-client.ts');
              const discoveredPorts = hostEndpoints.map((e) => e.port);
              const allHostPorts = [
                ...new Set([...getDefaultPortRange(), ...discoveredPorts]),
              ].sort((a, b) => a - b);
              const remoteHost = hostEndpoints[0]?.host ?? targetHostname;
              const remoteHostname = hostEndpoints[0]?.hostname ?? targetHostname;

              const portResults = await queryMultiplePorts({
                host: remoteHost,
                ports: allHostPorts,
                timeoutMs: FETCH_SESSIONS_TIMEOUT_MS,
                logLabel: 'attach',
              });

              if (portResults.length === 0) {
                console.error(
                  `Daemon found on ${remoteHostname} but could not query any port. Check connectivity to ${remoteHost}.`,
                );
                process.exit(1);
              }

              try {
                const remoteResolved = resolveSession(portResults, target);
                if (remoteResolved) {
                  targetSessionId = remoteResolved.session.sessionId;
                  resolvedHost = remoteResolved.host;
                  resolvedPort = remoteResolved.port;
                  foundRemote = true;
                  console.error(
                    `Found on ${remoteHostname} (${remoteResolved.host}:${remoteResolved.port})`,
                  );
                } else {
                  console.error(
                    `Daemon found on ${remoteHostname} but no session matches "${target}".`,
                  );
                  const available = portResults
                    .flatMap((r) => r.sessions)
                    .map((s) => s.name ?? s.sessionId.slice(0, 8))
                    .join(', ');
                  if (available) console.error(`  Available sessions: ${available}`);
                }
              } catch (resolveErr) {
                if (resolveErr instanceof AmbiguousSessionError) {
                  console.error(
                    `Ambiguous: ${resolveErr.matches.length} sessions match on ${remoteHostname}`,
                  );
                  for (const m of resolveErr.matches) {
                    console.error(`  ${m.name} (port ${m.port})`);
                  }
                  process.exit(1);
                }
                throw resolveErr;
              }
            } else {
              console.error(
                `No daemon found for hostname "${targetHostname}" on the network or VPN.`,
              );
            }
          } catch (err) {
            if (err instanceof AmbiguousSessionError) {
              throw err; // Already handled above
            }
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
  const allSessions = store.list();
  const filter = cliShowSessions; // 'running' | 'all' | 'exited'
  const sessions = allSessions.filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'exited') return s.exitedAt !== null;
    return s.exitedAt === null; // 'running'
  });

  if (sessions.length === 0) {
    if (filter === 'running') {
      console.log('No running sessions.');
      const exitedCount = allSessions.filter((s) => s.exitedAt !== null).length;
      if (exitedCount > 0) {
        console.log(`  ${exitedCount} exited session(s). Use --sessions all to show.`);
      }
    } else {
      console.log('No stored sessions.');
    }
  } else {
    for (const s of sessions) {
      const status = s.exitedAt ? `exited (${s.exitCode})` : 'running';
      const claudeId = s.claudeSessionId ? ` claude:${s.claudeSessionId.slice(0, 8)}` : '';
      console.log(
        `  ${s.remiSessionId.slice(0, 8)}  ${status}  ${s.projectPath}${claudeId}  ${s.startedAt}`,
      );
    }
    if (filter === 'running') {
      const exitedCount = allSessions.filter((s) => s.exitedAt !== null).length;
      if (exitedCount > 0) {
        console.log(`\n  ${exitedCount} exited session(s) hidden. Use --sessions all to show.`);
      }
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
// Handle 'new' subcommand enhancements: --host, --dir, --recent
// ---------------------------------------------------------------------------

// remi new --host: create session on remote daemon, then auto-attach
if ((cliSubcommand === 'new' || cliSubcommand === undefined) && cliHost) {
  // Support host:path syntax (e.g. yahyas-mcm:~/Documents/git/project)
  const { host: effectiveHost, directory: hostDir } = parseHostPath(cliHost);

  const resolvedPort =
    cliPort ??
    (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : DEFAULT_BASE_PORT);

  let directory = cliDir ?? hostDir;

  // --recent: fetch remote recent dirs and pick one
  if (cliRecent) {
    const { fetchRecentDirectories } = await import('./cli/recent-client.ts');
    const { pickDirectory } = await import('./cli/directory-picker.ts');
    let dirs: Awaited<ReturnType<typeof fetchRecentDirectories>>;
    try {
      dirs = await fetchRecentDirectories(effectiveHost, resolvedPort);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (dirs.length === 0) {
      console.error('No recent directories found on remote daemon.');
      process.exit(1);
    }
    const picked = await pickDirectory(dirs);
    if (!picked) {
      process.exit(0);
    }
    directory = picked;
  }

  // Create session on remote daemon and auto-attach
  const { runRemoteNew } = await import('./cli/remote-new-client.ts');
  try {
    const result = await runRemoteNew({
      host: effectiveHost,
      port: resolvedPort,
      directory,
    });
    process.exit(result.exitCode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// remi new --recent (local): pick directory from recent, chdir, then fall through to wrapper
if ((cliSubcommand === 'new' || cliSubcommand === undefined) && cliRecent && !cliHost) {
  const store = new SessionStore();
  const directories = getRecentDirectories(store, 20);
  if (directories.length === 0) {
    console.error('No recent directories found.');
    process.exit(1);
  }
  const { pickDirectory } = await import('./cli/directory-picker.ts');
  const picked = await pickDirectory(directories);
  if (!picked) {
    process.exit(0);
  }
  const dirResult = resolveDirectory(picked);
  if ('error' in dirResult) {
    console.error(dirResult.error);
    process.exit(1);
  }
  process.chdir(dirResult.resolved);
}

// remi new --dir (local): chdir to specified directory, then fall through to wrapper
if ((cliSubcommand === 'new' || cliSubcommand === undefined) && cliDir && !cliHost) {
  const dirResult = resolveDirectory(cliDir);
  if ('error' in dirResult) {
    console.error(dirResult.error);
    process.exit(1);
  }
  process.chdir(dirResult.resolved);
}

// ---------------------------------------------------------------------------
// Config (merge: CLI flags > env vars > config file > built-in defaults)
// ---------------------------------------------------------------------------
const portExplicitlySet = !!(cliPort || process.env['REMI_PORT']);
let PORT = cliPort || (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : 0);

// Auto-select port if not explicitly set
if (!portExplicitlySet) {
  const autoPort = await liveSessionsRegistry.findAvailablePort(
    remiConfig.daemon.base_port,
    remiConfig.daemon.port_range,
  );
  if (autoPort === null) {
    const rangeEnd = remiConfig.daemon.base_port + remiConfig.daemon.port_range - 1;
    console.error(`All remi ports in range ${remiConfig.daemon.base_port}-${rangeEnd} are in use.`);
    console.error('Use --port to specify a different port, or stop an existing remi session.');
    process.exit(1);
  }
  PORT = autoPort;
}
// Update per-port status file path now that PORT is finalized
STATUS_FILE = path.join(REMI_DIR, `status-${PORT}.json`);

const MAX_BULLET_LENGTH = cliMaxBulletLength ?? remiConfig.display.max_bullet_length;
const TELEGRAM_TOKEN = remiConfig.telegram.bot_token || undefined;
const TELEGRAM_ENABLED = !cliNoTelegram && remiConfig.telegram.enabled && !!TELEGRAM_TOKEN;
const TELEGRAM_AUTHORIZED_CHAT_IDS = [...remiConfig.telegram.authorized_chat_ids];
const TELEGRAM_AUTHORIZED_USER_IDS = [...remiConfig.telegram.authorized_user_ids];

// ---------------------------------------------------------------------------
// Core components
// ---------------------------------------------------------------------------
const _ptyManager = new PTYManager();
const transcriptDiscovery = new TranscriptDiscovery();
const transcriptWatchers: Map<UUID, TranscriptWatcher> = new Map();
const transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>> = new Map();
const sessionStore = new SessionStore();

const orphanTimeoutMs =
  cliOrphanTimeout !== undefined
    ? cliOrphanTimeout * 1000
    : remiConfig.daemon.orphan_timeout * 1000;
const sessionRegistry = new SessionRegistry(
  {
    orphanTimeoutMs,
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
      const session = sessionRegistry.getSession(sessionId);
      if (session?.locallyOwned) {
        log(`Session detached: ${sessionId} (locally owned, no timeout)`);
      } else {
        log(`Session orphaned: ${sessionId} (will timeout in 5 minutes)`);
      }
    },
    onSessionResumed: (sessionId, connectionId) => {
      log(`Session resumed: ${sessionId} by connection ${connectionId}`);
    },
  },
);

// The primary session ID (in wrapper mode, this is the one running in the terminal)
let primarySessionId: UUID | null = null;
// Ports being claimed by in-flight daemon spawn requests (prevents TOCTOU race)
const spawningPorts = new Set<number>();

// Hook infrastructure (initialized in wrapper mode when hooks are enabled)
let HOOK_PORT = 0; // OS-assigned; actual port read from hookServer.port after start
let hookServer: HookServer | null = null;
let hookConfigManager: HookConfigManager | null = null;

// mDNS publisher (initialized when daemon is network-accessible)
let mdnsPublisher: import('./mdns/mdns-publisher.ts').MdnsPublisher | null = null;

async function startMdnsIfNeeded(
  logFn: (msg: string) => void,
): Promise<import('./mdns/mdns-publisher.ts').MdnsPublisher | null> {
  if (cliNoMdns || !remiConfig.network.mdns || isLocalhostBind) return null;
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
      onStructuredMessage: (structured) => {
        try {
          sendAndRecord(createStructuredAgentOutput(structured, false));
        } catch (err) {
          logError(`[Session ${sessionId}] Failed to send structured message:`, err);
        }
      },
      onStructuredMessageUpdate: (_messageId, structured, changedBulletIds) => {
        try {
          sendAndRecord(createStructuredAgentOutput(structured, true, changedBulletIds));
        } catch (err) {
          logError(`[Session ${sessionId}] Failed to send structured message update:`, err);
        }
      },
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

  // PTY output parser: status-only mode (content comes from transcript for clean results)
  const outputProcessor = new OutputProcessor({ sessionId, streamStatusOnly: true }, {});

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
      env: { REMI_PORT: String(remiStatus.wsPort) },
    },
    {
      onRawData: (data: Uint8Array) => {
        // Write to local terminal (wrapper pass-through mode)
        if (passThrough && ptyStdoutFd !== null && !wrapperDetached) {
          try {
            fs.writeSync(ptyStdoutFd, data);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            ptyStdoutFd = null;
            wrapperDetached = true;
            if (code === 'EPIPE' || code === 'EIO') {
              logError(`Terminal write failed (${code}), detaching local terminal`);
            } else {
              logError(
                `Unexpected terminal write error (${code}):`,
                err instanceof Error ? err.message : String(err),
              );
            }
            // Clean up stdin to avoid dangling raw-mode reader
            if (process.stdin.isTTY) {
              try {
                process.stdin.setRawMode(false);
              } catch {
                // stdin may already be unusable
              }
            }
            process.stdin.pause();
            process.stdin.removeAllListeners('data');
            process.stdin.unref();
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
      onData: (output: string) => {
        try {
          outputProcessor.process(output);
        } catch (err) {
          logError(`[OutputProcessor] process() failed for session ${sessionId}:`, err);
        }
      },
      onExit: (code: number | null) => {
        try {
          outputProcessor.flush();
        } catch (err) {
          logError(`[OutputProcessor] flush() failed for session ${sessionId}:`, err);
        }
        log(`PTY ${ptySession.id} exited with code ${code}`);
        sessionRegistry.handlePTYExit(sessionId);
        sessionStore.markExited(sessionId, code);

        if (passThrough) {
          cleanup()
            .then(() => process.exit(code ?? 0))
            .catch((err) => {
              logError(`[PTY] Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
              process.exit(1);
            });
        }
      },
      onError: (error: Error) => {
        logError(`PTY ${ptySession.id} error:`, error);
      },
    },
  );

  const locallyOwned = passThrough; // wrapper-mode sessions are locally owned
  sessionRegistry.registerSession(
    sessionId,
    workingDirectory,
    ptySession,
    messageApi,
    locallyOwned,
  );
  await ptySession.start();

  sessionStore.save({
    remiSessionId: sessionId,
    claudeSessionId: null,
    projectPath: workingDirectory,
    port: PORT,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });

  // Transcript watcher: started by SessionStart hook (provides path directly).
  // Safety net: if hook doesn't fire, poll for a NEW transcript file.
  // Claude creates its transcript file after startup, so we must wait for it.
  const startupTime = Date.now();
  const fallbackInterval = setInterval(() => {
    if (transcriptWatchers.has(sessionId)) {
      clearInterval(fallbackInterval);
      transcriptFallbackTimers.delete(sessionId);
      return;
    }
    if (!sessionRegistry.hasSession(sessionId)) {
      clearInterval(fallbackInterval);
      transcriptFallbackTimers.delete(sessionId);
      return;
    }
    // Look for a transcript file created AFTER daemon startup
    const transcriptPath = transcriptDiscovery.findLatestTranscript(workingDirectory);
    if (transcriptPath) {
      try {
        const stat = fs.statSync(transcriptPath);
        if (stat.mtimeMs >= startupTime) {
          clearInterval(fallbackInterval);
          transcriptFallbackTimers.delete(sessionId);
          log(`[Hooks] Found new transcript via fallback: ${transcriptPath}`);
          startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
          extractClaudeSessionId(transcriptPath, sessionId);
          return;
        }
      } catch {
        /* stat failed, retry */
      }
    }
    // Give up after 30 seconds
    if (Date.now() - startupTime > 30000) {
      clearInterval(fallbackInterval);
      transcriptFallbackTimers.delete(sessionId);
      logError('[Hooks] Transcript fallback timed out. Using latest available file.');
      if (transcriptPath) {
        startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
        extractClaudeSessionId(transcriptPath, sessionId);
      }
    }
  }, 2000);
  transcriptFallbackTimers.set(sessionId, fallbackInterval);

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
  log(`[Transcript] Watching: ${transcriptPath}`);
  log(`[Transcript] File exists: ${fs.existsSync(transcriptPath)}`);

  const bridge = new TranscriptMessageBridge({ sessionId }, messageApi, {
    onTranscriptContent: (message) => {
      log(`[Transcript] Delivering content (${message.type}) to clients`);
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
        log(
          `[Transcript] Assistant entry: ${entry.uuid?.slice(0, 8)} (${entry.message?.content?.length ?? 0} blocks)`,
        );
        bridge.handleAssistantEntry(entry);
      },
      onUserMessage: (entry) => {
        log(`[Transcript] User entry: ${entry.uuid?.slice(0, 8)}`);
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
  log(`[Transcript] Watcher started for session ${sessionId}`);
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

function getRecentDirectories(store: SessionStore, limit: number): RecentDirectory[] {
  const sessions = store.list();
  const dirMap = new Map<string, { count: number; lastUsed: string }>();

  for (const s of sessions) {
    const dir = s.projectPath;
    const existing = dirMap.get(dir);
    if (existing) {
      existing.count++;
      if (s.startedAt > existing.lastUsed) {
        existing.lastUsed = s.startedAt;
      }
    } else {
      dirMap.set(dir, { count: 1, lastUsed: s.startedAt });
    }
  }

  const entries = Array.from(dirMap.entries())
    .map(([directory, { count, lastUsed }]) => ({
      directory,
      lastUsed,
      sessionCount: count,
      displayName: path.basename(directory),
    }))
    .sort((a, b) => (a.lastUsed > b.lastUsed ? -1 : 1))
    .slice(0, limit);

  return entries;
}

const sendToConnection = (connectionId: UUID, message: ProtocolMessage): void => {
  registry.sendRaw(connectionId, message);
};

const sharedEvents = {
  onConnect: async (connectionId: UUID, metadata: AdapterMetadata) => {
    log(`Client connected: ${connectionId} (${metadata.adapterType})`);

    registry.trackConnection(connectionId, metadata.adapterType);
    updateRemiStatus({ connections: remiStatus.connections + 1 });

    const resumeSessionId = metadata.platformData?.['resumeSessionId'] as UUID | undefined;

    // Unified connection flow: one session per daemon, both modes behave the same.
    // If a resumeSessionId is provided, validate it matches our session.
    if (resumeSessionId && primarySessionId && resumeSessionId !== primarySessionId) {
      log(`Resume ID mismatch: requested ${resumeSessionId}, daemon has ${primarySessionId}`);
      sendToConnection(
        connectionId,
        createError(
          'SESSION_NOT_FOUND',
          `Session ${resumeSessionId} not found on this daemon. Active session: ${primarySessionId}.`,
        ),
      );
      return;
    }

    // Try to attach to the primary (only) session
    const isQueryMode = metadata.platformData?.['mode'] === 'query';
    if (primarySessionId) {
      // Only auto-attach if the client wants to attach (not a utility client like ls/kill)
      if (!isQueryMode) {
        const targetSession = primarySessionId;
        const result = sessionRegistry.attachConnection(targetSession, connectionId);
        if (result.success) {
          sendToConnection(
            connectionId,
            createHelloAck('1.0.0', targetSession, {
              isResume: result.replayMessages.length > 0,
              replayCount: result.replayMessages.length,
              nextBulletId: result.nextBulletId,
            }),
          );
          if (result.replayMessages.length > 0) {
            sendToConnection(
              connectionId,
              createReplayBatch(targetSession, result.replayMessages, true),
            );
          }
          cancelOrphanTimeout();
          log(`Attached connection ${connectionId} to session ${targetSession}`);
          return;
        }
      }

      // Query mode or attach failed (session busy); send hello_ack without attach
      // so utility clients (ls, kill) can still send requests
      sendToConnection(connectionId, createHelloAck('1.0.0', primarySessionId));
      log(
        `Connection ${connectionId} connected without attach (${isQueryMode ? 'query mode' : 'session busy'})`,
      );
      return;
    }

    // No session available
    sendToConnection(connectionId, createError('NO_SESSION', 'No active session available'));
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
    // One session per daemon. Spawn a new daemon process for the new session.
    log(`Create session request from ${connectionId}, spawning new daemon`);

    try {
      const { spawnRemiDaemon } = await import('./cli/daemon-manager.ts');
      const { findAvailableTcpPort } = await import('./session/port-utils.ts');

      // Include in-flight spawn ports to prevent TOCTOU race on concurrent requests
      const liveUsed = new Set([
        ...liveSessionsRegistry.listLive().map((e) => e.wsPort),
        ...spawningPorts,
      ]);
      const freePort = await findAvailableTcpPort(
        remiConfig.daemon.base_port,
        remiConfig.daemon.port_range,
        liveUsed,
      );
      if (freePort === null) {
        const rangeEnd = remiConfig.daemon.base_port + remiConfig.daemon.port_range - 1;
        sendToConnection(
          connectionId,
          createCreateSessionResponse(
            false,
            requestId,
            undefined,
            `All ports in range ${remiConfig.daemon.base_port}-${rangeEnd} are in use.`,
          ),
        );
        return;
      }

      // Forward parent's flags so spawned daemon has matching config
      const inheritedArgs: string[] = [];
      if (cliAuth === true) inheritedArgs.push('--auth');
      if (cliAuth === false) inheritedArgs.push('--no-auth');
      if (cliNoRelay) inheritedArgs.push('--no-relay');
      if (cliNoMdns) inheritedArgs.push('--no-mdns');
      if (bindHost !== '0.0.0.0') inheritedArgs.push('--bind', bindHost);

      log(`Spawning new daemon on port ${freePort} for directory ${directory || '(cwd)'}`);
      spawningPorts.add(freePort);
      try {
        const result = await spawnRemiDaemon(freePort, directory, inheritedArgs);

        sendToConnection(
          connectionId,
          createCreateSessionResponse(
            true,
            requestId,
            result.sessionId as UUID,
            undefined,
            result.port,
          ),
        );
        log(
          `New daemon spawned: port=${result.port}, session=${result.sessionId}, pid=${result.pid}`,
        );
      } finally {
        spawningPorts.delete(freePort);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to spawn daemon: ${msg}`);
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

    const hadActiveClient =
      session.activeConnectionId !== null && session.activeConnectionId !== connectionId;
    sessionRegistry.closeSession(sessionId, 'forced');
    sendToConnection(connectionId, createKillSessionResponse(true, requestId));
    if (hadActiveClient) {
      log(`Session killed: ${sessionName} (disconnected attached client)`);
    } else {
      log(`Session killed: ${sessionName}`);
    }
  },

  onResumeSessionRequest: async (connectionId: UUID, targetSessionId: string, requestId: UUID) => {
    log(`Resume session request from ${connectionId} for session ${targetSessionId}`);

    // If the target matches our active session, try to attach
    const existingSession = sessionRegistry.getSession(targetSessionId as UUID);
    if (existingSession) {
      const result = sessionRegistry.attachConnection(targetSessionId as UUID, connectionId);
      if (result.success) {
        sendToConnection(
          connectionId,
          createResumeSessionResponse(true, requestId, targetSessionId as UUID),
        );
        sendToConnection(
          connectionId,
          createHelloAck('1.0.0', targetSessionId as UUID, {
            isResume: true,
            replayCount: result.replayMessages.length,
            nextBulletId: result.nextBulletId,
          }),
        );
        if (result.replayMessages.length > 0) {
          sendToConnection(
            connectionId,
            createReplayBatch(targetSessionId as UUID, result.replayMessages, true),
          );
        }
        log(`Session ${targetSessionId} still alive; attached connection`);
        return;
      }
      sendToConnection(
        connectionId,
        createResumeSessionResponse(false, requestId, undefined, result.error),
      );
      return;
    }

    // Session not alive in registry. One session per daemon, so we cannot
    // spawn a new session if one already exists.
    if (sessionRegistry.activeSession !== null) {
      sendToConnection(
        connectionId,
        createResumeSessionResponse(
          false,
          requestId,
          undefined,
          "This daemon already has an active session. Use 'remi new' to start a new daemon for resume.",
        ),
      );
      return;
    }

    // No active session; attempt transcript-based resume by spawning a new PTY.
    let claudeSessionId: string | null = null;
    let projectPath: string | null = null;

    const storedByRemi = sessionStore.findByRemiSessionId(targetSessionId as UUID);
    if (storedByRemi) {
      claudeSessionId = storedByRemi.claudeSessionId;
      projectPath = storedByRemi.projectPath;
    }

    if (!claudeSessionId) {
      const storedByClaude = sessionStore.findByClaudeSessionId(targetSessionId);
      if (storedByClaude) {
        claudeSessionId = storedByClaude.claudeSessionId;
        projectPath = storedByClaude.projectPath;
      }
    }

    if (!claudeSessionId) {
      const transcriptPath = transcriptDiscovery.findTranscriptBySessionId(targetSessionId);
      if (transcriptPath) {
        claudeSessionId = targetSessionId;
        const dirName = path.basename(path.dirname(transcriptPath));
        projectPath = dirName.replace(/-/g, '/');
      }
    }

    if (!claudeSessionId) {
      sendToConnection(
        connectionId,
        createResumeSessionResponse(
          false,
          requestId,
          undefined,
          `Session ${targetSessionId} not found. No Claude session ID available for resume.`,
        ),
      );
      return;
    }

    if (!projectPath) {
      sendToConnection(
        connectionId,
        createResumeSessionResponse(
          false,
          requestId,
          undefined,
          'Cannot resume: original project path is unknown.',
        ),
      );
      return;
    }

    const dirResult = resolveDirectory(projectPath);
    if ('error' in dirResult) {
      const hint = projectPath?.includes('/')
        ? ' Path may be inaccurate for projects with dashes in their name.'
        : '';
      sendToConnection(
        connectionId,
        createResumeSessionResponse(
          false,
          requestId,
          undefined,
          `Project directory not found: ${projectPath}.${hint}`,
        ),
      );
      return;
    }
    const workingDirectory = dirResult.resolved;

    const newSessionId = sessionRegistry.createSessionId();
    log(
      `Resuming Claude session ${claudeSessionId} as new Remi session ${newSessionId} in ${workingDirectory}`,
    );

    try {
      await createNewSession(
        newSessionId,
        workingDirectory,
        (sid, msg) => {
          const session = sessionRegistry.getSession(sid);
          if (session?.activeConnectionId) {
            sendToConnection(session.activeConnectionId, msg);
          }
        },
        ['--resume', claudeSessionId],
      );

      const result = sessionRegistry.attachConnection(newSessionId, connectionId);

      if (result.success) {
        sendToConnection(connectionId, createResumeSessionResponse(true, requestId, newSessionId));
        sendToConnection(
          connectionId,
          createHelloAck('1.0.0', newSessionId, {
            isResume: false,
            replayCount: 0,
            nextBulletId: 1,
          }),
        );
        log(`Session ${newSessionId} created via resume (claude: ${claudeSessionId})`);
      } else {
        sessionRegistry.closeSession(newSessionId, 'forced');
        sendToConnection(
          connectionId,
          createResumeSessionResponse(false, requestId, undefined, result.error),
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError('Failed to resume session:', msg);
      sessionRegistry.closeSession(newSessionId, 'forced');
      sendToConnection(connectionId, createResumeSessionResponse(false, requestId, undefined, msg));
    }
  },

  onSessionHistoryRequest: (connectionId: UUID, requestId: UUID, limit: number | undefined) => {
    log(`Session history request from ${connectionId}, limit: ${limit ?? 'default'}`);
    try {
      const clampedLimit = Math.max(1, limit ?? 20);
      const directories = getRecentDirectories(sessionStore, clampedLimit);
      sendToConnection(connectionId, createSessionHistoryResponse(directories, requestId));
    } catch (err) {
      log(`Failed to get recent directories: ${err instanceof Error ? err.message : err}`);
      sendToConnection(connectionId, createSessionHistoryResponse([], requestId));
    }
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
const bindHost = cliBindHost ?? remiConfig.daemon.bind;
const isLocalhostBind = bindHost === 'localhost' || bindHost === '127.0.0.1' || bindHost === '::1';

// Determine whether auth should be enabled
// Priority: CLI flag > config file > auto (based on bind host)
const configAuth = remiConfig.auth.enabled;
const authEnabled = cliAuth ?? (configAuth === 'auto' ? !isLocalhostBind : configAuth);

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

if (!cliNoRelay && remiConfig.network.relay) {
  const { RelayAdapter } = await import('./remote/relay-adapter.ts');
  const { generateConnectionCode } = await import('./remote/signaling-client.ts');
  const signalingUrl = cliSignalingUrl ?? remiConfig.network.signaling_url;

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
let cleanupRunning = false;
async function cleanup(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;

  cancelOrphanTimeout();

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
  for (const timer of transcriptFallbackTimers.values()) {
    clearInterval(timer);
  }
  transcriptFallbackTimers.clear();
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
// Ensure PATH includes user-installed tools (claude, bun, etc.).
// In daemon mode this is critical (LaunchAgent/systemd have minimal PATH).
// In wrapper mode the terminal provides the PATH, but resolveShellPath
// merges (never drops existing entries) so it's safe to call, and ensures
// remote session creation works even after the terminal is detached (SIGHUP).
resolveShellPath();

if (cliDaemonMode) {
  console.log('Starting Remi daemon...');

  // Phase 1: Start non-port-binding adapters (Relay, Telegram) once
  try {
    await registry.startAllExcept(['websocket']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start adapters: ${msg}`);
    await registry.stopAll();
    process.exit(1);
  }

  // Phase 2: Probe for available WebSocket port, then start
  if (!portExplicitlySet) {
    const liveUsed = new Set(liveSessionsRegistry.listLive().map((e) => e.wsPort));
    const probed = await findAvailableTcpPort(PORT, DEFAULT_PORT_RANGE, liveUsed);
    if (probed === null) {
      console.error(
        `All remi ports in range ${DEFAULT_BASE_PORT}-${DEFAULT_BASE_PORT + DEFAULT_PORT_RANGE - 1} are in use.`,
      );
      console.error('Use --port to specify a different port, or stop existing sessions.');
      await registry.stopAll();
      process.exit(1);
    }
    if (probed !== PORT) {
      console.log(`Port ${PORT} in use, using ${probed}`);
      await registry.unregister('websocket');
      PORT = probed;
      STATUS_FILE = path.join(REMI_DIR, `status-${PORT}.json`);
      const newWsAdapter = new WebSocketAdapter(
        { port: PORT, host: bindHost, authenticator },
        sharedEvents,
      );
      registry.register(newWsAdapter);
    }
  }

  try {
    await registry.startAdapter('websocket');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start WebSocket on port ${PORT}: ${msg}`);
    console.error('Use --port to specify a different port, or stop existing sessions.');
    await registry.stopAll();
    process.exit(1);
  }

  mdnsPublisher = await startMdnsIfNeeded(console.log);

  // Create the daemon's single session (one session per daemon)
  const workingDirectory = cliDir ? path.resolve(cliDir) : process.cwd();
  const sessionId = sessionRegistry.createSessionId();
  primarySessionId = sessionId;

  updateRemiStatus({ wsPort: PORT, sessionId, sessionStatus: 'starting' });
  installStatusLine();

  // Start hook server for Claude Code event detection (port 0 = OS-assigned)
  try {
    hookServer = new HookServer(
      { port: 0 },
      {
        onError: (err) => console.error(`[HookServer] ${err.message}`),
      },
    );
    hookServer.start();
    HOOK_PORT = hookServer.port;
    console.log(`  Hook server listening on port ${HOOK_PORT}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `Hook server failed to start: ${msg}. Status detection and question forwarding disabled.`,
    );
    hookServer = null;
  }

  if (hookServer) {
    try {
      hookConfigManager = new HookConfigManager(workingDirectory, hookServer.url);
      hookConfigManager.install();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Hook config install failed: ${msg}. Question forwarding may not work.`);
      hookConfigManager = null;
    }
  }

  // Register in live-sessions so remi ls can discover this daemon
  liveSessionsRegistry.register({
    sessionId,
    pid: process.pid,
    wsPort: PORT,
    hookPort: HOOK_PORT,
    projectPath: workingDirectory,
    name: path.basename(workingDirectory),
    startedAt: new Date().toISOString(),
  });

  // Create the PTY session
  try {
    await createNewSession(sessionId, workingDirectory, (sid, msg) => {
      const session = sessionRegistry.getSession(sid);
      if (session?.activeConnectionId) {
        sendToConnection(session.activeConnectionId, msg);
      }
      if (msg.type !== 'raw_pty_output') {
        registry.broadcast(msg);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create session: ${msg}`);
    liveSessionsRegistry.unregister(sessionId);
    await registry.stopAll();
    process.exit(1);
  }

  const managedSession = sessionRegistry.getSession(sessionId);

  console.log('');
  console.log('Remi daemon ready!');
  console.log(`  WebSocket: ws://${bindHost}:${PORT}/ws`);
  console.log(`  Port: ${PORT} (use --port to change)`);
  console.log(`  Session: ${managedSession?.name ?? sessionId}`);
  console.log(`  Directory: ${workingDirectory}`);
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
  // SIGUSR1: config reload signal (triggered by `remi reload`)
  // Uses SIGUSR1 to avoid collision with SIGHUP (used for terminal detach in wrapper mode)
  // Currently validates the config; hot-reload of running adapters is planned for a future release.
  process.on('SIGUSR1', () => {
    console.log('[reload] Re-reading configuration...');
    try {
      applyEnvOverrides(loadConfig());
      console.log('[reload] Config validated. Changes take effect on next daemon restart.');
    } catch (err) {
      console.error(
        `[reload] Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  } catch (logErr) {
    // Fall back to a temp file so diagnostics are not completely lost
    try {
      const tmpLog = path.join(os.tmpdir(), `remi-${process.pid}.log`);
      logFd = fs.openSync(tmpLog, 'a');
      fs.writeSync(
        logFd,
        `[remi] Primary log file failed: ${logErr instanceof Error ? logErr.message : String(logErr)}\n`,
      );
      fs.writeSync(2, `[remi] Logging to ${tmpLog} (primary log unavailable)\n`);
    } catch {
      // Last resort: write one message to stderr before it gets overridden
      fs.writeSync(2, '[remi] WARNING: All logging disabled (cannot open any log file)\n');
    }
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

  // Phase 1: Start non-port-binding adapters (Relay, Telegram) once
  try {
    await registry.startAllExcept(['websocket']);
  } catch (err) {
    logError(
      `Failed to start background adapters: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Phase 2: Probe for available WebSocket port, then start
  let wsStarted = false;
  let wsProbeSucceeded = true;
  if (!portExplicitlySet) {
    const liveUsed = new Set(liveSessionsRegistry.listLive().map((e) => e.wsPort));
    const probed = await findAvailableTcpPort(PORT, DEFAULT_PORT_RANGE, liveUsed);
    if (probed !== null && probed !== PORT) {
      log(`Port ${PORT} in use, using ${probed}`);
      try {
        await registry.unregister('websocket');
      } catch (teardownErr) {
        logError(
          `Failed to tear down WebSocket adapter: ${teardownErr instanceof Error ? teardownErr.message : String(teardownErr)}`,
        );
      }
      PORT = probed;
      STATUS_FILE = path.join(REMI_DIR, `status-${PORT}.json`);
      const newWsAdapter = new WebSocketAdapter(
        { port: PORT, host: bindHost, authenticator },
        sharedEvents,
      );
      registry.register(newWsAdapter);
    } else if (probed === null) {
      logError('All ports in range are in use. Remote monitoring disabled.');
      wsProbeSucceeded = false;
    }
  }

  if (wsProbeSucceeded) {
    try {
      await registry.startAdapter('websocket');
      log(`WebSocket server listening on ws://${bindHost}:${PORT}/ws`);
      mdnsPublisher = await startMdnsIfNeeded(log);
      wsStarted = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`WebSocket server failed to start: ${msg}. Remote monitoring disabled.`);
    }
  }

  // Update status with finalized WS port
  if (wsStarted) {
    updateRemiStatus({ wsPort: PORT });
  }

  // Start hook server for Claude Code event detection (port 0 = OS-assigned)
  try {
    hookServer = new HookServer(
      { port: 0 },
      {
        onError: (err) => logError(`[HookServer] ${err.message}`),
      },
    );
    hookServer.start();
    HOOK_PORT = hookServer.port;
    log(`Hook server listening on ${hookServer.url} (port ${HOOK_PORT})`);

    // Configure Claude Code hooks to POST to our server
    hookConfigManager = new HookConfigManager(workingDirectory, hookServer.url);
    hookConfigManager.install();
    log('[Hooks] Claude Code hooks configured');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(
      `Hook server failed to start: ${msg}. Status detection and question forwarding disabled.`,
    );
    hookServer = null;
    hookConfigManager = null;
  }

  // Register in live-sessions AFTER hook server starts so hookPort has real value
  if (wsStarted) {
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
  // SIGHUP (terminal closed): keep PTY + WebSocket alive for 30 minutes, then shut down.
  // Ctrl+B d (keybinding): cleanly exit and return the shell to the user.
  const SIGHUP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
      // Terminal closed: keep running for 30 minutes so remote clients can attach.
      // After the timeout, shut down to avoid accumulating orphaned sessions.
      process.stdin.unref();
      ptyStdoutFd = null;
      sighupTimeoutId = setTimeout(() => {
        log('[SIGHUP] Orphan timeout reached (30m), shutting down');
        cleanup()
          .then(() => process.exit(0))
          .catch((err) => {
            logError(
              `[SIGHUP] Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exit(1);
          });
      }, SIGHUP_TIMEOUT_MS);
      // unref() so this timer alone won't keep the process alive if PTY + servers
      // are already stopped (the process should exit naturally in that case).
      sighupTimeoutId.unref();
      log(
        `Local terminal detached (SIGHUP), PTY and WebSocket server running for ${SIGHUP_TIMEOUT_MS / 60_000}m`,
      );
    } else {
      // Ctrl+B d: cleanly shut down and return shell to user
      log('Ctrl+B d pressed, shutting down');
      cleanup()
        .then(() => process.exit(0))
        .catch((err) => {
          logError(`[Detach] Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        });
    }
  }

  // SIGHUP: terminal closed (e.g. window closed, SSH disconnect).
  // Detach the local terminal but keep the PTY and server alive.
  process.on('SIGHUP', () => {
    detachLocalTerminal('sighup');
    // Do NOT exit; the event loop keeps running for remote clients and PTY.
  });

  // SIGUSR1: config reload signal (triggered by `remi reload`)
  process.on('SIGUSR1', () => {
    log('[reload] Re-reading configuration...');
    try {
      applyEnvOverrides(loadConfig());
      log('[reload] Config validated. Changes take effect on next daemon restart.');
    } catch (err) {
      logError(
        `[reload] Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
        // PTY may have exited
      }
    }
    try {
      await cleanup();
    } catch (err) {
      logError(`[SIGTERM] Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  });
}
