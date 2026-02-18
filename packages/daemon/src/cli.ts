#!/usr/bin/env bun
/**
 * Remi CLI - Transparent wrapper around Claude Code.
 *
 * Usage:
 *   remi [claude-args...]          Start Claude with remote monitoring
 *   remi --resume [session-id]     Resume a previous session
 *   remi --sessions                List stored sessions
 *   remi --daemon                  Legacy daemon mode (no local PTY)
 *
 * The wrapper spawns Claude immediately, passes through stdin/stdout,
 * and runs a WebSocket server silently for remote phone/browser monitoring.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Paths and utilities for log file and status file (used in wrapper mode)
// ---------------------------------------------------------------------------
const REMI_DIR = path.join(os.homedir(), '.remi');
const LOG_FILE = path.join(REMI_DIR, 'remi.log');
const STATUS_FILE = path.join(REMI_DIR, 'status.json');
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
  if (!wrapperMode) return;
  // Atomic write: write to temp file then rename to avoid readers seeing partial JSON
  const tmpFile = `${STATUS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(remiStatus));
    fs.renameSync(tmpFile, STATUS_FILE);
    statusWriteErrorLogged = false;
  } catch (err) {
    if (!statusWriteErrorLogged) {
      writeToLog(`[error] Failed to write status file: ${err}`);
      statusWriteErrorLogged = true;
    }
  }
}

function cleanupStatusFile(): void {
  try {
    fs.unlinkSync(STATUS_FILE);
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
# REMI_PORT is set by remi when spawning Claude; only show remi info for remi-managed sessions
if [ -n "\$REMI_PORT" ] && [ -f "${STATUS_FILE}" ]; then
  IFS=\$'\\t' read -r S_PID S_CONNS S_STATUS S_REPO S_BRANCH < <(jq -r '[.pid // 0, .connections // 0, .sessionStatus // "unknown", .repo // "", .branch // ""] | @tsv' "${STATUS_FILE}" 2>/dev/null)
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
  createReplayBatch,
  createSessionListResponse,
  createTranscriptLoadComplete,
  generateId,
  now,
} from '@remi/shared';
import type { AgentStatus, ProtocolMessage, UUID } from '@remi/shared';
import {
  type AdapterMetadata,
  AdapterRegistry,
  TelegramAdapter,
  WebSocketAdapter,
} from './adapters/index.ts';
import { MessageAPI } from './api/index.ts';
import { OutputProcessor } from './parser/index.ts';
import { PTYManager, PTYSession } from './pty/index.ts';
import { SessionRegistry, SessionStore, type StoredSession } from './session/index.ts';
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
let cliResume: string | true | undefined; // true = resume most recent, string = session ID
let cliShowSessions = false;
let cliInstall = false;
let cliUninstall = false;
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
  } else if (arg === '--install') {
    cliInstall = true;
  } else if (arg === '--uninstall') {
    cliUninstall = true;
  } else if (arg === '--version' || arg === '-v') {
    console.log('remi 0.1.0');
    process.exit(0);
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Remi - Claude Code with remote monitoring

Usage:
  remi [claude-args...]          Start Claude with WebSocket monitoring
  remi --resume [session-id]     Resume a previous session
  remi --sessions                List stored sessions
  remi --daemon                  Legacy daemon mode (headless server)

Options:
  --port PORT              WebSocket port (default: 18765, env: REMI_PORT)
  --max-bullet-length N    Truncate bullets longer than N chars (default: 500, 0=disabled)
  --no-telegram            Disable Telegram adapter
  --install                Install as autostart service
  --uninstall              Remove autostart service
  --version, -v            Show version
  --help, -h               Show this help

Environment:
  REMI_PORT                WebSocket port
  REMI_MAX_BULLET_LENGTH   Max bullet length before truncation (default: 500, 0=disabled)
  TELEGRAM_BOT_TOKEN       Telegram bot token (enables Telegram adapter)
  TELEGRAM_ENABLED         Set to 'false' to disable Telegram

Any other arguments are passed through to Claude Code.
`);
    process.exit(0);
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
      const templatePath = path.join(path.dirname(binaryPath), '..', 'scripts', 'install', plistName);
      let template: string;
      try {
        template = fs.readFileSync(templatePath, 'utf-8');
      } catch {
        // Fallback: inline template for compiled binary
        template = `<?xml version="1.0" encoding="UTF-8"?>
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
      }
      const content = template.replace(/__REMI_BINARY__/g, binaryPath).replace(/__HOME__/g, home);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      const result = Bun.spawnSync(['launchctl', 'load', dest]);
      if (result.exitCode === 0) {
        console.log(`Installed LaunchAgent: ${dest}`);
        console.log('Remi will start automatically on login.');
      } else {
        console.error(`Failed to load LaunchAgent: ${result.stderr.toString()}`);
        process.exit(1);
      }
    } else {
      if (fs.existsSync(dest)) {
        Bun.spawnSync(['launchctl', 'unload', dest]);
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
const PORT =
  cliPort || (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : 18765);
const MAX_BULLET_LENGTH =
  cliMaxBulletLength ??
  (process.env['REMI_MAX_BULLET_LENGTH']
    ? Number.parseInt(process.env['REMI_MAX_BULLET_LENGTH'])
    : 500);
const TELEGRAM_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
const TELEGRAM_ENABLED =
  !cliNoTelegram && process.env['TELEGRAM_ENABLED'] !== 'false' && !!TELEGRAM_TOKEN;

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
        if (passThrough && ptyStdoutFd !== null) {
          // Write raw bytes directly to terminal - no decode/encode round-trip.
          // This preserves multi-byte UTF-8 sequences split across chunks and
          // avoids ANSI escape corruption from processing delays.
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
      },
      onData: (output: string) => {
        // Decoded text goes to processor only (status detection, questions)
        if (processor) {
          processor.process(output);
        }
      },
      onExit: (code: number | null) => {
        log(`PTY ${ptySession.id} exited with code ${code}`);
        if (processor) {
          processor.flush();
        }
        sessionRegistry.handlePTYExit(sessionId);
        sessionStore.markExited(sessionId, code);

        if (passThrough) {
          // In wrapper mode, exit with the same code as Claude
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

  const processor = new OutputProcessor(
    {
      sessionId: sessionId,
      updateThrottleMs: 100,
      streamStatusOnly: true,
    },
    {
      onMessage: (message) => {
        messageApi.handleMessage(message);
      },
      onMessageUpdate: (messageId, content, tool) => {
        messageApi.handleMessageUpdate(messageId, content, tool);
      },
      onQuestion: (question) => {
        messageApi.handleQuestion(question);
      },
      onStatusChange: (status: AgentStatus, context?: string) => {
        messageApi.handleStatusChange(status, context);
      },
    },
  );

  sessionRegistry.registerSession(sessionId, workingDirectory, ptySession, processor, messageApi);
  await ptySession.start();

  // Save session to persistent store
  sessionStore.save({
    remiSessionId: sessionId,
    claudeSessionId: null,
    projectPath: workingDirectory,
    port: PORT,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });

  // Start transcript watcher after delay
  setTimeout(() => {
    if (!sessionRegistry.hasSession(sessionId)) return;
    const transcriptPath = transcriptDiscovery.findLatestTranscript(workingDirectory);
    if (!transcriptPath) {
      log(`No transcript file found for ${workingDirectory}, will retry...`);
      setTimeout(() => {
        if (!sessionRegistry.hasSession(sessionId)) return;
        const retryPath = transcriptDiscovery.findLatestTranscript(workingDirectory);
        if (retryPath) {
          startTranscriptWatcher(sessionId, retryPath, messageApi, sendAndRecord);
          extractClaudeSessionId(retryPath, sessionId);
        } else {
          log(`Could not find transcript file for session ${sessionId}`);
        }
      }, 5000);
      return;
    }
    startTranscriptWatcher(sessionId, transcriptPath, messageApi, sendAndRecord);
    extractClaudeSessionId(transcriptPath, sessionId);
  }, 2000);

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

    // In daemon mode, create new session on connect
    if (!wrapperMode) {
      const requestedDir = metadata.platformData?.['directory'] as string | undefined;
      const dirResult = resolveDirectory(requestedDir);

      if ('error' in dirResult) {
        logError(`Directory error: ${dirResult.error}`);
        sendToConnection(connectionId, createError('INVALID_DIRECTORY', dirResult.error));
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

        const result = sessionRegistry.attachConnection(sessionId, connectionId);

        if (result.success) {
          sendToConnection(
            connectionId,
            createHelloAck('1.0.0', sessionId, {
              isResume: false,
              replayCount: 0,
              nextBulletId: 1,
            }),
          );
          log(`Session ${sessionId} created and attached to connection ${connectionId}`);
        } else {
          logError(`Failed to attach connection: ${result.error}`);
          sessionRegistry.closeSession(sessionId, 'forced');
          sendToConnection(
            connectionId,
            createError('ATTACH_FAILED', result.error ?? 'Failed to attach connection'),
          );
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logError('Failed to create session:', errMsg);
        sendToConnection(
          connectionId,
          createError('SESSION_CREATE_FAILED', `Failed to create session: ${errMsg}`),
        );
      }
    } else {
      // Wrapper mode but no primary session (shouldn't happen normally)
      sendToConnection(
        connectionId,
        createError('NO_SESSION', 'No active session in wrapper mode'),
      );
    }
  },

  onDisconnect: async (connectionId: UUID, reason: string) => {
    log(`Client disconnected: ${connectionId}`);
    log(`   Reason: ${reason}`);

    sessionRegistry.detachConnection(connectionId);
    registry.untrackConnection(connectionId);
    updateRemiStatus({ connections: Math.max(0, remiStatus.connections - 1) });
  },

  onUserInput: async (connectionId: UUID, _sessionId: UUID, content: string) => {
    log(`User input from ${connectionId}: ${content}`);

    const session = sessionRegistry.getSessionForConnection(connectionId);
    if (session) {
      await session.pty.submitInput(content);
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

  onError: (connectionId: UUID, error: Error) => {
    logError(`Error from ${connectionId}:`, error);
  },
};

// ---------------------------------------------------------------------------
// Create and register adapters
// ---------------------------------------------------------------------------
const wsAdapter = new WebSocketAdapter(
  {
    port: PORT,
    host: '0.0.0.0',
  },
  sharedEvents,
);
registry.register(wsAdapter);

if (TELEGRAM_ENABLED && TELEGRAM_TOKEN) {
  const telegramAdapter = new TelegramAdapter(
    {
      token: TELEGRAM_TOKEN,
      defaultDirectory: process.cwd(),
    },
    sharedEvents,
  );
  registry.register(telegramAdapter);
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

  for (const watcher of transcriptWatchers.values()) {
    watcher.stop();
  }
  transcriptWatchers.clear();
  await registry.stopAll();
  await sessionRegistry.shutdown();
  cleanupStatusFile();
}

// ---------------------------------------------------------------------------
// Main: Start in wrapper or daemon mode
// ---------------------------------------------------------------------------
if (cliDaemonMode) {
  // Legacy daemon mode: headless server, spawns Claude on WebSocket connect
  console.log('Starting Remi daemon...');
  await registry.startAll();

  console.log('');
  console.log('Remi daemon ready!');
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Port: ${PORT} (use --port to change)`);
  console.log(
    `  Bullet truncation: ${MAX_BULLET_LENGTH > 0 ? `${MAX_BULLET_LENGTH} chars` : 'disabled'}`,
  );
  if (TELEGRAM_ENABLED) {
    console.log('  Telegram: Bot is running');
  }
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');

  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    await cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...');
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
  // In wrapper mode, don't crash if port is busy - Claude still works locally
  try {
    await registry.startAll();
    log(`WebSocket server listening on ws://localhost:${PORT}/ws`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EADDRINUSE') || msg.includes('in use')) {
      logError(
        `Port ${PORT} is in use. Remote monitoring disabled. Use --port to specify a different port.`,
      );
    } else {
      logError(`WebSocket server failed to start: ${msg}. Remote monitoring disabled.`);
    }
  }

  // Create and start the primary PTY session
  const ptySession = await createNewSession(
    sessionId,
    workingDirectory,
    (sid, msg) => {
      // Broadcast to all connected WebSocket clients
      const session = sessionRegistry.getSession(sid);
      if (session?.activeConnectionId) {
        sendToConnection(session.activeConnectionId, msg);
      }
      // Also broadcast to all connections (for viewers without explicit attach)
      registry.broadcast(msg);
    },
    claudeArgs,
    true, // pass-through mode
  );

  // Set up raw stdin pass-through to PTY
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', (data: Buffer) => {
    if (ptySession.isRunning) {
      try {
        ptySession.write(data.toString());
      } catch {
        // PTY may have exited between the check and write
      }
    }
  });

  // Handle terminal resize
  process.stdout.on('resize', () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    try {
      if (ptySession.isRunning) {
        ptySession.resize({ cols, rows });
      }
    } catch {
      // PTY may have exited
    }
  });

  // Forward SIGINT/SIGTERM to PTY instead of exiting
  process.on('SIGINT', () => {
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
