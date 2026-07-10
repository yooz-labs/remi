/**
 * Integration tests for the hub lifecycle races and CLI round-trip (#542,
 * #731 review): the PID-file split-brain branches, `remi start`/`remi stop`
 * through the real CLI, and REMI_SPAWNED_CHILD per-port status routing.
 *
 * Same harness as hub-serve.test.ts: REAL cli.ts subprocesses under an
 * isolated $HOME, no mocks.
 *
 * NOT covered here (covered by on-machine verification instead): a hub
 * spawning a real `--daemon` session child and `remi stop` sparing it — the
 * child wraps a real `claude` process, which CI does not have, and a stub
 * claude binary would violate the no-mocks rule.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CLI_TS,
  type HubHandle,
  cleanupHub,
  findTestPort,
  isolatedEnv,
  makeIsolatedDirs,
  pollUntil,
  spawnHub,
  spawnServeRaw,
} from './hub-test-utils.ts';

const hubs: HubHandle[] = [];
/** PIDs of detached hubs (started via `remi start`) to reap unconditionally. */
const detachedPids: number[] = [];
/** Extra isolated dirs to remove (for tests not using a HubHandle). */
const extraDirs: string[] = [];

afterEach(async () => {
  for (const pid of detachedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead — the expected case when `remi stop` worked
    }
  }
  for (const hub of hubs.splice(0)) {
    await cleanupHub(hub);
  }
  for (const dir of extraDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('hub PID-file races (#542 split-brain fix)', () => {
  test('second hub in the same HOME exits 1 and leaves the first hub PID intact', async () => {
    const hub = await spawnHub();
    hubs.push(hub);
    const pidFile = path.join(hub.home, '.remi', 'daemon.pid');
    expect(fs.readFileSync(pidFile, 'utf-8').trim()).toBe(String(hub.proc.pid));

    // Same HOME, different port: must lose the PID-file claim and exit 1.
    const rivalPort = await findTestPort();
    const rival = spawnServeRaw(hub.home, hub.work, rivalPort);
    const code = await rival.exited;
    expect(code).toBe(1);
    const stderr = await new Response(rival.stderr).text();
    expect(stderr).toContain('Hub already running');
    expect(stderr).toContain(String(hub.proc.pid));

    // The losing rival must not have clobbered the winner's PID file, and
    // the winner keeps serving.
    expect(fs.readFileSync(pidFile, 'utf-8').trim()).toBe(String(hub.proc.pid));
    expect(hub.proc.exitCode).toBeNull();
  }, 30000);

  test('unwritable ~/.remi surfaces the real I/O error, not a bogus race message', async () => {
    const { home, work } = makeIsolatedDirs();
    extraDirs.push(home, work);
    const remiDir = path.join(home, '.remi');
    // Pre-create everything boot appends to, then make the DIR read-only:
    // existing files stay writable, but creating daemon.pid ('wx') fails
    // with EACCES — which must surface as an I/O error, not fall into the
    // "Another hub claimed the PID file" race diagnosis (#740 review).
    fs.mkdirSync(path.join(remiDir, 'live-sessions'), { recursive: true });
    fs.writeFileSync(path.join(remiDir, 'remi.log'), '');
    fs.writeFileSync(path.join(remiDir, 'daemon.log'), '');
    fs.chmodSync(remiDir, 0o555);
    try {
      const port = await findTestPort();
      const proc = spawnServeRaw(home, work, port);
      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(code).toBe(1);
      expect(stderr).toContain('Failed to write hub PID file');
      expect(stderr).not.toContain('Another hub claimed');
    } finally {
      fs.chmodSync(remiDir, 0o755);
    }
  }, 30000);

  test('stale PID file (dead process) is cleaned up and the hub boots', async () => {
    const { home, work } = makeIsolatedDirs();
    extraDirs.push(home, work);

    // A real process that has already exited — its PID is genuinely stale.
    const shortLived = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await shortLived.exited;
    const deadPid = shortLived.pid;

    const remiDir = path.join(home, '.remi');
    fs.mkdirSync(remiDir, { recursive: true });
    fs.writeFileSync(path.join(remiDir, 'daemon.pid'), String(deadPid));

    const hub = await spawnHub({ home, work });
    hubs.push(hub);

    // The stale entry was replaced by the booting hub's own PID.
    const pidContent = fs.readFileSync(path.join(remiDir, 'daemon.pid'), 'utf-8').trim();
    expect(Number.parseInt(pidContent, 10)).toBe(hub.proc.pid);
    expect(hub.proc.exitCode).toBeNull();
  }, 30000);
});

describe('remi start / remi stop round-trip (real CLI)', () => {
  test('start spawns a detached hub; stop terminates it and cleans the PID file', async () => {
    const { home, work } = makeIsolatedDirs();
    extraDirs.push(home, work);
    const port = await findTestPort();

    const start = Bun.spawn(
      [
        'bun',
        CLI_TS,
        'start',
        '--port',
        String(port),
        '--no-relay',
        '--no-telegram',
        '--no-mdns',
        '--no-auth',
      ],
      { cwd: work, env: isolatedEnv(home), stdout: 'pipe', stderr: 'pipe' },
    );
    expect(await start.exited).toBe(0);
    const startOut = await new Response(start.stdout).text();
    expect(startOut).toContain('Hub started');

    // The hub self-wrote its PID file; the process is alive and detached
    // (it survived its `remi start` parent exiting).
    const pidFile = path.join(home, '.remi', 'daemon.pid');
    const hubPid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(hubPid).toBeGreaterThan(0);
    detachedPids.push(hubPid);
    expect(isAlive(hubPid)).toBe(true);

    const status = JSON.parse(
      fs.readFileSync(path.join(home, '.remi', 'daemon-status.json'), 'utf-8'),
    );
    expect(status.mode).toBe('hub');
    expect(status.wsPort).toBe(port);
    expect(status.pid).toBe(hubPid);

    // `remi stop` resolves the hub via the PID file and SIGTERMs it.
    const stop = Bun.spawn(['bun', CLI_TS, 'stop'], {
      cwd: work,
      env: isolatedEnv(home),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await stop.exited).toBe(0);
    const stopOut = await new Response(stop.stdout).text();
    expect(stopOut.toLowerCase()).toContain('stopped');

    await pollUntil(() => !isAlive(hubPid), 10000, 'hub process to exit after remi stop');
    await pollUntil(() => !fs.existsSync(pidFile), 10000, 'PID file removal after remi stop');
  }, 45000);
});

describe('cleanupFiles ownership guard (#740 review)', () => {
  /** Run cleanupFiles(stoppedPid) in a subprocess whose $HOME is `home`, so
   *  the module-level ~/.remi paths in daemon-manager.ts resolve into the
   *  sandbox instead of the developer's real ~/.remi. */
  async function runCleanupFiles(home: string, stoppedPid: number): Promise<void> {
    const dmPath = path.resolve(import.meta.dir, '../../src/cli/daemon-manager.ts');
    const proc = Bun.spawn(
      [
        'bun',
        '-e',
        `const { cleanupFiles } = await import(${JSON.stringify(dmPath)}); cleanupFiles(Number(process.argv[1]));`,
        String(stoppedPid),
      ],
      { env: isolatedEnv(home), stdout: 'pipe', stderr: 'pipe' },
    );
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`cleanupFiles subprocess failed: ${await new Response(proc.stderr).text()}`);
    }
  }

  test('removes files naming the stopped pid; spares files a new hub claimed', async () => {
    const { home, work } = makeIsolatedDirs();
    extraDirs.push(home, work);
    const remiDir = path.join(home, '.remi');
    fs.mkdirSync(remiDir, { recursive: true });
    const pidFile = path.join(remiDir, 'daemon.pid');
    const statusFile = path.join(remiDir, 'daemon-status.json');

    // Case A: both files name the stopped pid -> removed.
    fs.writeFileSync(pidFile, '4242');
    fs.writeFileSync(statusFile, JSON.stringify({ pid: 4242, wsPort: 1 }));
    await runCleanupFiles(home, 4242);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(statusFile)).toBe(false);

    // Case B: a new hub already claimed both files -> left intact.
    fs.writeFileSync(pidFile, '5555');
    fs.writeFileSync(statusFile, JSON.stringify({ pid: 5555, wsPort: 1 }));
    await runCleanupFiles(home, 4242);
    expect(fs.readFileSync(pidFile, 'utf-8')).toBe('5555');
    expect(JSON.parse(fs.readFileSync(statusFile, 'utf-8')).pid).toBe(5555);
  }, 30000);
});

describe('REMI_SPAWNED_CHILD status routing (#542)', () => {
  test('a spawned child writes status-<port>.json, never the parent daemon-status.json', async () => {
    // Hub-spawned children run `--daemon`, which wraps a real `claude`
    // process CI does not have. The routing under test (StatusWriter's
    // getTargetFile: cliDaemonMode && REMI_SPAWNED_CHILD !== '1') evaluates
    // identically in serve mode (cliDaemonMode is true there too), which
    // boots without Claude — so drive it through serve.
    const { home, work } = makeIsolatedDirs();
    extraDirs.push(home, work);
    const port = await findTestPort();

    const proc = spawnServeRaw(home, work, port, { REMI_SPAWNED_CHILD: '1' });
    const perPortFile = path.join(home, '.remi', `status-${port}.json`);
    await pollUntil(
      () => {
        if (proc.exitCode !== null) {
          throw new Error(`child exited early with code ${proc.exitCode}`);
        }
        try {
          return JSON.parse(fs.readFileSync(perPortFile, 'utf-8')).wsPort === port;
        } catch {
          return false;
        }
      },
      15000,
      'per-port status file',
    );

    const status = JSON.parse(fs.readFileSync(perPortFile, 'utf-8'));
    expect(status.pid).toBe(proc.pid);
    // The parent's file must not exist: a child writing daemon-status.json
    // would make `remi stop`/`status` resolve the WRONG process.
    expect(fs.existsSync(path.join(home, '.remi', 'daemon-status.json'))).toBe(false);

    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }, 30000);
});
