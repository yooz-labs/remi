/**
 * `remi migrate-permissions` (#1125): maps old `[auto_approve] allow/deny`
 * lists to Claude Code `permissions` JSON, prints, and never writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  migratePermissions,
  runMigratePermissionsCommand,
  toClaudeRule,
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

describe('toClaudeRule: the mapping table', () => {
  const cases: Array<[unknown, string | null]> = [
    // bare tool names stay as they are
    ['Read', 'Read'],
    ['WebFetch', 'WebFetch'],
    ['NotebookEdit', 'NotebookEdit'],
    ['mcp__github__create_issue', 'mcp__github__create_issue'],
    // a Bash command prefix becomes Bash(prefix:*), trimmed
    ['git status', 'Bash(git status:*)'],
    ['bun test', 'Bash(bun test:*)'],
    ['ls', 'Bash(ls:*)'],
    ['sudo ', 'Bash(sudo:*)'],
    ['  npm run build  ', 'Bash(npm run build:*)'],
    ['rm -rf /', 'Bash(rm -rf /:*)'],
    // a lowercase single word is a command, not a tool
    ['read', 'Bash(read:*)'],
    // already in Tool(...) form: passes through untouched
    ['Bash(git push:*)', 'Bash(git push:*)'],
    ['WebFetch(domain:example.com)', 'WebFetch(domain:example.com)'],
    ['Edit(src/**)', 'Edit(src/**)'],
    // nothing to map
    ['', null],
    ['   ', null],
    [42, null],
    [null, null],
    [['git'], null],
  ];
  for (const [entry, expected] of cases) {
    test(`${JSON.stringify(entry)} -> ${JSON.stringify(expected)}`, () => {
      expect(toClaudeRule(entry)).toBe(expected);
    });
  }
});

describe('migratePermissions', () => {
  test('maps allow and deny, de-duplicating while keeping order', () => {
    const r = migratePermissions({
      allow: ['Read', 'git status', 'Read', 'Bash(git status:*)'],
      deny: ['sudo ', 'rm -rf /'],
    });
    expect(r.allow).toEqual(['Read', 'Bash(git status:*)']);
    expect(r.deny).toEqual(['Bash(sudo:*)', 'Bash(rm -rf /:*)']);
    expect(r.unmapped).toEqual([]);
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
    expect(migratePermissions(undefined)).toEqual({ allow: [], deny: [], unmapped: [] });
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
      permissions: { allow: ['Read', 'Bash(git status:*)'], deny: ['Bash(sudo:*)'] },
    });
    const notes = err.join('\n');
    expect(notes).toContain('auto_approve.level');
    expect(notes).toContain('substrings');
    expect(notes).toContain('Nothing was written');
    expect(notes).toContain('~/.claude/settings.json');
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

  test('no config file: empty permissions, exit 0', () => {
    const { io, out, err } = capture();
    expect(runMigratePermissionsCommand(path.join(home, 'missing.toml'), io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ permissions: { allow: [], deny: [] } });
    expect(err.join('\n')).toContain('nothing to migrate');
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
      permissions: { allow: ['Read', 'Bash(bun test:*)'], deny: ['Bash(rm -rf:*)'] },
    });
    expect(stderr).toContain('auto_approve.approve_groups');
    // The one-time boot notice is for daemon starts, not this command.
    expect(stderr).not.toContain('still has an [auto_approve] table');
    expect(snapshot(home)).toEqual(before);
  });
});
