import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import inputs from './inputs.json';
import { DecoderProcess, DecoderProcessError, MAX_RESULT_BYTES } from './process';
import { decodeInput, decodeWorker } from './worker';

const executable = () =>
  Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];

/** Faults are real owned OS children, never substituted decoder or approval results. */
export async function dispatchProcessWorker(): Promise<void> {
  if (process.argv.includes('--owned-decode-worker')) {
    await decodeWorker(process.argv.at(-1));
    process.exit(process.exitCode ?? 0);
  }
  const index = process.argv.indexOf('--owned-process-child');
  if (index < 0) return;
  const mode = process.argv[index + 1];
  const marker = process.argv[index + 2];
  if (!marker) throw new Error('owned child marker missing');
  if (process.env['REMI_PUSH_SECRET'] || process.env['REMI_PASSPHRASE']) process.exit(9);
  if (existsSync(marker)) {
    await decodeWorker(process.argv.at(-1));
    process.exit(process.exitCode ?? 0);
  }
  if (mode !== 'busy' && mode !== 'result-hold') await Bun.write(marker, 'ready');
  if (mode === 'overflow') {
    await Bun.write(Bun.stdout, 'x'.repeat(MAX_RESULT_BYTES + 1));
    while (true) {
      /* An overflow that never exits must be killed before the deadline. */
    }
  } else if (mode === 'invalid') {
    await Bun.write(Bun.stdout, 'not JSON');
  } else if (mode === 'duplicate') {
    await decodeWorker(process.argv.at(-1));
    await Bun.write(Bun.stdout, '{"kind":"refused"}\n');
  } else if (mode === 'extra' || mode === 'dimensions' || mode === 'hash') {
    const result = await decodeInput(process.argv.at(-1));
    const changed =
      mode === 'extra'
        ? { ...result, unexpected: true }
        : mode === 'dimensions'
          ? { ...result, width: result.width + 1 }
          : { ...result, pixelSha256: 'invalid' };
    await Bun.write(Bun.stdout, JSON.stringify(changed));
  } else if (mode === 'crash') {
    process.exit(7);
  } else if (mode === 'busy' || mode === 'result-hold') {
    if (mode === 'result-hold') await decodeWorker(process.argv.at(-1));
    await Bun.write(marker, 'ready');
    while (true) {
      /* Real CPU work until the parent kills this owned child. */
    }
  } else {
    process.exit(8);
  }
  process.exit(process.exitCode ?? 0);
}

function noChild(pid: number | undefined, witness: string): void {
  assert(pid !== undefined, 'actual child PID recorded');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, witness);
}

export async function processProof(png: Buffer, jpg: Buffer): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), 'remi-decoder-process-'));
  const checks: string[] = [];
  const manager = new DecoderProcess([...executable(), '--owned-decode-worker']);
  const expected = (index: number) => {
    const image = inputs.images[index];
    assert(image, 'owned worker pixel metadata');
    return {
      width: image.width,
      height: image.height,
      pixelBytes: image.pixelBytes,
      pixelSha256: image.pixelSha256,
    };
  };
  async function recovered(current: DecoderProcess): Promise<void> {
    assert.deepEqual(await current.decode(png, 'image/png'), expected(0), 'same slot recovers');
    noChild(current.lastChildPID, 'recovered child reaped');
  }
  const deadline = () => performance.now() + 2000;
  async function ready(marker: string): Promise<void> {
    const end = deadline();
    while (!existsSync(marker) && performance.now() < end) await Bun.sleep(5);
    assert(existsSync(marker), 'actual child reached CPU/result boundary');
  }
  async function refusal(
    task: Promise<unknown>,
    code: DecoderProcessError['code'],
    witness: string,
  ): Promise<void> {
    await assert.rejects(task, (error: unknown) => {
      assert(error instanceof DecoderProcessError, witness);
      assert.equal(error.code, code, witness);
      return true;
    });
  }
  const control = (mode: string) => {
    const marker = join(root, `${mode}-${crypto.randomUUID()}`);
    return {
      marker,
      manager: new DecoderProcess([...executable(), '--owned-process-child', mode, marker]),
    };
  };
  try {
    for (const [index, [bytes, kind]] of (
      [
        [png, 'image/png'],
        [jpg, 'image/jpeg'],
      ] as const
    ).entries()) {
      const result = await manager.decode(bytes, kind);
      assert.deepEqual(result, expected(index), 'actual worker exact decoded pixels');
      noChild(manager.lastChildPID, 'successful decode reaped');
    }
    const crc = Buffer.from(png);
    crc[29] ^= 1;
    await refusal(manager.decode(crc, 'image/png'), 'refused', 'real decoder refusal');
    noChild(manager.lastChildPID, 'refused decoder reaped');
    await recovered(manager);
    const controller = new AbortController();
    controller.abort();
    const neverStarted = new DecoderProcess([...executable(), '--owned-decode-worker']);
    await refusal(
      neverStarted.decode(png, 'image/png', { signal: controller.signal }),
      'cancelled',
      'pre-cancelled operation refused',
    );
    assert.equal(neverStarted.lastChildPID, undefined, 'pre-cancel spawns nothing');
    checks.push('owned decoder success refusal and pre-cancel cleanup');

    // Emulated cold startup can consume 300 ms; keep that lifetime check as well.
    const cold = control('busy');
    const coldStart = performance.now();
    await refusal(
      cold.manager.decode(png, 'image/png', { milliseconds: 300 }),
      'expired',
      'cold child lifetime deadline',
    );
    assert(performance.now() - coldStart < 2000, 'cold deadline reaps within two seconds');
    noChild(cold.manager.lastChildPID, 'cold deadline child reaped');
    const timed = control('busy');
    const start = performance.now();
    const expired = refusal(
      timed.manager.decode(png, 'image/png', { milliseconds: 1000 }),
      'expired',
      'busy child deadline',
    );
    await ready(timed.marker);
    await expired;
    assert(performance.now() - start < 2000, 'deadline reaps child within two seconds');
    noChild(timed.manager.lastChildPID, 'expired child reaped');
    await recovered(timed.manager);
    checks.push('actual busy child deadline and reap');

    const cancelled = control('busy');
    const cancel = new AbortController();
    const stopped = refusal(
      cancelled.manager.decode(png, 'image/png', { signal: cancel.signal }),
      'cancelled',
      'explicit cancellation',
    );
    await ready(cancelled.marker);
    const pid = cancelled.manager.lastChildPID;
    await refusal(cancelled.manager.decode(png, 'image/png'), 'busy', 'saturation refused');
    assert.equal(cancelled.manager.lastChildPID, pid, 'saturation does not spawn another child');
    const cancelAt = performance.now();
    cancel.abort();
    await stopped;
    assert(performance.now() - cancelAt < 2000, 'cancellation reaps within two seconds');
    noChild(pid, 'cancelled child reaped');
    await recovered(cancelled.manager);
    checks.push('actual cancellation saturation and reap');

    for (const mode of [
      'overflow',
      'invalid',
      'duplicate',
      'extra',
      'dimensions',
      'hash',
      'crash',
    ]) {
      const fault = control(mode);
      await refusal(
        fault.manager.decode(png, 'image/png'),
        mode === 'crash' ? 'failed' : 'protocol',
        'actual child output or exit refusal',
      );
      noChild(fault.manager.lastChildPID, 'failed output child reaped');
      await recovered(fault.manager);
    }
    checks.push('bounded output malformed duplicate and crash refusal');

    const racing = control('result-hold');
    const raceCancel = new AbortController();
    const discarded = refusal(
      racing.manager.decode(png, 'image/png', { signal: raceCancel.signal }),
      'cancelled',
      'cancelled unpublished result discarded',
    );
    await ready(racing.marker);
    raceCancel.abort();
    await discarded;
    noChild(racing.manager.lastChildPID, 'result race child reaped');
    await recovered(racing.manager);
    checks.push('actual result cancellation and subsequent decode');
    return checks;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
