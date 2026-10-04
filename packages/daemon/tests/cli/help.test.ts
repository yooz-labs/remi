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
  /**
   * The lines under `heading`, up to the next heading.
   *
   * Delimiting on the next HEADING rather than the next blank line matters:
   * `Options:` already contains an internal blank line, so a blank-line rule
   * would silently return a truncated section and let an assertion about a
   * dropped entry pass green. Headings are unindented; entries are not.
   */
  function sectionOf(text: string, heading: string): string {
    const plain = text.replace(/\x1b\[[0-9]+m/g, '');
    const lines = plain.split('\n');
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start === -1) throw new Error(`no "${heading}" section in help output`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^\S/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
  }

  test('sectionOf spans a section that contains a blank line', () => {
    // Guards the helper itself: `Options:` has a blank line in the middle, and
    // a blank-line-delimited reader drops everything after it while still
    // looking like it worked.
    const options = sectionOf(formatHelp('0.0.0-test'), 'Options:');
    expect(options).toContain('--port PORT');
    expect(options).toContain('--force'); // after the internal blank line
  });

  test('no auto-approve section, flags or model commands remain (#1125)', () => {
    const text = formatHelp('0.0.0-test');
    expect(text).not.toContain('Auto-Approve');
    expect(text).not.toContain('--auto-approve');
    expect(text).not.toContain('remi model');
  });

  test('remi model help says it was removed', () => {
    expect(formatCommandHelp('model')).toContain('Removed in #1125');
  });

  test('a term wider than the column still has a space before its description', () => {
    // `padEnd` is a no-op once the term is already at the column width, so a
    // long term ran straight into its text. The original case was a removed
    // auto-approve flag (#1125); this is the widest term left.
    const plain = formatCommandHelp('authorize').replace(/\x1b\[[0-9]+m/g, '');
    const line = plain.split('\n').find((l) => l.includes('remi authorize <key> --label "name"'));
    expect(line).toBeDefined();
    expect(line).toMatch(/--label "name" \S/);
  });
});

describe('the codex help (#1177)', () => {
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

  test('the global help lists remi codex and its resume', () => {
    const output = plain(formatHelp('0.0.0'));
    expect(output).toContain('remi codex ');
    expect(output).toContain('remi codex resume <id>');
  });

  test('remi codex --help says what ships: status only, and what is refused', () => {
    const output = plain(formatCommandHelp('codex'));
    expect(output).toContain('remi codex resume <thread id>');
    expect(output).toContain('status only');
    expect(output).toContain('Approvals, chat and turn pushes do not reach the');
    expect(output).toContain('never starts or stops the shared Codex app-server');
    // The `--` rule as shipped: the words after it are a prompt, never flags.
    expect(output).toContain('Everything after `--` is the first prompt, as text, never a flag');
    expect(output).toContain('-h, --help, -v, --version, --dir, --port, --resume');
    expect(output).toContain('run codex directly');
  });

  test('every subcommand still has a help entry', () => {
    for (const command of ['codex', 'new', 'ls', 'serve']) {
      expect(formatCommandHelp(command)).not.toContain('No help available');
    }
  });
});
