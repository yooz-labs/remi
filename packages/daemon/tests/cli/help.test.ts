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

  test('the global help line for remi codex says what it was checked against (L3, Q3)', () => {
    // The top-level quick start is the first place a person reads about remi codex; the
    // approvals claim there must say which Codex it was checked against, as the command help and
    // README do (the live run of 2026-10-04 against Codex 0.160.0 replaced "not yet checked").
    const line = plain(formatHelp('0.0.0'))
      .split('\n')
      .find((l) => l.trim().startsWith('remi codex ') && !l.includes('resume') && !l.includes('"'));
    expect(line).toBeDefined();
    expect(line).toContain('command approvals reach the phone');
    expect(line).toContain('checked live against Codex 0.160.0');
    expect(line).not.toContain('not yet checked against a real Codex');
  });

  test('remi codex --help says what ships: status and command approvals, and what is refused', () => {
    const output = plain(formatCommandHelp('codex'));
    expect(output).toContain('remi codex resume <thread id>');
    // What ships (#1178) and what is not checked: approvals reach the phone, the first answer wins,
    // nothing else is answerable from it, and which Codex it was checked against.
    expect(output).toContain(
      'checked against Codex 0.160.0 on 2026-10-04; subagent requests not yet',
    );
    expect(output).not.toContain('not yet checked against a real Codex');
    expect(output).toContain('Approve for me');
    expect(output).toContain('a command Codex asks to run');
    expect(output).toContain('the first answer wins');
    expect(output).toContain('show up as a notice to answer in the terminal');
    expect(output).toContain('Turn notifications do not reach the phone yet');
    expect(output).not.toContain('status only');
    // Phone chat is refused for a Codex session (W1), and the 30 s notice is not promised (W18).
    expect(output).toContain('a message typed from the phone is');
    expect(output).toContain('refused: type in the terminal');
    expect(output).toContain('type in the terminal');
    expect(output).toContain('some clients, the web client today, do not show it');
    expect(output).not.toMatch(/chat[^.]*reach the\s+phone yet/);
    expect(output).toContain('-i/--image cannot be combined with resume');
    expect(output).toContain('never starts or stops the shared Codex app-server');
    // The `--` rule as shipped: the words after it are a prompt, never flags.
    expect(output).toContain('Everything after `--` is the first prompt, as text, never a flag');
    expect(output).toContain('-h, --help, -v, --version, --dir, --port, --resume');
    expect(output).toContain('run codex directly');
  });

  test('remi codex --help lists what a remote request may carry, and no -a (LV-4)', () => {
    // Codex 0.160.0 rejects `-a untrusted`, the one value the help used to advertise, and no
    // other value can be shown to tighten the host: a remote request carries no -a at all.
    const words = (command: string): string =>
      plain(formatCommandHelp(command)).replace(/\s+/g, ' ');
    const codex = words('codex');
    expect(codex).toContain(
      'accepts only -m/--model <name>, -s read-only and `resume <thread id>`',
    );
    expect(codex).toContain('carries no -a at all');
    expect(codex).not.toContain('-a untrusted');
    expect(codex).not.toContain('resume is unverified');
    // The local launch passes -a through; Codex rejects any other value, and the help says which it takes.
    expect(codex).toContain('-a takes only on-request or never');
    // LV-4 ran Claude's --resume through a hub, so `remi new --help` no longer calls it unverified.
    expect(words('new')).not.toContain('unverified');
  });

  test('every subcommand still has a help entry', () => {
    for (const command of ['codex', 'new', 'ls', 'serve']) {
      expect(formatCommandHelp(command)).not.toContain('No help available');
    }
  });
});

// #1193: the help said the relay was something to "disable" and that the
// connection code is for the web and mobile app. The relay is off unless
// enabled, and no shipped client connects through it.
describe('relay wording', () => {
  const originalNoColor = process.env['NO_COLOR'];

  afterEach(() => {
    if (originalNoColor === undefined) {
      Reflect.deleteProperty(process.env, 'NO_COLOR');
    } else {
      process.env['NO_COLOR'] = originalNoColor;
    }
  });

  test('--no-relay says the relay is off unless enabled, in every place it appears', () => {
    process.env['NO_COLOR'] = '1';
    for (const text of [
      formatHelp('0.0.0'),
      formatCommandHelp('start'),
      formatCommandHelp('serve'),
    ]) {
      expect(text).toContain('--no-relay');
      expect(text).toContain('off unless network.relay = true');
    }
  });

  test('--permanent-code says it needs auth, turns the relay on, and beats relay = false', () => {
    process.env['NO_COLOR'] = '1';
    const help = formatHelp('0.0.0');
    expect(help).toContain('needs auth on; turns the relay on');
    expect(help).toContain('even if network.relay = false');
  });

  test('`remi code` is described as the permanent relay code, in the help and in its own help', () => {
    process.env['NO_COLOR'] = '1';
    const main = formatHelp('0.0.0');
    expect(main).toContain('Show the permanent relay code');
    expect(main).toContain('Generate a new permanent relay code');
    const code = formatCommandHelp('code');
    expect(code).toContain('Show or refresh the permanent relay code');
    expect(code).not.toContain('remote access connection code');
    expect(code).not.toContain('Show current connection code');
  });

  test('`remi code` no longer claims the web or mobile app uses the code', () => {
    process.env['NO_COLOR'] = '1';
    expect(formatHelp('0.0.0')).not.toContain('phone/browser');
    const code = formatCommandHelp('code');
    expect(code).not.toContain('web/mobile app');
    expect(code).toContain('No shipped client connects through the relay yet');
  });
});
