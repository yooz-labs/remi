import { expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createImageDecoder, imageWorkerCommand } from '../../src/tunnel/image-worker-command';

const entry = resolve(import.meta.dir, '../../src/entry.ts');
const fixtures = resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof');
const metadata = JSON.parse(readFileSync(resolve(fixtures, 'inputs.json'), 'utf8')) as {
  images: Array<{
    filename: string;
    width: number;
    height: number;
    pixelBytes: number;
    pixelSha256: string;
  }>;
};

function run(args: string[], cwd: string, remiHome: string, input = Buffer.alloc(0)) {
  return Bun.spawnSync([process.execPath, '--no-env-file', entry, ...args], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: cwd, REMI_HOME: remiHome, TMPDIR: tmpdir() },
    stdin: input,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

test('source worker dispatch decodes actual PNG/JPEG without loading CLI state', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'remi-image-entry-'));
  const directHome = mkdtempSync(resolve(tmpdir(), 'remi-image-direct-worker-'));
  try {
    for (const [index, media] of (['image/png', 'image/jpeg'] as const).entries()) {
      const expected = metadata.images[index];
      if (!expected) throw new Error('owned image metadata missing');
      const input = readFileSync(resolve(fixtures, expected.filename));
      // Loading remi-home would terminate even before normal help dispatch.
      const child = run(['--internal-image-worker', media], cwd, 'relative-refusal-control', input);
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe('');
      expect(JSON.parse(child.stdout.toString())).toEqual({
        kind: 'decoded',
        width: expected.width,
        height: expected.height,
        pixelBytes: expected.pixelBytes,
        pixelSha256: expected.pixelSha256,
      });
      // Compare against the actual worker body: Bun itself may create HOME/Library caches.
      const worker = resolve(import.meta.dir, '../../src/tunnel/image-worker.ts');
      const direct = Bun.spawnSync(
        [
          process.execPath,
          '--no-env-file',
          '-e',
          `const {decodeWorker}=await import(${JSON.stringify(worker)}); await decodeWorker(${JSON.stringify(media)});`,
        ],
        {
          cwd: directHome,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: directHome,
            REMI_HOME: 'relative-refusal-control',
            TMPDIR: tmpdir(),
          },
          stdin: input,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(direct.exitCode).toBe(0);
      expect(direct.stdout.toString()).toBe(child.stdout.toString());
      expect(direct.stderr.toString()).toBe('');
      expect(readdirSync(cwd)).toEqual(readdirSync(directHome));
      expect(readdirSync(cwd)).not.toContain('.remi');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(directHome, { recursive: true, force: true });
  }
});

test('internal mode refuses exact malformed shapes before imports; normal CLI keeps argv boundaries', () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'remi-image-entry-boundaries-'));
  try {
    for (const args of [
      ['--internal-image-worker'],
      ['--internal-image-worker', 'image/gif'],
      ['--internal-image-worker', 'image/png', '--help'],
      ['--internal-image-worker', '--repeat-decode', 'image/jpeg'],
      ['--internal-image-worker', 'image/png', '--'],
    ]) {
      const child = run(args, cwd, 'relative-refusal-control');
      expect(child.exitCode).toBe(1);
      expect(child.stdout.toString()).toBe('{"kind":"refused"}\n');
      expect(child.stderr.toString()).toBe('');
    }
    const cliControl = run(['--help'], cwd, 'relative-refusal-control');
    expect(cliControl.exitCode).toBe(1);
    expect(cliControl.stderr.toString()).toContain('REMI_HOME must be an absolute path');
    for (const args of [
      ['--help'],
      ['--help', '--', '--internal-image-worker', 'image/png'],
      ['--help', '--internal-image-worker', 'image/jpeg'],
    ]) {
      const child = run(args, cwd, resolve(cwd, 'state'));
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toContain('remi');
      expect(child.stdout.toString()).not.toContain('{"kind":');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('fixed factory requires an owned private empty cwd and performs actual child decoding', async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), 'remi-image-factory-'));
  try {
    expect(imageWorkerCommand()).toEqual([
      process.execPath,
      '--no-env-file',
      entry,
      '--internal-image-worker',
    ]);
    expect(() => createImageDecoder('relative')).toThrow('IMAGE_WORKER_CWD');
    const publicDir = resolve(cwd, 'public');
    mkdirSync(publicDir, { mode: 0o755 });
    expect(() => createImageDecoder(publicDir)).toThrow('IMAGE_WORKER_CWD');
    const occupied = resolve(cwd, 'occupied');
    mkdirSync(occupied, { mode: 0o700 });
    copyFileSync(resolve(fixtures, 'fixture.png'), resolve(occupied, 'input.png'));
    expect(() => createImageDecoder(occupied)).toThrow('IMAGE_WORKER_CWD');
    const privateDir = resolve(cwd, 'private');
    mkdirSync(privateDir, { mode: 0o700 });
    const alias = resolve(cwd, 'alias');
    symlinkSync(privateDir, alias);
    expect(() => createImageDecoder(alias)).toThrow('IMAGE_WORKER_CWD');
    const decoder = createImageDecoder(privateDir);
    const expected = metadata.images[0];
    if (!expected) throw new Error('owned PNG metadata missing');
    const result = await decoder.decode(
      readFileSync(resolve(fixtures, expected.filename)),
      'image/png',
    );
    expect(result.pixelSha256).toBe(expected.pixelSha256);
    expect(decoder.lastChildExit?.pid).toBe(decoder.lastChildPID);
    expect(decoder.lastChildExit?.exitCode).toBe(0);
    expect(decoder.lastChildExit?.signalCode).toBeNull();
    expect(readdirSync(privateDir)).toEqual([]);
    // An owned source-runtime positive demonstrates that dotenv is observable.
    const parentDir = resolve(cwd, 'parent-config');
    mkdirSync(parentDir, { mode: 0o700 });
    writeFileSync(resolve(parentDir, '.env'), 'REMI_ENTRY_OWNED_SENTINEL=owned\n');
    writeFileSync(
      resolve(parentDir, 'observe.ts'),
      "console.log(process.env['REMI_ENTRY_OWNED_SENTINEL'] === 'owned');\n",
    );
    const env = { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: tmpdir() };
    const positive = Bun.spawnSync([process.execPath, resolve(parentDir, 'observe.ts')], {
      cwd: parentDir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(positive.exitCode).toBe(0);
    expect(positive.stdout.toString()).toBe('true\n');
    const isolated = Bun.spawnSync(
      [process.execPath, '--no-env-file', resolve(parentDir, 'observe.ts')],
      { cwd: privateDir, env, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(isolated.exitCode).toBe(0);
    expect(isolated.stdout.toString()).toBe('false\n');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
