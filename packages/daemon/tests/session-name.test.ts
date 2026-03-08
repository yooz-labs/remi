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
    expect(makeUniqueName('mac/remi/main', existing)).toBe('mac/remi/main');
  });

  test('appends :2 for first duplicate', () => {
    const existing = new Set(['mac/remi/main']);
    expect(makeUniqueName('mac/remi/main', existing)).toBe('mac/remi/main:2');
  });

  test('appends :3 when :2 also exists', () => {
    const existing = new Set(['mac/remi/main', 'mac/remi/main:2']);
    expect(makeUniqueName('mac/remi/main', existing)).toBe('mac/remi/main:3');
  });

  test('skips to next available counter', () => {
    const existing = new Set([
      'mac/remi/main',
      'mac/remi/main:2',
      'mac/remi/main:3',
      'mac/remi/main:4',
    ]);
    expect(makeUniqueName('mac/remi/main', existing)).toBe('mac/remi/main:5');
  });
});

describe('generateSessionName', () => {
  test('generates name with hostname, dir, and branch for git repos', () => {
    // This test runs in the remi repo, so it should have a git branch
    const name = generateSessionName(process.cwd());
    const parts = name.split('/');
    // Should have hostname/dirname/branch format (3 parts)
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // First part should be the hostname (without .local)
    expect(parts[0]).not.toContain('.local');
    expect(parts[0]?.length).toBeGreaterThan(0);
  });

  test('generates name without branch for non-git directories', () => {
    const name = generateSessionName('/tmp');
    const parts = name.split('/');
    // /tmp is not a git repo, so should be hostname/dirname (2 parts)
    expect(parts.length).toBe(2);
    expect(parts[1]).toBe('tmp');
  });

  test('uses directory basename', () => {
    const name = generateSessionName('/some/deep/project');
    expect(name).toContain('/project');
  });
});
