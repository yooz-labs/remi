/**
 * License boundary guard (#1128, epic #1123, owner decision D8).
 *
 * `packages/daemon` and `packages/shared` are Apache-2.0 and ship in the
 * published `remi` binary. `packages/web`, `packages/signaling` and
 * `packages/macos` are PolyForm Shield 1.0.0. Code from the PolyForm packages
 * must therefore never be pulled into the Apache packages, or the compiled
 * binary would carry PolyForm code under an Apache-2.0 label.
 *
 * This test walks every TypeScript file under `packages/daemon/src` and
 * `packages/shared/src`, parses it with the TypeScript compiler (so comments
 * and string literals can never match), and fails if any module specifier
 * resolves into one of the PolyForm packages. Specifier forms covered:
 * `import ... from`, bare `import 'x'`, `export ... from`, `import x =
 * require('x')`, `require('x')`, `require.resolve('x')`, `import('x')` and
 * the type-position `import('x').T`. Specifiers are matched either by package
 * name (`@remi/web` and friends, including subpaths) or by resolving the path
 * (relative, absolute, or `packages/<name>/...`) against the repository.
 *
 * Known limit: a specifier computed at runtime (a variable or a template with
 * substitutions) cannot be resolved statically and is not checked, and neither
 * is a path built by hand for `fs` or `new URL(..., import.meta.url)`. The
 * `@remi/*` workspace names are the only way these packages are linked by the
 * toolchain, and that route is covered.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { moduleSpecifiers } from './helpers/module-specifiers.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/** Apache-2.0 packages whose sources are scanned. */
const SCANNED_DIRS = [
  join(PACKAGES_DIR, 'daemon', 'src'),
  join(PACKAGES_DIR, 'shared', 'src'),
] as const;

/** PolyForm Shield packages that the scanned sources must not reach. */
const PROTECTED_NAMES = ['web', 'signaling', 'macos'] as const;
const PROTECTED_DIRS = PROTECTED_NAMES.map((name) => join(PACKAGES_DIR, name));

const PROTECTED_ALT = PROTECTED_NAMES.join('|');
const WORKSPACE_NAME = new RegExp(`^@remi/(${PROTECTED_ALT})(/|$)`);
const REPO_RELATIVE_NAME = new RegExp(`^packages/(${PROTECTED_ALT})(/|$)`);

function insideDir(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Why `specifier`, written in `fromFile`, reaches a PolyForm package; null if it does not. */
function boundaryViolation(specifier: string, fromFile: string): string | null {
  if (WORKSPACE_NAME.test(specifier) || REPO_RELATIVE_NAME.test(specifier)) {
    return `names a PolyForm package: ${specifier}`;
  }
  let target: string | null = null;
  if (specifier.startsWith('.')) target = resolve(dirname(fromFile), specifier);
  else if (isAbsolute(specifier)) target = specifier;
  if (target === null) return null;
  const hit = PROTECTED_DIRS.find((dir) => insideDir(dir, target));
  return hit ? `resolves into ${relative(REPO_ROOT, hit)}: ${specifier}` : null;
}

function violationsIn(fileName: string, source: string): string[] {
  const out: string[] = [];
  for (const { text } of moduleSpecifiers(fileName, source, { requireResolve: true })) {
    const why = boundaryViolation(text, fileName);
    if (why) out.push(why);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((entry) => /\.(ts|tsx|mts|cts)$/.test(entry))
    .map((entry) => join(dir, entry));
}

describe('license boundary detector (parses real import syntax only)', () => {
  const FROM = join(PACKAGES_DIR, 'daemon', 'src', 'sub', 'file.ts');

  test('flags every import form that reaches a PolyForm package', () => {
    const cases: Record<string, string> = {
      'static import by workspace name': `import { x } from '@remi/web';`,
      'workspace subpath': `import { x } from '@remi/signaling/src/index';`,
      'macos by name': `import x from '@remi/macos';`,
      'bare side-effect import': `import '@remi/web/src/styles';`,
      'type-only import': `import type { T } from '@remi/web';`,
      'export from': `export * from '@remi/signaling';`,
      'named export from': `export { y } from '../../../web/src/lib/y';`,
      'import-equals require': `import w = require('@remi/web');`,
      'require call': `const w = require('../../../signaling/src/index');`,
      'require.resolve': `const p = require.resolve('@remi/web');`,
      'dynamic import': `const m = await import('@remi/web');`,
      'dynamic import, template without substitution': 'const m = await import(`@remi/web`);',
      'type-position import': `type T = import('@remi/web').Foo;`,
      'relative path into web': `import { z } from '../../../web/src/z';`,
      'relative path to the package directory itself': `import z from '../../../macos';`,
      'repo-relative path': `import z from 'packages/web/src/z';`,
      'absolute path': `import z from '${join(PACKAGES_DIR, 'signaling', 'src', 'index')}';`,
    };
    for (const [name, source] of Object.entries(cases)) {
      expect(violationsIn(FROM, source), name).toHaveLength(1);
    }
  });

  test('does not flag comments, string literals, or legitimate imports', () => {
    const source = [
      `// import { x } from '@remi/web';`,
      `/* const w = require('@remi/signaling'); */`,
      '/** Mirrors packages/web/src/lib/question-merge.ts (see ../../../web/src/lib). */',
      `const note = "import x from '@remi/web'";`,
      'const tpl = `await import("@remi/macos")`;',
      `const path = '../../../web/src/lib/question-merge.ts';`,
      `const label = '@remi/web';`,
      `import { a } from '@remi/shared';`,
      `import { b } from '@remi/shared/protocol';`,
      `import { c } from './sibling';`,
      `import { d } from '../other/place';`,
      `import { e } from 'node:fs';`,
      `import grammy from 'grammy';`,
      `import { f } from '../../../shared/src/types';`,
      `export { g } from '@remi/daemon';`,
      `const h = await import('./lazy');`,
      `const i = require('smol-toml');`,
    ].join('\n');
    expect(violationsIn(FROM, source)).toEqual([]);
  });

  test('does not flag a sibling directory that only shares a prefix with a PolyForm package', () => {
    expect(violationsIn(FROM, `import x from '../../../webhooks/src/x';`)).toEqual([]);
    expect(violationsIn(FROM, `import x from '@remi/webhooks';`)).toEqual([]);
  });
});

describe('Apache-2.0 packages never import PolyForm package code', () => {
  test('the PolyForm packages exist, so the guard is guarding something real', () => {
    for (const dir of PROTECTED_DIRS) {
      expect(readdirSync(dir).length, dir).toBeGreaterThan(0);
    }
  });

  test('no file in packages/daemon/src or packages/shared/src imports web, signaling or macos', () => {
    const files = SCANNED_DIRS.flatMap(sourceFiles);
    // A glob that silently matched nothing would make this test vacuous.
    expect(files.length).toBeGreaterThan(150);
    const violations: string[] = [];
    for (const file of files) {
      for (const why of violationsIn(file, readFileSync(file, 'utf8'))) {
        violations.push(`${relative(REPO_ROOT, file)}: ${why}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
