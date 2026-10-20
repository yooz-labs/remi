/** Explicit real-clock/test-host proof; never discovered by ordinary bun test. No production flag. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FileFetchAccepted } from '@remi/shared';
import {
  downloadFixture,
  until,
} from '../../packages/daemon/tests/helpers/file-download-service-fixture';

const state = (f: Awaited<ReturnType<typeof downloadFixture>>) =>
  (f.service as unknown as { records: Set<{ totalUntil: number; reason: string }> }).records;
function clean(f: Awaited<ReturnType<typeof downloadFixture>>) {
  assert(
    f
      .ledger()
      .inspect()
      .every((row) => row.state === 'settled' && row.charge === 0),
    'clock host confirmed settlement',
  );
}
async function sleepUntil(deadline: number) {
  while (performance.now() < deadline) await Bun.sleep(Math.min(100, deadline - performance.now()));
}
function acceptance(value: unknown): FileFetchAccepted {
  assert(
    value && typeof value === 'object' && 'type' in value && value.type === 'file_fetch_accepted',
    'clock host actual acceptance',
  );
  return value as FileFetchAccepted;
}

async function paused(checkpoint: string, result: string) {
  const f = await downloadFixture();
  try {
    const peer = await f.client();
    f.write('sample.bin', Buffer.alloc(10485760, 0x73));
    const work = f.service.handle(peer.id, peer.begin());
    const record = [...state(f)][0];
    assert(record, 'actual pending preparation record');
    const row = f
      .ledger()
      .inspect()
      .find((row) => row.state === 'active');
    assert(row, 'actual preparation journal exists before stop');
    const bytes = fs.statSync(
      join(f.files.home, 'image-staging', 'scratch', `${row.id}.artifact`),
    ).size;
    assert(bytes > 0 && bytes < 10485760, 'actual first bounded copy before acceptance');
    assert(
      !peer.frames.some((frame) => frame.type === 'file_fetch_accepted'),
      'checkpoint is pre-acceptance',
    );
    const before = performance.now();
    fs.writeFileSync(
      checkpoint,
      JSON.stringify({
        pid: process.pid,
        wall: Date.now(),
        before,
        remaining: record.totalUntil - before,
        copied: bytes,
        directory: f.files.directory,
        launcher: dirname(f.base.producer.browserPath),
      }),
      { mode: 0o600 },
    );
    process.kill(process.pid, 'SIGSTOP');
    const elapsed = performance.now() - before;
    assert(elapsed >= 299000, 'actual monotonic elapsed includes process suspension');
    await work;
    await Bun.sleep(20);
    assert.equal(record.reason, 'expired', 'pending preparation expires at original deadline');
    assert(
      !peer.frames.some(
        (frame) => frame.type === 'file_fetch_accepted' || frame.type === 'file_fetch_chunk',
      ),
      'expired preparation never exposes bytes',
    );
    clean(f);
    fs.writeFileSync(
      result,
      JSON.stringify({ elapsed, reason: record.reason, preAcceptance: true, settled: true }),
      { mode: 0o600 },
    );
  } finally {
    await f.close();
  }
}

async function cleanupFault(receipt: string) {
  const f = await downloadFixture();
  const peer = await f.client();
  const launcher = dirname(f.base.producer.browserPath);
  let safelyDrained = false;
  f.write('sample.bin', Buffer.alloc(10485760, 0x66));
  const work = f.service.handle(peer.id, peer.begin());
  const ledger = join(f.files.home, 'image-staging', 'ledger', 'reservations.json');
  const original = fs.readFileSync(ledger);
  fs.writeFileSync(
    receipt,
    JSON.stringify({
      directory: f.files.directory,
      home: f.files.home,
      pid: process.pid,
      stage: 'allocated',
    }),
    { mode: 0o600 },
  );
  try {
    fs.writeFileSync(ledger, '{ owned unreadable ledger');
    await work;
    await until(
      () => peer.frames.some((frame) => frame.type === 'file_fetch_refused'),
      'cleanup fault refusal',
    );
    assert(
      peer.frames.some(
        (frame) => frame.type === 'file_fetch_refused' && frame.code === 'cleanup_failed',
      ),
      'uncertain preparation is cleanup_failed',
    );
    assert.equal(state(f).size, 1, 'unknown cleanup retains bounded owned record');
    assert.equal(f.service.isAvailable(peer.id), false, 'unknown cleanup poisons admission');
    await f.service.handle(peer.id, peer.begin());
    assert.equal(state(f).size, 1, 'poisoned service cannot create another record');
    assert.equal(await f.service.close(), false, 'unknown cleanup keeps native ownership');
    fs.writeFileSync(ledger, original);
    assert(
      f
        .ledger()
        .inspect()
        .some((row) => row.charge > 0),
      'unknown cleanup remains charged',
    );
    // Exercise the actual helper's uncertain-close path, retaining charged native ownership.
    let closeError: unknown;
    try {
      await f.close();
    } catch (error) {
      closeError = error;
    }
    assert(closeError, 'uncertain helper close reports retained owned debt');
    assert.equal(
      f.base.pty.sessionState,
      'exited',
      'uncertain helper close drains actual consumer',
    );
    assert.equal(
      peer.ws.readyState,
      WebSocket.CLOSED,
      'uncertain helper close drains actual socket',
    );
    assert(!fs.existsSync(launcher), 'uncertain helper close removes launcher after consumer exit');
    assert(fs.existsSync(f.files.home), 'uncertain helper close preserves charged home');
    assert(
      f
        .ledger()
        .inspect()
        .some((row) => row.charge > 0),
      'uncertain helper close preserves charge',
    );
    safelyDrained = true;
    // Only actual process death may release this uncertain live journal owner.
    fs.writeFileSync(
      receipt,
      JSON.stringify({
        directory: f.files.directory,
        home: f.files.home,
        pid: process.pid,
        charged: true,
        close: false,
        safelyDrained,
        launcherRemoved: !fs.existsSync(launcher),
      }),
      { mode: 0o600 },
    );
  } finally {
    fs.writeFileSync(ledger, original);
    await f.service.close();
    if (!safelyDrained) {
      // Diagnostic original/removed-guard failure cleanup; never qualifies the helper assertion.
      f.base.producer.retire();
      peer.ws.close();
      f.base.service.close();
      await f.base.adapter.stop();
      await f.base.pty.close();
      assert.equal(f.base.pty.sessionState, 'exited', 'fault host cat actually ended');
      await f.base.producer.close();
      await f.base.registry.shutdown();
    }
  }
  process.exit(0);
}

async function clocks() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'remi-download-clock-'));
  const checkpoint = join(directory, 'checkpoint.json');
  const result = join(directory, 'result.json');
  const fixtures: Awaited<ReturnType<typeof downloadFixture>>[] = [];
  const launchers: string[] = [];
  let child: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
  let childExited: Promise<number> | undefined;
  let childReaped = false;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child || childReaped) return;
    try {
      process.kill(child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const failures: unknown[] = [];
  let measurement: object | undefined;
  let childDirectory: string | undefined;
  let childLauncher: string | undefined;
  try {
    const executable = Bun.main.startsWith('/$bunfs/')
      ? [process.execPath]
      : [process.execPath, '--no-env-file', import.meta.path];
    child = Bun.spawn([...executable, '--paused', checkpoint, result], {
      cwd: directory,
      env: {
        HOME: directory,
        TMPDIR: tmpdir(),
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        NODE_ENV: 'test',
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    childExited = child.exited.then((status) => {
      childReaped = true;
      return status;
    });
    const errors = new Response(child.stderr).text();
    await until(() => fs.existsSync(checkpoint) || childReaped, 'preparation checkpoint', 10000);
    assert(fs.existsSync(checkpoint), 'paused child reached actual preparation');
    const stopped = execFileSync('ps', ['-o', 'stat=', '-p', String(child.pid)], {
      encoding: 'utf8',
    }).trim();
    assert(stopped.includes('T'), 'owned preparation child actually SIGSTOPped');
    const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8')) as {
      wall: number;
      remaining: number;
      directory: string;
      launcher: string;
    };
    childDirectory = saved.directory;
    childLauncher = saved.launcher;
    const resumeAtWall = saved.wall + saved.remaining + 250;

    const setup = async (bytes: number) => {
      const f = await downloadFixture();
      fixtures.push(f);
      launchers.push(dirname(f.base.producer.browserPath));
      const peer = await f.client();
      f.write('sample.bin', Buffer.alloc(bytes, 0x77));
      const beginAt = performance.now();
      const value = acceptance(await peer.submit(peer.begin()));
      return { f, peer, value, beginAt, acceptedAt: performance.now() };
    };
    const total = await setup(10485760);
    const idle = await setup(1);
    const progress = await setup(65536);
    const other = await idle.f.client({ freshKey: true });
    const profiles = [
      (async () => {
        let seq = 0;
        let bytes = 0;
        for (let tick = 0; tick < 15; tick++) {
          await sleepUntil(total.beginAt + tick * 20000);
          const response = await total.peer.submit(total.peer.read(total.value, seq++, bytes));
          assert.equal(
            response.type,
            'file_fetch_chunk',
            'valid progress survives idle before total limit',
          );
          if (response.type === 'file_fetch_chunk')
            bytes += Buffer.from(response.data, 'base64url').length;
        }
        await sleepUntil(total.beginAt + 300250);
        const response = await total.peer.submit(total.peer.read(total.value, seq, bytes));
        assert(
          response.type === 'file_fetch_refused' &&
            ['expired', 'unavailable'].includes(response.code),
          'original five-minute deadline never resets',
        );
        clean(total.f);
      })(),
      (async () => {
        for (const tick of [10000, 20000]) {
          await sleepUntil(idle.acceptedAt + tick);
          const refused = await other.submit(other.read(idle.value));
          assert(
            refused.type === 'file_fetch_refused' && refused.code === 'unavailable',
            'wrong-owner traffic never refreshes idle',
          );
        }
        await sleepUntil(idle.acceptedAt + 25000);
        const unknown = await idle.peer.submit(
          idle.peer.read({
            ...idle.value,
            transferId: Buffer.alloc(16, 0xa5).toString('base64url'),
          }),
        );
        assert(
          unknown.type === 'file_fetch_refused' && unknown.code === 'unavailable',
          'unknown traffic never refreshes idle',
        );
        await sleepUntil(idle.acceptedAt + 30250);
        const response = await idle.peer.submit(idle.peer.read(idle.value));
        assert(
          response.type === 'file_fetch_refused' &&
            ['expired', 'unavailable'].includes(response.code),
          'actual30-second no-progress deadline',
        );
        clean(idle.f);
      })(),
      (async () => {
        await sleepUntil(progress.acceptedAt + 20000);
        assert.equal(
          (await progress.peer.submit(progress.peer.read(progress.value))).type,
          'file_fetch_chunk',
        );
        await sleepUntil(progress.acceptedAt + 30250);
        assert.equal(state(progress.f).size, 1, 'valid advancing read refreshes idle');
        await sleepUntil(progress.acceptedAt + 50500);
        const response = await progress.peer.submit(progress.peer.read(progress.value, 1, 32768));
        assert(
          response.type === 'file_fetch_refused' &&
            ['expired', 'unavailable'].includes(response.code),
          'idle expires30seconds after actual progress',
        );
        clean(progress.f);
      })(),
      (async () => {
        while (Date.now() < resumeAtWall) await Bun.sleep(Math.min(100, resumeAtWall - Date.now()));
        signalChild('SIGCONT');
        await until(() => childReaped, 'resumed child reaped', 15000);
        assert.equal(await childExited, 0, await errors);
        assert(fs.existsSync(result), 'paused-preparation result exists');
      })(),
    ];
    await Promise.race([
      Promise.all(profiles),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          reject(new Error('Owned download clock proof deadline'));
        }, 345000);
      }),
    ]);
    measurement = {
      qualified: true,
      bun: Bun.version,
      scope: 'actual dormant core only',
      totalMs: 300000,
      idleMs: 30000,
      paused: JSON.parse(fs.readFileSync(result, 'utf8')),
    };
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(watchdog);
    if (child && !childReaped) {
      signalChild('SIGCONT');
      // Resuming an early-aborted proof lets its actual fixture finally drain resources.
      await Promise.race([childExited, Bun.sleep(10000)]);
      if (!childReaped) signalChild('SIGKILL');
    }
    await childExited;
    for (const f of fixtures) {
      try {
        await f.close();
      } catch (error) {
        failures.push(error);
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  let childGone = !child;
  if (child && childReaped) {
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      childGone = true;
    }
  }
  const allClean =
    fixtures.every((f) => !fs.existsSync(f.files.directory)) &&
    launchers.every((path) => !fs.existsSync(path)) &&
    (!childDirectory || !fs.existsSync(childDirectory)) &&
    (!childLauncher || !fs.existsSync(childLauncher)) &&
    childReaped &&
    childGone &&
    !fs.existsSync(directory);
  console.log(
    JSON.stringify({
      clockCleanup: true,
      allClean,
      fixtures: fixtures.length,
      childReaped,
      childGone,
    }),
  );
  if (!allClean) failures.push(new Error('Owned clock resources remain'));
  if (failures.length) throw new AggregateError(failures, 'Owned download clock proof failed');
  console.log(JSON.stringify(measurement));
}
const pausedAt = process.argv.indexOf('--paused');
const faultAt = process.argv.indexOf('--cleanup-fault');
if (pausedAt >= 0) {
  const checkpoint = process.argv[pausedAt + 1];
  const result = process.argv[pausedAt + 2];
  assert(checkpoint && result);
  await paused(checkpoint, result);
} else if (faultAt >= 0) {
  const receipt = process.argv[faultAt + 1];
  assert(receipt);
  await cleanupFault(receipt);
} else {
  assert(process.argv.length <= 2, 'explicit clock host arguments');
  console.log(
    JSON.stringify({
      clockHost: true,
      bun: Bun.version,
      compiled: Bun.main.startsWith('/$bunfs/'),
      platform: process.platform,
      arch: process.arch,
    }),
  );
  await clocks();
}
