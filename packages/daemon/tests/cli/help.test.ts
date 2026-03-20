import { afterEach, describe, expect, test } from 'bun:test';
import { formatHelp } from '../../src/cli/help.ts';

describe('formatHelp', () => {
  const originalEnv = process.env['NO_COLOR'];

  afterEach(() => {
    if (originalEnv === undefined) {
      process.env['NO_COLOR'] = undefined as unknown as string;
    } else {
      process.env['NO_COLOR'] = originalEnv;
    }
  });

  test('includes version in output', () => {
    const output = formatHelp('1.2.3');
    expect(output).toContain('Remi v1.2.3');
  });

  test('includes all section headers', () => {
    const output = formatHelp('0.0.0');
    expect(output).toContain('Quick Start:');
    expect(output).toContain('Remote Access:');
    expect(output).toContain('Session Management:');
    expect(output).toContain('Service:');
    expect(output).toContain('Identity & Auth:');
    expect(output).toContain('Options:');
  });

  test('includes key commands', () => {
    const output = formatHelp('0.0.0');
    expect(output).toContain('remi ls');
    expect(output).toContain('remi attach');
    expect(output).toContain('remi new');
    expect(output).toContain('remi kill');
    expect(output).toContain('remi start');
    expect(output).toContain('remi stop');
    expect(output).toContain('remi keygen');
    expect(output).toContain('remi code');
  });

  test('includes footer hint', () => {
    const output = formatHelp('0.0.0');
    expect(output).toContain('passed through to Claude Code');
  });

  test('contains no ANSI escapes when NO_COLOR is set', () => {
    process.env['NO_COLOR'] = '1';
    const output = formatHelp('0.0.0');
    expect(output).not.toContain('\x1b[');
  });

  test('returns a string', () => {
    const output = formatHelp('0.0.0');
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(100);
  });
});
