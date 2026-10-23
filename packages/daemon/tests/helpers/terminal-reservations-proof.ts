/** Real private files and process owners; also compiled by the six-cell qualification. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withInterprocessFileLockNonblocking } from '../../src/storage/interprocess-file-lock.ts';
import { TerminalReservationError, TerminalReservations } from '../../src/terminal/reservations.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
  const end = performance.now() + 10000;
  while (!condition()) {
    assert(performance.now() < end, 'owned process barrier deadline');
    await delay(5);
  }
}
const code = (operation: () => unknown, expected: 'busy' | 'unavailable', name: string) =>
  assert.throws(
    operation,
    (error) => error instanceof TerminalReservationError && error.code === expected,
    name,
  );
const device = () => randomBytes(32).toString('hex');
const ledger = (home: string) => join(home, 'terminal-view', 'reservations.json');

export async function runTerminalReservationChild(args: readonly string[]): Promise<void> {
  const [mode, home, prefix, sharedDevice] = args;
  assert(home && prefix && mode);
  if (mode === 'lock') {
    withInterprocessFileLockNonblocking(ledger(home), () => {
      fs.writeFileSync(`${prefix}.ready`, 'locked');
      const end = performance.now() + 10000;
      while (!fs.existsSync(`${prefix}.go`)) {
        assert(performance.now() < end, 'owned lock release deadline');
        Bun.sleepSync(1);
      }
    });
    return;
  }
  let reservations: TerminalReservations | undefined;
  // Startup itself is one nonblocking ownership attempt. The process harness
  // retries only busy admission before reserving anything or entering its barrier.
  await until(() => {
    try {
      reservations = TerminalReservations.open(home);
      return true;
    } catch (error) {
      assert(error instanceof TerminalReservationError && error.code === 'busy');
      return false;
    }
  });
  assert(reservations);
  const admitted = reservations;
  if (mode === 'device') {
    assert(sharedDevice);
    const model = admitted.reserveModel(randomUUID());
    code(
      () => admitted.reserveView(model, sharedDevice, randomUUID()),
      'busy',
      'cross-process device limit',
    );
    return;
  }
  assert.equal(mode, 'models');
  await until(() => fs.existsSync(join(home, 'start')));
  const ids: string[] = [];
  for (let attempt = 0; attempt < 128; attempt++) {
    try {
      if (ids.length < 16) ids.push(admitted.reserveModel(randomUUID()));
    } catch (error) {
      assert(error instanceof TerminalReservationError && error.code === 'busy');
    }
    await delay(2);
  }
  fs.writeFileSync(`${prefix}.ready`, JSON.stringify({ pid: process.pid, ids }));
  await until(() => fs.existsSync(`${prefix}.go`));
  // Intentional process exit without release: the parent must prove death before reclaiming RAM charge.
}

export async function runTerminalReservationProof(command: readonly string[]): Promise<string[]> {
  const groups: string[] = [];
  const home = () => fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-terminal-quota-')));
  const scenario = async (
    name: string,
    run: (root: string, state: TerminalReservations) => void | Promise<void>,
  ) => {
    const root = home();
    let passed = false;
    try {
      await run(root, TerminalReservations.open(root));
      passed = true;
      groups.push(name);
    } finally {
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else console.error('Owned terminal reservation evidence retained', root);
    }
  };
  const children = new Set<Bun.Subprocess<'ignore', 'pipe', 'pipe'>>();
  const spawn = (args: readonly string[]) => {
    const child = Bun.spawn([...command, '--terminal-reservation-child', ...args], {
      env: { HOME: args[1], TMPDIR: tmpdir(), PATH: '/usr/bin:/bin' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.add(child);
    return child;
  };
  const reap = async (child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) => {
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    await until(() => child.exitCode !== null);
    const diagnostics = await stderr;
    assert.equal(await child.exited, 0, `owned child exit: ${diagnostics.slice(0, 4000)}`);
    assert.equal(diagnostics, '', 'owned child stderr');
    assert.equal(await stdout, '', 'owned child stdout');
    assert.throws(
      () => process.kill(child.pid, 0),
      (e) => (e as NodeJS.ErrnoException).code === 'ESRCH',
      'owned child absent',
    );
    children.delete(child);
  };
  try {
    await scenario('model budget and exact owner', (root, state) => {
      const ids = Array.from({ length: 32 }, () => state.reserveModel(randomUUID()));
      code(() => state.reserveModel(randomUUID()), 'busy', '33rd model refused');
      const foreign = TerminalReservations.open(root);
      assert.equal(foreign.release(ids[0] ?? ''), false, 'foreign release cannot free a model');
      code(
        () => foreign.reserveModel(randomUUID()),
        'busy',
        'foreign release preserves full budget',
      );
      assert(state.owns(ids[0] ?? ''));
      assert(state.release(ids[0] ?? ''));
      assert(!state.owns(ids[0] ?? ''));
      assert(state.reserveModel(randomUUID()));
    });
    await scenario('one model per session', (_root, state) => {
      const session = randomUUID();
      state.reserveModel(session);
      code(() => state.reserveModel(session), 'busy', 'duplicate session model refused');
    });
    await scenario('connection view limit', (_root, state) => {
      const model = state.reserveModel(randomUUID());
      const connection = randomUUID();
      state.reserveView(model, device(), connection);
      code(
        () => state.reserveView(model, device(), connection),
        'busy',
        'second view on connection refused',
      );
    });
    await scenario('device view limit across processes', async (root, state) => {
      const model = state.reserveModel(randomUUID());
      const key = device();
      state.reserveView(model, key, randomUUID());
      state.reserveView(model, key, randomUUID());
      code(() => state.reserveView(model, key, randomUUID()), 'busy', 'third device view refused');
      await reap(spawn(['device', root, join(root, 'device'), key]));
    });
    await scenario('session view limit', (_root, state) => {
      const model = state.reserveModel(randomUUID());
      for (let i = 0; i < 4; i++) state.reserveView(model, device(), randomUUID());
      code(
        () => state.reserveView(model, device(), randomUUID()),
        'busy',
        'fifth session view refused',
      );
    });
    await scenario('home view limit', (_root, state) => {
      for (let i = 0; i < 2; i++) {
        const model = state.reserveModel(randomUUID());
        for (let j = 0; j < 4; j++) state.reserveView(model, device(), randomUUID());
      }
      const model = state.reserveModel(randomUUID());
      code(
        () => state.reserveView(model, device(), randomUUID()),
        'busy',
        'ninth home view refused',
      );
    });
    await scenario('view model ownership and disposal ordering', (root, state) => {
      const model = state.reserveModel(randomUUID());
      const foreign = TerminalReservations.open(root);
      code(
        () => foreign.reserveView(model, device(), randomUUID()),
        'unavailable',
        'foreign model cannot host view',
      );
      const view = state.reserveView(model, device(), randomUUID());
      assert.equal(foreign.release(view), false, 'foreign view release refused');
      code(() => state.release(model), 'unavailable', 'model release cannot strand view');
      assert(state.release(view));
      assert(state.release(model));
      code(
        () => state.reserveView(model, device(), randomUUID()),
        'unavailable',
        'released model cannot host view',
      );
    });
    await scenario('independent homes', async (_root, state) => {
      for (let i = 0; i < 32; i++) state.reserveModel(randomUUID());
      await scenario('second home admission', (_other, other) => {
        assert(other.reserveModel(randomUUID()));
      });
    });
    await scenario('live concurrent owners and dead owner recovery', async (root, state) => {
      const actors = Array.from({ length: 4 }, (_, i) => {
        const prefix = join(root, `actor-${i}`);
        return { prefix, child: spawn(['models', root, prefix]) };
      });
      try {
        fs.writeFileSync(join(root, 'start'), 'start');
        await until(() => actors.every(({ prefix }) => fs.existsSync(`${prefix}.ready`)));
        const rows = actors.flatMap(({ prefix, child }) => {
          const result = JSON.parse(fs.readFileSync(`${prefix}.ready`, 'utf8')) as {
            pid: number;
            ids: string[];
          };
          assert.equal(result.pid, child.pid);
          return result.ids;
        });
        assert.equal(rows.length, 32, 'concurrent owners fill exactly 32 model slots');
        assert.equal(new Set(rows).size, 32, 'concurrent reservation IDs are unique');
        assert.equal(
          state.release(rows[0] ?? ''),
          false,
          'live child ownership survives foreign release',
        );
        code(() => state.reserveModel(randomUUID()), 'busy', 'concurrent owners cannot overbook');
      } finally {
        for (const { prefix } of actors) fs.writeFileSync(`${prefix}.go`, 'release');
        for (const { child } of actors) await reap(child);
      }
      for (let i = 0; i < 32; i++)
        assert(state.reserveModel(randomUUID()), 'proved dead owner reclaimed');
      code(() => state.reserveModel(randomUUID()), 'busy', 'recovered budget remains bounded');
    });
    await scenario('nonblocking held lock', async (root, state) => {
      const prefix = join(root, 'holder');
      const child = spawn(['lock', root, prefix]);
      try {
        await until(() => fs.existsSync(`${prefix}.ready`));
        const start = performance.now();
        code(() => state.reserveModel(randomUUID()), 'busy', 'held lock returns busy');
        assert(performance.now() - start < 100, 'held lock never waits for release');
        assert.equal(child.exitCode, null, 'real lock owner remains alive');
      } finally {
        fs.writeFileSync(`${prefix}.go`, 'release');
        await reap(child);
      }
      assert(state.reserveModel(randomUUID()));
    });
    const corruptions: Record<string, (root: string) => void> = {
      'missing ledger': (r) => fs.unlinkSync(ledger(r)),
      'missing namespace': (r) => fs.rmSync(join(r, 'terminal-view'), { recursive: true }),
      'missing marker': (r) => fs.unlinkSync(join(r, '.terminal-view-namespace')),
      'replaced namespace': (r) => {
        fs.renameSync(join(r, 'terminal-view'), join(r, 'old'));
        fs.mkdirSync(join(r, 'terminal-view'), { mode: 0o700 });
        fs.copyFileSync(join(r, 'old', 'reservations.json'), ledger(r));
      },
      'ledger symlink': (r) => {
        fs.renameSync(ledger(r), `${ledger(r)}.old`);
        fs.symlinkSync(`${ledger(r)}.old`, ledger(r));
      },
      'ledger hardlink': (r) => fs.linkSync(ledger(r), `${ledger(r)}.link`),
      'ledger mode': (r) => fs.chmodSync(ledger(r), 0o644),
      'namespace mode': (r) => fs.chmodSync(join(r, 'terminal-view'), 0o755),
      'marker mode': (r) => fs.chmodSync(join(r, '.terminal-view-namespace'), 0o644),
      'marker symlink': (r) => {
        const p = join(r, '.terminal-view-namespace');
        fs.renameSync(p, `${p}.old`);
        fs.symlinkSync(`${p}.old`, p);
      },
      'wrong marker namespace': (r) =>
        fs.writeFileSync(join(r, '.terminal-view-namespace'), '0:0\n'),
      'oversized ledger': (r) => fs.writeFileSync(ledger(r), ' '.repeat(32769)),
      'invalid UTF-8': (r) => fs.writeFileSync(ledger(r), Buffer.from([0xff])),
      'duplicate member': (r) =>
        fs.writeFileSync(
          ledger(r),
          fs.readFileSync(ledger(r), 'utf8').replace('"version":1', '"version":1,"version":1'),
        ),
      'malformed JSON': (r) => fs.writeFileSync(ledger(r), '{'),
      'unknown field': (r) =>
        fs.writeFileSync(
          ledger(r),
          fs.readFileSync(ledger(r), 'utf8').replace('"version":1', '"extra":0,"version":1'),
        ),
      'duplicate row': (r) => {
        const value = JSON.parse(fs.readFileSync(ledger(r), 'utf8'));
        value.records.push(value.records[0]);
        fs.writeFileSync(ledger(r), JSON.stringify(value));
      },
      'invalid owner PID': (r) => {
        const value = JSON.parse(fs.readFileSync(ledger(r), 'utf8'));
        value.records[0].pid = 0;
        fs.writeFileSync(ledger(r), JSON.stringify(value));
      },
    };
    for (const [name, change] of Object.entries(corruptions)) {
      await scenario(name, (root, state) => {
        const id = state.reserveModel(randomUUID());
        change(root);
        code(() => state.owns(id), 'unavailable', `${name} invalidates existing owner`);
        code(() => state.release(id), 'unavailable', `${name} cannot release charge`);
        code(
          () => TerminalReservations.open(root).reserveModel(randomUUID()),
          'unavailable',
          `${name} cannot reset budget`,
        );
      });
    }
    return groups;
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
  }
}

/** Real death and 30 seconds of age do not authorize automatic lock deletion. */
export async function runCrashedTerminalLockProof(command: readonly string[]): Promise<string> {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-terminal-crash-')));
  const state = TerminalReservations.open(home);
  const prefix = join(home, 'holder');
  const child = Bun.spawn([...command, '--terminal-reservation-child', 'lock', home, prefix], {
    env: { HOME: home, TMPDIR: tmpdir(), PATH: '/usr/bin:/bin' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let passed = false;
  try {
    await until(() => fs.existsSync(`${prefix}.ready`));
    const lock = `${ledger(home)}.lock`;
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number; acquiredAt: number };
    assert.equal(owner.pid, child.pid, 'actual lock owner PID');
    const minimum = Math.max(owner.acquiredAt, fs.statSync(lock).mtimeMs) + 30000;
    const started = performance.now();
    child.kill('SIGKILL');
    await child.exited;
    assert.equal(child.signalCode, 'SIGKILL', 'lock owner killed inside transaction');
    assert.equal(await stdout, '');
    assert.equal(await stderr, '');
    assert.throws(
      () => process.kill(child.pid, 0),
      (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    );
    code(() => state.reserveModel(randomUUID()), 'busy', 'young dead lock remains charged');
    while (Date.now() < minimum || performance.now() - started < 30000) await delay(25);
    const recoveryStarted = performance.now();
    code(
      () => state.reserveModel(randomUUID()),
      'busy',
      'abandoned old lock requires explicit repair',
    );
    assert(performance.now() - recoveryStarted < 100, 'abandoned lock remains nonblocking');
    assert(fs.existsSync(lock), 'abandoned lock is retained');
    // The sole child owner is proved dead/reaped, no resources were admitted,
    // and this controller owns the whole private fixture. Model quiescent operator repair.
    const records = JSON.parse(fs.readFileSync(ledger(home), 'utf8')) as { records: unknown[] };
    assert.equal(records.records.length, 0, 'no live resources during owned repair');
    fs.unlinkSync(lock);
    assert.doesNotThrow(
      () => TerminalReservations.open(home).reserveModel(randomUUID()),
      'quiescent explicit repair restores admission',
    );
    passed = true;
    return 'real crashed owner requires explicit lock repair';
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    if (passed) fs.rmSync(home, { recursive: true, force: true });
    else console.error('Owned crashed-lock evidence retained', home);
  }
}
