/** Real source hub + Worker with private state and inert CLI binaries. Never uses user credentials. */
import { afterEach } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { CAPABILITY_HEADER } from '../../../daemon/src/auth/capability-token';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers';
import { Mailbox } from '../../../signaling/tests/e2e/endpoints';
import { type TestWorker, startWorker } from '../../../signaling/tests/e2e/harness';
const homes: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const workers: TestWorker[] = [];
const sockets: WebSocket[] = [];
const CLI = resolve(import.meta.dir, '../../../daemon/src/cli.ts');
let fixtureRevision = 0;
const processHomes = new Map<ReturnType<typeof Bun.spawn>, string>();

/** Only PIDs proven to use this still-present private home may be signaled. */
function ownsProcess(pid: number, dir: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    const command = Bun.spawnSync(['/bin/ps', '-o', 'comm=', '-p', String(pid)]);
    if (command.exitCode !== 0) return false;
    const name = basename(command.stdout.toString().trim());
    if (name !== basename(process.execPath) && name !== 'cat') return false;
    const cwd =
      process.platform === 'linux'
        ? readlinkSync(`/proc/${pid}/cwd`)
        : Bun.spawnSync(['/usr/sbin/lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
            .stdout.toString()
            .split('\n')
            .find((line) => line.startsWith('n'))
            ?.slice(1);
    return cwd !== undefined && realpathSync(cwd) === realpathSync(dir);
  } catch {
    return false;
  }
}

function ownedPids(dir: string, roots: readonly number[]): Set<number> {
  const candidates = new Set(roots);
  const registry = join(dir, 'state/live-sessions');
  if (existsSync(registry))
    for (const name of readdirSync(registry)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(registry, name), 'utf8'));
        if (entry.projectPath !== dir && entry.projectPath !== realpathSync(dir)) continue;
        for (const pid of [entry.pid, entry.claudeChildPid])
          if (Number.isSafeInteger(pid)) candidates.add(pid);
      } catch {
        /* an in-flight registry write is covered by descendants */
      }
    }
  // Snapshot descendants BEFORE parents exit, including children not registered yet.
  const rows = Bun.spawnSync(['/bin/ps', '-axo', 'pid=,ppid='])
    .stdout.toString()
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows)
      if (pid && parent && candidates.has(parent) && !candidates.has(pid)) {
        candidates.add(pid);
        changed = true;
      }
  }
  return new Set([...candidates].filter((pid) => ownsProcess(pid, dir)));
}

async function stopOwnedHome(dir: string, roots: readonly number[]): Promise<void> {
  const pids = ownedPids(dir, roots);
  const signal = (pid: number, value: NodeJS.Signals) => {
    if (!ownsProcess(pid, dir)) return;
    try {
      process.kill(pid, value);
    } catch {
      /* already exited */
    }
  };
  for (const pid of pids) signal(pid, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    // Capture any last accepted create request's detached child before removing state.
    for (const pid of ownedPids(dir, roots))
      if (!pids.has(pid)) {
        pids.add(pid);
        signal(pid, 'SIGTERM');
      }
    if (![...pids].some((pid) => ownsProcess(pid, dir))) return;
    await Bun.sleep(20);
  }
  for (const pid of pids) signal(pid, 'SIGKILL');
  for (let i = 0; i < 20; i++) {
    if (![...pids].some((pid) => ownsProcess(pid, dir))) return;
    await Bun.sleep(20);
  }
  throw new Error('Owned relay fixture process failed to exit; private state retained.');
}

export async function cleanupOwnedRelayFixtures() {
  ++fixtureRevision;
  for (const socket of sockets.splice(0)) socket.close();
  const ownedHomes = homes.splice(0);
  const ownedProcesses = processes.splice(0);
  const ownedWorkers = workers.splice(0);
  // Dispose Workers even if a daemon exit fails, rather than waiting behind it.
  const results = await Promise.allSettled([
    ...ownedHomes.map((dir) =>
      stopOwnedHome(
        dir,
        ownedProcesses.filter((proc) => processHomes.get(proc) === dir).map((proc) => proc.pid),
      ),
    ),
    ...ownedWorkers.map((worker) => worker.stop()),
  ]);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length) {
    // Keep exact ownership records for a retry; never orphan them by dropping
    // the manifest merely because another teardown operation failed.
    homes.unshift(...ownedHomes);
    processes.unshift(...ownedProcesses);
    ownedWorkers.forEach((worker, index) => {
      if (results[ownedHomes.length + index]?.status === 'rejected') workers.push(worker);
    });
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Owned relay fixture cleanup failed',
    );
  }
  for (const proc of ownedProcesses) processHomes.delete(proc);
  for (const dir of ownedHomes) rmSync(dir, { recursive: true, force: true });
}
export function registerOwnedRelayFixtureCleanup() {
  afterEach(cleanupOwnedRelayFixtures);
}
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'remi-r3-'));
  chmodSync(dir, 0o700);
  homes.push(dir);
  mkdirSync(join(dir, 'bin'), { mode: 0o700 });
  for (const command of ['claude', 'codex'])
    writeFileSync(join(dir, 'bin', command), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
  return dir;
}
function spawn(dir: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: dir,
    env: {
      HOME: dir,
      REMI_HOME: join(dir, 'state'),
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      NODE_ENV: 'test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.push(proc);
  processHomes.set(proc, dir);
  return proc;
}
export async function ownedRelayHub() {
  const revision = fixtureRevision;
  const dir = home();
  const worker = await startWorker();
  if (revision !== fixtureRevision) {
    await worker.stop();
    throw new Error('Owned relay fixture lifetime ended');
  }
  workers.push(worker);
  const port = await reserveRange(1, 50, '127.0.0.1');
  if (revision !== fixtureRevision) throw new Error('Owned relay fixture lifetime ended');
  const proc = spawn(dir, [
    'serve',
    '--relay',
    '--signaling-url',
    worker.wsUrl,
    '--port',
    String(port),
    '--no-mdns',
    '--no-telegram',
  ]);
  const stdout = new Response(proc.stdout).text();
  let relayAdmitted = false;
  const stderr = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
      // The source hub emits this only after actual Worker control admission.
      // Listening /health alone does not establish relay readiness (#1202).
      if (output.split('\n').includes('Relay control admitted')) relayAdmitted = true;
    }
    return output + decoder.decode();
  })();
  const deadline = Date.now() + 10000;
  while (true) {
    if (proc.exitCode !== null) throw new Error(`hub exited: ${await stdout} ${await stderr}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok && relayAdmitted) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('hub startup deadline');
    await Bun.sleep(10);
  }
  return {
    dir,
    port,
    worker,
    proc,
    capability: readFileSync(join(dir, 'state/capability.key'), 'utf8').trim(),
  };
}

export async function ownedRelayOffer() {
  const running = await ownedRelayHub();
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/relay-control`, {
    headers: { [CAPABILITY_HEADER]: running.capability },
  } as never);
  sockets.push(ws);
  const inbox = new Mailbox<Record<string, unknown>>();
  ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('local control refused'));
  });
  ws.send(JSON.stringify({ t: 'pair', id: 'owned-r4' }));
  const offer = await inbox.next();
  if (offer['t'] !== 'offer') throw new Error('expected real pairing offer');
  return { running, ws, inbox, offer };
}

/** Controlled /bin/cat child: no Claude/Codex model turns or user config. */
export async function ownedRelayChild(running: Awaited<ReturnType<typeof ownedRelayHub>>) {
  const revision = fixtureRevision;
  writeFileSync(join(running.dir, 'bin/claude'), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 });
  const port = await reserveRange(1, 50, '127.0.0.1');
  if (revision !== fixtureRevision || !homes.includes(running.dir))
    throw new Error('Owned relay fixture lifetime ended');
  const child = spawn(running.dir, [
    '--daemon',
    '--port',
    String(port),
    '--no-relay',
    '--no-mdns',
    '--no-telegram',
  ]);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`controlled child exited: ${await stdout} ${await stderr}`);
    const live = join(running.dir, 'state/live-sessions');
    if (existsSync(live))
      for (const name of readdirSync(live).filter((name) => name.endsWith('.json'))) {
        const entry = JSON.parse(readFileSync(join(live, name), 'utf8'));
        if (entry.pid === child.pid && entry.claudeChildPid)
          return { child, entry: entry as { sessionId: string; hookPort: number; wsPort: number } };
      }
    await Bun.sleep(10);
  }
  throw new Error('controlled child registration deadline');
}
