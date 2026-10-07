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
  // Keyed by directory: two versions of one package are two entries.
  const roots = new Map<string, string>();
  for (const input of Object.keys(meta.inputs)) {
    const at = input.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const rest = input.slice(at + 'node_modules/'.length).split('/');
    const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : (rest[0] ?? '');
    roots.set(join(cwd, input.slice(0, at + 'node_modules/'.length) + name), name);
  }
  return roots;
}

describe('third-party notices (#1131)', () => {
  test('every package the daemon bundle includes is listed with its version and full license text', async () => {
    const entry = 'packages/daemon/src/cli.ts';
    const expected = metafilePackages(entry, repoRoot);
    expect(expected.size).toBeGreaterThan(0);

    const notices = renderNotices(await bundledPackages(entry, repoRoot), '0.0.0-test');

    for (const [root, name] of expected) {
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

  /** A throwaway project whose entry requires `entryRequires`. */
  function project(
    pkgs: ReadonlyArray<{
      dir: string;
      name: string;
      version: string;
      files: Record<string, string>;
      requires?: string[];
    }>,
    entryRequires: string[],
  ): string {
    const root = mkdtempSync(join(tmpdir(), 'remi-notices-project-'));
    temps.push(root);
    for (const pkg of pkgs) {
      const dir = join(root, pkg.dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: pkg.name, version: pkg.version, main: 'index.js', license: 'MIT' }),
      );
      const body = (pkg.requires ?? []).map((r) => `require('${r}');`).join('\n');
      writeFileSync(
        join(dir, 'index.js'),
        `${body}\nmodule.exports = '${pkg.name}@${pkg.version}';\n`,
      );
      for (const [file, text] of Object.entries(pkg.files)) writeFileSync(join(dir, file), text);
    }
    writeFileSync(
      join(root, 'entry.js'),
      `${entryRequires.map((r) => `console.log(require('${r}'));`).join('\n')}\n`,
    );
    return root;
  }

  test('two versions of one package are both listed (#1255 review)', async () => {
    const root = project(
      [
        {
          dir: 'node_modules/dup',
          name: 'dup',
          version: '1.0.0',
          files: { LICENSE: 'dup one license' },
        },
        {
          dir: 'node_modules/other',
          name: 'other',
          version: '1.0.0',
          files: { LICENSE: 'other license' },
          requires: ['dup'],
        },
        {
          dir: 'node_modules/other/node_modules/dup',
          name: 'dup',
          version: '2.0.0',
          files: { LICENSE: 'dup two license' },
        },
      ],
      ['dup', 'other'],
    );

    const notices = renderNotices(await bundledPackages('entry.js', root), '0.0.0-test');

    expect(notices).toContain('dup@1.0.0');
    expect(notices).toContain('dup@2.0.0');
    expect(notices).toContain('dup one license');
    expect(notices).toContain('dup two license');
  });

  test('every license file and the NOTICE file are reproduced, in name order (#1255 review)', async () => {
    const root = project(
      [
        {
          dir: 'node_modules/dual',
          name: 'dual',
          version: '3.0.0',
          files: {
            'LICENSE-MIT': 'the mit text',
            'LICENSE-APACHE': 'the apache text',
            NOTICE: 'the notice text',
          },
        },
      ],
      ['dual'],
    );

    const notices = renderNotices(await bundledPackages('entry.js', root), '0.0.0-test');

    const apache = notices.indexOf('the apache text');
    const mit = notices.indexOf('the mit text');
    const notice = notices.indexOf('the notice text');
    expect(apache).toBeGreaterThan(0);
    expect(mit).toBeGreaterThan(apache);
    expect(notice).toBeGreaterThan(mit);
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

describe('the notices ship with every package and release (#1131)', () => {
  const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

  test('every npm package lists LICENSE, NOTICE and THIRD_PARTY_NOTICES in its files', () => {
    const packages = readdirSync(join(repoRoot, 'npm'));
    expect(packages.length).toBeGreaterThan(0);
    for (const dir of packages) {
      const pkg = JSON.parse(read(`npm/${dir}/package.json`)) as { files: string[] };
      for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']) {
        expect(pkg.files).toContain(file);
      }
    }
  });

  test('the release generates them, copies them into the packages and attaches them to the release', () => {
    const release = read('.github/workflows/release.yml');
    // Once for the GitHub release, once for the npm packages.
    expect(release.split('bun scripts/third-party-notices.ts --out')).toHaveLength(3);
    expect(release).toContain('cp THIRD_PARTY_NOTICES "npm/remi-$PLAT/THIRD_PARTY_NOTICES"');
    expect(release).toContain('cp THIRD_PARTY_NOTICES npm/remi/THIRD_PARTY_NOTICES');
    expect(release).toMatch(/files: \|[\s\S]*\n\s+THIRD_PARTY_NOTICES\n/);
  });

  test('CI checks every bundled package has a license file, and the formula installs the notices', () => {
    const ci = read('.github/workflows/ci.yml');
    const typecheckJob = ci.slice(ci.indexOf('    name: Type Check'), ci.indexOf('    name: Test'));
    expect(typecheckJob).toContain('      - run: bun scripts/third-party-notices.ts --check');
    expect(read('scripts/update-homebrew.sh')).toContain(
      'doc.install Dir[\\"LICENSE\\", \\"NOTICE\\", \\"THIRD_PARTY_NOTICES\\"]',
    );
  });
});
