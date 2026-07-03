import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeProjectPath, resolveDirectory } from '../../src/cli/path-resolver.ts';

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

describe('normalizeProjectPath', () => {
  test('expands `~/...` to an absolute home-relative path', () => {
    expect(normalizeProjectPath('~/Documents/git/nemar/nemar-cli')).toBe(
      path.join(os.homedir(), 'Documents/git/nemar/nemar-cli'),
    );
  });

  test('expands bare `~` to the home directory', () => {
    expect(normalizeProjectPath('~')).toBe(os.homedir());
  });

  test('leaves an already-absolute path unchanged (aside from normalization)', () => {
    expect(normalizeProjectPath('/Users/yahya/Documents/git/nemar/nemar-cli')).toBe(
      '/Users/yahya/Documents/git/nemar/nemar-cli',
    );
  });

  test('tilde-form and absolute-form inputs for the same directory normalize identically (#674)', () => {
    const tildeForm = '~/Documents/git/nemar/nemar-cli';
    const absoluteForm = path.join(os.homedir(), 'Documents/git/nemar/nemar-cli');
    expect(normalizeProjectPath(tildeForm)).toBe(normalizeProjectPath(absoluteForm));
  });

  test('does not attempt to fix an already-malformed concatenated path', () => {
    // The exact shape observed live (#674): a tilde path resolved relative to
    // a cwd that already ends in the same tail, instead of being expanded
    // against $HOME. Once concatenated it no longer starts with `~`, so this
    // documents that normalizeProjectPath cannot un-concatenate it after the
    // fact — the fix must prevent this shape from being persisted at all.
    const malformed = '/Users/yahya/Documents/git/nemar/nemar-cli/~/Documents/git/nemar/nemar-cli';
    expect(normalizeProjectPath(malformed)).toBe(malformed);
  });

  test('does not touch the filesystem (safe on paths that do not exist)', () => {
    const doesNotExist = '~/this-directory-almost-certainly-does-not-exist-674';
    expect(() => normalizeProjectPath(doesNotExist)).not.toThrow();
    expect(normalizeProjectPath(doesNotExist)).toBe(
      path.join(os.homedir(), 'this-directory-almost-certainly-does-not-exist-674'),
    );
  });
});
