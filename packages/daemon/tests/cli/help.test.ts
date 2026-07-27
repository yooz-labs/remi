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

describe('help formatting', () => {
  /** The lines under `heading`, up to the next blank line. */
  function sectionOf(text: string, heading: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
    const plain = text.replace(/\x1b\[[0-9]+m/g, '');
    const lines = plain.split('\n');
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start === -1) throw new Error(`no "${heading}" section in help output`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.trim() === '');
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
  }

  test('the model commands sit in the Auto-Approve section, not Configuration', () => {
    // 0.7.0 shipped `remi model` with per-command help but no entry in the
    // global list (#843). The fix put one line at the BOTTOM of Configuration,
    // where a user read the whole output and still did not find it (#850) --
    // so asserting mere presence is not enough to call it discoverable.
    const text = formatHelp('0.0.0-test');
    expect(sectionOf(text, 'Auto-Approve (LLM):')).toContain('remi model');
    expect(sectionOf(text, 'Configuration:')).not.toContain('remi model');
  });

  test('the model commands come before the auto-approve flags', () => {
    // `remi model` is a ten-verb subsystem, not a setting; listing it after the
    // flags would read as an afterthought of them.
    const section = sectionOf(formatHelp('0.0.0-test'), 'Auto-Approve (LLM):');
    expect(section.indexOf('remi model')).toBeLessThan(section.indexOf('--auto-approve'));
  });

  test('a term wider than the column still has a space before its description', () => {
    // `padEnd` is a no-op once the term is already at the column width, so a
    // long flag ran straight into its text:
    //   --auto-approve-multichoice-model MAlt-model for multi-choice
    const text = formatHelp('0.0.0-test');
    const line = text.split('\n').find((l) => l.includes('--auto-approve-multichoice-model'));
    expect(line).toBeDefined();
    expect(line).not.toContain('MAlt-model');
    expect(line).toContain('M Alt-model');
  });
});
