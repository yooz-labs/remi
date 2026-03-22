/**
 * Background daemon lifecycle management for remi start/stop/status.
 *
 * Uses child_process.spawn with detached:true to launch remi --daemon
 * in the background. Tracks the daemon via a PID file (~/.remi/daemon.pid).
 * The daemon-status.json file provides additional runtime info.
 */

import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REMI_DIR = path.join(os.homedir(), '.remi');
const PID_FILE = path.join(REMI_DIR, 'daemon.pid');
const STATUS_FILE = path.join(REMI_DIR, 'daemon-status.json');
const LOG_FILE = path.join(REMI_DIR, 'daemon.log');

function ensureRemiDir(): void {
  fs.mkdirSync(REMI_DIR, { recursive: true });
}

/**
 * Read the daemon PID from the PID file.
 * Returns null if no PID file exists or the process is not running.
 */
export function getRunningDaemonPid(): number | null {
  let content: string;
  try {
    content = fs.readFileSync(PID_FILE, 'utf-8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`Warning: cannot read PID file: ${code ?? err}`);
    }
    return null;
  }

  const pid = Number.parseInt(content, 10);
  if (Number.isNaN(pid) || pid <= 0) return null;

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process not running; clean up stale PID file
    try {
      fs.unlinkSync(PID_FILE);
    } catch (unlinkErr) {
      const code = (unlinkErr as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`Warning: cannot remove stale PID file: ${code}`);
      }
    }
    return null;
  }
}

function readStatus(): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(STATUS_FILE, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(
        `Warning: cannot read status file: ${err instanceof Error ? err.message : err}`,
      );
    }
    return null;
  }
}

/**
 * Resolve the command and args to invoke remi.
 * Handles both compiled binary and bun/node script execution.
 */
export function resolveRemiCommand(): { command: string; baseArgs: string[] } {
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
  port?: number | undefined;
  /** Extra args to pass to the daemon */
  extraArgs?: string[] | undefined;
}

import { findAvailableTcpPort } from '../session/port-utils.ts';
import { DEFAULT_BASE_PORT, DEFAULT_PORT_RANGE } from '../session/session-registry-file.ts';

/**
 * Start the remi daemon in the background.
 * Returns the PID of the spawned process.
 */
export async function startDaemon(opts?: StartOptions): Promise<number> {
  ensureRemiDir();
  const existingPid = getRunningDaemonPid();
  if (existingPid) {
    const status = readStatus();
    const port = status?.['wsPort'] ?? 'unknown';
    console.error(`Daemon already running (PID ${existingPid}, port ${port}).`);
    console.error('Use `remi stop` to stop it first.');
    process.exit(1);
  }

  // Find a free port before spawning the daemon to avoid EADDRINUSE
  let daemonPort = opts?.port;
  if (!daemonPort) {
    const freePort = await findAvailableTcpPort(DEFAULT_BASE_PORT, DEFAULT_PORT_RANGE);
    if (freePort === null) {
      console.error(
        `All remi ports in range ${DEFAULT_BASE_PORT}-${DEFAULT_BASE_PORT + DEFAULT_PORT_RANGE - 1} are in use.`,
      );
      console.error('Use --port to specify a different port, or stop an existing remi session.');
      process.exit(1);
    }
    daemonPort = freePort;
  }

  const { command, baseArgs } = resolveRemiCommand();
  const spawnArgs = [...baseArgs, '--daemon', '--port', String(daemonPort)];
  if (opts?.extraArgs) {
    spawnArgs.push(...opts.extraArgs);
  }

  const logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(logFd, `\n--- Daemon starting at ${new Date().toISOString()} ---\n`);

  // Strip inherited REMI_PORT so the daemon auto-selects a free port
  // (unless the user explicitly passed --port, which is in spawnArgs)
  const childEnv = { ...process.env };
  if (!opts?.port) {
    // biome-ignore lint/performance/noDelete: must truly remove env var from child process
    delete childEnv['REMI_PORT'];
  }

  const child = spawn(command, spawnArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv,
  });

  const pid = child.pid;
  if (!pid) {
    console.error('Failed to start daemon process.');
    fs.closeSync(logFd);
    process.exit(1);
  }

  try {
    const fd = fs.openSync(PID_FILE, 'wx');
    fs.writeSync(fd, String(pid));
    fs.closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      console.error('Another daemon appears to be starting. Check with `remi status`.');
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to write PID file: ${msg}`);
    }
    fs.closeSync(logFd);
    process.exit(1);
  }
  child.unref();
  fs.closeSync(logFd);

  // Poll until daemon writes daemon-status.json or times out
  const startTime = Date.now();
  const timeout = 5000;
  let port: number | string = 'unknown';

  while (Date.now() - startTime < timeout) {
    const status = readStatus();
    if (status && status['pid'] === pid && status['wsPort']) {
      port = status['wsPort'] as number;
      break;
    }
    try {
      process.kill(pid, 0);
    } catch {
      console.error('Daemon process exited unexpectedly. Check logs:');
      console.error(`  ${LOG_FILE}`);
      try {
        fs.unlinkSync(PID_FILE);
      } catch {
        // PID file may already be cleaned up
      }
      process.exit(1);
    }
    Bun.sleepSync(100);
  }

  if (port === 'unknown') {
    console.log(
      `Daemon started (PID ${pid}) but did not report its port within ${timeout / 1000}s.`,
    );
    console.log('The daemon may still be initializing. Check status with: remi status');
  } else {
    console.log(`Daemon started (PID ${pid}, port ${port}).`);
  }
  console.log(`Logs: ${LOG_FILE}`);
  return pid;
}

export function stopDaemon(): void {
  const pid = getRunningDaemonPid();
  if (!pid) {
    console.error('No running daemon found.');
    process.exit(1);
  }

  console.log(`Stopping daemon (PID ${pid})...`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to send SIGTERM: ${msg}`);
    process.exit(1);
  }

  // Wait up to 5 seconds for graceful exit
  const startTime = Date.now();
  const timeout = 5000;

  while (Date.now() - startTime < timeout) {
    try {
      process.kill(pid, 0);
      Bun.sleepSync(200);
    } catch {
      cleanupFiles();
      console.log('Daemon stopped.');
      return;
    }
  }

  console.error('Daemon did not stop gracefully; sending SIGKILL...');
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: SIGKILL failed: ${msg}`);
      console.error('The daemon process may still be running.');
    }
  }
  Bun.sleepSync(200);
  cleanupFiles();
  console.log('Daemon killed.');
}

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

  console.log(`  Logs: ${LOG_FILE}`);
}

export function showDaemonLogs(lines = 50): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`No daemon log found at ${LOG_FILE}`);
    return;
  }
  try {
    const output = execSync(`tail -n ${lines} "${LOG_FILE}"`, { encoding: 'utf-8' });
    console.log(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read daemon log: ${msg}`);
  }
}

export interface SpawnResult {
  readonly pid: number;
  readonly port: number;
  readonly sessionId: string;
}

/**
 * Spawn a new remi daemon process on a specific port.
 * Unlike startDaemon(), this does not check for existing daemons or write PID files.
 * Polls the live-sessions registry until the new daemon registers.
 */
export async function spawnRemiDaemon(
  port: number,
  directory?: string,
  extraArgs: string[] = [],
  timeoutMs = 10000,
): Promise<SpawnResult> {
  const { SessionRegistryFile } = await import('../session/session-registry-file.ts');
  const liveRegistry = new SessionRegistryFile();

  const { command, baseArgs } = resolveRemiCommand();
  const spawnArgs = [...baseArgs, '--daemon', '--port', String(port)];
  if (directory) {
    spawnArgs.push('--dir', directory);
  }
  spawnArgs.push(...extraArgs);

  const logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(logFd, `\n--- Spawning daemon on port ${port} at ${new Date().toISOString()} ---\n`);

  const childEnv = { ...process.env };
  // biome-ignore lint/performance/noDelete: must truly remove env var from child process
  delete childEnv['REMI_PORT'];

  const child = spawn(command, spawnArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv,
  });

  const pid = child.pid;
  if (!pid) {
    fs.closeSync(logFd);
    throw new Error('Failed to start daemon process');
  }

  child.unref();
  fs.closeSync(logFd);

  // Poll live-sessions registry until the new daemon registers
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const entries = liveRegistry.listLive();
    const entry = entries.find((e) => e.wsPort === port && e.pid === pid);
    if (entry) {
      return { pid, port, sessionId: entry.sessionId };
    }

    // Check if process is still alive
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`Daemon process exited unexpectedly. Check logs: ${LOG_FILE}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Daemon did not register within ${timeoutMs / 1000}s. Check logs: ${LOG_FILE}`);
}

function cleanupFiles(): void {
  for (const file of [PID_FILE, STATUS_FILE]) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.error(`Warning: could not remove ${path.basename(file)}: ${code}`);
      }
    }
  }
}
