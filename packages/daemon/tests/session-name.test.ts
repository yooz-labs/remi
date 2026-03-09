import { describe, expect, test } from 'bun:test';
import { cleanHostname, generateSessionName, makeUniqueName } from '../src/session/session-name.ts';

describe('cleanHostname', () => {
  test('strips .local suffix', () => {
    expect(cleanHostname('macbook.local')).toBe('macbook');
  });

  test('leaves hostname without .local unchanged', () => {
    expect(cleanHostname('server01')).toBe('server01');
  });

  test('handles empty string', () => {
    expect(cleanHostname('')).toBe('');
  });

  test('only strips trailing .local, not embedded', () => {
    expect(cleanHostname('local.server')).toBe('local.server');
  });
});

describe('makeUniqueName', () => {
  test('returns base name when no duplicates', () => {
    const existing = new Set<string>();
    expect(makeUniqueName('mac:remi/main', existing)).toBe('mac:remi/main');
  });

  test('appends :2 for first duplicate', () => {
    const existing = new Set(['mac:remi/main']);
    expect(makeUniqueName('mac:remi/main', existing)).toBe('mac:remi/main:2');
  });

  test('appends :3 when :2 also exists', () => {
    const existing = new Set(['mac:remi/main', 'mac:remi/main:2']);
    expect(makeUniqueName('mac:remi/main', existing)).toBe('mac:remi/main:3');
  });

  test('skips to next available counter', () => {
    const existing = new Set([
      'mac:remi/main',
      'mac:remi/main:2',
      'mac:remi/main:3',
      'mac:remi/main:4',
    ]);
    expect(makeUniqueName('mac:remi/main', existing)).toBe('mac:remi/main:5');
  });
});

describe('generateSessionName', () => {
  test('generates name with hostname:dir/branch for git repos', () => {
    // This test runs in the remi repo, so it should have a git branch
    const name = generateSessionName(process.cwd());
    // Should have hostname:dir/branch format (colon separates hostname)
    expect(name).toContain(':');
    const [hostname, rest] = name.split(':');
    expect(hostname).not.toContain('.local');
    expect(hostname!.length).toBeGreaterThan(0);
    // rest should be dir/branch
    expect(rest).toContain('/');
  });

  test('generates name without branch for non-git directories', () => {
    const name = generateSessionName('/tmp');
    // Should be hostname:tmp (no branch)
    expect(name).toContain(':');
    const [_hostname, rest] = name.split(':');
    expect(rest).toBe('tmp');
    expect(rest).not.toContain('/');
  });

  test('uses directory basename', () => {
    const name = generateSessionName('/some/deep/project');
    const [_hostname, rest] = name.split(':');
    expect(rest).toMatch(/^project/);
  });
});
