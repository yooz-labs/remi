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
import { errorToString } from '@remi/shared';

// Version constant - read once at startup with fallback for compiled binaries
const REMI_VERSION = (() => {
  const pkgPath = path.resolve(import.meta.dir, '..', '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (typeof pkg.version !== 'string') {
      console.error('[remi] package.json missing "version" field');
      return '0.5.2-dev.2'; // REMI_COMPILED_VERSION
    }
    return pkg.version;
  } catch (err) {
    // REMI_COMPILED_VERSION is updated by scripts/bump-version.sh at release time.
    // This fallback is used in compiled binaries where package.json is unavailable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'MODULE_NOT_FOUND') {
      console.error(`[remi] Failed to read version: ${(err as Error).message}`);
    }
    return '0.5.2-dev.2'; // REMI_COMPILED_VERSION
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

// In wrapper mode, we save the real stdout file descriptor before overriding.
// Raw PTY bytes are written directly via fs.writeSync to avoid decode/encode.
let ptyStdoutFd: number | null = null;

/**
 * Select the APNS notification category based on the number of question options.
 * iOS will render action buttons matching the category; watchOS mirrors them automatically.
 */
function selectPushCategory(options: readonly QuestionOption[]): string | undefined {
  if (options.length === 2) return 'REMI_YN';
  if (options.length === 3) return 'REMI_YNA';
  if (options.length === 4) return 'REMI_MULTI';
  return undefined;
}

function ensureRemiDir(): void {
  fs.mkdirSync(REMI_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Status file for status line integration
// Guard: only writes in wrapper mode (wrapperMode is set during arg parsing)
// ---------------------------------------------------------------------------
import { detectGitInfo, loadDotenvFile } from './cli/startup-env.ts';
import { type RemiStatus, StatusWriter } from './cli/status-writer.ts';

const gitInfo = detectGitInfo();

const statusWriter = new StatusWriter(
  {
    pid: process.pid,
    connections: 0,
    sessionStatus: 'starting',
    adapters: [],
    wsPort: 0,
    sessionId: null,
    repo: gitInfo.repo,
    branch: gitInfo.branch,
  },
  {
    getTargetFile: () => (cliDaemonMode ? DAEMON_STATUS_FILE : STATUS_FILE),
    isEnabled: () => isWrapperMode() || cliDaemonMode,
    writeLog: writeToLog,
  },
);

/** Thin back-compat aliases so existing cli.ts call sites keep working. */
const remiStatus: Readonly<RemiStatus> = statusWriter.state;
const updateRemiStatus = (patch: Partial<RemiStatus>): void => statusWriter.update(patch);
const cleanupStatusFile = (): void => statusWriter.cleanup();

loadDotenvFile();

import {
  createHelloAck,
  createRawPtyOutput,
  createReplayBatch,
  createSessionListResponse,
  createSessionReset,
  createStructuredAgentOutput,
  generateId,
  now,
} from '@remi/shared';
import type {
  AgentStatus,
  ProtocolMessage,
  QuestionOption,
  UUID,
  UnlockedIdentity,
} from '@remi/shared';
import { isEncrypted, unlockIdentity } from '@remi/shared';
import { AdapterRegistry, TelegramAdapter, WebSocketAdapter } from './adapters/index.ts';
import { MessageAPI } from './api/index.ts';
import { Authenticator } from './auth/authenticator.ts';
import { IdentityStore } from './auth/identity-store.ts';
import { AutoApproveService, resolveProviderUrl } from './auto-approve/index.ts';
import { runConfigCommand } from './cli/cmd-config.ts';
import { runReloadCommand } from './cli/cmd-reload.ts';
import { DetachScanner } from './cli/detach-scanner.ts';
import {
  type ConnectionHandlers,
  createConnectionHandlers,
} from './cli/handlers/connection-events.ts';
import {
  type CreateSessionHandlers,
  createCreateSessionHandlers,
} from './cli/handlers/create-session-events.ts';
import { type InputHandlers, createInputHandlers } from './cli/handlers/input-events.ts';
import {
  type ResumeSessionHandlers,
  createResumeSessionHandlers,
} from './cli/handlers/resume-session-events.ts';
import { type SessionHandlers, createSessionHandlers } from './cli/handlers/session-events.ts';
import {
  type TranscriptHandlers,
  createTranscriptHandlers,
} from './cli/handlers/transcript-events.ts';
import { type TrivialHandlers, createTrivialHandlers } from './cli/handlers/trivial-events.ts';
import { endLogFileSession, startLogFileSession, writeToLog } from './cli/log-file.ts';
import { installStatusLine } from './cli/statusline-installer.ts';
import { applyEnvOverrides, loadConfig } from './config/index.ts';
import type { RemiConfig } from './config/index.ts';
import { HookConfigManager, HookEventBridge, HookServer } from './hooks/index.ts';
import { classifySessionEvent } from './hooks/session-lock-classifier.ts';
import { sendPushTrigger } from './notifications/push-client.ts';
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
import { configureLogger, isWrapperMode, log, logError, setWrapperMode } from './cli/logger.ts';

configureLogger({ writeLog: writeToLog });

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

import { resolveShellPath } from './cli/shell-path.ts';

import { resolveDirectory } from './cli/path-resolver.ts';

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
  console.error(errorToString(err));
  process.exit(1);
}

// Handle 'config' subcommand
if (parsedArgs.subcommand === 'config') {
  process.exit(runConfigCommand(parsedArgs.subcommandArg, remiConfig));
}

// Handle 'reload' subcommand
if (parsedArgs.subcommand === 'reload') {
  process.exit(runReloadCommand());
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
const cliDecrypt = parsedArgs.decrypt;
const cliEncrypt = parsedArgs.encrypt;
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
const cliPushSecret = parsedArgs.pushSecret ?? process.env['REMI_PUSH_SECRET'];
const cliOrphanTimeout = parsedArgs.orphanTimeout;
const claudeArgs = [...parsedArgs.claudeArgs];

if (cliDaemonMode) {
  setWrapperMode(false);
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
    console.error(errorToString(err));
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

// Handle key management subcommands (keygen, export-key, import-key, authorize, keys)
{
  const { isKeysSubcommand, runKeysCommand } = await import('./cli/cmd-keys.ts');
  if (isKeysSubcommand(cliSubcommand)) {
    process.exit(
      await runKeysCommand(cliSubcommand, {
        ...(cliSubcommandArg !== undefined && { subcommandArg: cliSubcommandArg }),
        ...(cliUsePassphrase !== undefined && { usePassphrase: cliUsePassphrase }),
        ...(cliDecrypt !== undefined && { decrypt: cliDecrypt }),
        ...(cliEncrypt !== undefined && { encrypt: cliEncrypt }),
        ...(cliForce !== undefined && { force: cliForce }),
        ...(cliPublicOnly !== undefined && { publicOnly: cliPublicOnly }),
        ...(cliLabel !== undefined && { label: cliLabel }),
        ...(cliRemoveFingerprint !== undefined && { removeFingerprint: cliRemoveFingerprint }),
      }),
    );
  }
}

// Handle 'code' subcommand: show or refresh the persistent connection code
if (cliSubcommand === 'code') {
  const { CodeStore } = await import('./remote/code-store.ts');
  const { runCodeCommand } = await import('./cli/cmd-code.ts');
  process.exit(runCodeCommand(new CodeStore(), { refresh: cliCodeRefresh }));
}

// Handle daemon lifecycle commands: start, stop, status, logs
if (
  cliSubcommand === 'start' ||
  cliSubcommand === 'stop' ||
  cliSubcommand === 'status' ||
  cliSubcommand === 'logs'
) {
  const { runDaemonLifecycleCommand } = await import('./cli/cmd-daemon.ts');
  process.exit(
    await runDaemonLifecycleCommand(cliSubcommand, {
      ...(cliPort !== undefined && { port: cliPort }),
      ...(cliBindHost !== undefined && { bindHost: cliBindHost }),
      ...(cliAuth !== undefined && { auth: cliAuth }),
      noMdns: cliNoMdns,
      noRelay: cliNoRelay,
      noTelegram: cliNoTelegram,
      permanentCode: cliPermanentCode,
      ...(cliSignalingUrl !== undefined && { signalingUrl: cliSignalingUrl }),
      ...(cliPushSecret !== undefined && { pushSecret: cliPushSecret }),
      ...(cliOrphanTimeout !== undefined && { orphanTimeout: cliOrphanTimeout }),
    }),
  );
}

// Live sessions registry: shared by subcommands and daemon/wrapper mode.
// Instantiated early so subcommand handlers (ls, attach, kill) can use it.
const liveSessionsRegistry = new SessionRegistryFile();

// Handle 'ls' subcommand: query live sessions from running daemon(s)
if (cliSubcommand === 'ls') {
  const { runLsCommand } = await import('./cli/cmd-ls.ts');
  process.exit(
    await runLsCommand(
      {
        ...(cliPort !== undefined && { port: cliPort }),
        ...(cliHost !== undefined && { host: cliHost }),
        network: cliNetwork,
      },
      liveSessionsRegistry,
    ),
  );
}

// Handle 'recent' subcommand: browse recent project directories
if (cliSubcommand === 'recent') {
  const { runRecentCommand } = await import('./cli/cmd-recent.ts');
  process.exit(
    await runRecentCommand(
      {
        ...(cliPort !== undefined && { port: cliPort }),
        ...(cliHost !== undefined && { host: cliHost }),
      },
      () => getRecentDirectories(new SessionStore(), 20),
    ),
  );
}

// Handle 'kill' subcommand: kill a session by name or ID
if (cliSubcommand === 'kill') {
  const { runKillCommand } = await import('./cli/cmd-kill.ts');
  process.exit(
    await runKillCommand(resolved, {
      getLivePorts: () => liveSessionsRegistry.getLivePorts(),
      explicitPort: cliPort,
    }),
  );
}

// Handle 'detach' subcommand: detach from a session without killing it
if (cliSubcommand === 'detach') {
  const { runDetachCommand } = await import('./cli/cmd-detach.ts');
  process.exit(
    await runDetachCommand(resolved, {
      getLivePorts: () => liveSessionsRegistry.getLivePorts(),
      explicitPort: cliPort,
    }),
  );
}

// Handle 'attach' subcommand: attach terminal to an orphaned session
if (cliSubcommand === 'attach') {
  const { runAttachCommand } = await import('./cli/cmd-attach.ts');
  process.exit(
    await runAttachCommand(
      resolved,
      {
        ...(cliPort !== undefined && { port: cliPort }),
        ...(cliHost !== undefined && { host: cliHost }),
        ...(cliSubcommandArg !== undefined && { subcommandArg: cliSubcommandArg }),
      },
      { store: new SessionStore(), registry: liveSessionsRegistry },
      { out: console.log, err: console.error, log },
    ),
  );
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
      console.error(errorToString(err));
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
    console.error(errorToString(err));
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
// Telegram disabled: multi-daemon 409 conflicts (issue #285). Re-enable when addressed.
const TELEGRAM_ENABLED = false;
if (TELEGRAM_TOKEN) {
  console.warn('[Telegram] Telegram notifications are currently disabled (multi-daemon conflict)');
}
const TELEGRAM_AUTHORIZED_CHAT_IDS = [...remiConfig.telegram.authorized_chat_ids];
const TELEGRAM_AUTHORIZED_USER_IDS = [...remiConfig.telegram.authorized_user_ids];

// ---------------------------------------------------------------------------
// Auto-approve service (optional, LLM-based permission evaluation)
// ---------------------------------------------------------------------------
let autoApproveService: AutoApproveService | null = null;
{
  const aaCfg = remiConfig.auto_approve;
  const aaEnabled = parsedArgs.autoApprove ?? aaCfg.enabled;
  if (aaEnabled) {
    const provider = parsedArgs.autoApproveProvider ?? aaCfg.provider;
    const model = parsedArgs.autoApproveModel ?? aaCfg.model;
    const apiKey = parsedArgs.autoApproveApiKey ?? aaCfg.api_key;
    const baseUrl = resolveProviderUrl(provider, aaCfg.base_url);
    // CLI allow/deny flags append to config lists; instructions override config.
    const allow = [...aaCfg.allow, ...parsedArgs.autoApproveAllow];
    const deny = [...aaCfg.deny, ...parsedArgs.autoApproveDeny];
    const instructions = parsedArgs.autoApproveInstructions ?? aaCfg.instructions;
    if (parsedArgs.autoApproveInstructions && aaCfg.instructions) {
      writeToLog(
        `[AutoApprove] CLI --auto-approve-instructions overrides TOML instructions (${aaCfg.instructions.length} chars discarded)`,
      );
    }

    autoApproveService = new AutoApproveService(
      {
        ...aaCfg,
        provider,
        model,
        api_key: apiKey,
        base_url: baseUrl,
        enabled: true,
        allow,
        deny,
        instructions,
      },
      writeToLog,
    );
    const rulesSummary = `allow=${allow.length} deny=${deny.length} instructions=${instructions ? 'yes' : 'no'}`;
    writeToLog(
      `[AutoApprove] Enabled: model=${model}, provider=${provider}, base_url=${baseUrl}, ${rulesSummary}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SIGTSTP protection: the daemon must never suspend itself.
// When Claude Code handles Ctrl+Z (which spawns a subshell inside its PTY),
// the terminal may propagate SIGTSTP to the process group. Ignoring it here
// keeps the daemon, WebSocket server, and all remote connections alive.
// ---------------------------------------------------------------------------
process.on('SIGTSTP', () => {
  // Intentionally ignored. The PTY child handles Ctrl+Z on its own; the
  // daemon process must remain running to serve remote clients.
  writeToLog('[signal] SIGTSTP received and ignored (daemon must not suspend)');
});

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
      } else if (session?.explicitlyDetached) {
        log(`Session explicitly detached: ${sessionId} (no timeout, re-attachable)`);
      } else {
        log(`Session orphaned: ${sessionId} (will timeout in 5 minutes)`);
      }
    },
    onSessionResumed: (sessionId, connectionId) => {
      log(`Session resumed: ${sessionId} by connection ${connectionId}`);
    },
    onConnectionPromoted: (sessionId, connectionId, result) => {
      log(`Promoted waiting connection ${connectionId} to session ${sessionId}`);
      const sent = registry.sendRaw(
        connectionId,
        createHelloAck('1.0.0', sessionId, {
          isResume: result.replayMessages.length > 0,
          replayCount: result.replayMessages.length,
          nextBulletId: result.nextBulletId,
        }),
      );
      if (!sent) {
        log(`Promoted connection ${connectionId} is unreachable; detaching`);
        sessionRegistry.detachConnection(connectionId);
        return;
      }
      if (result.replayMessages.length > 0) {
        const replaySent = registry.sendRaw(
          connectionId,
          createReplayBatch(sessionId, result.replayMessages, true),
        );
        if (!replaySent) {
          log(`Failed to send replay batch to promoted connection ${connectionId}`);
        }
      }
      cancelOrphanTimeout();
    },
  },
);

// The primary session ID (in wrapper mode, this is the one running in the terminal).
// Stored in cli/session-state.ts so extracted handler modules can read it via
// getPrimarySessionId() without closing over a cli.ts-local `let` that flips
// after handler registration.
import { getPrimarySessionId, setPrimarySessionId } from './cli/session-state.ts';
// Ports being claimed by in-flight daemon spawn requests (prevents TOCTOU race)
const spawningPorts = new Set<number>();

// Device tokens for push notifications (cleaned up on disconnect; re-registered on reconnect)
const deviceTokens = new Map<
  string,
  { token: string; platform: string; registeredAt: number; connectionId: UUID }
>();

// Hook infrastructure (initialized in wrapper mode when hooks are enabled)
let HOOK_PORT = 0; // OS-assigned; actual port read from hookServer.port after start
let hookServer: HookServer | null = null;
let hookConfigManager: HookConfigManager | null = null;

// mDNS publisher (initialized when daemon is network-accessible)
let mdnsPublisher: import('./mdns/mdns-publisher.ts').MdnsPublisher | null = null;

// Watcher for live-sessions directory (pushes session list updates on new daemon startup)
let liveSessionsWatcher: import('node:fs').FSWatcher | null = null;
let liveWatchDebounce: ReturnType<typeof setTimeout> | null = null;

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
    const msg = errorToString(err);
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
    // Always record under primarySessionId so replay works correctly.
    // The client only knows primarySessionId (from hello_ack).
    const recordId = getPrimarySessionId() ?? sessionId;
    sendMessage(sessionId, message);
    sessionRegistry.recordOutgoingMessage(recordId, message);
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
        const questionSessionId = getPrimarySessionId() ?? sessionId;
        const msg: ProtocolMessage = {
          type: 'question',
          id: generateId(),
          timestamp: now(),
          question: question,
          sessionId: questionSessionId,
        };
        sendAndRecord(msg);
        sessionRegistry.updateQuestion(questionSessionId, question);

        // Push to registered devices only when no client is actively viewing the session.
        // If a client is attached, they see the question in the UI; no push needed.
        const sessionForPush = sessionRegistry.getSession(questionSessionId);
        const hasActiveClient =
          sessionForPush !== undefined && sessionForPush.activeConnectionId !== null;
        if (deviceTokens.size > 0 && !hasActiveClient) {
          const session = sessionRegistry.getSession(sessionId);
          const sessionName = session?.name || 'Agent';
          const signalingUrl = cliSignalingUrl ?? remiConfig.network.signaling_url;
          const pushSessionId = getPrimarySessionId() ?? sessionId;
          const pushCategory = selectPushCategory(question.options);
          const pushOptions = question.options.map((o) => o.value);
          for (const dt of deviceTokens.values()) {
            sendPushTrigger(signalingUrl, dt.token, {
              title: `${sessionName} needs input`,
              body: question.text.slice(0, 100),
              ...(cliPushSecret !== undefined ? { pushSecret: cliPushSecret } : {}),
              sessionId: pushSessionId,
              questionId: question.id,
              ...(pushCategory !== undefined ? { category: pushCategory } : {}),
              ...(pushOptions.length > 0 ? { options: pushOptions } : {}),
            })
              .then(() => log(`Push notification sent for session ${pushSessionId}`))
              .catch((err) => log(`Push notification failed: ${err}`));
          }
        }
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

  // PTY output parser: streamStatusOnly suppresses regular agent content (comes
  // from transcript). Tool-output errors (e.g. "OAuth token revoked") bypass the
  // guard so terminal-only failures still reach remote clients.
  const outputProcessor = new OutputProcessor(
    { sessionId, streamStatusOnly: true },
    {
      onMessage: (message) => {
        // Only fires for tool-output errors that bypass streamStatusOnly.
        messageApi.handleMessage(message);
      },
      onQuestion: (question) => {
        // When hooks are active, questions come from HookEventBridge which merges
        // PermissionRequest (tool context) with Notification (numbered options).
        // PTY question detection is only needed when hooks are not available.
        if (!hookServer) {
          messageApi.handleQuestion(question);
        }
      },
      onStatusChange: (status, context) => {
        if (!hookServer) {
          messageApi.handleStatusChange(status, context);
        }
      },
    },
  );

  // Hook-based event bridge for status/question detection
  if (hookServer) {
    // Track the Claude session ID so we can filter hook events by session.
    // Before SessionStart fires, we let events through (claudeSessionId is null).
    let claudeSessionId: string | null = null;

    // Our PTY is the ground truth for "main interactive session". A hook event
    // with a different session_id is NEVER our main:
    //  - Subagent spawn (TaskCreate/TeamCreate) — different session_id, no own PTY
    //  - Sibling daemon's Claude — different session_id, different PTY elsewhere
    //  - Actual Claude restart in our PTY — only possible after our PTY exited
    // So: while our PTY is running, treat any different session_id as foreign.
    // Once our PTY exits, a new session_id represents a genuine new Claude.
    // Flag set on explicit SessionEnd so we don't wait for PTY exit if Claude
    // shut down cleanly.
    let mainSessionEnded = false;

    // Extract transcript info from hook events. Most Claude Code hook events include
    // session_id and transcript_path. When present, the first event gives us the
    // transcript path, bypassing the slower mtime fallback.
    //
    // GUARD: When sibling daemons serve the same directory, all Claudes POST to all
    // hook URLs (shared settings.local.json). So a sibling's event may arrive before
    // our own Claude fires. In that case, skip hook-based discovery and let the
    // mtime fallback handle it. For single-daemon directories (the common case),
    // accept the first event immediately.
    let hasSiblingInDir: boolean | null = null; // Computed once, then cached

    // Safely tear down an existing transcript watcher, reset messages, and notify
    // clients. Handles errors from stop() and sendAndRecord() so they never prevent
    // the new watcher from being created. Shared by initFromHookEvent and onSessionInfo.
    function teardownWatcher(reason: string, label: string): void {
      const watcher = transcriptWatchers.get(sessionId);
      if (!watcher) return;
      transcriptWatchers.delete(sessionId); // Remove from map FIRST to unblock new watcher
      try {
        watcher.stop();
      } catch (stopErr) {
        logError(`[Hooks] Failed to stop watcher (${label}): ${errorToString(stopErr)}`);
      }
      messageApi.reset();
      try {
        sendAndRecord(createSessionReset(sessionId, reason));
      } catch (sendErr) {
        logError(`[Hooks] Failed to send ${reason} for ${sessionId}: ${errorToString(sendErr)}`);
      }
    }

    function initFromHookEvent(input: {
      session_id?: string;
      transcript_path?: string;
      hook_event_name?: string;
    }): void {
      if (!input.session_id) return;

      const classification = classifySessionEvent({
        currentLock: claudeSessionId,
        incomingSessionId: input.session_id,
        mainPtyRunning: sessionRegistry.getSession(sessionId)?.pty.isRunning ?? false,
        mainSessionEnded,
      });

      if (classification === 'foreign') {
        // Subagent or sibling daemon event. Drop to avoid hijacking our lock.
        // Log for observability: if classifier misbehaves, we still see activity.
        log(
          `[Hooks] Dropped foreign ${input.hook_event_name ?? 'event'}: lock=${claudeSessionId?.slice(0, 8)} incoming=${input.session_id.slice(0, 8)}`,
        );
        return;
      }
      if (classification === 'restart') {
        log(
          `[Hooks] Claude restart detected (ended=${mainSessionEnded}): ${claudeSessionId} -> ${input.session_id}`,
        );
        teardownWatcher('claude_restarted', 'restart');
        claudeSessionId = null;
        mainSessionEnded = false;
      }
      // classification === 'match': either our tracked session or first-time lock.
      if (claudeSessionId) return; // already initialized
      if (!input.transcript_path) return;

      if (hasSiblingInDir === null) {
        hasSiblingInDir = liveSessionsRegistry
          .listLive()
          .some(
            (e) =>
              e.projectPath === workingDirectory && e.sessionId !== sessionId && e.wsPort !== PORT,
          );
      }

      if (hasSiblingInDir) {
        // Cannot trust which Claude sent this event — defer to fallback
        return;
      }

      try {
        claudeSessionId = input.session_id;
        log(
          `[Hooks] Transcript from ${input.hook_event_name ?? 'hook'}: claude=${claudeSessionId}, transcript=${input.transcript_path}`,
        );
        sessionStore.updateClaudeSessionId(sessionId, claudeSessionId);

        // Cancel the fallback timer since we have the exact path
        const fallbackTimer = transcriptFallbackTimers.get(sessionId);
        if (fallbackTimer) {
          clearInterval(fallbackTimer);
          transcriptFallbackTimers.delete(sessionId);
        }

        // If a fallback watcher claimed the slot with a different (stale) file,
        // replace it with the authoritative hook-provided path.
        const existingWatcher = transcriptWatchers.get(sessionId);
        if (
          existingWatcher &&
          path.resolve(existingWatcher.filePath) !== path.resolve(input.transcript_path)
        ) {
          log(
            `[Hooks] Replacing stale watcher: ${existingWatcher.filePath} -> ${input.transcript_path}`,
          );
          teardownWatcher('transcript_changed', 'stale-replace');
        }

        if (!transcriptWatchers.has(sessionId) && sessionRegistry.hasSession(sessionId)) {
          startTranscriptWatcher(sessionId, input.transcript_path, messageApi, sendAndRecord);
        }
      } catch (err) {
        logError(
          `[Hooks] initFromHookEvent failed for session ${sessionId}: ${errorToString(err)}`,
        );
        claudeSessionId = null; // Reset so fallback can take over
      }
    }

    const hookBridge = new HookEventBridge(sessionId, {
      onStatusChange: (status: AgentStatus, context?: string) => {
        messageApi.handleStatusChange(status, context);
      },
      onQuestion: (question) => {
        messageApi.handleQuestion(question);
      },
      onSessionInfo: (hookClaudeSessionId: string, transcriptPath: string) => {
        // Guard: skip if sibling daemons share this directory (event may be from sibling's Claude)
        if (hasSiblingInDir === null) {
          hasSiblingInDir = liveSessionsRegistry
            .listLive()
            .some(
              (e) =>
                e.projectPath === workingDirectory &&
                e.sessionId !== sessionId &&
                e.wsPort !== PORT,
            );
        }
        if (hasSiblingInDir) return;

        // Use the same classifier as initFromHookEvent so both paths share
        // one rule for distinguishing foreign (subagent/sibling) from restart.
        const classification = classifySessionEvent({
          currentLock: claudeSessionId,
          incomingSessionId: hookClaudeSessionId,
          mainPtyRunning: sessionRegistry.getSession(sessionId)?.pty.isRunning ?? false,
          mainSessionEnded,
        });
        if (classification === 'foreign') {
          log(
            `[Hooks] Dropped foreign SessionInfo: lock=${claudeSessionId?.slice(0, 8)} incoming=${hookClaudeSessionId.slice(0, 8)}`,
          );
          return;
        }
        if (classification === 'restart') {
          log(
            `[Hooks] Claude restart (SessionInfo, ended=${mainSessionEnded}): ${claudeSessionId} -> ${hookClaudeSessionId}`,
          );
          teardownWatcher('claude_restarted', 'restart-sessioninfo');
          claudeSessionId = null;
          mainSessionEnded = false;
        }

        try {
          claudeSessionId = hookClaudeSessionId;
          log(`[Hooks] SessionStart: claude=${hookClaudeSessionId}, transcript=${transcriptPath}`);
          sessionStore.updateClaudeSessionId(sessionId, hookClaudeSessionId);

          // If a fallback watcher claimed the slot with a different (stale) file,
          // replace it with the authoritative hook-provided path.
          const existingWatcher = transcriptWatchers.get(sessionId);
          if (
            existingWatcher &&
            path.resolve(existingWatcher.filePath) !== path.resolve(transcriptPath)
          ) {
            log(
              `[Hooks] Replacing stale watcher (SessionInfo): ${existingWatcher.filePath} -> ${transcriptPath}`,
            );
            teardownWatcher('transcript_changed', 'stale-replace-sessioninfo');
          }

          if (!transcriptWatchers.has(sessionId) && sessionRegistry.hasSession(sessionId)) {
            startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
          }
        } catch (err) {
          logError(`[Hooks] onSessionInfo failed for ${sessionId}: ${errorToString(err)}`);
          claudeSessionId = null;
        }
      },
    });

    const handlers = hookBridge.hookHandlers();
    // initFromHookEvent runs before the bridge handler: it covers events where
    // onSessionInfo doesn't fire (PreToolUse, etc.). For SessionStart, both paths
    // converge; guards prevent double-processing.
    hookServer.on('SessionStart', (input) => {
      // SessionStart with an explicit main-transition source (/clear /compact
      // /resume) is the authoritative signal that our main Claude took a new
      // session_id while our PTY kept running. Pre-empt the classifier by
      // treating the old session as ended, so the classifier sees a 'restart'
      // and cleanly switches the lock.
      if (input.source === 'clear' || input.source === 'compact' || input.source === 'resume') {
        if (claudeSessionId && input.session_id && input.session_id !== claudeSessionId) {
          log(
            `[Hooks] Main lifecycle transition (${input.source}): ${claudeSessionId} -> ${input.session_id}`,
          );
          mainSessionEnded = true; // classifier will pick this up as 'restart'
        }
      }
      initFromHookEvent(input);
      handlers.onSessionStart?.(input);
    });
    // Filter: accept events only from our own Claude. Before claudeSessionId is known,
    // block events when siblings exist (they could be from sibling's Claude).
    const filterBySession = (input: { session_id?: string }): boolean => {
      if (claudeSessionId) return input.session_id === claudeSessionId;
      return !hasSiblingInDir; // No sibling → events can only be ours
    };

    // Subagent/team-member events carry `agent_id` (confirmed via
    // REMI_HOOK_DEBUG capture 2026-04-16). They share main's session_id and
    // transcript, so session-id filtering cannot distinguish them. Drop these
    // at the hook layer so status updates, auto-approve, question emission,
    // and PTY injection all stay scoped to the main interactive session.
    const isSubagentEvent = (input: { agent_id?: string }): boolean =>
      typeof input.agent_id === 'string' && input.agent_id.length > 0;

    hookServer.on('PreToolUse', (input) => {
      initFromHookEvent(input);
      if (!filterBySession(input)) return;
      if (isSubagentEvent(input)) return;
      handlers.onPreToolUse?.(input);
    });
    hookServer.on('PostToolUse', (input) => {
      initFromHookEvent(input);
      if (!filterBySession(input)) return;
      if (isSubagentEvent(input)) return;
      handlers.onPostToolUse?.(input);
    });
    hookServer.on('Notification', (input) => {
      initFromHookEvent(input);
      if (!filterBySession(input)) return;
      // Subagent notifications must not bubble up to the user (phantom prompts).
      if (isSubagentEvent(input)) {
        log(`[Hooks] Dropped subagent Notification: agent=${input.agent_id?.slice(0, 8)}`);
        return;
      }
      handlers.onNotification?.(input);
    });
    hookServer.on('PermissionRequest', (input) => {
      initFromHookEvent(input);
      if (!filterBySession(input)) return;

      // Subagent PermissionRequest: Claude Code sets `agent_id` on events
      // originating from Task/Agent-spawned subagents or team members. Those
      // events share the main session_id and transcript but are handled
      // internally by Claude Code — they MUST NOT be injected into our main PTY.
      if (isSubagentEvent(input)) {
        log(
          `[Hooks] Dropped subagent PermissionRequest: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
        );
        return;
      }

      // Legacy nested-Task context (kept as secondary safety net).
      const inSubagent = hookBridge.isInSubagentContext();
      const sessionTag = sessionId.slice(0, 8);

      // Helper: inject an answer into the PTY. Returns true on success. On
      // failure (session not found, PTY not running, submitInput throws) the
      // helper never throws — it logs and returns false so callers can fall
      // back to escalating the prompt to the user.
      const inject = async (value: '1' | '3', reason: string): Promise<boolean> => {
        try {
          const session = sessionRegistry.getSession(sessionId);
          if (!session) {
            logError(`[AutoApprove ${sessionTag}] Session not found; cannot inject "${value}"`);
            return false;
          }
          await session.pty.submitInput(value);
          log(`[AutoApprove ${sessionTag}] Injected "${value}" into PTY (${reason})`);
          sessionRegistry.updateStatus(sessionId, value === '1' ? 'executing' : 'thinking');
          hookBridge.markPermissionHandled();
          return true;
        } catch (err) {
          logError(`[AutoApprove ${sessionTag}] inject("${value}") threw:`, err);
          return false;
        }
      };

      // Safe escalation to the user. Used when inject fails or when auto-approve
      // is off and we're in main context. Wrapped so bridge/push failures don't
      // leave the hook handler with a dangling unhandled rejection.
      const escalateToUser = () => {
        try {
          handlers.onPermissionRequest?.(input);
        } catch (err) {
          logError(`[AutoApprove ${sessionTag}] escalateToUser threw:`, err);
        }
      };

      // Auto-approve gate: evaluate before creating Question object.
      if (autoApproveService) {
        const aaService = autoApproveService;
        aaService
          .evaluate(input.tool_name, input.tool_input, sessionTag)
          .then(async (result) => {
            if (result.decision === 'approve') {
              if (!(await inject('1', 'approved'))) escalateToUser();
              return;
            }
            if (result.decision === 'deny') {
              if (!(await inject('3', 'denied'))) escalateToUser();
              return;
            }
            // escalate: if we're in a subagent context, default-deny to avoid
            // hanging the subagent. The user would not be able to answer anyway.
            if (inSubagent) {
              log(`[AutoApprove ${sessionTag}] Subagent context; escalate->deny to prevent hang`);
              // If inject fails here, the subagent is hung regardless — no main
              // PTY to escalate to. Log and accept.
              await inject('3', 'subagent-escalate-default-deny');
              return;
            }
            escalateToUser();
          })
          .catch(async (err) => {
            // Last line of defense. Must not leave an unhandled rejection.
            try {
              logError(`[AutoApprove ${sessionTag}] Unexpected error:`, err);
              if (inSubagent) {
                await inject('3', 'subagent-error-default-deny');
                return;
              }
              escalateToUser();
            } catch (inner) {
              logError(`[AutoApprove ${sessionTag}] catch handler threw:`, inner);
            }
          });
        return;
      }

      // No auto-approve. If in subagent context, still must not hang the subagent:
      // default-deny rather than emit a question the user can't answer.
      if (inSubagent) {
        log(`[${sessionTag}] Subagent context without auto-approve; default-deny`);
        inject('3', 'subagent-no-aa-default-deny').catch((err) => {
          logError(`[${sessionTag}] Failed to inject default-deny:`, err);
        });
        return;
      }

      escalateToUser();
    });
    hookServer.on('Stop', (input) => {
      initFromHookEvent(input);
      if (!filterBySession(input)) return;
      handlers.onStop?.(input);
    });
    hookServer.on('SessionEnd', (input) => {
      // Only mark our main as ended when the session_id matches what we locked.
      // Foreign SessionEnds (subagents, siblings) must not unlock our tracking.
      if (input.session_id && claudeSessionId && input.session_id === claudeSessionId) {
        mainSessionEnded = true;
      }
      if (!filterBySession(input)) return;
      handlers.onSessionEnd?.(input);
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
              logError(`Unexpected terminal write error (${code}):`, errorToString(err));
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
              logError(`[PTY] Cleanup failed: ${errorToString(err)}`);
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

  // Transcript watcher: normally started by hook event (provides path directly).
  // When sibling daemons serve the same directory, hook events are skipped and
  // this fallback becomes the primary discovery path.
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
    // Look for a transcript file that is actively being written to.
    // When sibling daemons serve the same directory, exclude transcripts they've
    // already claimed (by claudeSessionId in sessions.json) to avoid double-watching.
    const RECENT_THRESHOLD_MS = 5 * 60 * 1000;
    const siblingClaudeIds = new Set<string>();
    for (const entry of sessionStore.list()) {
      if (entry.remiSessionId !== sessionId && entry.claudeSessionId && !entry.exitedAt) {
        siblingClaudeIds.add(entry.claudeSessionId);
      }
    }
    const transcriptPath =
      siblingClaudeIds.size > 0
        ? transcriptDiscovery.findLatestTranscriptExcluding(workingDirectory, siblingClaudeIds)
        : transcriptDiscovery.findLatestTranscript(workingDirectory);
    if (transcriptPath) {
      try {
        const stat = fs.statSync(transcriptPath);
        if (stat.mtimeMs >= startupTime || Date.now() - stat.mtimeMs < RECENT_THRESHOLD_MS) {
          clearInterval(fallbackInterval);
          transcriptFallbackTimers.delete(sessionId);
          log(`[Hooks] Found new transcript via fallback: ${transcriptPath}`);
          startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
          extractClaudeSessionId(transcriptPath, sessionId);
          return;
        }
      } catch (err) {
        log(`[Hooks] Fallback stat failed for ${transcriptPath}: ${errorToString(err)}`);
      }
    }
    // Give up after 30 seconds
    if (Date.now() - startupTime > 30000) {
      clearInterval(fallbackInterval);
      transcriptFallbackTimers.delete(sessionId);
      if (transcriptPath) {
        try {
          const stat = fs.statSync(transcriptPath);
          const isRecent =
            stat.mtimeMs >= startupTime || Date.now() - stat.mtimeMs < RECENT_THRESHOLD_MS;
          if (isRecent) {
            log('[Hooks] Transcript fallback: found recent transcript on final check.');
            startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
            extractClaudeSessionId(transcriptPath, sessionId);
            return;
          }

          logError(
            `[Hooks] Transcript fallback timed out without a fresh transcript. Skipping stale file: ${transcriptPath}`,
          );
          return;
        } catch {
          logError(
            '[Hooks] Transcript fallback timed out and transcript stat failed on final check.',
          );
          return;
        }
      }

      logError('[Hooks] Transcript fallback timed out without any transcript file.');
    }
  }, 2000);
  transcriptFallbackTimers.set(sessionId, fallbackInterval);

  return ptySession;
}

/** Extract Claude session ID from transcript filename and persist it. Returns the extracted ID or null. */
function extractClaudeSessionId(transcriptPath: string, sessionId: UUID): string | null {
  // Transcript filenames are plain UUIDs (e.g. "abc123-def456.jsonl").
  // The underscore split is defensive in case a prefixed format is ever introduced.
  const basename = path.basename(transcriptPath, '.jsonl');
  const parts = basename.split('_');
  const candidateId = parts[parts.length - 1];
  if (candidateId && candidateId.length >= 8) {
    sessionStore.updateClaudeSessionId(sessionId, candidateId);
    log(`Claude session ID: ${candidateId}`);
    return candidateId;
  }
  return null;
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

import { getRecentDirectories } from './cli/recent-client.ts';

const sendToConnection = (connectionId: UUID, message: ProtocolMessage): boolean => {
  return registry.sendRaw(connectionId, message);
};

const trivialHandlers: TrivialHandlers = createTrivialHandlers({
  deviceTokens,
  sessionStore,
  sessionRegistry,
  send: sendToConnection,
});

const inputHandlers: InputHandlers = createInputHandlers({
  sessionRegistry,
  send: sendToConnection,
});

const sessionHandlers: SessionHandlers = createSessionHandlers({
  sessionRegistry,
  sessionStore,
  transcriptDiscovery,
  liveSessionsRegistry,
  currentPort: () => PORT,
  untrackConnection: (id) => registry.untrackConnection(id),
  onConnectionRemoved: () =>
    updateRemiStatus({ connections: Math.max(0, remiStatus.connections - 1) }),
  send: sendToConnection,
});

const transcriptHandlers: TranscriptHandlers = createTranscriptHandlers({
  transcriptDiscovery,
  transcriptWatchers,
  send: sendToConnection,
});

const resumeSessionHandlers: ResumeSessionHandlers = createResumeSessionHandlers({
  sessionRegistry,
  sessionStore,
  transcriptDiscovery,
  createNewSession,
  send: sendToConnection,
});

const createSessionHandlers_: CreateSessionHandlers = createCreateSessionHandlers({
  liveSessionsRegistry,
  spawningPorts,
  basePort: remiConfig.daemon.base_port,
  portRange: remiConfig.daemon.port_range,
  // Lazy: bindHost is declared after sharedEvents is wired up, so compute
  // the inherited-args array on each spawn rather than capturing it here.
  inheritedArgs: () => {
    const args: string[] = [];
    if (cliAuth === true) args.push('--auth');
    if (cliAuth === false) args.push('--no-auth');
    if (cliNoRelay) args.push('--no-relay');
    if (cliNoMdns) args.push('--no-mdns');
    if (bindHost !== '0.0.0.0') args.push('--bind', bindHost);
    return args;
  },
  send: sendToConnection,
});

const connectionHandlers: ConnectionHandlers = createConnectionHandlers({
  sessionRegistry,
  deviceTokens,
  trackConnection: (id, adapterType) => registry.trackConnection(id, adapterType),
  untrackConnection: (id) => registry.untrackConnection(id),
  onConnectionAdded: () => updateRemiStatus({ connections: remiStatus.connections + 1 }),
  onConnectionRemoved: () =>
    updateRemiStatus({ connections: Math.max(0, remiStatus.connections - 1) }),
  cancelOrphanTimeout,
  send: sendToConnection,
});

const sharedEvents = {
  ...trivialHandlers,
  ...inputHandlers,
  ...sessionHandlers,
  ...connectionHandlers,
  ...transcriptHandlers,
  ...createSessionHandlers_,
  ...resumeSessionHandlers,
};

// ---------------------------------------------------------------------------
// Auth setup: disabled by default. Enable with --auth flag.
// Local/private networks don't need auth; relay/public access does.
// ---------------------------------------------------------------------------
const bindHost = cliBindHost ?? remiConfig.daemon.bind;
const isLocalhostBind = bindHost === 'localhost' || bindHost === '127.0.0.1' || bindHost === '::1';

// Determine whether auth should be enabled
// Priority: CLI flag > config file > default (off)
const configAuth = remiConfig.auth.enabled;
const authEnabled = cliAuth ?? (configAuth === 'auto' ? false : configAuth);

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
      const detail = errorToString(err);
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
      const detail = errorToString(err);
      console.error(`Failed to unlock identity: ${detail}`);
      console.error('Wrong passphrase?');
      process.exit(1);
    }
  } else {
    // Unencrypted identity: unlock instantly
    try {
      unlockedIdentity = await unlockIdentity(storedIdentity);
    } catch (err) {
      const detail = errorToString(err);
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
      logError(`[Hooks] Failed to uninstall hook config: ${errorToString(err)}`);
    }
    hookConfigManager = null;
  }

  if (mdnsPublisher) {
    try {
      await mdnsPublisher.stop();
    } catch (err) {
      const msg = errorToString(err);
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
  if (liveWatchDebounce) {
    clearTimeout(liveWatchDebounce);
    liveWatchDebounce = null;
  }
  if (liveSessionsWatcher) {
    liveSessionsWatcher.close();
    liveSessionsWatcher = null;
  }
  await registry.stopAll();
  await sessionRegistry.shutdown();
  cleanupStatusFile();

  // Remove from live sessions directory
  const primary = getPrimarySessionId();
  if (primary) {
    liveSessionsRegistry.unregister(primary);
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
resolveShellPath({ log, error: logError });

if (cliDaemonMode) {
  console.log('Starting Remi daemon...');

  // Phase 1: Start non-port-binding adapters (Relay, Telegram) once
  try {
    await registry.startAllExcept(['websocket']);
  } catch (err) {
    const msg = errorToString(err);
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
    const msg = errorToString(err);
    console.error(`Failed to start WebSocket on port ${PORT}: ${msg}`);
    console.error('Use --port to specify a different port, or stop existing sessions.');
    await registry.stopAll();
    process.exit(1);
  }

  mdnsPublisher = await startMdnsIfNeeded(console.log);

  // Create the daemon's single session (one session per daemon)
  const workingDirectory = cliDir ? path.resolve(cliDir) : process.cwd();
  const sessionId = sessionRegistry.createSessionId();
  setPrimarySessionId(sessionId);

  updateRemiStatus({ wsPort: PORT, sessionId, sessionStatus: 'starting' });
  installStatusLine(REMI_DIR);

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
    const msg = errorToString(err);
    console.error(
      `Hook server failed to start: ${msg}. Status detection and question forwarding disabled.`,
    );
    hookServer = null;
  }

  if (hookServer) {
    try {
      hookConfigManager = new HookConfigManager(workingDirectory, hookServer.url);
      await hookConfigManager.install();
    } catch (err) {
      const msg = errorToString(err);
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
    const msg = errorToString(err);
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
      console.error(`[reload] Failed to load config: ${errorToString(err)}`);
    }
  });
} else {
  // Wrapper mode: spawn Claude immediately, pass through terminal I/O
  // Block ALL output paths to the terminal. In Bun compiled binaries,
  // console.log uses a native path that bypasses process.stdout.write,
  // so we must override both layers. Only the PTY raw byte pass-through
  // (via fs.writeSync to stdout fd) can reach the actual terminal.
  ptyStdoutFd = 1; // stdout file descriptor

  ensureRemiDir();
  startLogFileSession(LOG_FILE, { dir: os.tmpdir(), pid: process.pid });

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
  process.on('exit', endLogFileSession);

  // Install status line script (~/.remi/statusline.sh) and auto-configure Claude Code settings
  installStatusLine(REMI_DIR);
  const workingDirectory = process.cwd();
  const sessionId = sessionRegistry.createSessionId();
  setPrimarySessionId(sessionId);

  updateRemiStatus({ wsPort: PORT, sessionId, sessionStatus: 'starting' });

  // Phase 1: Start non-port-binding adapters (Relay, Telegram) once
  try {
    await registry.startAllExcept(['websocket']);
  } catch (err) {
    logError(`Failed to start background adapters: ${errorToString(err)}`);
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
        logError(`Failed to tear down WebSocket adapter: ${errorToString(teardownErr)}`);
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
      const msg = errorToString(err);
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
    await hookConfigManager.install();
    log('[Hooks] Claude Code hooks configured');
  } catch (err) {
    const msg = errorToString(err);
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

    // Watch for new daemons registering in live-sessions and push updates to clients.
    // This lets clients auto-connect when a sibling session starts in the same directory.
    try {
      liveSessionsWatcher = fs.watch(
        liveSessionsRegistry.dirPath,
        { persistent: false },
        (_event) => {
          // Debounce: macOS FSEvents fires multiple events per rename (tmp → final).
          if (liveWatchDebounce) clearTimeout(liveWatchDebounce);
          liveWatchDebounce = setTimeout(() => {
            liveWatchDebounce = null;
            try {
              const newPorts = liveSessionsRegistry.getLivePorts().filter((p) => p !== PORT);
              if (newPorts.length === 0) return;
              // Include external sessions so the broadcast doesn't wipe transcript sessions
              // that are already visible on the client (session_list_response replaces all
              // sessions for this connection).
              const managedIds = new Set<string>(sessionRegistry.getActiveSessionIds());
              for (const remiId of [...managedIds]) {
                const stored = sessionStore.findByRemiSessionId(remiId as UUID);
                if (stored?.claudeSessionId) managedIds.add(stored.claudeSessionId);
              }
              const allSessions = [
                ...sessionRegistry.listSessions(),
                ...transcriptDiscovery.discoverSessions(managedIds),
              ];
              const msg = createSessionListResponse(allSessions, generateId() as UUID, newPorts);
              registry.broadcast(msg);
            } catch (err) {
              logError(`[LiveSessions] Error pushing session update: ${errorToString(err)}`);
            }
          }, 300);
        },
      );
    } catch (err) {
      logError(`[LiveSessions] Could not watch live-sessions dir: ${errorToString(err)}`);
    }
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
        log(`[Wrapper] Failed to write session name: ${errorToString(err)}`);
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
        log(`[PTY] write failed: ${errorToString(err)}`);
      }
    }
  }

  const detachScanner = new DetachScanner({
    onDetach: () => {
      if (ptyStdoutFd !== null) {
        try {
          fs.writeSync(ptyStdoutFd, '\r\n[detached]\r\n');
        } catch (err) {
          log(`[Detach] Failed to write detach message: ${errorToString(err)}`);
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
      log(`[PTY] resize failed: ${errorToString(err)}`);
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
        log(`[Detach] setRawMode restore failed: ${errorToString(err)}`);
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
            logError(`[SIGHUP] Cleanup failed: ${errorToString(err)}`);
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
          logError(`[Detach] Cleanup failed: ${errorToString(err)}`);
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
      logError(`[reload] Failed to load config: ${errorToString(err)}`);
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
      logError(`[SIGTERM] Cleanup failed: ${errorToString(err)}`);
    }
    process.exit(0);
  });
}
