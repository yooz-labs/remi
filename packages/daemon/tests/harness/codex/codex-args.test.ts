/**
 * `remi codex` argument validation (epic #1175, phase 2 #1176): the local
 * denylist, the subcommand refusal, the remote allowlist and the working
 * directory rule. Each denylist entry and each refused subcommand has its own
 * test, so deleting one entry from the source fails exactly that test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveCodexWorkingDirectory,
  validateCodexArgs,
  validateCodexRemoteArgs,
} from '../../../src/harness/codex/codex-args.ts';

const UUID = '019abcde-0000-7000-8000-00000000abcd';

function accepted(result: ReturnType<typeof validateCodexArgs>) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

function refusal(result: ReturnType<typeof validateCodexArgs>): string {
  if (result.ok) throw new Error(`expected a refusal, got args ${JSON.stringify(result.args)}`);
  return result.error;
}

describe('validateCodexArgs: what is accepted', () => {
  test('no arguments is a fresh session', () => {
    expect(validateCodexArgs([])).toEqual({ ok: true, args: [], resumeThreadId: null });
  });

  test('a bare prompt is passed through', () => {
    expect(accepted(validateCodexArgs(['fix the failing test'])).args).toEqual([
      'fix the failing test',
    ]);
  });

  test('shared options are passed through as written, with their values', () => {
    const args = ['-m', 'a-model', '-a', 'untrusted', '--sandbox', 'read-only', '--add-dir', '/x'];
    expect(accepted(validateCodexArgs(args)).args).toEqual(args);
    expect(accepted(validateCodexArgs(['--model=a-model', '-mother'])).args).toEqual([
      '--model=a-model',
      '-mother',
    ]);
  });

  test('--no-alt-screen is accepted and removed, so the launch adds it exactly once', () => {
    expect(accepted(validateCodexArgs([])).args).not.toContain('--no-alt-screen');
    expect(accepted(validateCodexArgs(['--no-alt-screen'])).args).toEqual([]);
    expect(
      accepted(validateCodexArgs(['--no-alt-screen', '-m', 'x', '--no-alt-screen', 'p'])).args,
    ).toEqual(['-m', 'x', 'p']);
  });

  test('a flag-shaped token after -- is prompt text: nothing after the separator is a flag', () => {
    const args = ['--', '-c', 'x=y', '--profile', 'p'];
    expect(accepted(validateCodexArgs(args)).args).toEqual(args);
    expect(accepted(validateCodexArgs(['-m', 'x', '--', '--oss'])).args).toEqual([
      '-m',
      'x',
      '--',
      '--oss',
    ]);
  });

  test('an attached value that merely contains a denied letter is not a denied flag', () => {
    // `-mcfoo` is -m with the value `cfoo`, and `-ac` is -a with the value `c`.
    expect(accepted(validateCodexArgs(['-mcfoo', '-ac'])).args).toEqual(['-mcfoo', '-ac']);
  });

  test('help and version are passed through (Codex prints and exits)', () => {
    expect(accepted(validateCodexArgs(['--help'])).args).toEqual(['--help']);
    expect(accepted(validateCodexArgs(['-V'])).args).toEqual(['-V']);
  });
});

describe('validateCodexArgs: resume <uuid>', () => {
  test('is the one subcommand allowed, and reports the thread id', () => {
    expect(validateCodexArgs(['resume', UUID])).toEqual({
      ok: true,
      args: ['resume', UUID],
      resumeThreadId: UUID,
    });
  });

  test('options may come before or after it', () => {
    expect(accepted(validateCodexArgs(['-m', 'x', 'resume', UUID]))).toMatchObject({
      args: ['-m', 'x', 'resume', UUID],
      resumeThreadId: UUID,
    });
    expect(accepted(validateCodexArgs(['resume', UUID, '-m', 'x']))).toMatchObject({
      args: ['resume', UUID, '-m', 'x'],
      resumeThreadId: UUID,
    });
  });

  test('the thread id is reported lowercased and the argument is kept as written', () => {
    const upper = UUID.toUpperCase();
    expect(accepted(validateCodexArgs(['resume', upper]))).toMatchObject({
      args: ['resume', upper],
      resumeThreadId: UUID,
    });
  });

  test('--no-alt-screen between resume and its id is removed without breaking the pair', () => {
    expect(accepted(validateCodexArgs(['resume', '--no-alt-screen', UUID])).args).toEqual([
      'resume',
      UUID,
    ]);
  });

  test('resume after a prompt is told to come first', () => {
    expect(refusal(validateCodexArgs(['a prompt', 'resume', UUID]))).toContain('before any prompt');
  });

  test.each([
    ['no id', ['resume']],
    ['--last', ['resume', '--last']],
    ['the picker with options only', ['resume', '-m', 'x']],
    ['an id that is not a UUID', ['resume', 'not-a-uuid']],
    ['a short id prefix', ['resume', UUID.slice(0, 8)]],
    ['a prompt after the id', ['resume', UUID, 'continue please']],
    ['a prompt after -- ', ['resume', UUID, '--', 'continue']],
    ['resume after a prompt', ['a prompt', 'resume', UUID]],
    ['a second resume', ['resume', UUID, 'resume', UUID]],
    ['resume as the first token after --', ['--', 'resume', UUID]],
  ])('is refused with %s', (_name, args) => {
    expect(refusal(validateCodexArgs(args))).toMatch(/resume/);
  });
});

describe('validateCodexArgs: subcommands other than resume are refused', () => {
  const SUBCOMMANDS = [
    'fork',
    'exec',
    'login',
    'logout',
    'mcp',
    'mcp-server',
    'app-server',
    'proxy',
    'completion',
    'debug',
    'apply',
    'cloud',
    'sandbox',
    'review',
  ];

  test.each(SUBCOMMANDS)('%s', (subcommand) => {
    const error = refusal(validateCodexArgs([subcommand]));
    expect(error).toContain('interactive TUI only');
    expect(error).toContain(subcommand);
  });

  test('also after a flag with a value, after other options and after --', () => {
    expect(refusal(validateCodexArgs(['-m', 'x', 'exec']))).toContain('exec');
    expect(refusal(validateCodexArgs(['--model', 'x', '-a', 'untrusted', 'login']))).toContain(
      'login',
    );
    expect(refusal(validateCodexArgs(['--', 'fork']))).toContain('fork');
    expect(refusal(validateCodexArgs(['exec', 'ls']))).toContain('exec');
  });

  test.each(['--model', '--ask-for-approval', '--sandbox', '--add-dir', '-m', '-a', '-s'])(
    'a value of %s that looks like a subcommand is a value, not a subcommand',
    (flag) => {
      expect(accepted(validateCodexArgs([flag, 'exec', 'a prompt'])).args).toEqual([
        flag,
        'exec',
        'a prompt',
      ]);
    },
  );

  test('a short flag with its value attached takes no next token, so a subcommand after it is seen', () => {
    expect(refusal(validateCodexArgs(['-mother', 'exec']))).toContain('exec');
    expect(refusal(validateCodexArgs(['-aon-request', 'review']))).toContain('review');
    expect(refusal(validateCodexArgs(['--model=x', 'fork']))).toContain('fork');
  });
});

describe('validateCodexArgs: denylisted flags, one case per entry', () => {
  const LONG_FLAGS = [
    '--config',
    '--enable',
    '--disable',
    '--profile',
    '--strict-config',
    '--dangerously-bypass-hook-trust',
    '--no-daemon',
    '--search',
    '--approve-for-me',
    '--remote',
    '--remote-auth-token-env',
    '--oss',
    '--local-provider',
    '--cd',
  ];

  test.each(LONG_FLAGS)('%s, bare, joined with =, and after a valued flag', (flag) => {
    expect(refusal(validateCodexArgs([flag]))).toContain(flag);
    expect(refusal(validateCodexArgs([`${flag}=value`]))).toContain(flag);
    expect(refusal(validateCodexArgs([flag, 'value']))).toContain(flag);
    expect(refusal(validateCodexArgs(['-m', 'x', flag, 'v', 'prompt']))).toContain(flag);
  });

  test.each(['c', 'p', 'C'])('-%s, bare and in every attached form', (letter) => {
    const flag = `-${letter}`;
    expect(refusal(validateCodexArgs([flag]))).toContain(flag);
    expect(refusal(validateCodexArgs([flag, 'key=value']))).toContain(flag);
    expect(refusal(validateCodexArgs([`${flag}key=value`]))).toContain(flag);
    expect(refusal(validateCodexArgs([`${flag}=value`]))).toContain(flag);
  });

  test('a denied short letter cannot hide in a cluster after another flag', () => {
    for (const letter of ['c', 'p', 'C']) {
      expect(refusal(validateCodexArgs([`-v${letter}`, 'x']))).toContain(`-${letter}`);
    }
  });

  test('-C and --cd say why: the session is identified by its working directory', () => {
    expect(refusal(validateCodexArgs(['-C', '/x']))).toContain('working directory');
    expect(refusal(validateCodexArgs(['--cd', '/x']))).toContain('working directory');
  });

  test('a denied flag is refused before a later valid resume or prompt is considered', () => {
    expect(refusal(validateCodexArgs(['resume', UUID, '--profile', 'p']))).toContain('--profile');
  });

  test('a flag that only starts like a denied one is not denied', () => {
    expect(accepted(validateCodexArgs(['--configuration-note'])).args).toEqual([
      '--configuration-note',
    ]);
    expect(accepted(validateCodexArgs(['--cdrom'])).args).toEqual(['--cdrom']);
  });
});

describe('validateCodexRemoteArgs: the default-deny allowlist', () => {
  function remoteOk(args: readonly unknown[]) {
    const result = validateCodexRemoteArgs(args);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    return result;
  }
  function remoteRefused(args: readonly unknown[]): string {
    const result = validateCodexRemoteArgs(args);
    if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.args)}`);
    return result.error;
  }

  test('no arguments is a fresh session', () => {
    expect(validateCodexRemoteArgs([])).toEqual({ ok: true, args: [], resumeThreadId: null });
  });

  test('accepts a model, an approval policy, a sandbox mode and resume, in any order', () => {
    const args = [
      '-s',
      'workspace-write',
      'resume',
      UUID,
      '--model',
      'gpt-5.1',
      '-a',
      'on-request',
    ];
    expect(remoteOk(args)).toEqual({ ok: true, args, resumeThreadId: UUID });
  });

  test('both model spellings and the allowed value sets', () => {
    expect(remoteOk(['-m', 'a.b_c:d[1]-2']).args).toEqual(['-m', 'a.b_c:d[1]-2']);
    expect(remoteOk(['-a', 'untrusted']).args).toEqual(['-a', 'untrusted']);
    expect(remoteOk(['-s', 'read-only']).args).toEqual(['-s', 'read-only']);
  });

  test('a model name is 1 to 64 characters of the allowed set and never starts with a hyphen', () => {
    expect(remoteOk(['-m', 'm'.repeat(64)]).args).toHaveLength(2);
    expect(remoteRefused(['-m', 'm'.repeat(65)])).toContain('model');
    for (const bad of ['', 'a b', 'a;b', 'a/b', '$(x)', '-c', '--profile', 'a\nb', 'é']) {
      expect(remoteRefused(['-m', bad]), JSON.stringify(bad)).toContain('model');
    }
    expect(remoteRefused(['-m'])).toContain('model');
  });

  test('approval policies and sandbox modes are the two allowed values each, nothing else', () => {
    for (const bad of ['never', 'on-failure', 'on_request', 'UNTRUSTED', '']) {
      expect(remoteRefused(['-a', bad]), bad).toContain('-a');
    }
    for (const bad of ['danger-full-access', 'workspace_write', 'READ-ONLY', '']) {
      expect(remoteRefused(['-s', bad]), bad).toContain('-s');
    }
    expect(remoteRefused(['-a'])).toContain('-a');
    expect(remoteRefused(['-s'])).toContain('-s');
  });

  test('resume needs a UUID', () => {
    expect(remoteRefused(['resume'])).toContain('resume');
    expect(remoteRefused(['resume', 'last'])).toContain('resume');
    expect(remoteRefused(['resume', UUID.slice(0, 8)])).toContain('resume');
    expect(remoteOk(['resume', UUID.toUpperCase()]).resumeThreadId).toBe(UUID);
  });

  test('each option at most once', () => {
    expect(remoteRefused(['-m', 'a', '--model', 'b'])).toContain('twice');
    expect(remoteRefused(['-a', 'untrusted', '-a', 'on-request'])).toContain('twice');
    expect(remoteRefused(['-s', 'read-only', '-s', 'workspace-write'])).toContain('twice');
    expect(remoteRefused(['resume', UUID, 'resume', UUID])).toContain('twice');
  });

  test('everything else is refused: a prompt, --, remi-owned flags, the = spelling, every local denylist entry', () => {
    const others = [
      'a prompt',
      '--',
      '--no-alt-screen',
      '--model=gpt-5',
      '-mgpt-5',
      '--ask-for-approval',
      '--sandbox',
      '--dangerously-bypass-approvals-and-sandbox',
      '--full-auto',
      '--add-dir',
      'exec',
      'fork',
      '-c',
      '-p',
      '-C',
      '--config',
      '--enable',
      '--disable',
      '--profile',
      '--strict-config',
      '--dangerously-bypass-hook-trust',
      '--no-daemon',
      '--search',
      '--approve-for-me',
      '--remote',
      '--remote-auth-token-env',
      '--oss',
      '--local-provider',
      '--cd',
    ];
    for (const arg of others) {
      expect(remoteRefused([arg]), arg).toContain('not allowed');
      // And behind an otherwise valid prefix.
      expect(remoteRefused(['-m', 'x', arg]), arg).toContain('not allowed');
    }
  });

  test('at most 16 arguments, 256 characters each, no NUL, only strings', () => {
    // Sixteen arguments is the most: four options with values, resume, and so on.
    const sixteen = ['-m', 'x', '-a', 'untrusted', '-s', 'read-only', 'resume', UUID];
    expect(remoteOk(sixteen).args).toHaveLength(8);
    expect(remoteRefused([...sixteen, ...sixteen, 'extra'])).toContain('at most 16');
    expect(remoteRefused(new Array(17).fill('x'))).toContain('at most 16');
    expect(remoteRefused(['-m', 'x'.repeat(257)])).toContain('256');
    expect(remoteRefused(['-m', 'a\0b'])).toContain('NUL');
    expect(remoteRefused(['-m', 5])).toContain('strings');
    expect(remoteRefused([null])).toContain('strings');
    expect(remoteRefused([{}])).toContain('strings');
  });

  test('exactly 16 arguments pass the count and fail only on their content', () => {
    // 16 valid-length tokens that are all `-m`: the count check passes, the grammar refuses.
    expect(remoteRefused(new Array(16).fill('-m'))).not.toContain('at most 16');
    expect(remoteRefused(new Array(16).fill('x'.repeat(256)))).not.toContain('256');
  });

  test('the returned arguments are a copy', () => {
    const input = ['-m', 'x'];
    const result = remoteOk(input);
    expect(result.args).toEqual(input);
    expect(result.args).not.toBe(input);
  });
});

describe('resolveCodexWorkingDirectory', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-codex-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an existing directory resolves to its realpath', () => {
    const real = fs.realpathSync(dir);
    expect(resolveCodexWorkingDirectory(dir)).toEqual({ ok: true, directory: real });
  });

  test('a symlink to a directory resolves to the directory it points at', () => {
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link);

    expect(resolveCodexWorkingDirectory(link)).toEqual({
      ok: true,
      directory: fs.realpathSync(target),
    });
  });

  test('a path that does not exist is refused', () => {
    const result = resolveCodexWorkingDirectory(path.join(dir, 'absent'));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('does not exist');
  });

  test('a dangling symlink is refused as not existing', () => {
    const link = path.join(dir, 'dangling');
    fs.symlinkSync(path.join(dir, 'gone'), link);

    const result = resolveCodexWorkingDirectory(link);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('does not exist');
  });

  test('a file is refused as not a directory', () => {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');

    const result = resolveCodexWorkingDirectory(file);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('not a directory');
  });

  test('a symlink to a file is refused as not a directory', () => {
    const file = path.join(dir, 'file.txt');
    const link = path.join(dir, 'to-file');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(file, link);

    const result = resolveCodexWorkingDirectory(link);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('not a directory');
  });
});
