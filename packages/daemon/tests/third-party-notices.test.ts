/**
 * Third-party notices for what the `remi` binary bundles (#1131).
 *
 * The compiled binary bundles MIT and BSD-licensed packages whose licenses
 * require their notice to travel with redistributed copies. The notices are
 * generated from the bundle's real inputs (`bun build --metafile`), never a
 * hand-kept list, and generation fails when a bundled package has no license
 * file. These tests run the real generator over real bundles.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledPackages,
  packageRootOf,
  renderNotices,
} from '../../../scripts/third-party-notices.ts';

const repoRoot = join(import.meta.dir, '../../..');
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** The packages a real bundle of `entry` pulls from node_modules, computed here independently. */
function metafilePackages(entry: string, cwd: string): Map<string, string> {
  const out = mkdtempSync(join(tmpdir(), 'remi-notices-meta-'));
  temps.push(out);
  const proc = Bun.spawnSync(
    [
      process.execPath,
      'build',
      entry,
      '--target=bun',
      `--outdir=${join(out, 'out')}`,
      `--metafile=${join(out, 'meta.json')}`,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(proc.exitCode).toBe(0);
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) as {
    inputs: Record<string, unknown>;
  };
  const roots = new Map<string, string>();
  for (const input of Object.keys(meta.inputs)) {
    const at = input.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const rest = input.slice(at + 'node_modules/'.length).split('/');
    const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : (rest[0] ?? '');
    roots.set(name, join(cwd, input.slice(0, at + 'node_modules/'.length) + name));
  }
  return roots;
}

describe('third-party notices (#1131)', () => {
  test('every package the daemon bundle includes is listed with its version and full license text', async () => {
    const entry = 'packages/daemon/src/cli.ts';
    const expected = metafilePackages(entry, repoRoot);
    expect(expected.size).toBeGreaterThan(0);

    const notices = renderNotices(await bundledPackages(entry, repoRoot), '0.0.0-test');

    for (const [name, root] of expected) {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        version: string;
      };
      expect(notices).toContain(`${name}@${pkg.version}`);
      const licenseFile = readdirSync(root).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      expect(licenseFile).toBeDefined();
      const text = readFileSync(join(root, licenseFile as string), 'utf8').trim();
      expect(notices).toContain(text);
    }
  });

  test('a package root is found inside the Bun store and for scoped names', () => {
    expect(
      packageRootOf(
        'node_modules/.bun/@grammyjs+types@3.23.0/node_modules/@grammyjs/types/out/x.js',
      ),
    ).toEqual({
      name: '@grammyjs/types',
      root: 'node_modules/.bun/@grammyjs+types@3.23.0/node_modules/@grammyjs/types',
    });
    expect(packageRootOf('node_modules/ms/index.js')).toEqual({
      name: 'ms',
      root: 'node_modules/ms',
    });
    expect(packageRootOf('packages/daemon/src/cli.ts')).toBeNull();
  });

  test('a bundled package with no license file fails generation and is named', async () => {
    const project = mkdtempSync(join(tmpdir(), 'remi-notices-nolicense-'));
    temps.push(project);
    const pkg = join(project, 'node_modules', 'unlicensed-dep');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'unlicensed-dep', version: '1.2.3', main: 'index.js' }),
    );
    writeFileSync(join(pkg, 'index.js'), 'module.exports = 42;\n');
    writeFileSync(
      join(project, 'entry.js'),
      "const x = require('unlicensed-dep'); console.log(x);\n",
    );

    await expect(bundledPackages('entry.js', project)).rejects.toThrow('unlicensed-dep@1.2.3');
  });
});
