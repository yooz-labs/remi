import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const CLI = fs.readFileSync(path.join(ROOT, 'packages/daemon/src/cli.ts'), 'utf-8');

describe('Version synchronization', () => {
  test('REMI_COMPILED_VERSION in cli.ts matches package.json version', () => {
    const matches = CLI.match(/return '([^']+)'; \/\/ REMI_COMPILED_VERSION/g);
    expect(matches).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect(matches!.length).toBeGreaterThanOrEqual(2);

    // biome-ignore lint/style/noNonNullAssertion: checked above
    for (const m of matches!) {
      const version = m.match(/return '([^']+)'/)?.[1];
      expect(version).toBe(PKG.version);
    }
  });

  test('REMI_COMPILED_VERSION marker exists in cli.ts', () => {
    expect(CLI).toContain('// REMI_COMPILED_VERSION');
  });

  test('npm wrapper optionalDependencies are self-consistent', () => {
    const npmPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'npm/remi/package.json'), 'utf-8'));
    const deps = npmPkg.optionalDependencies ?? {};
    const versions = Object.values(deps) as string[];
    if (versions.length > 0) {
      const first = versions[0] as string;
      for (const v of versions) {
        expect(v as string).toBe(first);
      }
    }
  });
});
