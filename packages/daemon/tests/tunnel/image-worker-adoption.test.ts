import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import inputs from '../../../../scripts/tunnel-decoder-proof/inputs.json';
import * as proofProcess from '../../../../scripts/tunnel-decoder-proof/process';
import * as proofWorker from '../../../../scripts/tunnel-decoder-proof/worker';
import {
  type DecodedPixels,
  type DecoderChildExit,
  DecoderProcess,
  DecoderProcessError,
  MAX_RESULT_BYTES,
  type RepeatedDecodeReady,
} from '../../src/tunnel/image-process';
import { decodeInput, decodeRepeatedWorker, decodeWorker } from '../../src/tunnel/image-worker';

const fixture = (name: string) =>
  fs.readFileSync(path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof', name));
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

function exited(controller: DecoderProcess, code: number | null, signal: string | null) {
  const observed: DecoderChildExit | undefined = controller.lastChildExit;
  expect(observed).toBeDefined();
  if (!observed) throw new Error('owned decoder child exit metadata missing');
  const proofObserved: proofProcess.DecoderChildExit = observed;
  const pid = controller.lastChildPID;
  if (pid === undefined) throw new Error('owned decoder child PID missing');
  expect(proofObserved.pid).toBe(pid);
  expect(proofObserved.exitCode).toBe(code);
  expect(proofObserved.signalCode).toBe(signal);
  expect(Object.isFrozen(proofObserved)).toBe(true);
  assert.throws(() => process.kill(proofObserved.pid, 0), { code: 'ESRCH' });
}

test('proof adapters share daemon controller and worker with actual owned child round trips', async () => {
  expect(proofProcess.DecoderProcess).toBe(DecoderProcess);
  expect(proofProcess.DecoderProcessError).toBe(DecoderProcessError);
  expect(proofProcess.MAX_RESULT_BYTES).toBe(MAX_RESULT_BYTES);
  expect(MAX_RESULT_BYTES).toBe(4096);
  expect(proofWorker.decodeInput).toBe(decodeInput);
  expect(proofWorker.decodeRepeatedWorker).toBe(decodeRepeatedWorker);
  expect(proofWorker.decodeWorker).toBe(decodeWorker);
  const policyKeys = ['BUN_JSC_useJIT', 'BUN_JSC_useBaselineJIT', 'REMI_DECODER_POLICY_SENTINEL'];
  const parentPolicy = policyKeys.map((key) => process.env[key]);
  const home = fs.mkdtempSync(path.join(tmpdir(), 'remi-image-worker-adoption-'));
  const entry = path.join(home, 'entry.ts');
  const worker = path.resolve(import.meta.dir, '../../src/tunnel/image-worker.ts');
  const code = [
    "import assert from 'node:assert/strict';",
    `import { decodeRepeatedWorker, decodeWorker } from ${JSON.stringify(worker)};`,
    "assert.equal(process.env['BUN_JSC_useJIT'], '0');",
    "assert(Object.keys(process.env).filter(key => key.startsWith('BUN_JSC_')).every(key => key === 'BUN_JSC_useJIT'));",
    "assert.equal(process.env['REMI_DECODER_POLICY_SENTINEL'], undefined);",
    "if (process.argv.includes('--repeat-decode')) await decodeRepeatedWorker(process.argv.at(-1));",
    'else await decodeWorker(process.argv.at(-1));',
  ].join('\n');
  const controller = new DecoderProcess([process.execPath, '--no-env-file', entry]);
  let cancellation: AbortController | undefined;
  let repeated: Promise<{ kind: 'completed' } | { kind: 'refused'; error: unknown }> | undefined;
  try {
    fs.chmodSync(home, 0o700);
    fs.writeFileSync(entry, `${code}\n`, { flag: 'wx', mode: 0o600 });
    for (const [index, mediaType] of (['image/png', 'image/jpeg'] as const).entries()) {
      const expected = inputs.images[index];
      if (!expected) throw new Error('owned image fixture metadata missing');
      const bytes = fixture(expected.filename);
      expect(sha256(bytes)).toBe(expected.inputSha256);
      const ownedInput = Buffer.from(bytes);
      const pending = controller.decode(ownedInput, mediaType);
      ownedInput.fill(0);
      const result: DecodedPixels = await pending;
      const proofResult: proofProcess.DecodedPixels = result;
      expect(proofResult).toEqual({
        width: expected.width,
        height: expected.height,
        pixelBytes: expected.pixelBytes,
        pixelSha256: expected.pixelSha256,
      });
      exited(controller, 0, null);
    }
    const png = fixture('fixture.png');
    const crc = png[29];
    if (crc === undefined) throw new Error('owned PNG CRC byte missing');
    const corrupt = Buffer.from(png);
    corrupt[29] = crc ^ 1;
    await expect(controller.decode(corrupt, 'image/png')).rejects.toMatchObject({
      code: 'refused',
    });
    exited(controller, 1, null);
    cancellation = new AbortController();
    let ready: RepeatedDecodeReady | undefined;
    repeated = controller
      .decodeRepeated(fixture('fixture.jpg'), 'image/jpeg', {
        signal: cancellation.signal,
        onReady(result) {
          ready = result;
          cancellation?.abort();
        },
      })
      .then(
        () => ({ kind: 'completed' as const }),
        (error: unknown) => ({ kind: 'refused' as const, error }),
      );
    await expect(controller.decode(png, 'image/png')).rejects.toMatchObject({ code: 'busy' });
    const outcome = await repeated;
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused')
      throw new Error('owned repeated decoder unexpectedly completed');
    expect(outcome.error).toBeInstanceOf(DecoderProcessError);
    expect(outcome.error).toMatchObject({ code: 'cancelled' });
    const proofReady: proofProcess.RepeatedDecodeReady | undefined = ready;
    const jpeg = inputs.images[1];
    if (!jpeg) throw new Error('owned JPEG fixture metadata missing');
    expect(proofReady).toEqual({
      decodes: 2,
      width: jpeg.width,
      height: jpeg.height,
      pixelBytes: jpeg.pixelBytes,
      pixelSha256: jpeg.pixelSha256,
    });
    exited(controller, null, 'SIGKILL');
    const recovered = await controller.decode(png, 'image/png');
    const expectedPNG = inputs.images[0];
    if (!expectedPNG) throw new Error('owned PNG fixture metadata missing');
    expect(recovered.pixelSha256).toBe(expectedPNG.pixelSha256);
    exited(controller, 0, null);
    expect(policyKeys.map((key) => process.env[key])).toEqual(parentPolicy);
  } finally {
    cancellation?.abort();
    if (repeated) await repeated;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
