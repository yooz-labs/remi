/** Rebuild the pinned headless engine with lazy attribute planes; never fetches code. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import manifest from './manifest.json';
import { headlessPackageRoot, prepareOriginalEngine } from './source';

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const derivedFiles = [
  'lib-headless/remi-headless.cjs',
  'lib-headless/remi-headless.cjs.map',
  'lib-headless/remi-headless.json',
] as const;

export function applyLazyAttributes(source: string): void {
  const file = join(source, 'src/common/buffer/BufferLine.ts');
  assert.equal(sha256(readFileSync(file)), manifest.sources['src/common/buffer/BufferLine.ts']);
  const patch = join(import.meta.dir, 'lazy-attributes.patch');
  assert.equal(sha256(readFileSync(patch)), manifest.patchSha256, 'pinned storage patch');
  const original = readFileSync(file, 'utf8').split('\n');
  const diff = readFileSync(patch, 'utf8').split('\n');
  assert.equal(diff.shift(), '--- upstream6/BufferLine.ts');
  assert.equal(diff.shift(), '+++ lazy/BufferLine.ts');
  const output: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < diff.length) {
    const line = diff[index++];
    if (line === '' && index === diff.length) break;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line ?? '');
    assert(hunk, 'one exact buffer source patch');
    const start = Math.max(0, Number(hunk[1]) - 1);
    assert(start >= cursor && start <= original.length);
    output.push(...original.slice(cursor, start));
    cursor = start;
    let removed = 0;
    let added = 0;
    while (index < diff.length && !diff[index]?.startsWith('@@ ')) {
      const value = diff[index++];
      if (value === '' && index === diff.length) break;
      assert(value && [' ', '-', '+'].includes(value[0] ?? ''));
      if (value[0] !== '+') {
        assert.equal(original[cursor++], value.slice(1), 'exact upstream patch context');
        removed++;
      }
      if (value[0] !== '-') {
        output.push(value.slice(1));
        added++;
      }
    }
    assert.equal(removed, Number(hunk[2] ?? 1));
    assert.equal(added, Number(hunk[4] ?? 1));
  }
  output.push(...original.slice(cursor));
  const patched = output.join('\n');
  assert.equal(sha256(patched), manifest.patchedBufferLineSha256);
  writeFileSync(file, patched);
  assert.equal(sha256(readFileSync(file)), manifest.patchedBufferLineSha256);
}

export async function buildDerivedEngine(destination: string): Promise<void> {
  assert.equal(esbuild.version, '0.27.0', 'pinned engine compiler');
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'remi-engine-build-')));
  try {
    const packageRoot = prepareOriginalEngine(source);
    applyLazyAttributes(source);
    const published = readFileSync(join(packageRoot, 'lib-headless/xterm-headless.mjs'), 'utf8');
    assert.equal(sha256(published), manifest.publishedMjsSha256);
    const banner = published.match(/^(?:\s*\/\*[\s\S]*?\*\/\s*)+/)?.[0];
    assert(
      typeof banner === 'string' && banner.includes('@license MIT'),
      'preserve published copyright banners',
    );
    const output = join(destination, derivedFiles[0]);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    const result = await esbuild.build({
      absWorkingDir: source,
      entryPoints: ['src/headless/public/Terminal.ts'],
      outfile: output,
      tsconfig: join(source, 'tsconfig.json'),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2020',
      minify: true,
      sourcemap: 'linked',
      metafile: true,
      banner: { js: banner },
      logLevel: 'silent',
    });
    assert(result.metafile);
    const allowed = new Set([
      ...Object.keys(manifest.sources),
      ...manifest.supplemental.map((entry) => entry.path),
    ]);
    const sourceHashes: Readonly<Record<string, string>> = {
      ...manifest.sources,
      ...Object.fromEntries(manifest.supplemental.map((entry) => [entry.path, entry.sha256])),
      'src/common/buffer/BufferLine.ts': manifest.patchedBufferLineSha256,
    };
    for (const input of Object.keys(result.metafile.inputs)) {
      assert(allowed.has(input), 'engine contains only pinned upstream sources');
    }
    assert(Object.values(result.metafile.outputs).every((file) => file.imports.length === 0));
    const mapFile = join(destination, derivedFiles[1]);
    const map = JSON.parse(readFileSync(mapFile, 'utf8')) as {
      sources: string[];
      sourcesContent: string[];
      file?: string;
    };
    assert.equal(map.sources.length, map.sourcesContent.length);
    map.file = basename(output);
    map.sources = map.sources.map((path, index) => {
      const at = path.lastIndexOf('/src/');
      assert(at >= 0, 'canonical engine source path');
      const relative = path.slice(at + 1);
      assert(allowed.has(relative));
      const expected = sourceHashes[relative];
      assert.equal(sha256(map.sourcesContent[index] ?? ''), expected);
      return relative;
    });
    writeFileSync(mapFile, `${JSON.stringify(map)}\n`, { mode: 0o600 });
    const metadata = {
      upstream: { name: manifest.name, version: manifest.version, revision: manifest.revision },
      sourceMapSha256: manifest.mapSha256,
      sourcePatchSha256: manifest.patchSha256,
      patchedBufferLineSha256: manifest.patchedBufferLineSha256,
      compiler: {
        name: 'esbuild',
        version: esbuild.version,
        target: 'es2020',
        format: 'cjs',
        platform: 'node',
      },
      hashes: Object.fromEntries(
        derivedFiles
          .slice(0, 2)
          .map((name) => [name, sha256(readFileSync(join(destination, name)))]),
      ),
    };
    writeFileSync(join(destination, derivedFiles[2]), `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    });
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'remi-engine-output-')));
  try {
    const mode = process.argv[2];
    const directory = process.argv[3];
    assert(
      mode === '--check' || (mode === '--output' && directory),
      'use --check or --output <directory>',
    );
    await buildDerivedEngine(temporary);
    const target = mode === '--check' ? headlessPackageRoot() : resolve(directory ?? '');
    for (const file of derivedFiles) {
      const bytes = readFileSync(join(temporary, file));
      if (mode === '--check')
        assert(bytes.equals(readFileSync(join(target, file))), 'reproducible installed engine');
      else {
        mkdirSync(dirname(join(target, file)), { recursive: true, mode: 0o700 });
        writeFileSync(join(target, file), bytes, { mode: 0o600 });
      }
    }
    console.info(
      mode === '--check' ? 'Terminal engine reproduction passed' : 'Terminal engine generated',
    );
  } finally {
    esbuild.stop();
    rmSync(temporary, { recursive: true, force: true });
  }
}
