import { afterEach, describe, expect, test } from 'bun:test';
import { formatCommandHelp, formatHelp } from '../../src/cli/help.ts';

describe('formatHelp', () => {
  const originalEnv = process.env['NO_COLOR'];

  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: must truly remove env var, not set to "undefined"
      delete process.env['NO_COLOR'];
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

describe('formatCommandHelp', () => {
  test('ls help includes usage and options', () => {
    const output = formatCommandHelp('ls');
    expect(output).toContain('remi ls');
    expect(output).toContain('--host');
    expect(output).toContain('--network');
  });

  test('attach help includes detach hint', () => {
    const output = formatCommandHelp('attach');
    expect(output).toContain('Ctrl+B d');
    expect(output).toContain('host:port/name');
  });

  test('kill help includes remote format', () => {
    const output = formatCommandHelp('kill');
    expect(output).toContain('host:port/name');
    expect(output).toContain('--host');
  });

  test('new help includes all creation modes', () => {
    const output = formatCommandHelp('new');
    expect(output).toContain('--dir');
    expect(output).toContain('--recent');
    expect(output).toContain('--host');
    expect(output).toContain('/path');
  });

  test('recent help includes remote option', () => {
    const output = formatCommandHelp('recent');
    expect(output).toContain('--host');
  });

  test('code help includes refresh', () => {
    const output = formatCommandHelp('code');
    expect(output).toContain('--refresh');
  });

  test('start help includes port and bind', () => {
    const output = formatCommandHelp('start');
    expect(output).toContain('--port');
    expect(output).toContain('--bind');
  });

  test('serve help includes port and session-less hint', () => {
    const output = formatCommandHelp('serve');
    expect(output).toContain('--port');
    expect(output).toContain('remi new');
  });

  test('keygen help includes force and passphrase', () => {
    const output = formatCommandHelp('keygen');
    expect(output).toContain('--force');
    expect(output).toContain('--passphrase');
  });

  test('all subcommands have help entries', () => {
    const commands = [
      'ls',
      'attach',
      'kill',
      'new',
      'recent',
      'code',
      'start',
      'stop',
      'status',
      'logs',
      'serve',
      'keygen',
      'authorize',
      'keys',
      'export-key',
      'import-key',
      'detach',
    ];
    for (const cmd of commands) {
      const output = formatCommandHelp(cmd);
      expect(output).toContain(`remi ${cmd}`);
    }
  });

  test('unknown command returns fallback message', () => {
    const output = formatCommandHelp('nonexistent');
    expect(output).toContain('No help available');
    expect(output).toContain('remi --help');
  });
});
