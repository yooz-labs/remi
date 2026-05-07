import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDirectory } from '../../src/cli/path-resolver.ts';

describe('resolveDirectory', () => {
  let sandbox: string;
  let originalCwd: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-resolve-'));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('returns cwd when input is null / undefined / empty string', () => {
    process.chdir(sandbox);
    // On macOS, tmpdir paths are symlinked: /var/folders -> /private/var/folders.
    // process.cwd() after chdir returns the realpath-resolved form.
    const expectedCwd = process.cwd();
    expect(resolveDirectory(null)).toEqual({ resolved: expectedCwd });
    expect(resolveDirectory(undefined)).toEqual({ resolved: expectedCwd });
    expect(resolveDirectory('')).toEqual({ resolved: expectedCwd });
  });

  test('expands `~/` to the home directory', () => {
    const result = resolveDirectory('~/');
    // Success branch: home expansion resolves to an existing directory.
    expect(result).toHaveProperty('resolved');
    if ('resolved' in result) {
      expect(result.resolved).toBe(os.homedir());
    }
  });

  test('expands `~` alone to the home directory', () => {
    const result = resolveDirectory('~');
    expect(result).toEqual({ resolved: os.homedir() });
  });

  test('resolves absolute paths as-is', () => {
    expect(resolveDirectory(sandbox)).toEqual({ resolved: sandbox });
  });

  test('resolves relative paths against cwd', () => {
    const child = fs.mkdtempSync(path.join(sandbox, 'child-'));
    process.chdir(sandbox);
    const result = resolveDirectory(path.basename(child));
    // See previous test for the tmpdir symlink explanation.
    const expected = path.resolve(path.basename(child));
    expect(result).toEqual({ resolved: expected });
  });

  test('returns an error for non-existent paths', () => {
    const result = resolveDirectory(path.join(sandbox, 'nope'));
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toStartWith('Directory not found: ');
    }
  });

  test('returns an error when the path is a file (not a directory)', () => {
    const file = path.join(sandbox, 'file.txt');
    fs.writeFileSync(file, 'hello');
    const result = resolveDirectory(file);
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toStartWith('Not a directory: ');
    }
  });
});
