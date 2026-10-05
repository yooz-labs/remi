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
      return '0.7.16-dev.11'; // REMI_COMPILED_VERSION
    }
    return pkg.version;
  } catch (err) {
    // REMI_COMPILED_VERSION is updated by scripts/bump-version.sh at release time.
    // This fallback is used in compiled binaries where package.json is unavailable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'MODULE_NOT_FOUND') {
      console.error(`[remi] Failed to read version: ${(err as Error).message}`);
    }
    return '0.7.16-dev.11'; // REMI_COMPILED_VERSION
  }
})();

// ---------------------------------------------------------------------------
// Paths and utilities for log file and status file (used in wrapper mode)
// ---------------------------------------------------------------------------
const REMI_DIR = remiHome();
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
import { type RemiStatus, StatusWriter } from './cli/status-writer.ts';

const gitInfo = detectGitInfo();

// #754/#755: the StatusWriter is constructed before the AdapterRegistry and
// SessionRegistry exist, so its broadcast + attach-state deps are late-bound
// through these slots (assigned right after the AdapterRegistry below).
let remiStatusBroadcast: ((status: Readonly<RemiStatus>) => void) | null = null;
let remiAttachState: (() => { attached: boolean; queuedCount: number } | null) | null = null;

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
    version: REMI_VERSION,
  },
  {
    // daemon-status.json belongs EXCLUSIVELY to the hub (#542, #740 review):
    // every session daemon — hub-spawned (REMI_SPAWNED_CHILD, set by
    // spawnRemiDaemon for ANY parent handling create_session_request) or a
    // manually run `remi --daemon` — writes the per-port status-<PORT>.json
    // a wrapper does. Two writers on daemon-status.json would race, and
    // `remi stop`/`status` resolve the hub through that file; per-port is
    // also what the Claude statusline script reads ($REMI_PORT-keyed).
    getTargetFile: () =>
      serveMode && process.env['REMI_SPAWNED_CHILD'] !== '1' ? DAEMON_STATUS_FILE : STATUS_FILE,
    isEnabled: () => isWrapperMode() || cliDaemonMode,
    writeLog: writeToLog,
    getAttachState: () => remiAttachState?.() ?? null,
    broadcast: (status) => remiStatusBroadcast?.(status),
  },
);

/** Thin back-compat aliases so existing cli.ts call sites keep working. */
const remiStatus: Readonly<RemiStatus> = statusWriter.state;
const updateRemiStatus = (patch: Partial<RemiStatus>): void => statusWriter.update(patch);
const cleanupStatusFile = (): void => statusWriter.cleanup();

loadDotenvFile();

import {
  createDaemonUpdateAvailable,
  createQuestionResolved,
  createQuestionSnapshot,
  createRemiStatus,
  createSessionUpdate,
} from '@remi/shared';
import type { HarnessId, ProtocolMessage, UUID, UnlockedIdentity } from '@remi/shared';
import { isEncrypted, unlockIdentity } from '@remi/shared';
import type { AnswerKeyPair } from '@remi/shared';
import { AdapterRegistry, TelegramAdapter, WebSocketAdapter } from './adapters/index.ts';
import { loadOrCreateAnswerKey } from './auth/answer-key.ts';
import { Authenticator } from './auth/authenticator.ts';
import { loadOrCreateCapabilityToken } from './auth/capability-token.ts';
import { IdentityStore } from './auth/identity-store.ts';
import {
  type SubagentAlert,
  SubagentAlerter,
  alertBody,
  alertTitle,
} from './auto-approve/index.ts';
import {
  MODEL_COMMAND_REMOVED_MESSAGE,
  bootNoticeLines,
  legacyEnginePaths,
  removedAutoApproveEnvVars,
} from './cli/auto-approve-removal.ts';
import { detectAutostartState } from './cli/autostart-state.ts';
import { runConfigCommand } from './cli/cmd-config.ts';
import { runMigratePermissionsCommand } from './cli/cmd-migrate-permissions.ts';
import { runReloadCommand } from './cli/cmd-reload.ts';
import { runUnstickCommand } from './cli/cmd-unstick.ts';
import { PID_FILE, readPidFileLive } from './cli/daemon-manager.ts';
import { DetachScanner } from './cli/detach-scanner.ts';
import {
  type ConnectionHandlers,
  createConnectionHandlers,
} from './cli/handlers/connection-events.ts';
import {
  type CreateSessionHandlers,
  createCreateSessionHandlers,
} from './cli/handlers/create-session-events.ts';
import {
  type InputHandlers,
  createInputHandlers,
  gateAnswerDeps,
  trackerScreenDeps,
} from './cli/handlers/input-events.ts';
import { promptUpDeps } from './cli/handlers/prompt-up.ts';
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
import { permissionHoldPolicy } from './cli/hold-policy.ts';
import { HubClientTracker } from './cli/hub-client-tracker.ts';
import { buildHubQuestionCensus } from './cli/hub-question-census.ts';
import type { LiveSessionsCollectResult } from './cli/live-sessions-watcher.ts';
import { startLiveSessionsWatcher } from './cli/live-sessions-watcher.ts';
import {
  endLogFileSession,
  setLogFileContext,
  startLogFileSession,
  writeToLog,
} from './cli/log-file.ts';
import { installProcessGuards } from './cli/process-guards.ts';
import { PtyQuiescenceGate } from './cli/pty-quiescence-gate.ts';
import { createMessageApiForSession } from './cli/session-phases/message-api-setup.ts';
import { StatusBar, childRows } from './cli/status-bar.ts';
import { installStatusLine } from './cli/statusline-installer.ts';
import { installSuspendHandler } from './cli/suspend-handler.ts';
import { isRemiBinaryPath, startUpdateWatcher } from './cli/update-watcher.ts';
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  applyEnvOverrides,
  loadConfigWithNotices,
  relayRequested,
} from './config/index.ts';
import type { LoadedConfig, RemiConfig } from './config/index.ts';
import {
  configPathForDisplay,
  isRemiHomeOverridden,
  remiHome,
  serviceCommandRefusal,
} from './config/remi-home.ts';
import { validateClaudeRemoteArgs } from './harness/claude-args.ts';
import { attachCommand } from './harness/codex/attach-hint.ts';
import { validateCodexArgs, validateCodexRemoteArgs } from './harness/codex/codex-args.ts';
import {
  codexLaunchRefusal,
  codexResumeCommand,
  findHeldThread,
  legacyWriterRefusal,
  olderRemiNotice,
} from './harness/codex/codex-session.ts';
import { CodexHarness } from './harness/codex/codex.ts';
import { shortThreadId } from './harness/codex/thread-id.ts';
import { ClaudeHarness } from './harness/index.ts';
import type { Harness, HarnessSession } from './harness/index.ts';
import { HarnessRegistry } from './harness/registry.ts';
import { ForeignSessionEscalator, HookConfigManager, HookServer } from './hooks/index.ts';
import type { PermissionDeniedHookInput } from './hooks/index.ts';
// Static, unlike the publisher below it: this is a pure decision with no
// side effects and nothing to load, so there is nothing for a dynamic import
// to defer -- and it is needed on the path where mDNS never starts at all.
import { mdnsSuppression, mdnsSuppressionMessage } from './mdns/advertise-decision.ts';
import { createClaudeTurnStop } from './notifications/claude-turn-stop.ts';
import { DeviceTokenStore } from './notifications/device-token-store.ts';
import { pushHarnessDenied } from './notifications/harness-denied.ts';
import type { NotificationDispatcher } from './notifications/notification-dispatcher.ts';
import { sendPushTrigger } from './notifications/push-client.ts';
import { createTurnEventSink } from './notifications/turn-events.ts';
import { createTurnFailedRoutes } from './notifications/turn-failed.ts';
import { TurnTimer } from './notifications/turn-timer.ts';
import { PTYManager, type PTYSession } from './pty/index.ts';
import { RELAY_NOT_STARTED_NOTICE } from './remote/relay-notices.ts';
import {
  AmbiguousSessionIdentityError,
  DEFAULT_BASE_PORT,
  DEFAULT_PORT_RANGE,
  PendingQuestionCreatedAtTracker,
  SessionBindingStore,
  SessionHarnessMismatchError,
  SessionRegistry,
  SessionRegistryFile,
  SessionStore,
  type StoredSession,
  TranscriptIndex,
  isClaudeRecord,
  resolveStoredSession,
  storedHarness,
} from './session/index.ts';
import { findLegacyWriters, readStatusFiles } from './session/legacy-writers.ts';
import { findAvailableTcpPort } from './session/port-utils.ts';
import { traceQuestionEvent } from './session/question-trace.ts';
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
import { looseArgs, parseArgs, parseHostPath } from './cli/arg-parser.ts';
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

// 'migrate-permissions' (#1125) reads the RAW config.toml itself, so it runs
// before the config loader (which no longer knows [auto_approve]) and works
// even when another section of the file would fail validation.
if (parsedArgs.subcommand === 'migrate-permissions') {
  process.exit(runMigratePermissionsCommand(parsedArgs.subcommandArg));
}

// ---------------------------------------------------------------------------
// Load config file (before consuming parsed args, so config provides defaults)
// ---------------------------------------------------------------------------
let remiConfig: RemiConfig;
let loadedConfig: LoadedConfig;
try {
  loadedConfig = loadConfigWithNotices();
  remiConfig = applyEnvOverrides(loadedConfig.config);
} catch (err) {
  console.error(errorToString(err));
  process.exit(1);
}

// #1125 (ADR 0030): settings and flags for the removed auto-approve judgment
// are accepted and ignored, never fatal. Say so ONCE per boot (see
// `bootNoticeLines` for which commands print what), not on every client
// subcommand (`remi ls`, ...). process.stderr, not console.warn: Bun colors
// console output even when piped, and the LaunchAgent captures this stream
// into remi-stderr.log.
for (const line of bootNoticeLines(
  parsedArgs.subcommand,
  {
    configPath: CONFIG_PATH,
    removedConfigKeys: loadedConfig.removedAutoApproveKeys,
    subagentAlertFromLegacy: loadedConfig.subagentAlertFromLegacy,
    removedFlags: parsedArgs.removedFlags,
    removedEnvVars: removedAutoApproveEnvVars(process.env),
    ...legacyEnginePaths(),
  },
  process.env,
)) {
  process.stderr.write(`${line}\n`);
}

// Handle 'config' subcommand
if (parsedArgs.subcommand === 'config') {
  process.exit(runConfigCommand(parsedArgs.subcommandArg, remiConfig));
}

// Handle 'reload' subcommand
if (parsedArgs.subcommand === 'reload') {
  process.exit(runReloadCommand());
}

// 'model' subcommand (#819) was removed with the local LLM evaluator (#1125,
// ADR 0030). Still recognized, so `remi model pull x` never reaches Claude as
// arguments; it explains the removal and exits 2.
if (parsedArgs.subcommand === 'model') {
  // process.stderr, not console.error: Bun colors console.error even when
  // piped, and a script checking this line should see plain text.
  process.stderr.write(`${MODEL_COMMAND_REMOVED_MESSAGE}\n`);
  process.exit(2);
}

// Handle 'unstick' subcommand (#617): SIGUSR2 -> force-release stuck daemon(s).
if (parsedArgs.subcommand === 'unstick') {
  const parsedPort = parsedArgs.subcommandArg ? Number(parsedArgs.subcommandArg) : Number.NaN;
  const targetPort = Number.isInteger(parsedPort) ? parsedPort : undefined;
  process.exit(runUnstickCommand(targetPort));
}

// Destructure into existing variable names for zero downstream changes
const cliPort = parsedArgs.port;
const cliNoTelegram = parsedArgs.noTelegram;
const cliMaxBulletLength = parsedArgs.maxBulletLength;
const cliSignalingUrl = parsedArgs.signalingUrl;
const cliNoRelay = parsedArgs.noRelay;
const cliResume = parsedArgs.resume;
const cliShowSessions = parsedArgs.showSessions;
const cliInstall = parsedArgs.install;
const cliUninstall = parsedArgs.uninstall;
const cliSubcommand = parsedArgs.subcommand;
const cliSubcommandArg = parsedArgs.subcommandArg;
// `remi serve` (#542) boots the session-less hub: same boot sequence as
// `--daemon`, minus the single-session tail (see the `serveMode` branches
// further down). It is deliberately NOT among the start/stop/status/logs
// dispatch below, so it falls through to the shared daemon/wrapper boot path.
const serveMode = cliSubcommand === 'serve';
const cliDaemonMode = parsedArgs.daemonMode || serveMode;
const cliCodeRefresh = parsedArgs.codeRefresh;
const cliPermanentCode = parsedArgs.permanentCode;
const cliForce = parsedArgs.force;
const cliStopAll = parsedArgs.stopAll;
const cliUsePassphrase = parsedArgs.usePassphrase;
const cliDecrypt = parsedArgs.decrypt;
const cliEncrypt = parsedArgs.encrypt;
const cliNoTofu = parsedArgs.noTofu;
const cliAuth = parsedArgs.auth;
const cliLabel = parsedArgs.label;
const cliPublicOnly = parsedArgs.publicOnly;
const cliBindHost = parsedArgs.bindHost;
/**
 * The host every listener in this process binds -- and therefore the ONLY host
 * a port bind-probe may be run against (#880). Declared here, next to the flag
 * it comes from, because the first probe happens during port auto-selection far
 * above where the auth block used to compute it; a probe against a different
 * host reports "free" for a port the real bind then fails on. See port-utils.ts.
 */
const bindHost = cliBindHost ?? remiConfig.daemon.bind;
const cliRemoveFingerprint = parsedArgs.removeFingerprint;
const cliNoMdns = parsedArgs.noMdns;
const cliNetwork = parsedArgs.network;
const cliHost = parsedArgs.host;
const cliDir = parsedArgs.dir;
const cliRecent = parsedArgs.recent;
const cliPushSecret = parsedArgs.pushSecret ?? process.env['REMI_PUSH_SECRET'];
const cliOrphanTimeout = parsedArgs.orphanTimeout;
const claudeArgs = [...parsedArgs.claudeArgs];

// Which harness this process hosts (#1177): `remi codex`, or the `--harness <id>` a hub
// gives a child daemon. This build has adapters for Claude and Codex only.
const harnessId: HarnessId = parsedArgs.harness ?? (cliSubcommand === 'codex' ? 'codex' : 'claude');
{
  // `--host` sends only what follows `--`. `--resume` is remi's own flag, so `parseArgs` consumes it
  // and it is not a loose word (G2): without this a Claude `remi new --host h --resume X` looked X
  // up in the LOCAL store (Session not found, or a silently fresh remote session when a local one
  // held the id), the silent-drop class of G2 (#1204 round 2, P5).
  const resumeWithHost =
    cliHost !== undefined &&
    cliResume !== undefined &&
    (cliSubcommand === 'new' || cliSubcommand === undefined || cliSubcommand === 'codex');
  const refusal =
    resumeWithHost && harnessId === 'codex'
      ? 'remi: --resume is not sent to a remote host; for Codex put the resume after --: remi codex --host <host> -- resume <thread id>'
      : resumeWithHost
        ? 'remi: --resume is not sent to a remote host; put it after --: -- --resume <uuid>'
        : harnessId !== 'claude' && harnessId !== 'codex'
          ? `This build has no ${harnessId} adapter.`
          : harnessId !== 'claude' && serveMode
            ? 'The hub hosts no session of its own, so it takes no --harness.'
            : harnessId === 'codex' && cliResume !== undefined
              ? "--resume is remi's flag for Claude sessions; resume a Codex thread with `remi codex resume <thread id>` (`remi --sessions` lists the ids)."
              : null;
  if (refusal !== null) {
    console.error(refusal);
    process.exit(2);
  }
}

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
  const refusal = serviceCommandRefusal(cliInstall ? '--install' : '--uninstall');
  if (refusal !== null) {
    console.error(refusal);
    process.exit(1);
  }
  const platform = process.platform;
  const home = os.homedir();
  // Prefer the PATH-resolved `remi` (a symlink like /opt/homebrew/bin/remi
  // survives a brew upgrade) over process.execPath (a versioned Cellar path
  // baked at install time breaks when the old keg is removed, #542).
  const pathResolved = Bun.which('remi');
  const binaryPath = pathResolved ?? process.execPath;

  if (platform === 'darwin') {
    // Template rationale (serve-not-daemon, KeepAlive semantics) lives with
    // the builder in service-templates.ts.
    const { launchAgentPath, buildLaunchAgentPlist } = await import('./cli/service-templates.ts');
    const dest = launchAgentPath(home);

    if (cliInstall) {
      const content = buildLaunchAgentPlist(binaryPath, home);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // The plist's log paths are `~/.remi` (service-templates.ts) and the
      // service does not inherit this shell's REMI_HOME, so this stays the
      // default directory rather than `remiHome()`.
      fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
      const uid = process.getuid?.() ?? 501;
      // Idempotent reinstall: bootstrap fails if the label is already
      // loaded, so boot out any prior install first (best-effort).
      if (fs.existsSync(dest)) {
        Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}`, dest]);
      }
      fs.writeFileSync(dest, content);
      const result = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, dest]);
      if (result.exitCode === 0) {
        console.log(`Installed LaunchAgent: ${dest}`);
        console.log(`Hub binary: ${binaryPath}${pathResolved ? ' (PATH-resolved)' : ''}`);
        if (!pathResolved) {
          console.log('note: no `remi` on PATH; the absolute binary path was baked into the');
          console.log('LaunchAgent. Re-run `remi --install` after upgrading remi.');
        } else if (fs.realpathSync(pathResolved) !== fs.realpathSync(process.execPath)) {
          // A dev running --install from a local dist/remi while a different
          // remi sits on PATH would otherwise silently bake the OTHER binary.
          console.log('note: PATH remi differs from the binary running --install');
          console.log(`  LaunchAgent will run: ${fs.realpathSync(pathResolved)}`);
          console.log(`  You are running:      ${fs.realpathSync(process.execPath)}`);
        }
        console.log('The Remi hub will start automatically on login.');
      } else {
        console.error(`Failed to load LaunchAgent: ${result.stderr.toString()}`);
        process.exit(1);
      }
    } else {
      if (fs.existsSync(dest)) {
        const uid = process.getuid?.() ?? 501;
        // Deleting the plist does NOT unload a loaded job — bootout does. A
        // non-zero exit is benign when the job simply wasn't loaded, but on
        // any other failure the hub would keep running while we report
        // "Removed", so surface it instead of claiming success silently.
        const bootout = Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}`, dest]);
        if (bootout.exitCode !== 0) {
          const detail = bootout.stderr.toString().trim();
          console.log(
            `note: launchctl bootout exited ${bootout.exitCode}${detail ? ` (${detail})` : ''} — fine if the agent was not loaded; if the hub is still running, stop it with \`remi stop\`.`,
          );
        }
        fs.unlinkSync(dest);
        console.log(`Removed LaunchAgent: ${dest}`);
      } else {
        console.log('No LaunchAgent installed.');
      }
    }
  } else if (platform === 'linux') {
    const { systemdUnitPath, buildSystemdUnit } = await import('./cli/service-templates.ts');
    const dest = systemdUnitPath(home);
    const serviceDir = path.dirname(dest);

    if (cliInstall) {
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.writeFileSync(dest, buildSystemdUnit(binaryPath));
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
        // Same rationale as the darwin branch: `disable --now` is what stops
        // the running unit; deleting the file alone leaves it running.
        const disable = Bun.spawnSync(['systemctl', '--user', 'disable', '--now', 'remi.service']);
        if (disable.exitCode !== 0) {
          const detail = disable.stderr.toString().trim();
          console.log(
            `note: systemctl disable --now exited ${disable.exitCode}${detail ? ` (${detail})` : ''} — fine if the unit was not active; if the hub is still running, stop it with \`remi stop\`.`,
          );
        }
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
      resolvedBindHost: bindHost,
      ...(cliAuth !== undefined && { auth: cliAuth }),
      noMdns: cliNoMdns,
      noRelay: cliNoRelay,
      noTelegram: cliNoTelegram,
      permanentCode: cliPermanentCode,
      ...(cliSignalingUrl !== undefined && { signalingUrl: cliSignalingUrl }),
      ...(cliPushSecret !== undefined && { pushSecret: cliPushSecret }),
      ...(cliOrphanTimeout !== undefined && { orphanTimeout: cliOrphanTimeout }),
      remiVersion: REMI_VERSION,
      all: cliStopAll,
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
        remiVersion: REMI_VERSION,
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
      listLive: () => liveSessionsRegistry.listLive(),
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
      // The harness's own id, labeled with its harness: `claude:<first 8>` for a
      // Claude record, `codex:<last 8>` for a Codex one (#1176; a Codex thread id
      // is a UUIDv7, whose first eight characters are a timestamp). A Claude record
      // with no id yet prints no label, as it always did; a record of another
      // harness with none prints `<harness>:-`, so it never reads as an
      // id-less Claude one.
      const claude = isClaudeRecord(s);
      const recordedId = claude ? s.claudeSessionId : (s.harnessSessionId ?? null);
      const idLabel = recordedId
        ? ` ${storedHarness(s)}:${claude ? recordedId.slice(0, 8) : shortThreadId(recordedId)}`
        : claude
          ? ''
          : ` ${storedHarness(s)}:-`;
      console.log(
        `  ${s.remiSessionId.slice(0, 8)}  ${status}  ${s.projectPath}${idLabel}  ${s.startedAt}`,
      );
      // `remi codex resume` takes the whole thread id, which the label above cuts, and runs in
      // the current directory, so the line changes into the session's own.
      if (s.harness === 'codex' && s.exitedAt !== null && recordedId) {
        console.log(`      resume: ${codexResumeCommand(s.projectPath, recordedId)}`);
      }
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

  try {
    if (cliResume === true) {
      session = store.getMostRecent('claude');
      if (!session) {
        console.error('No sessions to resume. Run `remi --sessions` to see stored sessions.');
        process.exit(1);
      }
    } else {
      // Resolve exact Remi, unique Remi prefix, then Claude identity without
      // ever selecting the first row when the store is ambiguous. A session
      // that ran under another harness is refused, not resumed as Claude.
      session = resolveStoredSession(store.list(), cliResume as string, { harness: 'claude' });
    }
  } catch (err) {
    const reason =
      err instanceof AmbiguousSessionIdentityError || err instanceof SessionHarnessMismatchError
        ? err.message
        : `Could not read stored sessions: ${errorToString(err)}`;
    console.error(reason);
    process.exit(1);
  }

  if (!session) {
    console.error(`Session not found: ${cliResume}`);
    console.error('Run `remi --sessions` to see stored sessions.');
    process.exit(1);
  }

  if (!session.claudeSessionId) {
    console.error(
      `Session ${session.remiSessionId.slice(0, 8)} has no Claude session ID (was it too short-lived?).`,
    );
    process.exit(1);
  }

  // Inject --resume into Claude args. This is the same flag as
  // `ClaudeHarness.resumeArgs` (harness/claude.ts); this block runs at module
  // top level, before `harness` is constructed below, so it cannot call it.
  // Change Claude's resume flag in both places.
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

// remi new --host (and `remi codex --host`): create session on remote daemon, then auto-attach
if (
  (cliSubcommand === 'new' || cliSubcommand === undefined || cliSubcommand === 'codex') &&
  cliHost
) {
  // Only the words after `--` go to the remote session. A loose one used to be dropped without a
  // word, so the host started its own defaults (a fresh session where a resume was typed, its own
  // sandbox where `-s read-only` was): refused instead, before anything is sent (#1179 review, G2).
  const loose = looseArgs(parsedArgs);
  if (loose.length > 0) {
    console.error(
      `remi: arguments for the remote session go after \`--\` (for example \`remi codex --host <host> -- -m <model>\`); not sent: ${loose.join(' ')}`,
    );
    process.exit(2);
  }

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
      // Named only when the person named one (`remi codex`, `--harness`): a request that names none
      // is the plain request an older daemon already understands. What follows `--` is the
      // harness's arguments; the remote daemon checks them against its own allowlist.
      harness: parsedArgs.harness ?? (cliSubcommand === 'codex' ? 'codex' : undefined),
      args: parsedArgs.explicitArgs,
    });
    process.exit(result.exitCode);
  } catch (err) {
    console.error(errorToString(err));
    process.exit(1);
  }
}

// remi new --recent (local): pick directory from recent, chdir, then fall through to wrapper
if (
  (cliSubcommand === 'new' || cliSubcommand === undefined || cliSubcommand === 'codex') &&
  cliRecent &&
  !cliHost
) {
  // A refused Codex argument is refused before the interactive picker, not after it.
  if (harnessId === 'codex') {
    const args = validateCodexArgs(parsedArgs.passthroughArgs);
    if (!args.ok) {
      console.error(args.error);
      process.exit(2);
    }
  }
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
if (
  (cliSubcommand === 'new' || cliSubcommand === undefined || cliSubcommand === 'codex') &&
  cliDir &&
  !cliHost
) {
  const dirResult = resolveDirectory(cliDir);
  if ('error' in dirResult) {
    console.error(dirResult.error);
    process.exit(1);
  }
  process.chdir(dirResult.resolved);
}

// #1025: `gitInfo` above was computed from process.cwd() at module load,
// before args were parsed — a hub-spawned child inherits the hub's cwd, so
// that snapshot named the hub's repo/branch. The --resume/--recent/--dir
// chdirs above (if any) have now settled process.cwd() on the real session
// directory; refresh the status snapshot from it. `remi serve` never chdirs
// here, so this is a no-op and the hub keeps reporting its own cwd.
updateRemiStatus(detectGitInfo());

// Every read-only / remote-client subcommand (ls, recent, kill, detach, attach,
// code, start/stop/status/logs, keys, autostart, --host remote-new) has already
// exited above. Everything past this point boots a daemon or a local wrapper
// session, both of which construct a TranscriptBinder via setupHookBridge.
//
// `transcript_binder_enabled` is a deprecated kill-switch (#470): the old
// hook-binding path it used to select back to has been deleted, so setting it
// false has no effect on behavior anymore — warn so an operator relying on it
// as an escape hatch notices instead of silently getting drive mode anyway.
// Gated here (not earlier) so read-only client invocations, which never touch
// the binder, don't get spammed with a warning about it.
if (!remiConfig.features.transcript_binder_enabled) {
  logError(
    '[Config] transcript_binder_enabled=false is deprecated and has no effect: the old hook-binding path it used to restore was deleted in #470. The TranscriptBinder always drives session binding now.',
  );
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
    bindHost,
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
// Per-session harness sessions, keyed by sessionId (#1164): the answer, chat
// and Stop handlers reach the RIGHT session's decisions (gate handle and
// screen reads, #573, #920) through it, `remi unstick` force-releases each
// one, and session close disposes it (which tears down the Claude
// TranscriptBinder's rotation dir-poll that the shared transcriptWatchers and
// transcriptFallbackTimers cleanup below cannot reach, #453). It replaced the
// `sessionGateHandles`, `sessionTrackers` and `binderClosers` maps, which the
// launch filled in separately; every session has an entry, a session with no
// hook server just has nothing held.
const harnessSessions: Map<UUID, HarnessSession> = new Map();
/**
 * Force-release every session's gate (#617, `remi unstick` -> SIGUSR2): the "just
 * get me out" lever when cards are stuck. Each gate resolves and dismisses every
 * open escalation it tracks, except that a live hold is released to the terminal
 * with a notice (#1126; its dialog is on screen). Idempotent and safe with zero
 * sessions. Every harness session counts in the logged total, including one
 * with no hook server (nothing to release there).
 */
function forceReleaseAllSessions(): void {
  let resolved = 0;
  // Per-session try/catch: a throw in one gate's release must not abort the loop
  // and leave the remaining sessions stuck (the whole point is "get me out").
  for (const [sessionId, session] of harnessSessions.entries()) {
    try {
      resolved += session.decisions.forceRelease('force-release (remi unstick)').resolved;
    } catch (err) {
      logError(`[unstick] Failed to force-release session ${sessionId.slice(0, 8)}:`, err);
    }
  }
  log(`[unstick] Force-released ${harnessSessions.size} session(s): ${resolved} card(s) resolved`);
}
// Per-session APNS dispatchers (#585, P7), keyed by sessionId, so the
// question-resolved path can fire a quiet lock-screen dismissal through the same
// device-token fan-out that pushed the card. Populated by createNewSession,
// before it asks the harness to build the session (#1165 E); removed on session
// close.
const sessionNotifiers: Map<UUID, NotificationDispatcher> = new Map();
// `StopFailure` -> the session's `turn_failed` push, and its later dismissal
// (#1153); no config involved, see `createTurnFailedRoutes`.
const turnFailedRoutes = createTurnFailedRoutes(sessionNotifiers);
const sessionStore = new SessionStore();
// Tracks the subagent chats the primary session spawns, so the client can
// switch the displayed view to a subagent (epic #499 phase 3). Shared by the
// hook bridge (writes) and the transcript handler (resolves agentId -> path).
const subagentViews = new SubagentViewRegistry();
// Single binding accessor for the whole daemon (#460 phase 2): the one typed,
// disk-backed surface for remiUUID<->claudeSessionId. Every binding read/write +
// both resume resolvers route through it. No cache — see session-binding-store.ts.
// Durable, long-TTL remiUUID -> {claudeSessionId, projectPath} index (#577). Not
// subject to sessions.json's 100-entry cap or 7-day purge, so a transcript_load
// for an older session still resolves after the liveness store has dropped it.
// The binding store mirrors every preAssign/update write into it.
const transcriptIndex = new TranscriptIndex();
const bindingStore = new SessionBindingStore(sessionStore, transcriptIndex);

const orphanTimeoutMs =
  cliOrphanTimeout !== undefined
    ? cliOrphanTimeout * 1000
    : remiConfig.daemon.orphan_timeout * 1000;
// Forward reference to the session handlers' deferred-Stop resolver (#641). The
// registry below is constructed before `sessionHandlers` exists, so onSessionClosed
// reaches the resolver through this holder, assigned once the handlers are wired.
let resolveStopOnClose: ((sessionId: UUID) => void) | null = null;
// Mirrors the session's pending questions into the live-sessions registry
// file (#786/#787), keyed by question id so `createdAt` stays stable across
// the repeated onQuestionsChanged calls a single question's lifecycle fires.
const pendingQuestionCreatedAt = new PendingQuestionCreatedAtTracker();
const sessionRegistry = new SessionRegistry(
  {
    orphanTimeoutMs,
    maxReplayHistory: 1000,
    // A Codex card's text is a command (#1178): the registry's log lines leave it out.
    redactQuestionLogs: harnessId === 'codex',
  },
  {
    onSessionCreated: (sessionId) => {
      log(`Session created: ${sessionId}`);
    },
    onSessionClosed: (sessionId, reason) => {
      log(`Session closed: ${sessionId} (reason: ${reason})`);
      // Resolve any deferred Stop (#641): ack the requester + notify a
      // third-party client now that the session has actually ended.
      resolveStopOnClose?.(sessionId);
      // Tear down the drive-mode binder (rotation dir-poll + fallback timer) at
      // session close, not just at process cleanup — else the poll interval leaks
      // for the rest of the daemon's life across resumes (#463 phase 3 review).
      // The session's dispose() also drops its #914 admits filter, so a closed
      // session's binder can never keep admitting turns on its behalf.
      harnessSessions.get(sessionId)?.dispose();
      // Drop the session with its gate handle (#573; its open escalations were
      // already resolved by the gate's cancelStale on teardown) and its
      // QuestionPresenceTracker (#920): a stale entry would make
      // `isPromptCurrent` resolve against a dead session's last-observed PTY
      // state instead of falling back to "no tracker".
      harnessSessions.delete(sessionId);
      // Drop the per-session APNS dispatcher (#585, P7).
      sessionNotifiers.delete(sessionId);
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
      } else if (session?.persistent) {
        log(`Session detached: ${sessionId} (persistent, no timeout, re-attachable)`);
      } else {
        log(
          `Session orphaned: ${sessionId} (will timeout in ${Math.round(orphanTimeoutMs / 1000)}s)`,
        );
      }
    },
    onSessionResumed: (sessionId, connectionId) => {
      log(`Session resumed: ${sessionId} by connection ${connectionId}`);
    },
    // #1038: `attached`/`queuedCount` are PULLED from this registry at flush
    // time, and nothing on an attach path calls updateRemiStatus -- so
    // without this a connected phone read as "no clients" on the reserved-row
    // bar, in status-<PORT>.json, in the attach client and in the app, until
    // some unrelated status change happened to flush. Emitted from the two
    // lines that mutate the set, so it covers every attach path by
    // construction; `refresh()` schedules only on a real change.
    onAttachStateChanged: () => statusWriter.refresh(),
    onQuestionsChanged: (sessionId, questions) => {
      // Best-effort: a registry-file hiccup here must never take down the
      // question pipeline itself (the live WS `question`/`question_resolved`
      // broadcasts already happened before this fires).
      try {
        liveSessionsRegistry.setPendingQuestions(
          sessionId,
          pendingQuestionCreatedAt.sync(questions),
        );
      } catch (err) {
        logError(`[live-sessions] setPendingQuestions failed: ${errorToString(err)}`);
      }
      // #798: broadcast the authoritative live-question-id set to every
      // connected client (same fan-out as question_resolved/remi_status).
      // Backstops the client-side replay gate -- a client that reconnects
      // into a quiet session gets no new question/resolve event to re-sync
      // it, so this snapshot is what actually clears a phantom card there.
      try {
        registry.broadcast(
          createQuestionSnapshot(
            sessionId,
            questions.map((q) => q.id),
          ),
        );
      } catch (err) {
        logError(`[QuestionSnapshot] broadcast failed for ${sessionId}: ${errorToString(err)}`);
      }
      // #808: this is the ONLY signal that drives client-side reconciliation
      // (pruneQuestionsNotLive) today, and it fires ONLY on a change -- never
      // proactively on attach/reconnect (see connection-events.ts /
      // resume-session-events.ts, which only resend the still-live set).
      // Recording every broadcast lets the on-device capture correlate "the
      // daemon told every client the live set was X" against "the client
      // still shows a card not in X".
      traceQuestionEvent({
        action: 'snapshot_broadcast',
        sessionId,
        signal: 'onQuestionsChanged',
        callSite: 'cli.ts:onQuestionsChanged',
        detail: { liveQuestionIds: questions.map((q) => q.id) },
      });
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
// Persistent, shared device-token registry (epic #603 Phase 6, R4): every local
// daemon loads the same `~/.remi/device-tokens.json` so a fresh worktree daemon
// can push immediately, and a dead token pruned on APNS rejection stays pruned.
// `deviceTokens` is the store's live in-memory map (stable reference), so all the
// existing Map consumers are unchanged.
const deviceTokenStore = new DeviceTokenStore(path.join(REMI_DIR, 'device-tokens.json'));
deviceTokenStore.load();
const deviceTokens = deviceTokenStore.map;

// Daemon-wide fail-safe for a PermissionRequest no session on this daemon owns
// (#672): shared by every session's hook bridge so its escalation rate-limit
// is per foreign claude session id ACROSS the whole daemon, not reset per
// session. See ForeignSessionEscalator's module doc for the ownership ladder.
const foreignSessionEscalator = new ForeignSessionEscalator({
  liveSessionsRegistry,
  bindingStore,
  deviceTokens,
  pushConfig: () => ({
    signalingUrl: cliSignalingUrl ?? remiConfig.network.signaling_url,
    ...(cliPushSecret !== undefined ? { pushSecret: cliPushSecret } : {}),
  }),
  currentPort: () => PORT,
});

// Daemon-wide destructive-command alerter for subagents, foreground or
// background (#807). Shared across every session's hook bridge for the same
// reason as the escalator above: the rate-limit window must be daemon-wide,
// or a fleet of agents spread over several sessions each gets its own quota
// and the throttle stops throttling. See `subagent-alert.ts` for why this alerts rather than gates.
const subagentAlerter = new SubagentAlerter(remiConfig.notifications.subagent_alert);

/** Deliver a subagent alert (#807): a log line plus a dismiss-only push. The
 *  hook bridge calls it when a subagent's call that matched an alert
 *  pattern finished without ever prompting (#1155, see `subagent-alert.ts`).
 *  Fire-and-forget: it must never delay or throw into hook handling. */
function deliverSubagentAlert(alert: SubagentAlert): void {
  const title = alertTitle(alert);
  const body = alertBody(alert);
  // Log unconditionally: the push can fail or be throttled downstream, and the
  // local record is what makes a silent background decision auditable.
  log(`[SubagentAlert] ${title} - ${body}`);

  if (deviceTokens.size === 0) return;
  const signalingUrl = cliSignalingUrl ?? remiConfig.network.signaling_url;
  for (const dt of deviceTokens.values()) {
    // Deliberately no `category` / `options` / `questionId`: this is
    // dismiss-only and answers nothing (see subagent-alert.ts module doc).
    void sendPushTrigger(signalingUrl, dt.token, {
      title,
      body,
      ...(cliPushSecret !== undefined ? { pushSecret: cliPushSecret } : {}),
      kind: 'subagent_alert',
    }).catch((err) => {
      logError('[SubagentAlert] push failed:', err);
    });
  }
}

/** Push a `harness_denied` notice (#1126): Claude Code's auto-mode
 *  classifier blocked a tool call. Informational, per-device mutable
 *  (`pushPrefs.harnessDenied`), fire-and-forget like the alert above. */
function onHarnessDenied(input: PermissionDeniedHookInput): void {
  const primarySessionId = getPrimarySessionId();
  const session = primarySessionId ? sessionRegistry.getSession(primarySessionId) : undefined;
  log(`[HarnessDenied] auto mode blocked ${input.tool_name}: ${input.reason ?? '(no reason)'}`);
  // Pick up a device removed or muted by a sibling daemon since our last
  // read (#690), as the question push does.
  try {
    deviceTokenStore.refreshFromDisk();
  } catch (err) {
    logError('[HarnessDenied] device token refresh failed:', err);
  }
  pushHarnessDenied(
    {
      deviceTokens: deviceTokens.values(),
      sessionId: primarySessionId ?? 'unbound',
      signalingUrl: cliSignalingUrl ?? remiConfig.network.signaling_url,
      pushSecret: cliPushSecret,
      sessionName: session?.name || 'Agent',
      send: sendPushTrigger,
      onError: (err) => logError('[HarnessDenied] push failed:', err),
    },
    input,
  );
}

// Daemon-wide turn-duration tracker (#914). Fed from HookServer's onAnyEvent
// for every hook event (see the two HookServer constructions below), keyed
// on `prompt_id` -- present on every hook payload's common fields. Originally
// cost no DEDICATED hook registration (it rode whatever events were already
// registered for other reasons); since #893 registered `UserPromptSubmit`
// (originally for the auto-approve authority summary, deleted in #1125; the
// registration now stays for this tracker), that event is the earliest one
// `onAnyEvent` sees per turn, so
// `elapsedMs` measures from actual prompt submission instead of
// approximating from the first tool-use/permission event -- see turn-timer.ts
// for the accuracy/notification-threshold consequence. See turn-timer.ts for
// why the map is safe to share across the daemon's one session.
const turnTimer = new TurnTimer();

/**
 * The turn-event sink (#1180): the one place a finished turn becomes a push, for any harness.
 * Everything it reads is read when a turn ends (the config, the devices, the endpoint), so a
 * change while the daemon runs is seen. `onTurnStop` below is Claude's way in; the Codex harness
 * is handed the same sink and calls it from its `turn/completed` frames.
 */
const turnEvents = createTurnEventSink({
  config: () => ({
    onTurnComplete: remiConfig.notifications.on_turn_complete,
    turnCompleteMinSeconds: remiConfig.notifications.turn_complete_min_seconds,
  }),
  deviceTokens: () => deviceTokens.values(),
  sessionName: (sessionId) => sessionRegistry.getSession(sessionId)?.name,
  notifiers: sessionNotifiers,
  signalingUrl: () => cliSignalingUrl ?? remiConfig.network.signaling_url,
  pushSecret: () => cliPushSecret,
  send: sendPushTrigger,
  log,
  onError: (err) => logError('[TurnComplete] push failed:', err),
});

/**
 * Claude's `Stop` listener (#914): the #914 session filter, then the turn's duration from the
 * timer above, handed to the sink (`notifications/claude-turn-stop.ts`; #1180 moved the filter
 * order, the timer reads and the hand-off out of `cli.ts` so a test reaches them, and the gate,
 * the text and the fan-out into the sink). `claudeHarness` is built further down; the filter
 * asks it when a Stop arrives, never before.
 */
const onTurnStop = createClaudeTurnStop({
  admits: (input) => claudeHarness.admitsAnySession(input),
  timer: turnTimer,
  primarySessionId: getPrimarySessionId,
  sink: turnEvents,
});

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

// Watcher for live-sessions directory (pushes session list updates when a
// sibling daemon registers). Closer assigned once started (wrapper mode, and
// daemon mode since #542); cleanup() calls it unconditionally (no-op if null).
let liveSessionsWatcherCloser: (() => void) | null = null;

/**
 * Build the payload for the live-sessions watcher's `collect()` (#542): the
 * daemon's currently known sessions plus any newly-seen sibling ports. Shared
 * by both daemon and wrapper mode so a new sibling starting up is broadcast
 * to connected clients either way -- daemon mode never did this before #542.
 * Reads `PORT`, `sessionRegistry`, `bindingStore`, `transcriptDiscovery`, and
 * `liveSessionsRegistry` at CALL time (not closure-capture time), so it always
 * reflects the finalized port and current session state.
 */
function collectLiveSessionsUpdate(): LiveSessionsCollectResult | null {
  const newPorts = liveSessionsRegistry.getLivePorts().filter((p) => p !== PORT);
  if (newPorts.length === 0) return null;
  const managedIds = new Set<string>(sessionRegistry.getActiveSessionIds());
  for (const remiId of [...managedIds]) {
    const binding = bindingStore.get(remiId as UUID);
    if (binding?.claudeSessionId) managedIds.add(binding.claudeSessionId);
  }
  const sessions = [
    ...sessionRegistry.listSessions(),
    ...transcriptDiscovery.discoverSessions(managedIds),
  ];
  return { sessions, newPorts };
}

// Reserved-row status bar (#565). Assigned in wrapper mode; stays null in
// daemon mode. Module-level so cleanup() (defined outside the wrapper block)
// can clear the row on shutdown.
let statusBar: StatusBar | null = null;

// #932 durable fix: the quiescence + clean-boundary gate for the wrapper's
// own local terminal fd -- the same fd `statusBar` draws into. Module-level
// (like `statusBar`) so the harness's `observeLocalPtyOutput` wiring
// (constructed once, before the bar itself exists) and the bar's own
// `isBoundaryClean`/`isQuiescent` deps (wired after, in the wrapper block
// below) share one instance regardless of call order. Harmless to construct
// unconditionally in daemon mode too: it is only ever fed via
// `observeLocalPtyOutput`, which `pty-session-setup.ts`'s `onRawData` only
// invokes when `passThrough` is true -- daemon-mode sessions never feed it.
const wrapperPtyGate = new PtyQuiescenceGate();

async function startMdnsIfNeeded(
  logFn: (msg: string) => void,
): Promise<import('./mdns/mdns-publisher.ts').MdnsPublisher | null> {
  // #1051: say WHICH condition suppressed it. This used to be a bare
  // `return null` while every other exit from this function logged, and since
  // #880 moved the bind default to loopback it became the path every stock
  // install takes -- so the daemon silently stopped being discoverable and
  // nothing in its own output said why.
  const suppression = mdnsSuppression({
    cliNoMdns,
    configMdns: remiConfig.network.mdns,
    isLocalhostBind,
    bindHost,
  });
  if (suppression !== null) {
    logFn(mdnsSuppressionMessage(suppression));
    return null;
  }
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
  const { messageApi, sendAndRecord, notifications } = createMessageApiForSession(
    {
      sessionRegistry,
      transcriptWatchers,
      deviceTokens,
      // #603 Phase 6: prune a permanently-invalid token (BadDeviceToken) so the
      // daemon stops retrying it; the store removes + persists it.
      pruneToken: (token) => deviceTokenStore.prune(token, 'apns-invalid'),
      // #690: pick up a sibling daemon's removal/registration before deciding
      // whether to push.
      refreshDeviceTokens: () => deviceTokenStore.refreshFromDisk(),
      pushConfig: () => ({
        signalingUrl: cliSignalingUrl ?? remiConfig.network.signaling_url,
        ...(cliPushSecret !== undefined ? { pushSecret: cliPushSecret } : {}),
      }),
      updateRemiStatus: (patch) => updateRemiStatus(patch),
      maxBulletLength: MAX_BULLET_LENGTH,
      sendMessage,
      // A Codex card's text is a command (#1178): the log line for it leaves the text out.
      redactQuestionLogs: harnessId === 'codex',
      // Lazy disk-backed read so the identity seen on each question emission is
      // the current value: it survives /resume rotation via the hook bridge's
      // bindingStore.update write, and a Codex session's thread id once learned.
      // Wrapped in try/catch so a transient sessions.json I/O hiccup cannot kill
      // question emission (the dep contract is non-throwing).
      getIdentity: () => {
        try {
          return bindingStore.getIdentity(sessionId);
        } catch (err) {
          logError(`[Binding] getIdentity lookup failed: ${errorToString(err)}`);
          return null;
        }
      },
    },
    sessionId,
  );
  // Register this session's APNS dispatcher before the harness builds
  // anything that can fire a decision: the question-resolved path and the
  // harness's terminal-notice closures read `sessionNotifiers.get(sid)` to
  // dismiss or push through the same device-token fan-out (#585, P7, #1165 E).
  // It is neutral work (a per-session dispatcher, nothing Claude's), so the
  // shell does it once for every harness.
  sessionNotifiers.set(sessionId, notifications);
  // Everything Claude-specific (the question tracker, the PTY output parser,
  // the pre-spawn session binding, the hook bridge and the unstarted PTY) is
  // built behind the harness seam, in `harness/claude-session.ts`.
  const session = harness.createSession({
    sessionId,
    workingDirectory,
    extraArgs,
    passThrough,
    reservedRows,
    messageApi,
    sendAndRecord,
    sendMessage,
  });
  harnessSessions.set(sessionId, session);
  const ptySession = session.pty;

  const locallyOwned = passThrough; // wrapper-mode sessions are locally owned
  // Persist non-wrapper (daemon-spawned/remote) sessions across disconnects by
  // default so a session created from the app survives until Claude exits or it
  // is explicitly stopped (#637). Wrapper-mode sessions are locallyOwned and
  // already never time out, so the flag only applies to daemon-mode sessions.
  const persistent = !passThrough && remiConfig.daemon.persist_sessions;
  sessionRegistry.registerSession(
    sessionId,
    workingDirectory,
    ptySession,
    messageApi,
    locallyOwned,
    persistent,
  );

  // #576: give clients a defined pill state from the first hello_ack. Without
  // this, no status reaches the client until the first hook fires (Claude can
  // take tens of seconds to its first PreToolUse), so the session shows no
  // signal. Recorded via sendAndRecord so a client that connects later replays
  // it. Wrapped so a send hiccup can never abort session creation.
  try {
    sendAndRecord(createSessionUpdate(sessionId, 'starting'));
  } catch (err) {
    logError(`[Session ${sessionId}] Failed to emit starting status:`, err);
  }

  // If the spawn or any post-spawn wiring throws, mark the pre-saved
  // store entry as exited so sibling daemons reading the store don't
  // see a phantom "live" session with our claudeSessionId reserved.
  // Without this, the failed-spawn entry stays exitedAt=null and the
  // pid-aliveness self-heal in SessionStore only fires after our
  // daemon process itself exits.
  try {
    await session.start();
  } catch (err) {
    try {
      sessionStore.markExited(sessionId, null);
    } catch (persistErr) {
      logError(`[Session ${sessionId}] Failed to persist failed spawn:`, persistErr);
    }
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

  // The TranscriptBinder's start() (inside setupHookBridge) already armed BOTH
  // the fallback poll and the #452 rotation dir-watch; calling
  // startTranscriptFallback again here would double-arm the same fallback timer.

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

// #754: every debounced status flush also reaches connected clients, so the
// terminal attach client can draw the same reserved-row bar the wrapper does.
remiStatusBroadcast = (status) => {
  const primary = getPrimarySessionId();
  if (!primary) return;
  registry.broadcast(createRemiStatus(primary, status as RemiStatus));
};
// #755: attach state pulled from the session registry at flush time — the
// set of attached connections, never the blunt connection counter. #795:
// there is no more exclusive slot or FIFO queue, so `queuedCount` is always
// 0; kept on the wire for older readers of the status bar/file.
remiAttachState = () => {
  const primary = getPrimarySessionId();
  if (!primary) return { attached: false, queuedCount: 0 };
  const session = sessionRegistry.getSession(primary);
  return {
    attached: (session?.attachedConnections.size ?? 0) > 0,
    queuedCount: 0,
  };
};

/**
 * Cross-client question dismissal (#585, P7). Fired when a pending question stops
 * being pending on ANY channel: (a) answered locally (input-events.handleAnswer,
 * reason 'answered'), or (b) resolved without a user answer (an external
 * resolution, a Stop / SubagentStop / SessionEnd sweep, a superseded render,
 * `remi unstick`; reason 'cancelled'). Since #1125 the daemon never sends the
 * protocol's 'auto_approved' / 'auto_denied' reasons. It does TWO throw-safe things:
 *   1. Broadcast `question_resolved` to every connected client so each dismisses
 *      its card (in-app, over the WebSocket / Telegram via the AdapterRegistry).
 *   2. Fire a quiet APNS dismissal through this session's NotificationDispatcher
 *      (apns-collapse-id = questionId, content-available) so a suspended device's
 *      lock-screen card is cleared.
 * Each step is independently guarded so a failure in one never blocks the other,
 * and neither can propagate into the answer handler or the gate decision.
 */
const onQuestionResolved = (
  sessionId: UUID,
  questionId: UUID,
  reason: 'answered' | 'cancelled',
): void => {
  try {
    registry.broadcast(createQuestionResolved(sessionId, questionId, reason));
  } catch (err) {
    logError(`[QuestionResolved] broadcast failed for ${questionId}: ${errorToString(err)}`);
  }
  try {
    sessionNotifiers.get(sessionId)?.dismiss(sessionId, questionId);
  } catch (err) {
    logError(`[QuestionResolved] APNS dismissal failed for ${questionId}: ${errorToString(err)}`);
  }
};

import { createPtyMessageFanout } from './cli/handlers/pty-message-fanout.ts';
import { getRecentDirectories } from './cli/recent-client.ts';

const sendToConnection = (connectionId: UUID, message: ProtocolMessage): boolean => {
  return registry.sendRaw(connectionId, message);
};

// #795: raw_pty_output fans out to every ATTACHED connection (there is no
// more single exclusive one); every other message type keeps broadcasting to
// all connections as before. Shared by both daemon-mode and wrapper-mode
// session creation below.
const ptyMessageFanout = createPtyMessageFanout({
  sessionRegistry,
  sendToConnection,
  broadcast: (message) => registry.broadcast(message),
});

const trivialHandlers: TrivialHandlers = createTrivialHandlers({
  // #603 Phase 6: registration goes through the store (rotation prune + persist).
  registerDeviceToken: (token, platform, connectionId) =>
    deviceTokenStore.register(token, platform, connectionId),
  // #690: explicit user removal of this server from the phone app. Never
  // fires on a mere disconnect/app suspension — those must keep pushing.
  unregisterDeviceToken: (token) => deviceTokenStore.unregister(token),
  sessionStore,
  sessionRegistry,
  send: sendToConnection,
});

// #1155: the one "a prompt is up" signal (a held main prompt, a hook-backed
// prompt waiting in the terminal, or a numbered menu on screen), built once
// and spread into both handler factories below, so the chat guard and Stop
// cannot disagree. Backed by the RIGHT session's gate and tracker.
const promptUpWiring = promptUpDeps(
  (sessionId) => harnessSessions.get(sessionId)?.decisions,
  (sessionId) => harnessSessions.get(sessionId)?.decisions.screen,
);

const inputHandlers: InputHandlers = createInputHandlers({
  sessionRegistry,
  bindingStore,
  send: sendToConnection,
  // #573/#1126: the RIGHT session's decisions (`harnessSessions`, filled per
  // session by createNewSession from `harness.createSession`) retire an
  // answered question and answer a held
  // prompt through its hook. One helper, shared with the tests, like
  // trackerScreenDeps below.
  ...gateAnswerDeps((sessionId) => harnessSessions.get(sessionId)?.decisions),
  // #1155: the chat guard reads the one "a prompt is up" signal Stop reads.
  ...promptUpWiring,
  // #1177: a Codex session takes no typed chat (its TUI cannot be read), whatever
  // client sends it; raw keystrokes still reach it.
  acceptsTypedChat: (sessionId) => harnessSessions.get(sessionId)?.acceptsTypedChat,
  // #585: a locally answered question dismisses its card + lock-screen push on
  // every other client.
  onQuestionResolved: (sessionId, questionId) =>
    onQuestionResolved(sessionId, questionId, 'answered'),
  // The screen reads the answer guards need (#920 prompt currency, #1002 any
  // prompt on screen, #1134 the on-screen menu), backed by the RIGHT session's
  // tracker (each session's `decisions.screen`, from the same per-sessionId
  // map as the gate above). One helper, shared with the tests, so
  // the wiring they exercise is this wiring. No tracker for this sessionId
  // (session already closed, or never wired one) => nothing observed, which
  // fails toward refusing the injection.
  ...trackerScreenDeps((sessionId) => harnessSessions.get(sessionId)?.decisions.screen),
});

// One daemon hosts one session, so the harness is a per-daemon singleton, built
// once here and handed to the handler factories (epic #1161, phase 2). It is
// built this late because launching a session (`createNewSession` ->
// `harness.createSession`, phase 3) reads daemon-wide services declared above.
// `hookServer`, `PORT`, the websocket port and `[prompts]` are read when a
// session launches, not when the harness is built, so they are passed as
// getters.
const claudeHarness = new ClaudeHarness(transcriptDiscovery, {
  sessionRegistry,
  sessionStore,
  bindingStore,
  liveSessionsRegistry,
  transcriptDiscovery,
  transcriptWatchers,
  transcriptFallbackTimers,
  subagentViews,
  foreignSessionEscalator,
  subagentAlerts: { alerter: subagentAlerter, deliver: deliverSubagentAlert },
  onQuestionResolved,
  onHarnessDenied,
  pushTurnFailed: turnFailedRoutes.push,
  dismissTurnFailed: turnFailedRoutes.dismiss,
  prompts: () => remiConfig.prompts,
  hookServer: () => hookServer,
  currentPort: () => PORT,
  wsPort: () => remiStatus.wsPort,
  cleanup,
  // #932: the wrapper's quiescence gate and status bar (see the PTY wiring in
  // harness/claude-session.ts for what each forwarded chunk does).
  observeLocalPtyOutput: (data) => {
    if (wrapperPtyGate.observe(data)) statusBar?.notifyScrollRegionReset();
  },
  sessionNotifiers,
});

/**
 * The `harness` of this daemon's live-sessions entry (#1179): absent for Claude, so a Claude
 * entry stays byte-identical to what an older remi wrote and reads (ADR 0032), named for any other.
 */
function liveEntryHarness(): { harness?: HarnessId } {
  return harnessId === 'claude' ? {} : { harness: harnessId };
}

// The older-daemon gate (#1165 D): the live remi processes that would erase a Codex identity.
// The Codex launch reads it before it writes a record, and the hub before it spawns a Codex child.
// A record of exactly this build's version is the same build and has the same shim, so it is not
// an older remi even when the version does not parse (a PR-stamped build's sessions, wrappers and
// hub would otherwise each count as one, #1204 round 2).
const legacyWriters = () =>
  findLegacyWriters({
    liveSessions: liveSessionsRegistry,
    statusFiles: () => readStatusFiles(REMI_DIR),
    selfPid: process.pid,
    ownVersion: REMI_VERSION,
  });

// `remi codex` hosts a Codex session instead (#1177). Its launch reads these services when a
// session starts, and the older-daemon gate reads the live-sessions entries and status files of
// other remi processes then. `onQuestionResolved` is how an approval card that Codex resolved
// (the TUI answered first) is cleared on every client (#1178).
const codexHarness =
  harnessId === 'codex'
    ? new CodexHarness({
        sessionRegistry,
        sessionStore,
        bindingStore,
        liveSessionsRegistry,
        currentPort: () => PORT,
        wsPort: () => remiStatus.wsPort,
        cleanup,
        env: () => process.env,
        onQuestionResolved,
        legacyWriters,
        remiVersion: REMI_VERSION,
        // A finished turn is reported to the same sink Claude's Stop hook ends in (#1180).
        turnEvents,
        log,
      })
    : undefined;
const harness: Harness = codexHarness ?? claudeHarness;

/** What a remote requester is told when the older-daemon gate refuses a Codex session (G8): no pid, no file. */
const LEGACY_WRITER_CLIENT_TEXT =
  "An older remi is running on the host and would erase the Codex session id from its sessions file, so a Codex session was not started. Update or stop that remi on the host, then try again; the host's remi log names it.";

/** What a remote requester is told when a resume names a session or thread a live session holds (P4, P10): no id, no port. */
const HELD_THREAD_CLIENT_TEXT =
  'That Codex thread is already open in a live remi session on the host.';
const HELD_CLAUDE_CLIENT_TEXT =
  'That Claude session is already open in a live remi session on the host.';
const AMBIGUOUS_THREAD_CLIENT_TEXT =
  "That Codex thread cannot be resumed from here: the host's records of it are ambiguous.";

// The harnesses a `create_session_request` may name (#1179), and what each allows: advertised on
// every hello_ack (`harnesses`) and checked before anything is spawned. Built here because the
// validators sit behind the import boundary that keeps Claude and Codex apart.
const harnessRegistry = new HarnessRegistry({
  claude: {
    command: 'claude',
    validateRemoteArgs: validateClaudeRemoteArgs,
    // A resume of a Claude session a live remi session already holds would make two active records
    // of it (a wrapper and a child both claiming the id), so it is refused here, before a child is
    // spawned, whether or not the request names the harness. The requester is told that the session
    // is open and nothing about the holder; the holder goes to the log (#1204 round 2, P10).
    launchRefusal: ({ resumeThreadId }) => {
      if (resumeThreadId === null) return null;
      const holder = sessionStore
        .list()
        .find(
          (s) => isClaudeRecord(s) && s.claudeSessionId === resumeThreadId && s.exitedAt === null,
        );
      if (holder === undefined) return null;
      return {
        client: HELD_CLAUDE_CLIENT_TEXT,
        detail: `a resume of the Claude session ${resumeThreadId.slice(0, 8)} was refused: it is open in remi session ${holder.remiSessionId.slice(0, 8)} (port ${holder.port})`,
      };
    },
  },
  codex: {
    command: 'codex',
    validateRemoteArgs: validateCodexRemoteArgs,
    // A session the hub starts has no terminal, and Codex may stop at an Update or Trust prompt
    // that remi never answers (it types nothing into Codex); the hub cannot see that it did, or that
    // it has already exited (the hub answers once the child has registered, before it launches
    // Codex). Line one is the condition, line two the way out, naming this session: a bare
    // `remi attach` takes the newest one. Nothing host-local (no path, no pid).
    headlessNotice: ({ sessionId, port }) =>
      [
        'Codex was started on the host without a terminal, so remi cannot tell whether it reached its prompt: it may be waiting at an Update or Trust prompt, or may already have exited.',
        `If it does not respond, \`${attachCommand(port, sessionId)}\` shows it, from a machine that can reach that port (<host> is the address you reached this daemon at); that this lets you answer such a prompt has not been checked against a real Codex.`,
      ].join('\n'),
    // The requester gets a short text; the host's log gets the whole reason (pids, files). Then a
    // resume of a thread a live session holds is refused here, before a child is spawned: the
    // requester is told the thread is open and nothing about the session that holds it, and the
    // log names the holder and its port (#1204 round 2, P4). The person at the machine, running
    // `remi codex resume` locally, still reads the full text (`heldThreadRefusal`).
    launchRefusal: ({ resumeThreadId }) => {
      const writers = legacyWriters();
      if (writers.length > 0) {
        return { client: LEGACY_WRITER_CLIENT_TEXT, detail: legacyWriterRefusal(writers) };
      }
      if (resumeThreadId === null) return null;
      const held = findHeldThread(sessionStore, resumeThreadId);
      if (held === null) return null;
      const ending = shortThreadId(resumeThreadId);
      if (held.kind === 'ambiguous') {
        return {
          client: AMBIGUOUS_THREAD_CLIENT_TEXT,
          detail: `a resume of the Codex thread ending ${ending} was refused: the session store holds more than one active record of it`,
        };
      }
      return {
        client: HELD_THREAD_CLIENT_TEXT,
        detail: `a resume of the Codex thread ending ${ending} was refused: it is open in remi session ${held.remiSessionId.slice(0, 8)} (port ${held.port})`,
      };
    },
  },
});

// A Codex launch that will be refused is refused HERE, before a daemon boots or a wrapper takes
// over the terminal (where console output goes to the log): a refused argument exits 2, an older
// live remi exits 1, and nothing has been written yet. A daemon's arguments are what follows
// `--` (`explicitArgs`: a hub puts the ones it validated there, last). What the launch cannot
// protect against is said once.
let codexLaunchArgs: string[] = [];
if (codexHarness) {
  // A daemon reads its arguments from what follows `--` and nothing else (a hub appends them
  // there, last); a wrapper hands everything the user typed to the validator. A loose word on a
  // Codex daemon is an error, as every argument was before Phase 5: ignoring it would start Codex
  // without what was asked (#1179 review, G3). A Claude daemon still ignores loose words, so an
  // existing LaunchAgent plist starts as before.
  const loose = cliDaemonMode ? looseArgs(parsedArgs) : [];
  if (loose.length > 0) {
    console.error(
      `remi codex --daemon takes its Codex arguments after \`--\`; not recognized: ${loose.join(' ')}`,
    );
    process.exit(2);
  }
  const preflight = codexHarness.preflight(
    cliDaemonMode ? parsedArgs.explicitArgs : parsedArgs.passthroughArgs,
    process.cwd(),
  );
  if (!preflight.ok) {
    console.error(preflight.message);
    process.exit(preflight.exitCode);
  }
  codexLaunchArgs = preflight.args;
  console.error(olderRemiNotice());
}

const sessionHandlers: SessionHandlers = createSessionHandlers({
  sessionRegistry,
  bindingStore,
  transcriptDiscovery,
  harness,
  liveSessionsRegistry,
  currentPort: () => PORT,
  untrackConnection: (id) => registry.untrackConnection(id),
  onConnectionRemoved: () =>
    updateRemiStatus({ connections: Math.max(0, remiStatus.connections - 1) }),
  send: sendToConnection,
  // #1140, #1155: a Stop does not type "/exit" + Enter while a prompt is up
  // (the Enter would confirm the highlighted option); it reads the same
  // signal the chat guard does.
  ...promptUpWiring,
});
// Wire the deferred-Stop resolver now that the handlers exist (#641); the
// registry's onSessionClosed reaches it through this holder.
resolveStopOnClose = sessionHandlers.resolveStopOnClose;

// The single authoritative "current owned session" accessor (#499), shared by
// the transcript-request redirect and the hello_ack binding so they never diverge.
const currentOwnedSession = makeCurrentSessionResolver({
  getPrimarySessionId,
  sessionStore,
  harness,
  harnessId,
});

const transcriptHandlers: TranscriptHandlers = createTranscriptHandlers({
  transcriptDiscovery,
  harness,
  transcriptWatchers,
  bindingStore,
  transcriptIndex,
  currentOwnedSession,
  subagentViews,
  // A harness that reads its own history (Codex's app-server, #1180) answers a transcript load
  // itself; Claude's sessions have no chat and take the transcript-file path.
  chatFor: (sessionId) => harnessSessions.get(sessionId)?.chat,
  send: sendToConnection,
});

const resumeSessionHandlers: ResumeSessionHandlers = createResumeSessionHandlers({
  // `remi serve` is session-less and must never run Claude (#1124).
  hubMode: serveMode,
  harnessId,
  harnesses: () => harnessRegistry.available(),
  sessionRegistry,
  sessionStore,
  bindingStore,
  transcriptDiscovery,
  harness,
  createNewSession,
  send: sendToConnection,
});

const createSessionHandlers_: CreateSessionHandlers = createCreateSessionHandlers({
  harnesses: harnessRegistry,
  liveSessionsRegistry,
  spawningPorts,
  basePort: remiConfig.daemon.base_port,
  portRange: remiConfig.daemon.port_range,
  bindHost,
  inheritedArgs: () => {
    const args: string[] = [];
    if (cliAuth === true) args.push('--auth');
    if (cliAuth === false) args.push('--no-auth');
    if (cliNoRelay) args.push('--no-relay');
    if (cliNoMdns) args.push('--no-mdns');
    // Always forwarded, never "only when non-default" (#880). This used to
    // compare against a hardcoded '0.0.0.0', which silently stopped meaning
    // "is the default" the moment the default changed -- and a child that
    // falls back to its own default instead of inheriting the hub's bind is
    // exactly the drift that makes an exposure reappear on one process.
    args.push('--bind', bindHost);
    return args;
  },
  send: sendToConnection,
});

// Hub client census (#650): hub-mode only. The tracker classifies every
// protocol connection (local/remote/excluded) and drives the `hub_status`
// broadcast behind the menu-bar icon. Session daemons and wrappers leave it
// null, so the connection hooks below are no-ops outside `remi serve`.
const hubClientTracker: HubClientTracker | null = serveMode
  ? new HubClientTracker({
      send: (connectionId, message) => {
        sendToConnection(connectionId, message);
      },
      broadcast: (message) => registry.broadcast(message),
      // #786/#787: the same listLive() read the plain session count used,
      // now also flattened into the pending-question census.
      getCensus: () => buildHubQuestionCensus(liveSessionsRegistry.listLive()),
      // Re-checked on every census build/change-check (#788): a cheap fs
      // stat, cheap enough to not bother caching across calls.
      getAutostartState: () => detectAutostartState(process.platform, os.homedir()),
      hubVersion: REMI_VERSION,
    })
  : null;

const connectionHandlers: ConnectionHandlers = createConnectionHandlers({
  hubMode: serveMode,
  sessionRegistry,
  currentOwnedSession,
  harnessId,
  harnesses: () => harnessRegistry.available(),
  trackConnection: (id, adapterType) => registry.trackConnection(id, adapterType),
  untrackConnection: (id) => registry.untrackConnection(id),
  onConnectionAdded: () => updateRemiStatus({ connections: remiStatus.connections + 1 }),
  onConnectionRemoved: () =>
    updateRemiStatus({ connections: Math.max(0, remiStatus.connections - 1) }),
  cancelOrphanTimeout,
  send: sendToConnection,
  remiVersion: REMI_VERSION,
  onPeerConnect: hubClientTracker
    ? (connectionId, metadata) => hubClientTracker.onConnect(connectionId, metadata)
    : undefined,
  onPeerDisconnect: hubClientTracker
    ? (connectionId) => hubClientTracker.onDisconnect(connectionId)
    : undefined,
});

const sharedEvents = {
  ...trivialHandlers,
  ...inputHandlers,
  ...sessionHandlers,
  ...connectionHandlers,
  ...transcriptHandlers,
  ...createSessionHandlers_,
  ...resumeSessionHandlers,
  // Expose the shared answer core under the adapter's relay event name (#575,
  // P4a). The HTTP /answer endpoint routes through the SAME logic as the
  // WebSocket onAnswer, just reporting a structured outcome instead of an
  // over-the-connection error frame.
  onAnswerRelay: inputHandlers.relayAnswer,
};

// ---------------------------------------------------------------------------
// Auth setup: disabled by default. Enable with --auth flag.
// Local/private networks don't need auth; relay/public access does.
// ---------------------------------------------------------------------------
// `bindHost` is declared near the CLI flags above, not here: port
// auto-selection probes with it long before this point (#880).

// Local capability token (#869). Created on first run with mode 0600 so the
// CLI can prove it is a local client without a TOFU round trip. Generated
// unconditionally, even while `require_local_auth` is false, so that turning
// the flag on later never has to also create a secret mid-flight.
//
// NOT fatal if it cannot be written. An unwritable `~/.remi` is a broken
// environment and the daemon says so a few lines later when the PID file
// fails, which is the more useful error; dying here would replace it with a
// worse one. Running with no token fails CLOSED: `capabilityTokenMatches`
// rejects an empty expected value, so nobody is admitted by this path and
// local clients fall back to the Ed25519 challenge.
let localCapabilityToken = '';
try {
  localCapabilityToken = loadOrCreateCapabilityToken(undefined, logError);
} catch (err) {
  logError(
    `[capability] could not create the local capability token: ${errorToString(err)}. Local clients will be challenged instead.`,
  );
}
const isLocalhostBind = bindHost === 'localhost' || bindHost === '127.0.0.1' || bindHost === '::1';

// Determine whether auth should be enabled
// Priority: CLI flag > config file > default (off)
const configAuth = remiConfig.auth.enabled;
const authEnabled = cliAuth ?? (configAuth === 'auto' ? false : configAuth);

let authenticator: Authenticator | undefined;
/** Opens sealed lock-screen answers (#875); handed to the relay adapter. */
let daemonAnswerKey: AnswerKeyPair | undefined;
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
  // Published in every auth challenge so phones can pin it and seal
  // lock-screen answers to this daemon (#875). Non-fatal: without it the
  // daemon simply cannot open sealed answers and says so when one arrives,
  // which is better than refusing to start.
  try {
    const answerKey = await loadOrCreateAnswerKey(undefined, logError);
    authenticator.setAnswerEncryptionKey(answerKey.publicKeyBase64);
    daemonAnswerKey = answerKey;
  } catch (err) {
    logError(`[answer-key] could not load or create the answer key: ${errorToString(err)}`);
  }
  serverFingerprint = storedIdentity.fingerprint;
  console.log(`Authentication enabled (fingerprint: ${serverFingerprint}, TOFU: ${tofuMode})`);
} else {
  if (!isLocalhostBind) {
    // #880. This is the ONLY signal an install that pre-dates the loopback
    // default gets: `remi config init` materialized `bind = "0.0.0.0"` into
    // config.toml, a value on disk beats a changed default, and nothing about
    // their setup breaks to make them look. So it names the exact remedy rather
    // than only describing the state.
    //
    // `console.error`, NOT `logError`, and that is load-bearing. A first draft
    // used `logError` "because console.warn is dropped in wrapper mode
    // (#1043)". That reasoning is backwards: in wrapper mode `logError` routes
    // to `writeToLog`, a no-op until `startLogFileSession`, which runs ~490
    // lines below this point -- so the message went nowhere, while the
    // `console.warn` it replaced reached the terminal.
    //
    // SCOPE that correctly, because a second review round caught the fix's own
    // comment overstating it. Wrapper mode is NOT simply "the default": line
    // ~325 is `cliDaemonMode = parsedArgs.daemonMode || serveMode`, so `remi
    // serve` -- the LaunchAgent/systemd entrypoint, and the long-lived install
    // most likely to carry a materialized `0.0.0.0` -- already took the
    // console branch and printed both lines either way. The regression was real
    // but confined to the plain-`remi` wrapper session path.
    //
    // At THIS point in module init the console is not yet redirected (the
    // overrides are installed alongside the log session, far below), so
    // `console.error` reaches the terminal in wrapper mode and stderr in daemon
    // mode -- both destinations a human sees.
    console.error(
      `WARNING: bound to ${bindHost} with authentication disabled. Any host that can reach this port can approve permission prompts and type into your Claude session.`,
    );
    console.error(
      `  Remedy: set daemon.bind = "${DEFAULT_CONFIG.daemon.bind}" in ${configPathForDisplay()} (the default since #880), or pass --auth to require authentication on this bind.`,
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
    allowedOrigins: remiConfig.daemon.allowed_origins,
    capabilityToken: localCapabilityToken,
    requireLocalAuth: remiConfig.daemon.require_local_auth,
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

// Off unless enabled (#1193); `--permanent-code` is itself the opt-in. Without
// it nothing can authenticate a relay peer, so no adapter is created at all and
// the daemon holds no connection to the Worker.
const relayWanted = relayRequested(remiConfig.network.relay, {
  noRelay: cliNoRelay,
  permanentCode: cliPermanentCode,
});
if (relayWanted && !cliPermanentCode) {
  console.error(RELAY_NOT_STARTED_NOTICE);
} else if (relayWanted) {
  const { RelayAdapter } = await import('./remote/relay-adapter.ts');
  const signalingUrl = cliSignalingUrl ?? remiConfig.network.signaling_url;

  // Permanent code mode: persist code to disk, require Ed25519 auth over relay
  if (!authenticator) {
    console.error(
      'Permanent connection codes require authentication. Pass --auth (a non-localhost bind does NOT enable it on its own; see #880).',
    );
    process.exit(1);
  }
  const { CodeStore } = await import('./remote/code-store.ts');
  const codeStore = new CodeStore();
  const code = codeStore.load() ?? codeStore.refresh();
  const relayAdapter = new RelayAdapter(
    { enabled: true, signalingUrl, code, rotateCode: false as const, authenticator },
    sharedEvents,
  );

  if (daemonAnswerKey) relayAdapter.setAnswerKey(daemonAnswerKey);
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

  // Binders own a rotation dir-poll interval the shared maps below do not
  // reach; dispose() tears down its watcher + fallback timer + dir-poll, and
  // drops the session's turn filter (the hook server was stopped above, so no
  // Stop can arrive to read it). The sessions stay in the map; onSessionClosed
  // disposes them again when the PTY exits, which dispose()'s guard makes a
  // no-op. Before, cleanup cleared binderClosers and left the gate, tracker
  // and turn-filter maps.
  for (const session of harnessSessions.values()) {
    session.dispose();
  }
  for (const watcher of transcriptWatchers.values()) {
    watcher.stop();
  }
  transcriptWatchers.clear();
  for (const timer of transcriptFallbackTimers.values()) {
    clearInterval(timer);
  }
  transcriptFallbackTimers.clear();
  liveSessionsWatcherCloser?.();
  liveSessionsWatcherCloser = null;
  await registry.stopAll();
  await sessionRegistry.shutdown();
  cleanupStatusFile();

  // Remove from live sessions directory
  const primary = getPrimarySessionId();
  if (primary) {
    liveSessionsRegistry.unregister(primary);
  }

  // Remove the hub PID file (#542), but only if it still names THIS process
  // -- a foreign hub that won the write race (or that started after a stale
  // entry was cleaned up) must keep its own entry intact.
  if (serveMode) {
    try {
      const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
      if (Number.parseInt(content, 10) === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logError(`[Hub] Failed to clean up PID file: ${errorToString(err)}`);
      }
    }
  }
}

// Guard against unhandled rejections / uncaught exceptions killing the whole
// daemon unsupervised (#534). Covers wrapper mode + daemon mode; short-lived
// subcommands process.exit() earlier and never reach this line.
installProcessGuards({ logError, onFatal: cleanup });

// ---------------------------------------------------------------------------
// Main: Start in wrapper or daemon mode
// ---------------------------------------------------------------------------
// Ensure PATH includes user-installed tools (claude, bun, etc.).
// In daemon mode this is critical (LaunchAgent/systemd have minimal PATH).
// In wrapper mode the terminal provides the PATH, but resolveShellPath
// merges (never drops existing entries) so it's safe to call, and ensures
// remote session creation works even after the terminal is detached (SIGHUP).
resolveShellPath({ log, error: logError }, harnessId === 'codex' ? 'codex' : 'claude');

if (cliDaemonMode) {
  console.log(serveMode ? 'Starting Remi hub...' : 'Starting Remi daemon...');

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
    const probed = await findAvailableTcpPort(PORT, DEFAULT_PORT_RANGE, liveUsed, bindHost);
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
        {
          port: PORT,
          host: bindHost,
          authenticator,
          allowedOrigins: remiConfig.daemon.allowed_origins,
          capabilityToken: localCapabilityToken,
          requireLocalAuth: remiConfig.daemon.require_local_auth,
        },
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

  // Notify attached clients when a new dist/remi build replaces this binary
  // on disk so they know to restart their session (#287). Shared: a hub
  // needs this exactly as much as a single-session daemon does.
  startBinaryUpdateWatcher();

  // Watch for sibling daemons (child session-daemons under a hub, or another
  // co-located daemon) registering in live-sessions and push updates to
  // clients (#542). Daemon mode never did this before; only wrapper mode
  // did, so a client sitting on a spawned session daemon never learned about
  // a new sibling starting up alongside it.
  liveSessionsWatcherCloser = startLiveSessionsWatcher({
    dirPath: liveSessionsRegistry.dirPath,
    collect: collectLiveSessionsUpdate,
    broadcast: (message) => registry.broadcast(message),
    logError,
    // Session registrations AND removals change the hub census (#650);
    // collect() only broadcasts on new ports, so the tracker hooks the raw
    // flush. No-op outside hub mode (tracker is null).
    onDirChange: hubClientTracker ? () => hubClientTracker.refresh() : undefined,
  });

  // Statusline install mutates the GLOBAL ~/.claude/settings.json; a
  // session-less hub never runs Claude, so it has no business touching it
  // (the first session child installs it anyway). Session daemons keep the
  // existing behavior.
  if (!serveMode && harnessId === 'claude') {
    installStatusLine(REMI_DIR, undefined, !isRemiHomeOverridden());
  }

  if (serveMode) {
    // Hub mode (#542): a session-less supervisor. It binds the well-known
    // port and shares services (relay, telegram, mDNS, device tokens) but
    // spawns no session of its own -- sessions are created via
    // create_session_request (the app) or `remi new`, each spawning its own
    // `remi --daemon` child (spawnRemiDaemon / onCreateSessionRequest,
    // machinery unchanged). The hub must NEVER: spawn Claude, install
    // Claude-Code hook config for its own cwd, or register itself in
    // ~/.remi/live-sessions (it would read as a phantom session).

    // Self-write the PID file so `remi stop`/`remi status` can find this hub
    // regardless of how it was launched (a bare `remi serve`, `remi start`,
    // or a LaunchAgent) -- closing the split-brain where only the CLI parent
    // process (the old `startDaemon()`) ever wrote it.
    //
    // Explicit dir creation: without it the 'wx' open only works on a fresh
    // $HOME because startLiveSessionsWatcher() happens to mkdir ~/.remi as a
    // side effect earlier in boot — an ordering dependency a refactor would
    // silently break (#740 review).
    fs.mkdirSync(REMI_DIR, { recursive: true });
    // Tri-state so a real I/O error (EACCES, ENOSPC) exits with its own
    // message instead of being misdiagnosed as a lost hub-boot race (#740
    // review); only EEXIST takes the stale-entry/race path.
    const writeHubPidFile = (): 'ok' | 'exists' | 'error' => {
      try {
        const fd = fs.openSync(PID_FILE, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return 'ok';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        console.error(`Failed to write hub PID file: ${errorToString(err)}`);
        return 'error';
      }
    };
    const firstWrite = writeHubPidFile();
    if (firstWrite === 'error') {
      await registry.stopAll();
      process.exit(1);
    }
    if (firstWrite === 'exists') {
      const foreignPid = readPidFileLive();
      if (foreignPid !== null) {
        console.error(`Hub already running (PID ${foreignPid}). Use \`remi status\`.`);
        await registry.stopAll();
        process.exit(1);
      }
      // readPidFileLive() already unlinked the stale entry; retry once. If a
      // concurrent boot wins the race in this gap, exit too — continuing
      // would leave a live hub whose PID is recorded nowhere, invisible to
      // `remi stop`/`status` forever (review finding on #731).
      const retryWrite = writeHubPidFile();
      if (retryWrite === 'error') {
        await registry.stopAll();
        process.exit(1);
      }
      if (retryWrite === 'exists') {
        const winnerPid = readPidFileLive();
        console.error(
          `Another hub claimed the PID file${winnerPid !== null ? ` (PID ${winnerPid})` : ''}; exiting.`,
        );
        await registry.stopAll();
        process.exit(1);
      }
    }

    updateRemiStatus({ wsPort: PORT, sessionId: null, sessionStatus: 'idle', mode: 'hub' });

    console.log('');
    console.log('Remi hub ready!');
    console.log(`  WebSocket: ws://${bindHost}:${PORT}/ws`);
    console.log(`  Port: ${PORT} (use --port to change)`);
    console.log('  Sessions: create from the app or `remi new`');
    if (mdnsPublisher?.isRunning) {
      console.log('  mDNS: Advertising on local network');
    }
    console.log('');
    console.log('Press Ctrl+C to stop');
    console.log('');
  } else {
    // Create the daemon's single session (one session per daemon).
    // NOTE: when --dir/--recent was passed, we already `process.chdir()`'d to
    // the tilde-expanded, validated directory above (see the `resolveDirectory`
    // calls near the top of this file). Re-resolving the raw `cliDir` string
    // here (which may still contain a literal `~`) against that NEW cwd used to
    // produce a malformed concatenated path (#674); process.cwd() is always the
    // correct value by this point.
    const workingDirectory = process.cwd();
    const sessionId = sessionRegistry.createSessionId();
    setPrimarySessionId(sessionId);

    updateRemiStatus({ wsPort: PORT, sessionId, sessionStatus: 'starting', mode: 'session' });

    // Hooks are Claude Code's; a Codex session has none (and writes nothing to the
    // working directory's .claude).
    if (harnessId === 'claude') {
      // Start hook server for Claude Code event detection (port 0 = OS-assigned)
      try {
        hookServer = new HookServer(
          { port: 0 },
          {
            onError: (err) => console.error(`[HookServer] ${err.message}`),
            onAnyEvent: (input) => turnTimer.observe(input.prompt_id),
          },
        );
        hookServer.start();
        // Additive second Stop listener (#914) -- see onTurnStop's module doc
        // for why this is deliberately separate from hook-bridge-setup.ts's own.
        hookServer.on('Stop', onTurnStop);
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
          // #1126: a daemon or hub session holds prompts for up to
          // daemon_hold_seconds, so its hook registration outlasts that.
          hookConfigManager = new HookConfigManager(workingDirectory, hookServer.url, {
            permissionRequestTimeout: permissionHoldPolicy(false, remiConfig.prompts)
              .permissionRequestTimeoutSec,
          });
          await hookConfigManager.install();
        } catch (err) {
          const msg = errorToString(err);
          console.error(`Hook config install failed: ${msg}. Question forwarding may not work.`);
          hookConfigManager = null;
        }
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
      version: REMI_VERSION,
      ...liveEntryHarness(),
    });

    // Create the PTY session. A hub's child gets its harness's arguments from after `--`
    // (`explicitArgs`, #1179); a loose word elsewhere on the command line is still ignored.
    try {
      await createNewSession(
        sessionId,
        workingDirectory,
        ptyMessageFanout,
        harnessId === 'codex' ? codexLaunchArgs : [...parsedArgs.explicitArgs],
      );
    } catch (err) {
      const msg = errorToString(err);
      console.error(`Failed to create session: ${msg}`);
      liveSessionsRegistry.unregister(sessionId);
      await registry.stopAll();
      // A Codex launch the harness refuses after the preflight passed (an older remi that started
      // in between, a race for a thread) keeps its own exit code.
      process.exit(codexLaunchRefusal(err)?.exitCode ?? 1);
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
  }

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
      applyEnvOverrides(loadConfigWithNotices().config);
      console.log('[reload] Config validated. Changes take effect on next daemon restart.');
    } catch (err) {
      console.error(`[reload] Failed to load config: ${errorToString(err)}`);
    }
  });
  process.on('SIGUSR2', forceReleaseAllSessions);
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

  // Install status line script (<state dir>/statusline.sh) and auto-configure
  // Claude Code settings, except under a REMI_HOME override (see installStatusLine).
  if (harnessId === 'claude') installStatusLine(REMI_DIR, undefined, !isRemiHomeOverridden());
  const workingDirectory = process.cwd();
  const sessionId = sessionRegistry.createSessionId();
  setPrimarySessionId(sessionId);
  setLogFileContext({ port: PORT, sessionId });

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
    const probed = await findAvailableTcpPort(PORT, DEFAULT_PORT_RANGE, liveUsed, bindHost);
    if (probed !== null && probed !== PORT) {
      const occupiedPort = PORT;
      try {
        await registry.unregister('websocket');
      } catch (teardownErr) {
        logError(`Failed to tear down WebSocket adapter: ${errorToString(teardownErr)}`);
      }
      PORT = probed;
      STATUS_FILE = path.join(REMI_DIR, `status-${PORT}.json`);
      const newWsAdapter = new WebSocketAdapter(
        {
          port: PORT,
          host: bindHost,
          authenticator,
          allowedOrigins: remiConfig.daemon.allowed_origins,
          capabilityToken: localCapabilityToken,
          requireLocalAuth: remiConfig.daemon.require_local_auth,
        },
        sharedEvents,
      );
      registry.register(newWsAdapter);
      // Attribute the reassignment log to the port this wrapper will actually
      // serve, not the occupied tentative port another session owns.
      setLogFileContext({ port: PORT, sessionId });
      log(`Port ${occupiedPort} in use, using ${PORT}`);
    } else if (probed === null) {
      logError('All ports in range are in use. Remote monitoring disabled.');
      wsProbeSucceeded = false;
    }
  }

  // The second probe can move the session away from the initial port. Update
  // the shared-log attribution before hook or PTY traffic starts so later
  // lines name the actual WebSocket port rather than the tentative one.
  setLogFileContext({ port: PORT, sessionId });

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

  // Hooks are Claude Code's; a Codex session has none (and writes nothing to the
  // working directory's .claude).
  if (harnessId === 'claude') {
    // Start hook server for Claude Code event detection (port 0 = OS-assigned)
    try {
      hookServer = new HookServer(
        { port: 0 },
        {
          onError: (err) => logError(`[HookServer] ${err.message}`),
          onAnyEvent: (input) => turnTimer.observe(input.prompt_id),
        },
      );
      hookServer.start();
      // Additive second Stop listener (#914) -- see onTurnStop's module doc for
      // why this is deliberately separate from hook-bridge-setup.ts's own.
      hookServer.on('Stop', onTurnStop);
      HOOK_PORT = hookServer.port;
      log(`Hook server listening on ${hookServer.url} (port ${HOOK_PORT})`);

      // Configure Claude Code hooks to POST to our server; a wrapper session
      // has a local terminal (#1126, hold-policy.ts).
      hookConfigManager = new HookConfigManager(workingDirectory, hookServer.url, {
        permissionRequestTimeout: permissionHoldPolicy(true, remiConfig.prompts)
          .permissionRequestTimeoutSec,
      });
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
      version: REMI_VERSION,
      ...liveEntryHarness(),
    });

    // Notify attached clients when a new dist/remi build replaces this binary
    // on disk so they know to restart their session (#287).
    startBinaryUpdateWatcher();

    // Watch for new daemons registering in live-sessions and push updates to
    // clients. This lets clients auto-connect when a sibling session starts
    // in the same directory (extracted to live-sessions-watcher.ts, #542).
    liveSessionsWatcherCloser = startLiveSessionsWatcher({
      dirPath: liveSessionsRegistry.dirPath,
      collect: collectLiveSessionsUpdate,
      broadcast: (message) => registry.broadcast(message),
      logError,
    });
  }

  // Reserved-row status bar (#565). Only in wrapper mode with a real TTY, and
  // off-able via config. When active, Claude is reported `rows - 1` so it never
  // touches the bottom row, which remi draws into. A non-TTY stdout (piped) has
  // no row to reserve, so it fails safe to off.
  const statusBarActive =
    harnessId === 'claude' && remiConfig.terminal.status_bar && Boolean(process.stdout.isTTY);
  const reservedRows = statusBarActive ? 1 : 0;

  // Create and start the primary PTY session
  let ptySession: PTYSession;
  try {
    ptySession = await createNewSession(
      sessionId,
      workingDirectory,
      ptyMessageFanout,
      harnessId === 'codex' ? codexLaunchArgs : claudeArgs,
      true, // pass-through mode
      reservedRows,
    );
  } catch (err) {
    if (harnessId !== 'codex') throw err;
    // A Codex launch that fails after boot (a refusal the preflight could not see, a race for
    // a thread, a `codex` that is not installed) used to die as an unhandled rejection with its
    // text in the log: a wrapper's console is redirected there. Say it on the real stderr, with
    // the refusal's own exit code.
    const refusal = codexLaunchRefusal(err);
    const message = refusal ? refusal.message : `Failed to create session: ${errorToString(err)}`;
    try {
      fs.writeSync(2, `${message}\n`);
    } catch {
      // stderr may already be gone
    }
    await cleanup().catch(() => {});
    process.exit(refusal?.exitCode ?? 1);
  }

  // Start drawing the reserved-row bar now that the PTY is up. Reads the live
  // StatusWriter state and repaints on a 250ms timer (the cadence of the
  // `evaluating Ns` counter). Inert until started, and a no-op when detached.
  // The bar and Claude's own output share one fd, so a paint must never land
  // mid-render; while a question is pending that means waiting for PTY
  // quiescence on every paint (#932, #1038 -- see status-bar.ts's module doc).
  if (statusBarActive) {
    statusBar = new StatusBar({
      getStdoutFd: getPtyStdoutFd,
      getStatus: () => statusWriter.state,
      getSize: () => ({
        cols: process.stdout.columns || 120,
        rows: process.stdout.rows || 40,
      }),
      isEnabled: () => !isWrapperDetached(),
      hasLiveQuestions: () =>
        (sessionRegistry.getSession(sessionId)?.currentQuestions.size ?? 0) > 0,
      // #932 durable fix: gate every paint on the same PTY-forwarding gate
      // `observeLocalPtyOutput` (above) feeds. `wrapperPtyGate` is
      // module-level so it exists before this StatusBar does and keeps
      // accumulating state across a detach/reattach within one process.
      isBoundaryClean: () => wrapperPtyGate.isBoundaryClean(),
      isQuiescent: () => wrapperPtyGate.isQuiescent(),
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
        // write() is queued (#795); the immediate synchronous state check
        // still throws here, but the actual byte write settles later, so
        // catch its rejection too.
        void ptySession.write(text).catch((err) => {
          log(`[PTY] write failed: ${errorToString(err)}`);
        });
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
      applyEnvOverrides(loadConfigWithNotices().config);
      log('[reload] Config validated. Changes take effect on next daemon restart.');
    } catch (err) {
      logError(`[reload] Failed to load config: ${errorToString(err)}`);
    }
  });
  // SIGUSR2: force-release signal (triggered by `remi unstick`)
  process.on('SIGUSR2', forceReleaseAllSessions);

  // Forward SIGINT/SIGTERM to PTY instead of exiting
  process.on('SIGINT', () => {
    if (isWrapperDetached()) return; // No local terminal to forward from
    if (ptySession.isRunning) {
      try {
        // Send Ctrl+C (0x03) to the PTY. Queued (#795); catch the deferred
        // rejection too, not just the immediate synchronous state check.
        void ptySession.write('\x03').catch(() => {
          // PTY may have exited
        });
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
