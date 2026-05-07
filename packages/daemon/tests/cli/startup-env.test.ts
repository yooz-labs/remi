import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectGitInfo, loadDotenvFile, parseEnvLine } from '../../src/cli/startup-env.ts';

describe('detectGitInfo', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-gitinfo-'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('returns basename + ? when .git is absent', () => {
    const info = detectGitInfo(sandbox);
    expect(info.repo).toBe(path.basename(sandbox));
    expect(info.branch).toBe('?');
  });

  test('parses a ref-style HEAD file', () => {
    fs.mkdirSync(path.join(sandbox, '.git'));
    fs.writeFileSync(path.join(sandbox, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
    const info = detectGitInfo(sandbox);
    expect(info.branch).toBe('feature/x');
  });

  test('shortens a detached-HEAD commit sha to 8 chars', () => {
    fs.mkdirSync(path.join(sandbox, '.git'));
    fs.writeFileSync(
      path.join(sandbox, '.git', 'HEAD'),
      'abcdef1234567890abcdef1234567890abcdef12',
    );
    const info = detectGitInfo(sandbox);
    expect(info.branch).toBe('abcdef12');
  });

  test('does not throw on inaccessible HEAD file', () => {
    // Create .git as a file, not directory — stats lookup on HEAD should fail
    fs.writeFileSync(path.join(sandbox, '.git'), 'gitdir: /nowhere');
    const info = detectGitInfo(sandbox);
    expect(info.repo).toBe(path.basename(sandbox));
    expect(info.branch).toBe('?');
  });
});

describe('parseEnvLine', () => {
  test('parses KEY=value', () => {
    expect(parseEnvLine('FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
  });

  test('strips double quotes', () => {
    expect(parseEnvLine('FOO="bar baz"')).toEqual({ key: 'FOO', value: 'bar baz' });
  });

  test('strips single quotes', () => {
    expect(parseEnvLine("FOO='bar baz'")).toEqual({ key: 'FOO', value: 'bar baz' });
  });

  test('trims surrounding whitespace', () => {
    expect(parseEnvLine('  FOO = bar  ')).toEqual({ key: 'FOO', value: 'bar' });
  });

  test('returns null for blank lines', () => {
    expect(parseEnvLine('')).toBeNull();
    expect(parseEnvLine('   ')).toBeNull();
  });

  test('returns null for comment lines', () => {
    expect(parseEnvLine('# a comment')).toBeNull();
    expect(parseEnvLine('   # indented comment')).toBeNull();
  });

  test('returns null when = is missing', () => {
    expect(parseEnvLine('NOEQUALS')).toBeNull();
  });

  test('returns null when key is empty', () => {
    expect(parseEnvLine('=value')).toBeNull();
  });

  test('allows empty value', () => {
    expect(parseEnvLine('FOO=')).toEqual({ key: 'FOO', value: '' });
  });

  test('preserves = inside the value', () => {
    expect(parseEnvLine('URL=https://example.com/?a=1&b=2')).toEqual({
      key: 'URL',
      value: 'https://example.com/?a=1&b=2',
    });
  });
});

describe('loadDotenvFile', () => {
  let sandbox: string;
  const testKeys = ['REMI_TEST_FOO', 'REMI_TEST_BAR', 'REMI_TEST_EXISTING'];

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-dotenv-'));
    for (const k of testKeys) delete process.env[k];
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    for (const k of testKeys) delete process.env[k];
  });

  test('sets vars from the file into process.env', () => {
    const envPath = path.join(sandbox, '.env');
    fs.writeFileSync(envPath, 'REMI_TEST_FOO=hello\nREMI_TEST_BAR="world"\n');
    loadDotenvFile(envPath);
    expect(process.env['REMI_TEST_FOO']).toBe('hello');
    expect(process.env['REMI_TEST_BAR']).toBe('world');
  });

  test('does not override already-set variables', () => {
    process.env['REMI_TEST_EXISTING'] = 'existing';
    const envPath = path.join(sandbox, '.env');
    fs.writeFileSync(envPath, 'REMI_TEST_EXISTING=from-dotenv\n');
    loadDotenvFile(envPath);
    expect(process.env['REMI_TEST_EXISTING']).toBe('existing');
  });

  test('is a no-op when the file is missing', () => {
    const envPath = path.join(sandbox, 'nonexistent.env');
    expect(() => loadDotenvFile(envPath)).not.toThrow();
  });

  test('skips comments and blank lines', () => {
    const envPath = path.join(sandbox, '.env');
    fs.writeFileSync(envPath, '# leading comment\n\nREMI_TEST_FOO=val\n   # indented comment\n');
    loadDotenvFile(envPath);
    expect(process.env['REMI_TEST_FOO']).toBe('val');
  });
});
