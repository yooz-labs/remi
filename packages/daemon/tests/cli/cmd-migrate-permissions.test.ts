/**
 * `remi migrate-permissions` (#1125): maps old `[auto_approve] allow/deny`
 * lists to Claude Code `permissions` JSON, prints, and never writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SUBAGENT_ALERT_MOVE_HINT } from '../../src/cli/auto-approve-removal.ts';
import {
  CLAUDE_TOOL_NAMES,
  classifyEntry,
  migratePermissions,
  runMigratePermissionsCommand,
} from '../../src/cli/cmd-migrate-permissions.ts';
import { CLI_TS, isolatedEnv } from '../integration/hub-test-utils.ts';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-migrate-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Every file under `dir`, with its content: the "nothing was written" oracle.
 *  Skips the runtime's own cache directories (Bun, not remi, writes there). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      if (d === dir && (name === 'Library' || name === '.cache')) continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf-8');
    }
  };
  walk(dir);
  return out;
}

function capture(): {
  io: { out: (t: string) => void; err: (t: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

type Expect = string | 'skip';

/** Each row: [entry, what `allow` makes of it, what `deny` makes of it]. */
const TABLE: Array<[unknown, Expect, Expect]> = [
  // known tool names and MCP ids stay as they are
  ['Read', 'Read', 'Read'],
  ['WebFetch', 'WebFetch', 'WebFetch'],
  ['NotebookEdit', 'NotebookEdit', 'NotebookEdit'],
  ['mcp__github__create_issue', 'mcp__github__create_issue', 'mcp__github__create_issue'],
  // bare Bash: remi never applied it, Claude Code reads it as every shell call
  ['Bash', 'skip', 'skip'],
  // tool-shaped but not a Claude Code tool: remi substring-matched it in shell
  ['TRUNCATE', 'skip', 'skip'],
  ['Readme', 'skip', 'skip'],
  // a command: allow keeps the word-boundary prefix, deny becomes start-anchored
  ['git status', 'Bash(git status:*)', 'Bash(git status*)'],
  ['bun test', 'Bash(bun test:*)', 'Bash(bun test*)'],
  ['ls', 'Bash(ls:*)', 'Bash(ls*)'],
  ['sudo ', 'Bash(sudo:*)', 'Bash(sudo *)'],
  ['  npm run build  ', 'Bash(npm run build:*)', 'Bash(npm run build *)'],
  ['rm -rf /', 'Bash(rm -rf /:*)', 'Bash(rm -rf /*)'],
  ['rm -f', 'Bash(rm -f:*)', 'Bash(rm -f*)'],
  ['chmod 777', 'Bash(chmod 777:*)', 'Bash(chmod 777*)'],
  // a lowercase single word is a command, not a tool
  ['read', 'Bash(read:*)', 'Bash(read*)'],
  // mid-command deny patterns have no faithful start-anchored form
  ['push --force', 'Bash(push --force:*)', 'skip'],
  ['push -f ', 'Bash(push -f:*)', 'skip'],
  ['reset --hard', 'Bash(reset --hard:*)', 'skip'],
  ['DROP TABLE', 'Bash(DROP TABLE:*)', 'skip'],
  ['--force', 'Bash(--force:*)', 'skip'],
  // operators, redirection, substitution: Claude Code splits on them
  ['curl | sh', 'skip', 'skip'],
  ['| bash', 'skip', 'skip'],
  ['make && make install', 'skip', 'skip'],
  ['ls; id', 'skip', 'skip'],
  ['echo hi > out.txt', 'skip', 'skip'],
  ['cat < in.txt', 'skip', 'skip'],
  ['echo $(id)', 'skip', 'skip'],
  ['echo `id`', 'skip', 'skip'],
  // literal characters Claude Code reads as syntax
  ['git *', 'skip', 'skip'],
  ['echo (x)', 'skip', 'skip'],
  // already Claude Code syntax: passed through, except a blanket allow
  ['Bash(git push:*)', 'Bash(git push:*)', 'Bash(git push:*)'],
  ['WebFetch(domain:example.com)', 'WebFetch(domain:example.com)', 'WebFetch(domain:example.com)'],
  ['Edit(src/**)', 'Edit(src/**)', 'Edit(src/**)'],
  ['Bash(*)', 'skip', 'Bash(*)'],
  ['Bash(:*)', 'skip', 'Bash(:*)'],
  ['Read()', 'skip', 'Read()'],
  // nothing to map
  ['', 'skip', 'skip'],
  ['   ', 'skip', 'skip'],
  [42, 'skip', 'skip'],
  [null, 'skip', 'skip'],
  [['git'], 'skip', 'skip'],
];

describe('classifyEntry: the mapping table', () => {
  for (const [entry, allowExpect, denyExpect] of TABLE) {
    for (const [list, expected] of [
      ['allow', allowExpect],
      ['deny', denyExpect],
    ] as const) {
      test(`${list} ${JSON.stringify(entry)} -> ${expected}`, () => {
        const outcome = classifyEntry(entry, list);
        if (expected === 'skip') {
          expect(outcome.kind).toBe('skip');
          if (outcome.kind === 'skip') expect(outcome.reason.length).toBeGreaterThan(0);
        } else {
          expect(outcome).toMatchObject({ kind: 'rule', rule: expected });
        }
      });
    }
  }

  test('every emitted command deny says it is narrower than before', () => {
    const outcome = classifyEntry('rm -rf /', 'deny');
    expect(outcome.kind === 'rule' ? outcome.note : '').toContain('STARTS with it');
  });

  test('a mid-command ALLOW entry is kept as a prefix rule and flagged', () => {
    for (const entry of ['DROP TABLE', 'push --force', 'reset --hard', '--force']) {
      const outcome = classifyEntry(entry, 'allow');
      expect(outcome.kind === 'rule' ? outcome.note : '').toBe(
        'kept as a prefix rule; matches only commands that start with it',
      );
    }
    // A command-start allow entry is carried over without a note.
    const plain = classifyEntry('git status', 'allow');
    expect(plain.kind === 'rule' ? plain.note : 'skip').toBeUndefined();
  });

  test('a passed-through Tool(...) rule says remi never applied it', () => {
    const outcome = classifyEntry('Bash(npm test:*)', 'allow');
    expect(outcome.kind === 'rule' ? outcome.note : '').toContain('never applied this form');
  });

  test('bare Bash in allow explains that it would allow every shell command', () => {
    const outcome = classifyEntry('Bash', 'allow');
    expect(outcome.kind === 'skip' ? outcome.reason : '').toContain('every shell command');
  });

  test('known tool names include the current built-ins and the old names', () => {
    for (const name of ['Agent', 'Skill', 'PowerShell', 'Task', 'NotebookRead', 'MultiEdit']) {
      expect(CLAUDE_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe('migratePermissions', () => {
  test("the old config template's example deny list", () => {
    const r = migratePermissions({ deny: ['rm -rf /', 'sudo ', 'curl | sh', '| bash'] });
    expect(r.deny).toEqual(['Bash(rm -rf /*)', 'Bash(sudo *)']);
    expect(r.changed).toHaveLength(2);
    expect(r.unmapped).toHaveLength(2);
    expect(r.unmapped[0]).toContain('deny "curl | sh"');
    expect(r.unmapped[1]).toContain('deny "| bash"');
  });

  test('maps allow and deny, de-duplicating while keeping order', () => {
    const r = migratePermissions({
      allow: ['Read', 'git status', 'Read', 'Bash(git status:*)', 'Bash'],
      deny: ['sudo ', 'rm -rf /', 'push --force'],
    });
    expect(r.allow).toEqual(['Read', 'Bash(git status:*)']);
    expect(r.deny).toEqual(['Bash(sudo *)', 'Bash(rm -rf /*)']);
    expect(r.unmapped.join('\n')).toContain('allow "Bash"');
    expect(r.unmapped.join('\n')).toContain('deny "push --force"');
  });

  test('groups, level and agent sections are reported, never translated', () => {
    const r = migratePermissions({
      allow: ['Read'],
      approve_groups: ['read-only', 'vcs-read'],
      deny_groups: ['net-write'],
      level: 'trusted',
      agents: { Explore: { approve_groups: ['net-read'] }, 'pr-review': { allow: [] } },
    });
    expect(r.allow).toEqual(['Read']);
    const notes = r.unmapped.join('\n');
    expect(notes).toContain('auto_approve.approve_groups');
    expect(notes).toContain('auto_approve.deny_groups');
    expect(notes).toContain('auto_approve.level = "trusted"');
    expect(notes).toContain('auto_approve.agents.Explore');
    expect(notes).toContain('auto_approve.agents.pr-review');
  });

  test('an empty group list is not worth a note', () => {
    expect(migratePermissions({ approve_groups: [], deny_groups: [] }).unmapped).toEqual([]);
  });

  test('a non-list allow and unusable entries are reported', () => {
    const r = migratePermissions({ allow: 'git', deny: ['', 7] });
    expect(r.allow).toEqual([]);
    expect(r.deny).toEqual([]);
    expect(r.unmapped).toHaveLength(3);
  });

  test('no table and a non-table', () => {
    expect(migratePermissions(undefined)).toEqual({
      allow: [],
      deny: [],
      changed: [],
      unmapped: [],
    });
    expect(migratePermissions(true).unmapped).toHaveLength(1);
  });
});

describe('runMigratePermissionsCommand', () => {
  test('prints {"permissions":{allow,deny}} on stdout and guidance on stderr', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(
      configPath,
      '[auto_approve]\nenabled = true\nallow = ["Read", "git status"]\ndeny = ["sudo "]\nlevel = "balanced"\n',
    );
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({
      permissions: { allow: ['Read', 'Bash(git status:*)'], deny: ['Bash(sudo *)'] },
    });
    const notes = err.join('\n');
    expect(notes).toContain('auto_approve.level');
    expect(notes).toContain('Carried over, with a different meaning');
    expect(notes).toContain('NOT carried over:');
    expect(notes).toContain('Nothing was written');
    expect(notes).toContain('~/.claude/settings.json');
  });

  test('a mid-command allow entry is listed on stderr as a prefix rule', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, '[auto_approve]\nallow = ["DROP TABLE", "git status"]\n');
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(0);
    expect(JSON.parse(out.join('\n')).permissions.allow).toEqual([
      'Bash(DROP TABLE:*)',
      'Bash(git status:*)',
    ]);
    expect(err.join('\n')).toContain(
      'allow "DROP TABLE" -> Bash(DROP TABLE:*): kept as a prefix rule; matches only commands that start with it',
    );
    expect(err.join('\n')).not.toContain('allow "git status" ->');
  });

  test('every entry that is not carried over is named on stderr with its reason', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(
      configPath,
      '[auto_approve]\nallow = ["Bash"]\ndeny = ["curl | sh", "TRUNCATE", "DROP TABLE"]\n',
    );
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ permissions: { allow: [], deny: [] } });
    const notes = err.join('\n');
    const heading = notes.indexOf('NOT carried over:');
    expect(heading).toBeGreaterThanOrEqual(0);
    for (const e of ['allow "Bash"', 'deny "curl | sh"', 'deny "TRUNCATE"', 'deny "DROP TABLE"']) {
      expect(notes.indexOf(e)).toBeGreaterThan(heading);
    }
  });

  test('a legacy subagent_alert gets the move hint, and never lands in the JSON', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, '[auto_approve]\nsubagent_alert = ["curl"]\n');
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ permissions: { allow: [], deny: [] } });
    expect(err).toContain(SUBAGENT_ALERT_MOVE_HINT);
  });

  test('a legacy subagent_alert shadowed by [notifications] is called ignored', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(
      configPath,
      '[notifications]\nsubagent_alert = ["ssh "]\n\n[auto_approve]\nsubagent_alert = ["curl"]\n',
    );
    const { io, err } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(0);
    expect(err.join('\n')).toContain('is ignored because [notifications] subagent_alert is set');
    expect(err).not.toContain(SUBAGENT_ALERT_MOVE_HINT);
  });

  test('reads values the old validator refused, and other broken sections do not matter', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(
      configPath,
      '[daemon]\nallowed_origins = "not-a-list"\n\n[auto_approve]\nprovider = "ollama"\nallow = ["Glob"]\n',
    );
    const { io, out } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(0);
    expect(JSON.parse(out.join('\n')).permissions.allow).toEqual(['Glob']);
  });

  test('no config at the DEFAULT path: empty permissions, exit 0', () => {
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(undefined, io, path.join(home, 'missing.toml'))).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ permissions: { allow: [], deny: [] } });
    expect(err.join('\n')).toContain('nothing to migrate');
  });

  test('a path the user named that does not exist: exit 1, nothing on stdout', () => {
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(path.join(home, 'missing.toml'), io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('No config file at');
  });

  test('no [auto_approve] table: empty permissions, says so', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, '[daemon]\nbase_port = 19000\n');
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ permissions: { allow: [], deny: [] } });
    expect(err.join('\n')).toContain('no [auto_approve] table');
  });

  test('invalid TOML is an error, exit 1, nothing on stdout', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, '[auto_approve\nallow = [');
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(configPath, io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('Cannot read');
  });

  test('never writes: the config dir is byte-identical afterwards', () => {
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, '[auto_approve]\nallow = ["Read"]\ndeny = ["sudo "]\n');
    const before = snapshot(home);
    runMigratePermissionsCommand(configPath, capture().io);
    expect(snapshot(home)).toEqual(before);
  });
});

describe('remi migrate-permissions (real cli.ts)', () => {
  test('reads ~/.remi/config.toml, prints JSON, and writes nothing anywhere under $HOME', async () => {
    fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      '{"permissions":{"allow":["Read"]}}',
    );
    fs.writeFileSync(
      path.join(home, '.remi', 'config.toml'),
      '[auto_approve]\nallow = ["Read", "bun test"]\ndeny = ["rm -rf"]\napprove_groups = ["read-only"]\n',
    );
    const before = snapshot(home);
    const proc = Bun.spawn(['bun', CLI_TS, 'migrate-permissions'], {
      cwd: home,
      // Bun's own transpiler cache would otherwise land under this $HOME;
      // that is the runtime writing, not remi.
      env: isolatedEnv(home, { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      permissions: { allow: ['Read', 'Bash(bun test:*)'], deny: ['Bash(rm -rf*)'] },
    });
    expect(stderr).toContain('auto_approve.approve_groups');
    // The one-time boot notice is for daemon starts, not this command.
    expect(stderr).not.toContain('still has an [auto_approve] table');
    expect(snapshot(home)).toEqual(before);
  });

  test('a large block piped out arrives whole, and a named missing path exits 1', async () => {
    fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
    const entries = Array.from({ length: 20000 }, (_, k) => `"tool-${k} --flag"`).join(', ');
    fs.writeFileSync(
      path.join(home, '.remi', 'config.toml'),
      `[auto_approve]\nallow = [${entries}]\n`,
    );
    const env = isolatedEnv(home, { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' });
    const big = Bun.spawn(['bun', CLI_TS, 'migrate-permissions'], {
      cwd: home,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(big.stdout).text(), big.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).permissions.allow).toHaveLength(20000);

    const missing = Bun.spawn(
      ['bun', CLI_TS, 'migrate-permissions', path.join(home, 'nope.toml')],
      { cwd: home, env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [out2, code2] = await Promise.all([new Response(missing.stdout).text(), missing.exited]);
    expect(code2).toBe(1);
    expect(out2).toBe('');
  });
});
