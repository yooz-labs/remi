/** Exact upstream source fixtures for the terminal engine characterization and reproducible build. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import manifest from './manifest.json';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sourceHashes: Readonly<Record<string, string>> = manifest.sources;

export function headlessPackageRoot(): string {
  const daemon = resolve(import.meta.dir, '../../packages/daemon');
  return resolve(dirname(Bun.resolveSync('@xterm/headless', daemon)), '..');
}

export function prepareOriginalEngine(destination: string): string {
  const packageRoot = headlessPackageRoot();
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert(pkg.name === manifest.name && pkg.version === manifest.version, 'pinned engine package');
  const raw = readFileSync(join(packageRoot, 'lib-headless/xterm-headless.mjs.map'));
  assert.equal(sha256(raw), manifest.mapSha256, 'pinned engine source map');
  const map = JSON.parse(raw.toString('utf8')) as { sources: string[]; sourcesContent: string[] };
  assert.equal(map.sources.length, map.sourcesContent.length);
  const seen = new Set<string>();
  const write = (relative: string, text: string | Uint8Array) => {
    assert(relative.startsWith('src/') && !relative.split('/').includes('..'));
    assert(!seen.has(relative), 'one exact engine source per path');
    seen.add(relative);
    const path = join(destination, relative);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  };
  for (let index = 0; index < map.sources.length; index++) {
    const name = map.sources[index];
    const text = map.sourcesContent[index];
    assert(typeof name === 'string' && typeof text === 'string');
    const at = name.indexOf('/src/');
    assert(at >= 0);
    const relative = name.slice(at + 1);
    assert.equal(sha256(text), sourceHashes[relative], 'exact upstream engine source');
    write(relative, text);
  }
  assert.equal(seen.size, Object.keys(sourceHashes).length);
  // Const-enum/type-only modules are absent from the published map after tree shaking.
  for (const entry of manifest.supplemental) {
    const bytes = readFileSync(join(import.meta.dir, 'upstream', entry.fixture));
    assert.equal(sha256(bytes), entry.sha256, 'exact supplementary upstream source');
    write(entry.path, bytes);
  }
  writeFileSync(
    join(destination, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2020', experimentalDecorators: true, useDefineForClassFields: false, baseUrl: './src', paths: { 'common/*': ['common/*'], 'headless/*': ['headless/*'], 'vs/*': ['vs/*'] } } }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return packageRoot;
}

export function writeOriginalBufferTests(destination: string): string {
  const source = readFileSync(join(import.meta.dir, 'upstream/BufferLine.test.ts.txt'), 'utf8');
  assert.equal(sha256(source), manifest.testSha256, 'exact upstream buffer characterization');
  const chai = "import { assert } from 'chai';";
  assert.equal(source.split(chai).length, 2);
  const adapted = source.replace(
    chai,
    "import assert from 'node:assert/strict';\nimport { describe, test as it } from 'bun:test';",
  );
  const file = join(destination, 'src/common/buffer/BufferLine.test.ts');
  writeFileSync(file, adapted, { flag: 'wx', mode: 0o600 });
  return file;
}
