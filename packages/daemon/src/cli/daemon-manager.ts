/**
 * Background daemon lifecycle management for remi start/stop/status.
 *
 * Uses child_process.spawn with detached:true to launch remi --daemon
 * in the background. Tracks the daemon via a PID file (~/.remi/daemon.pid).
 * The status.json file provides additional runtime info.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function getRemiDir(): string {
  const dir = path.join(os.homedir(), '.remi');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pidFile(): string {
  return path.join(getRemiDir(), 'daemon.pid');
}

function statusFile(): string {
  return path.join(getRemiDir(), 'daemon-status.json');
}

function daemonLogFile(): string {
  return path.join(getRemiDir(), 'daemon.log');
}

/**
 * Read the daemon PID from the PID file.
 * Returns null if no PID file exists or the process is not running.
 */
export function getRunningDaemonPid(): number | null {
  try {
    const content = fs.readFileSync(pidFile(), 'utf-8').trim();
    const pid = Number.parseInt(content, 10);
    if (Number.isNaN(pid) || pid <= 0) return null;

    // Check if the process is actually running
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process not running; clean up stale PID file
      try {
        fs.unlinkSync(pidFile());
      } catch {
        // ignore cleanup errors
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Read status.json for daemon runtime information.
 */
function readStatus(): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(statusFile(), 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the command and args to invoke remi.
 * Handles both compiled binary and bun/node script execution.
 */
function resolveRemiCommand(): { command: string; baseArgs: string[] } {
  const argv0 = process.argv[0] ?? '';
  const argv1 = process.argv[1] ?? '';

  // Compiled binary: argv[0] is the remi binary itself
  if (argv0.endsWith('/remi') || argv0.endsWith('\\remi')) {
    return { command: argv0, baseArgs: [] };
  }

  // Running via bun/node: argv[0] is the runtime, argv[1] is the script
  if (argv1 && (argv0.includes('bun') || argv0.includes('node'))) {
    return { command: argv0, baseArgs: [argv1] };
  }

  // Fallback: assume 'remi' is on PATH
  return { command: 'remi', baseArgs: [] };
}

export interface StartOptions {
  /** Port for WebSocket server */
  port?: number;
  /** Extra args to pass to the daemon */
  extraArgs?: string[];
}

/**
 * Start the remi daemon in the background.
 * Returns the PID of the spawned process.
 */
export function startDaemon(opts?: StartOptions): number {
  const existingPid = getRunningDaemonPid();
  if (existingPid) {
    const status = readStatus();
    const port = status?.['wsPort'] ?? 'unknown';
    console.error(`Daemon already running (PID ${existingPid}, port ${port}).`);
    console.error('Use `remi stop` to stop it first.');
    process.exit(1);
  }

  const { command, baseArgs } = resolveRemiCommand();
  const logPath = daemonLogFile();

  // Build args: [script-if-needed] --daemon [--port N] [extra...]
  const spawnArgs = [...baseArgs, '--daemon'];
  if (opts?.port) {
    spawnArgs.push('--port', String(opts.port));
  }
  if (opts?.extraArgs) {
    spawnArgs.push(...opts.extraArgs);
  }

  // Open log file for stdout/stderr redirection
  const logFd = fs.openSync(logPath, 'a');
  fs.writeSync(logFd, `\n--- Daemon starting at ${new Date().toISOString()} ---\n`);

  // Spawn detached process
  const child = spawn(command, spawnArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  const pid = child.pid;
  if (!pid) {
    console.error('Failed to start daemon process.');
    fs.closeSync(logFd);
    process.exit(1);
  }

  // Write PID file
  fs.writeFileSync(pidFile(), String(pid), 'utf-8');

  // Detach from parent so the daemon survives
  child.unref();
  fs.closeSync(logFd);

  // Wait briefly for the daemon to initialize and write status.json
  const startTime = Date.now();
  const timeout = 5000;
  let port: number | string = 'unknown';

  while (Date.now() - startTime < timeout) {
    const status = readStatus();
    if (status && status['pid'] === pid && status['wsPort']) {
      port = status['wsPort'] as number;
      break;
    }
    // Verify the process is still alive
    try {
      process.kill(pid, 0);
    } catch {
      console.error('Daemon process exited unexpectedly. Check logs:');
      console.error(`  ${logPath}`);
      try {
        fs.unlinkSync(pidFile());
      } catch {
        // ignore
      }
      process.exit(1);
    }
    // Small sync sleep to avoid busy loop
    execFileSync('sleep', ['0.1']);
  }

  console.log(`Daemon started (PID ${pid}, port ${port}).`);
  console.log(`Logs: ${logPath}`);
  return pid;
}

/**
 * Stop the running remi daemon.
 */
export function stopDaemon(): void {
  const pid = getRunningDaemonPid();
  if (!pid) {
    console.error('No running daemon found.');
    process.exit(1);
  }

  console.log(`Stopping daemon (PID ${pid})...`);

  // Send SIGTERM for graceful shutdown
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to send SIGTERM: ${msg}`);
    process.exit(1);
  }

  // Wait for the process to exit (up to 5 seconds)
  const startTime = Date.now();
  const timeout = 5000;

  while (Date.now() - startTime < timeout) {
    try {
      process.kill(pid, 0);
      // Still running; wait
      execFileSync('sleep', ['0.2']);
    } catch {
      // Process exited
      cleanupFiles();
      console.log('Daemon stopped.');
      return;
    }
  }

  // Force kill if still running
  console.error('Daemon did not stop gracefully; sending SIGKILL...');
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead
  }
  cleanupFiles();
  console.log('Daemon killed.');
}

/**
 * Show daemon status.
 */
export function showDaemonStatus(): void {
  const pid = getRunningDaemonPid();
  if (!pid) {
    console.log('Daemon is not running.');
    return;
  }

  const status = readStatus();
  if (status && status['pid'] === pid) {
    console.log(`Daemon running (PID ${pid})`);
    console.log(`  Port: ${status['wsPort']}`);
    console.log(`  Connections: ${status['connections']}`);
    console.log(`  Status: ${status['sessionStatus']}`);
    const adapters = status['adapters'];
    if (Array.isArray(adapters) && adapters.length > 0) {
      console.log(`  Adapters: ${adapters.join(', ')}`);
    }
  } else {
    console.log(`Daemon running (PID ${pid}), no status info available.`);
  }

  console.log(`  Logs: ${daemonLogFile()}`);
}

/**
 * Show recent daemon log output.
 */
export function showDaemonLogs(lines = 50): void {
  const logPath = daemonLogFile();
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    const tail = allLines.slice(-lines);
    console.log(tail.join('\n'));
  } catch {
    console.error(`No daemon log found at ${logPath}`);
  }
}

function cleanupFiles(): void {
  try {
    fs.unlinkSync(pidFile());
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(statusFile());
  } catch {
    // ignore
  }
}
