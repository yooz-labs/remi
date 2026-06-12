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
      return '0.6.11-dev.2'; // REMI_COMPILED_VERSION
    }
    return pkg.version;
  } catch (err) {
    // REMI_COMPILED_VERSION is updated by scripts/bump-version.sh at release time.
    // This fallback is used in compiled binaries where package.json is unavailable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'MODULE_NOT_FOUND') {
      console.error(`[remi] Failed to read version: ${(err as Error).message}`);
    }
    return '0.6.11-dev.2'; // REMI_COMPILED_VERSION
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
// State lives in cli/wrapper-state.ts so extracted phases can read/write it
// without closing over a cli.ts-local `let` that flips across call sites.
import {
  getPtyStdoutFd,
  isWrapperDetached,
  setPtyStdoutFd,
  setWrapperDetached,
} from './cli/wrapper-state.ts';

function ensureRemiDir(): void {
  fs.mkdirSync(REMI_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Status file for status line integration
// Guard: only writes in wrapper mode (wrapperMode is set during arg parsing)
// ---------------------------------------------------------------------------
import { detectGitInfo, loadDotenvFile } from './cli/startup-env.ts';
import { IDLE_AUTO_APPROVE, type RemiStatus, StatusWriter } from './cli/status-writer.ts';

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
    autoApprove: { ...IDLE_AUTO_APPROVE },
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
  createDaemonUpdateAvailable,
  createHelloAck,
  createReplayBatch,
  createSessionListResponse,
  generateId,
} from '@remi/shared';
import type { ProtocolMessage, UUID, UnlockedIdentity } from '@remi/shared';
import { isEncrypted, unlockIdentity } from '@remi/shared';
import { AdapterRegistry, TelegramAdapter, WebSocketAdapter } from './adapters/index.ts';
import { QuestionPresenceTracker } from './api/question-presence-tracker.ts';
import { Authenticator } from './auth/authenticator.ts';
import { IdentityStore } from './auth/identity-store.ts';
import { AutoApproveService, resolveProviderUrl } from './auto-approve/index.ts';
import { resolveClaudeBinding } from './cli/claude-binding.ts';
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
import { setupHookBridge } from './cli/session-phases/hook-bridge-setup.ts';
import { createMessageApiForSession } from './cli/session-phases/message-api-setup.ts';
import { createPtySessionForSession } from './cli/session-phases/pty-session-setup.ts';
import { StatusBar, childRows } from './cli/status-bar.ts';
import { installStatusLine } from './cli/statusline-installer.ts';
import { installSuspendHandler } from './cli/suspend-handler.ts';
import { startTranscriptFallback } from './cli/transcript-fallback.ts';
import { isRemiBinaryPath, startUpdateWatcher } from './cli/update-watcher.ts';
import { applyEnvOverrides, loadConfig } from './config/index.ts';
import type { RemiConfig } from './config/index.ts';
import { HookConfigManager, HookServer } from './hooks/index.ts';
import { OutputProcessor } from './parser/output-processor.ts';
import { PTYManager, type PTYSession } from './pty/index.ts';
import {
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
  SessionBindingStore,
  SessionRegistry,
  SessionRegistryFile,
  SessionStore,
  type StoredSession,
} from './session/index.ts';
import { findAvailableTcpPort } from './session/port-utils.ts';
import { TranscriptDiscovery, type TranscriptWatcher } from './transcript/index.ts';

// ---------------------------------------------------------------------------
// Logging: In wrapper mode, all daemon logs go to ~/.remi/remi.log
// ---------------------------------------------------------------------------
import { configureLogger, isWrapperMode, log, logError, setWrapperMode } from './cli/logger.ts';

configureLogger({ writeLog: writeToLog });

// wrapperDetached lives in cli/wrapper-state.ts (see top of file).
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

// Experimental TranscriptBinder flags (#453 phase 3). Snapshotted into immutable
// module-level consts at boot and NEVER re-read per session: a mid-process flip
// would split sessions across the old/new code paths, which share the
// transcriptWatchers map. SIGUSR1 / config reload is a no-op for these; an
// instant flip-back means a daemon restart (design §3.1 v4 #9).
// transcript_binder_enabled defaults ON (#503); transcript_binder_shadow OFF.
const binderEnabled = remiConfig.features.transcript_binder_enabled;
// Drive mode and shadow mode are mutually exclusive: enabled wins. When the
// binder DRIVES, running the shadow alongside it would be meaningless (and would
// double-construct the binder), so the shadow is suppressed whenever drive is on.
const binderShadow = remiConfig.features.transcript_binder_shadow && !binderEnabled;

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

    const multichoice = parsedArgs.autoApproveMultichoice ?? aaCfg.multichoice;
    const multichoiceModel = parsedArgs.autoApproveMultichoiceModel ?? aaCfg.multichoice_model;

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
        multichoice,
        multichoice_model: multichoiceModel,
      },
      writeToLog,
    );
    const rulesSummary = `allow=${allow.length} deny=${deny.length} instructions=${instructions ? 'yes' : 'no'}`;
    const mcSummary = `multichoice=${multichoice}${multichoiceModel ? ` mc_model=${multichoiceModel}` : ''}`;
    const escalateSummary = aaCfg.escalate_model
      ? `escalate_model=${aaCfg.escalate_model}${aaCfg.escalate_timeout > 0 ? ` (timeout=${aaCfg.escalate_timeout}s)` : ''}`
      : 'escalate_model=none';
    const queueSummary = `queue_timeout=${aaCfg.queue_timeout > 0 ? `${aaCfg.queue_timeout}s` : 'none'}`;
    writeToLog(
      `[AutoApprove] Enabled: model=${model}, provider=${provider}, base_url=${baseUrl}, ${rulesSummary}, ${mcSummary}, ${escalateSummary}, ${queueSummary}`,
    );
    // Warm-load the heavy second-opinion model so the first escalation is not a
    // cold start. Best-effort, fire-and-forget (never blocks daemon startup).
    void autoApproveService.warmEscalateModel();
  }
}

// The auto-approve eval cue (#560) is surfaced in Claude's native status line via
// the StatusWriter (see the gate cue wiring in setupHookBridge); it replaced the
// shared title-bar TerminalIndicator, which raced under concurrent evals.

// ---------------------------------------------------------------------------
// SIGTSTP / Ctrl+Z handling.
//
// Wrapper mode (`remi <args>`): the wrapper installs `cli/suspend-handler.ts`
// later, after the PTY is up. That handler tears down raw mode and self-sends
// SIGSTOP for a real shell-job suspend.
//
// Daemon mode (`remi daemon`): we MUST never let the daemon suspend itself.
// If a foreground daemon receives `kill -TSTP <pid>` (or the controlling
// terminal sends SIGTSTP for any reason), the kernel default would stop the
// process, dropping every WebSocket client and halting APNS push. We install
// an unconditional no-op listener here so the kernel default never fires.
// REGRESSION GUARD (PR #364 review): a previous refactor deleted this
// listener and only installed the wrapper-mode handler; foreground `remi
// daemon` then suspended on `kill -TSTP`. Do not remove this without
// replacing it with an equivalent guard.
//
// Other non-wrapper invocations (`remi ls`, `remi attach`, etc.) are
// short-lived clients where the kernel default for SIGTSTP is acceptable.
// ---------------------------------------------------------------------------
if (cliDaemonMode) {
  process.on('SIGTSTP', () => {
    // Intentionally ignored. The daemon must remain running to serve remote
    // clients; suspending it would drop WebSocket sessions and APNS pushes.
    writeToLog('[signal] SIGTSTP received and ignored (daemon must not suspend)');
  });
}

// ---------------------------------------------------------------------------
// Core components
// ---------------------------------------------------------------------------
const _ptyManager = new PTYManager();
const transcriptDiscovery = new TranscriptDiscovery();
const transcriptWatchers: Map<UUID, TranscriptWatcher> = new Map();
const transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>> = new Map();
// Per-session drive-mode TranscriptBinder teardown hooks (#453 phase 3, commit
// 5). The shared transcriptWatchers/transcriptFallbackTimers cleanup below stops
// the binder's watcher + fallback timer, but NOT its #452 rotation dir-poll
// interval (it lives inside the binder); close() reaches all three. Empty when
// transcript_binder_enabled is off (no binder is ever constructed).
const binderClosers: Map<UUID, () => void> = new Map();
const sessionStore = new SessionStore();
// Tracks the subagent chats the primary session spawns, so the client can
// switch the displayed view to a subagent (epic #499 phase 3). Shared by the
// hook bridge (writes) and the transcript handler (resolves agentId -> path).
const subagentViews = new SubagentViewRegistry();
// Single binding accessor for the whole daemon (#460 phase 2): the one typed,
// disk-backed surface for remiUUID<->claudeSessionId. Every binding read/write +
// both resume resolvers route through it. No cache — see session-binding-store.ts.
const bindingStore = new SessionBindingStore(sessionStore);

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
      // Tear down the drive-mode binder (rotation dir-poll + fallback timer) at
      // session close, not just at process cleanup — else the poll interval leaks
      // for the rest of the daemon's life across resumes (#463 phase 3 review).
      binderClosers.get(sessionId)?.();
      binderClosers.delete(sessionId);
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
      // NOTE: this resolves the hello_ack binding inline rather than via
      // currentOwnedSession() because the promoted connection may be attaching
      // to a specific `sessionId` that is not necessarily the daemon's primary.
      // Both read the same disk-backed store, so they stay in sync (#499).
      const stored = sessionStore.findByRemiSessionId(sessionId);
      const claudeId = stored?.claudeSessionId ?? null;
      const projPath = stored?.projectPath ?? null;
      const tpath =
        claudeId && projPath
          ? `${transcriptDiscovery.getProjectTranscriptDir(projPath)}/${claudeId}.jsonl`
          : null;
      const sent = registry.sendRaw(
        connectionId,
        createHelloAck(
          '1.0.0',
          sessionId,
          {
            isResume: result.replayMessages.length > 0,
            replayCount: result.replayMessages.length,
            nextBulletId: result.nextBulletId,
          },
          { claudeSessionId: claudeId, transcriptPath: tpath },
        ),
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

import { SubagentViewRegistry } from './api/subagent-view-registry.ts';
import { makeCurrentSessionResolver } from './cli/current-session.ts';
// The primary session ID (in wrapper mode, this is the one running in the terminal).
// Stored in cli/session-state.ts so extracted handler modules can read it via
// getPrimarySessionId() without closing over a cli.ts-local `let` that flips
// after handler registration.
import { getPrimarySessionId, setPrimarySessionId } from './cli/session-state.ts';
// Ports being claimed by in-flight daemon spawn requests (prevents TOCTOU race)
const spawningPorts = new Set<number>();

// Device tokens for push notifications. INTENTIONALLY persisted across
// WebSocket disconnect — push notifications are the suspended-app path, so
// dropping on disconnect breaks the only case they exist for. Cleanup happens
// at process exit only. Issue #286.
const deviceTokens = new Map<
  string,
  { token: string; platform: string; registeredAt: number; connectionId: UUID }
>();

// Hook infrastructure (initialized in wrapper mode when hooks are enabled)
let HOOK_PORT = 0; // OS-assigned; actual port read from hookServer.port after start
let hookServer: HookServer | null = null;
let hookConfigManager: HookConfigManager | null = null;

// Watches `dist/remi` (or whatever process.execPath resolves to) for a fresh
// build and notifies attached clients so users know to restart their session.
// Initialised in both wrapper and daemon modes after the WebSocket server
// is up; cleaned up alongside hookServer in cleanup(). Issue #287.
let updateWatcher: import('./cli/update-watcher.ts').UpdateWatcher | null = null;

// Best-effort synchronous cleanup on any exit path. SIGINT/SIGTERM already
// run the async cleanup() which calls hookConfigManager.uninstall(); this
// handler is the last line of defense for `process.exit()` calls and
// uncaught exceptions, so a daemon that crashes does not leave stale
// hook URLs in `.claude/settings.local.json` that gate Claude Code
// (issue #203). SIGKILL still leaves entries by definition; the next
// startup's purgeStaleHooks recovers from that.
process.on('exit', () => {
  if (hookConfigManager) {
    hookConfigManager.uninstallSync();
  }
});

// mDNS publisher (initialized when daemon is network-accessible)
let mdnsPublisher: import('./mdns/mdns-publisher.ts').MdnsPublisher | null = null;

/**
 * Start the on-disk binary watcher. Idempotent — repeated calls are no-ops.
 * Polls every 60s; on the first detected change, broadcasts a single
 * `daemon_update_available` to every attached client and stops itself.
 *
 * Skips activation when `process.execPath` does not look like the compiled
 * remi binary. `bun run packages/daemon/src/cli.ts` (dev) or an npm-wrapper
 * install that invokes a runtime (bun, node) directly would otherwise have
 * the watcher tracking the runtime instead of remi — and a `brew upgrade
 * bun` would silently misfire as "remi update available". The guard mirrors
 * `daemon-manager.ts`'s existing endsWith('/remi') convention. Issue #287
 * review (PR #370).
 */
function startBinaryUpdateWatcher(): void {
  if (updateWatcher) return;
  const execPath = process.execPath;
  if (!isRemiBinaryPath(execPath)) {
    log(`[update] Watcher disabled: execPath ${execPath} is not the remi binary`);
    return;
  }
  updateWatcher = startUpdateWatcher({
    binaryPath: execPath,
    intervalMs: 60_000,
    onUpdateDetected: () => {
      log(`[update] Newer remi binary detected at ${execPath}; notifying clients`);
      try {
        registry.broadcast(createDaemonUpdateAvailable(REMI_VERSION, execPath));
      } catch (err) {
        logError(`[update] broadcast failed: ${errorToString(err)}`);
      }
    },
    onError: (err) => logError(`[update] ${err.message}`),
  });
}

// Watcher for live-sessions directory (pushes session list updates on new daemon startup)
let liveSessionsWatcher: import('node:fs').FSWatcher | null = null;
let liveWatchDebounce: ReturnType<typeof setTimeout> | null = null;

// Reserved-row status bar (#565). Assigned in wrapper mode; stays null in
// daemon mode. Module-level so cleanup() (defined outside the wrapper block)
// can clear the row on shutdown.
let statusBar: StatusBar | null = null;

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
  reservedRows = 0,
): Promise<PTYSession> {
  const { messageApi, sendAndRecord } = createMessageApiForSession(
    {
      sessionRegistry,
      transcriptWatchers,
      deviceTokens,
      pushConfig: () => ({
        signalingUrl: cliSignalingUrl ?? remiConfig.network.signaling_url,
        ...(cliPushSecret !== undefined ? { pushSecret: cliPushSecret } : {}),
      }),
      updateRemiStatus: (patch) => updateRemiStatus(patch),
      maxBulletLength: MAX_BULLET_LENGTH,
      sendMessage,
      // Lazy disk-backed read so the binding seen on each question emission is
      // the current value — survives /resume rotation via the hook bridge's
      // bindingStore.update write. Wrapped in try/catch so a transient
      // sessions.json I/O hiccup cannot kill question emission (the dep
      // contract is non-throwing).
      getClaudeSessionId: () => {
        try {
          return (bindingStore.get(sessionId)?.claudeSessionId ?? null) as UUID | null;
        } catch (err) {
          logError(`[Binding] getClaudeSessionId lookup failed: ${errorToString(err)}`);
          return null;
        }
      },
    },
    sessionId,
  );

  // PTY output parser: streamStatusOnly suppresses regular agent content (comes
  // from transcript). Tool-output errors (e.g. "OAuth token revoked") bypass the
  // guard so terminal-only failures still reach remote clients.

  // QuestionPresenceTracker pairs hook-derived metadata with PTY-derived
  // screen presence: hooks record (no push), PTY confirms (push). Status
  // transitions out of 'waiting' drop pending records so auto-approve
  // silent paths never push.
  const tracker = new QuestionPresenceTracker((q) => messageApi.handleQuestion(q));

  const outputProcessor = new OutputProcessor(
    { sessionId, streamStatusOnly: true },
    {
      onMessage: (message) => {
        // Only fires for tool-output errors that bypass streamStatusOnly.
        messageApi.handleMessage(message);
      },
      onQuestion: (question) => {
        tracker.onPTYPromptVisible(question);
      },
      onStatusChange: (status, context) => {
        if (!hookServer) {
          messageApi.handleStatusChange(status, context);
        }
        tracker.onStatusChange(status);
      },
    },
  );

  // Deterministic PTY -> transcript binding (#427). Resolve the
  // claudeSessionId Claude will write under BEFORE spawning, so sibling
  // daemons in the same cwd cannot race-claim each other's transcripts
  // through mtime-based discovery.
  const binding = resolveClaudeBinding(extraArgs, {
    displayName: `remi:${remiStatus.wsPort}`,
  });
  log(
    `[Binding] claude=${binding.claudeSessionId.slice(0, 8)} source=${binding.source} for remi=${sessionId.slice(0, 8)}`,
  );

  // Persist the binding before spawn so siblings observing the store
  // during the race window see our claim immediately.
  bindingStore.preAssign({
    remiSessionId: sessionId,
    claudeSessionId: binding.claudeSessionId,
    projectPath: workingDirectory,
    port: PORT,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });

  if (hookServer) {
    const hookBridgeHandle = setupHookBridge(
      {
        sessionRegistry,
        bindingStore,
        liveSessionsRegistry,
        transcriptWatchers,
        transcriptFallbackTimers,
        autoApproveService,
        currentPort: () => PORT,
        shadowBinder: binderShadow,
        binderEnabled,
        transcriptDiscovery,
        subagentViews,
        statusWriter,
      },
      { hookServer, sessionId, workingDirectory, messageApi, sendAndRecord, tracker },
    );
    // In drive mode the binder owns the fallback poll + #452 dir-watch (armed by
    // its start() inside setupHookBridge); record its teardown so cleanup()
    // reaches the rotation dir-poll interval the shared maps below cannot.
    if (binderEnabled) binderClosers.set(sessionId, hookBridgeHandle.closeBinder);
  }

  const ptySession = createPtySessionForSession(
    {
      sessionRegistry,
      sessionStore,
      liveSessionsRegistry,
      outputProcessor,
      wsPort: remiStatus.wsPort,
      sendMessage,
      cleanup,
    },
    { sessionId, workingDirectory, extraArgs: binding.args, passThrough, reservedRows },
  );

  const locallyOwned = passThrough; // wrapper-mode sessions are locally owned
  sessionRegistry.registerSession(
    sessionId,
    workingDirectory,
    ptySession,
    messageApi,
    locallyOwned,
  );

  // If the spawn or any post-spawn wiring throws, mark the pre-saved
  // store entry as exited so sibling daemons reading the store don't
  // see a phantom "live" session with our claudeSessionId reserved.
  // Without this, the failed-spawn entry stays exitedAt=null and the
  // pid-aliveness self-heal in SessionStore only fires after our
  // daemon process itself exits.
  try {
    await ptySession.start();
  } catch (err) {
    sessionStore.markExited(sessionId, null);
    throw err;
  }

  // Record the spawned Claude child pid in the live-sessions entry now that the
  // PTY is up. Co-located daemons use it to tell a live sibling from a zombie
  // (daemon process alive, its Claude long dead) so a leftover daemon can no
  // longer permanently wedge our rotation handling (#451).
  const claudeChildPid = ptySession.childPid;
  if (claudeChildPid !== null) {
    liveSessionsRegistry.setClaudeChildPid(sessionId, claudeChildPid);
  } else {
    // Unreachable after a successful start() (the child pid is assigned
    // synchronously by the spawn). Log rather than silently skip: without the
    // pid the entry stays "unknown" and peers keep treating this live session
    // as a zombie's sibling, re-opening the wedge this fix closes (#451).
    logError(`[live-sessions] No Claude child pid after PTY start for session ${sessionId}`);
  }

  // In drive mode the TranscriptBinder's start() (inside setupHookBridge) already
  // armed BOTH the fallback poll and the #452 rotation dir-watch; arming it again
  // here would double-arm the same fallback timer. Only the old path needs this.
  if (!binderEnabled) {
    startTranscriptFallback(
      {
        sessionRegistry,
        transcriptDiscovery,
        transcriptWatchers,
        transcriptFallbackTimers,
      },
      sessionId,
      workingDirectory,
      binding.claudeSessionId,
      messageApi,
      sendAndRecord,
    );
  }

  return ptySession;
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
  bindingStore,
  send: sendToConnection,
});

const sessionHandlers: SessionHandlers = createSessionHandlers({
  sessionRegistry,
  bindingStore,
  transcriptDiscovery,
  liveSessionsRegistry,
  currentPort: () => PORT,
  untrackConnection: (id) => registry.untrackConnection(id),
  onConnectionRemoved: () =>
    updateRemiStatus({ connections: Math.max(0, remiStatus.connections - 1) }),
  send: sendToConnection,
});

// The single authoritative "current owned session" accessor (#499), shared by
// the transcript-request redirect and the hello_ack binding so they never diverge.
const currentOwnedSession = makeCurrentSessionResolver({
  getPrimarySessionId,
  sessionStore,
  transcriptDiscovery,
});

const transcriptHandlers: TranscriptHandlers = createTranscriptHandlers({
  transcriptDiscovery,
  transcriptWatchers,
  bindingStore,
  currentOwnedSession,
  subagentViews,
  send: sendToConnection,
});

const resumeSessionHandlers: ResumeSessionHandlers = createResumeSessionHandlers({
  sessionRegistry,
  sessionStore,
  bindingStore,
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
  currentOwnedSession,
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

  // Stop and clear the reserved-row status bar (#565) before the rest of
  // teardown so the terminal is left clean. No-op in daemon mode (null).
  statusBar?.stop();
  statusBar = null;

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

  if (updateWatcher) {
    updateWatcher.stop();
    updateWatcher = null;
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

  // Drive-mode binders own a rotation dir-poll interval the shared maps below do
  // not reach; close() tears down its watcher + fallback timer + dir-poll. No-op
  // map when transcript_binder_enabled is off.
  for (const closeBinder of binderClosers.values()) {
    closeBinder();
  }
  binderClosers.clear();
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

  // Notify attached clients when a new dist/remi build replaces this binary
  // on disk so they know to restart their session (#287).
  startBinaryUpdateWatcher();

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
  setPtyStdoutFd(1); // stdout file descriptor

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

    // Notify attached clients when a new dist/remi build replaces this binary
    // on disk so they know to restart their session (#287).
    startBinaryUpdateWatcher();

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
                const binding = bindingStore.get(remiId as UUID);
                if (binding?.claudeSessionId) managedIds.add(binding.claudeSessionId);
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

  // Reserved-row status bar (#565). Only in wrapper mode with a real TTY, and
  // off-able via config. When active, Claude is reported `rows - 1` so it never
  // touches the bottom row, which remi draws into. A non-TTY stdout (piped) has
  // no row to reserve, so it fails safe to off.
  const statusBarActive = remiConfig.terminal.status_bar && Boolean(process.stdout.isTTY);
  const reservedRows = statusBarActive ? 1 : 0;

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
    reservedRows,
  );

  // Start drawing the reserved-row bar now that the PTY is up. Reads the live
  // StatusWriter state and repaints on a 1Hz timer (the cadence of the
  // `evaluating Ns` counter), which also re-asserts the bar if Claude's output
  // scrolled it. Inert until started, and a no-op when detached.
  if (statusBarActive) {
    statusBar = new StatusBar({
      getStdoutFd: getPtyStdoutFd,
      getStatus: () => statusWriter.state,
      getSize: () => ({
        cols: process.stdout.columns || 120,
        rows: process.stdout.rows || 40,
      }),
      isEnabled: () => !isWrapperDetached(),
      log: (m) => log(m),
    });
    statusBar.start();
  }

  // Print session name to terminal (useful for 'remi new' and general awareness)
  {
    const stdoutFd = getPtyStdoutFd();
    if (stdoutFd !== null) {
      const managedSession = sessionRegistry.getSession(sessionId);
      if (managedSession) {
        try {
          fs.writeSync(stdoutFd, `Session: ${managedSession.name}\r\n`);
        } catch (err) {
          log(`[Wrapper] Failed to write session name: ${errorToString(err)}`);
        }
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

  // Ctrl+Z handler (issue #361). Installed before the DetachScanner so the
  // scanner can route the `0x1A` byte directly into `requestSuspend()`. The
  // SIGCONT path re-enters raw mode; restoring the data listener is
  // unnecessary because Bun keeps it attached across the SIGSTOP boundary.
  const suspendController = installSuspendHandler({
    onResume: () => {
      // Re-attach to stdin: setRawMode(true) is done inside the handler;
      // here we just ensure stdin is flowing again. `process.stdin.resume()`
      // is idempotent.
      process.stdin.resume();
    },
  });

  const detachScanner = new DetachScanner({
    onDetach: () => {
      const stdoutFd = getPtyStdoutFd();
      if (stdoutFd !== null) {
        try {
          fs.writeSync(stdoutFd, '\r\n[detached]\r\n');
        } catch (err) {
          log(`[Detach] Failed to write detach message: ${errorToString(err)}`);
        }
      }
      // detachLocalTerminal disposes the suspend controller as part of its
      // teardown, so no extra cleanup is needed here.
      detachLocalTerminal('keybinding');
    },
    onData: (data) => {
      writeToPty(data.toString());
    },
    onSuspend: () => {
      suspendController.requestSuspend();
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
    const realRows = process.stdout.rows || 40;
    // Keep reserving the bottom row for the bar (#565): Claude still sees one
    // row fewer so it never reflows over the reserved row. Once detached, give
    // Claude the full height back (the bar is gone).
    const rows = childRows(realRows, statusBarActive && !isWrapperDetached());
    try {
      if (ptySession.isRunning) {
        ptySession.resize({ cols, rows });
      }
    } catch (err) {
      log(`[PTY] resize failed: ${errorToString(err)}`);
    }
    // Repaint the bar at the new last row after the child has reflowed.
    statusBar?.render();
  });

  // Detach local terminal.
  // SIGHUP (terminal closed): keep PTY + WebSocket alive for 30 minutes, then shut down.
  // Ctrl+B d (keybinding): cleanly exit and return the shell to the user.
  const SIGHUP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  function detachLocalTerminal(reason: 'sighup' | 'keybinding'): void {
    if (isWrapperDetached()) return;
    setWrapperDetached(true);

    // Tear down the wrapper-mode SIGTSTP/SIGCONT listeners; once the local
    // terminal is gone there is no value in suspending the process.
    suspendController.dispose();

    // Stop the reserved-row bar and clear it while the real fd is still valid
    // (the sighup branch nulls it below). Restore Claude's full winsize so the
    // lingering PTY isn't stuck a row short before a remote client re-attaches.
    statusBar?.stop();
    statusBar = null;
    if (statusBarActive && ptySession.isRunning) {
      try {
        ptySession.resize({
          cols: process.stdout.columns || 120,
          rows: process.stdout.rows || 40,
        });
      } catch (err) {
        logError(`[Detach] winsize restore failed: ${errorToString(err)}`);
      }
    }

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
      setPtyStdoutFd(null);
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
    if (isWrapperDetached()) return; // No local terminal to forward from
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
