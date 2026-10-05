/**
 * `remi codex` argument validation (epic #1175, phase 2 #1176): the local
 * allowlist, the inserted `--`, the refusal messages, the remote allowlist and
 * the working directory rule. Each allowlisted flag, each denylisted flag (it
 * only picks the message) and each subcommand name has its own test, so
 * deleting one entry from the source fails exactly that test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type WorkingDirectoryFs,
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

describe('validateCodexArgs: what is accepted, and the shape it returns', () => {
  test('no arguments is a fresh session with nothing added', () => {
    expect(validateCodexArgs([])).toEqual({ ok: true, args: [], resumeThreadId: null });
  });

  test('a bare prompt gets an inserted -- so Codex can never read it as a subcommand', () => {
    expect(accepted(validateCodexArgs(['fix the failing test'])).args).toEqual([
      '--',
      'fix the failing test',
    ]);
  });

  test('flags come first, then the inserted --, then the prompt words', () => {
    expect(accepted(validateCodexArgs(['do it', '-m', 'a-model', 'now', '--yolo'])).args).toEqual([
      '-m',
      'a-model',
      '--yolo',
      '--',
      'do it',
      'now',
    ]);
  });

  test('a prompt that looks like a subcommand is safe after the inserted --', () => {
    expect(accepted(validateCodexArgs(['x', 'exec'])).args).toEqual(['--', 'x', 'exec']);
  });

  test('--no-alt-screen is accepted and removed, so the launch adds it exactly once', () => {
    expect(accepted(validateCodexArgs(['--no-alt-screen'])).args).toEqual([]);
    expect(
      accepted(validateCodexArgs(['--no-alt-screen', '-m', 'x', '--no-alt-screen', 'p'])).args,
    ).toEqual(['-m', 'x', '--', 'p']);
  });

  test('a user-typed -- ends the flags: what follows is prompt text, flag-shaped or not', () => {
    expect(accepted(validateCodexArgs(['--', '-c', 'x=y', '--profile', 'p'])).args).toEqual([
      '--',
      '-c',
      'x=y',
      '--profile',
      'p',
    ]);
    expect(accepted(validateCodexArgs(['-m', 'x', '--', '--oss'])).args).toEqual([
      '-m',
      'x',
      '--',
      '--oss',
    ]);
    expect(accepted(validateCodexArgs(['--', 'fork'])).args).toEqual(['--', 'fork']);
    expect(accepted(validateCodexArgs(['--', 'resume', UUID])).args).toEqual([
      '--',
      'resume',
      UUID,
    ]);
  });

  test('only the first -- ends the flags: a second one is prompt text too', () => {
    expect(accepted(validateCodexArgs(['-m', 'x', '--', 'a', '--', '-c'])).args).toEqual([
      '-m',
      'x',
      '--',
      'a',
      '--',
      '-c',
    ]);
  });

  test('a user -- with nothing after it adds nothing', () => {
    expect(accepted(validateCodexArgs(['-m', 'x', '--'])).args).toEqual(['-m', 'x']);
  });

  test('a lone - is a positional, not a flag', () => {
    expect(accepted(validateCodexArgs(['-'])).args).toEqual(['--', '-']);
    expect(accepted(validateCodexArgs(['-m', '-'])).args).toEqual(['-m', '-']);
  });
});

describe('validateCodexArgs: the allowlist, one test per flag', () => {
  test.each([
    ['-m', 'a-model'],
    ['--model', 'a-model'],
    ['-a', 'never'],
    ['--ask-for-approval', 'on-request'],
    ['-s', 'read-only'],
    ['--sandbox', 'workspace-write'],
    ['--add-dir', '/some/dir'],
    ['-i', 'a.png'],
    ['--image', 'a.png'],
  ])('%s takes a value as the next token', (flag, value) => {
    expect(accepted(validateCodexArgs([flag, value])).args).toEqual([flag, value]);
  });

  test.each(['--model', '--ask-for-approval', '--sandbox', '--add-dir', '--image'])(
    '%s accepts the --flag=value spelling',
    (flag) => {
      expect(accepted(validateCodexArgs([`${flag}=value`])).args).toEqual([`${flag}=value`]);
    },
  );

  test.each(['-m', '-a', '-s', '-i'])('%s accepts an attached value', (flag) => {
    expect(accepted(validateCodexArgs([`${flag}value`])).args).toEqual([`${flag}value`]);
    expect(accepted(validateCodexArgs([`${flag}=value`])).args).toEqual([`${flag}=value`]);
  });

  test.each([
    '--dangerously-bypass-approvals-and-sandbox',
    '--yolo',
    '--help',
    '--version',
    '-h',
    '-V',
  ])('%s is a flag with no value', (flag) => {
    expect(accepted(validateCodexArgs([flag])).args).toEqual([flag]);
    // A prompt after it is a prompt, not its value.
    expect(accepted(validateCodexArgs([flag, 'a prompt'])).args).toEqual([flag, '--', 'a prompt']);
  });

  test.each(['--yolo', '--help', '--version', '--dangerously-bypass-approvals-and-sandbox'])(
    '%s refuses a joined value',
    (flag) => {
      expect(refusal(validateCodexArgs([`${flag}=1`]))).toContain(`${flag} takes no value`);
    },
  );

  test('a flag that only starts like an allowed one is not allowed', () => {
    expect(refusal(validateCodexArgs(['--modelx', 'a']))).toContain('--modelx');
    expect(refusal(validateCodexArgs(['--yoloo']))).toContain('--yoloo');
    expect(refusal(validateCodexArgs(['--sandboxes', 'a']))).toContain('--sandboxes');
  });

  test('a cluster of short flags is not allowed, even of allowed letters', () => {
    expect(refusal(validateCodexArgs(['-hV']))).toContain('-h');
    expect(refusal(validateCodexArgs(['-Vh']))).toContain('-V');
  });

  test('every other flag is refused with a message naming it', () => {
    for (const flag of ['--full-auto', '--fancy', '--sandbox-mode', '-Z', '-5']) {
      const error = refusal(validateCodexArgs([flag]));
      expect(error, flag).toContain(`remi codex does not support ${flag} yet`);
      expect(error, flag).toContain('run codex directly');
    }
    expect(refusal(validateCodexArgs(['--fancy=value']))).toContain('--fancy yet');
    expect(refusal(validateCodexArgs(['-vc']))).toContain('-v yet');
  });
});

describe('validateCodexArgs: a valued flag never takes a flag-shaped token as its value', () => {
  const COUNTEREXAMPLES: string[][] = [
    ['-m', '-c', 'x=y'],
    ['-a', '--remote=unix:///x'],
    ['--add-dir', '--profile', 'p'],
    ['-s', '-C', '/tmp'],
    ['--sandbox', '--oss'],
    ['-s', '--no-alt-screen'],
    ['-m', '--model'],
    ['--image', '-m', 'x'],
  ];

  test.each(COUNTEREXAMPLES.map((args) => [args.join(' '), args] as const))(
    '%s is a refusal that says the first flag needs a value',
    (_name, args) => {
      expect(refusal(validateCodexArgs(args))).toMatch(/needs a value/);
    },
  );

  test.each([['--model'], ['-m'], ['--ask-for-approval'], ['-a'], ['--sandbox'], ['-s'], ['-i']])(
    'a trailing %s with no value is a refusal',
    (flag) => {
      expect(refusal(validateCodexArgs([flag]))).toContain(`${flag.replace(/^--?/, '')}`);
      expect(refusal(validateCodexArgs([flag]))).toMatch(/needs a value/);
      expect(refusal(validateCodexArgs(['x', flag]))).toMatch(/needs a value/);
    },
  );

  test('a value that merely contains a hyphen is still a value', () => {
    expect(accepted(validateCodexArgs(['-m', 'gpt-5-codex'])).args).toEqual(['-m', 'gpt-5-codex']);
    expect(accepted(validateCodexArgs(['-m', 'x-'])).args).toEqual(['-m', 'x-']);
  });

  test('a flag value that looks like a subcommand is a value, not a subcommand', () => {
    expect(accepted(validateCodexArgs(['-m', 'exec', 'a prompt'])).args).toEqual([
      '-m',
      'exec',
      '--',
      'a prompt',
    ]);
  });
});

describe('validateCodexArgs: -i/--image with resume (W16)', () => {
  // `-i` may take several values; then clap would read `resume` and the id as image paths and
  // start a fresh session while remi expects the thread. Unverified, so refused.
  const spellings: string[][] = [
    ['-i', 'shot.png'],
    ['-ishot.png'],
    ['--image', 'shot.png'],
    ['--image=shot.png'],
  ];
  for (const image of spellings) {
    test(`${image.join(' ')} together with resume is refused, whichever side it is on`, () => {
      for (const args of [
        [...image, 'resume', UUID],
        ['resume', UUID, ...image],
        ['resume', ...image, UUID],
      ]) {
        const message = refusal(validateCodexArgs(args));
        expect(message).toContain('-i/--image');
        expect(message).toContain('resume');
        expect(message).toContain('image paths');
      }
    });
  }

  test('an image on a fresh session, and resume without an image, are accepted', () => {
    expect(accepted(validateCodexArgs(['-i', 'shot.png', 'fix it'])).args).toEqual([
      '-i',
      'shot.png',
      '--',
      'fix it',
    ]);
    expect(accepted(validateCodexArgs(['-m', 'x', 'resume', UUID])).resumeThreadId).toBe(UUID);
  });

  test('a model or directory whose value merely looks like an image flag is not one', () => {
    expect(accepted(validateCodexArgs(['--add-dir', '/work/images', 'resume', UUID])).args).toEqual(
      ['--add-dir', '/work/images', 'resume', UUID],
    );
  });
});

describe('validateCodexArgs: resume <uuid>', () => {
  test('is the one subcommand run, and reports the thread id', () => {
    expect(validateCodexArgs(['resume', UUID])).toEqual({
      ok: true,
      args: ['resume', UUID],
      resumeThreadId: UUID,
    });
  });

  test('flags are returned first and resume <uuid> last, whichever side the user put them', () => {
    expect(accepted(validateCodexArgs(['-m', 'x', 'resume', UUID])).args).toEqual([
      '-m',
      'x',
      'resume',
      UUID,
    ]);
    expect(accepted(validateCodexArgs(['resume', UUID, '-m', 'x'])).args).toEqual([
      '-m',
      'x',
      'resume',
      UUID,
    ]);
    expect(accepted(validateCodexArgs(['resume', '-m', 'x', UUID])).args).toEqual([
      '-m',
      'x',
      'resume',
      UUID,
    ]);
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

  test('resume after other positionals is prompt text, behind the inserted --', () => {
    expect(accepted(validateCodexArgs(['a prompt', 'resume', UUID])).args).toEqual([
      '--',
      'a prompt',
      'resume',
      UUID,
    ]);
  });

  test('--last is not a supported flag, so resume --last is refused by name', () => {
    expect(refusal(validateCodexArgs(['resume', '--last']))).toContain('--last');
    expect(refusal(validateCodexArgs(['resume', UUID, '--last']))).toContain('--last');
  });

  test.each([
    ['no id', ['resume']],
    ['the picker with options only', ['resume', '-m', 'x']],
    ['an id that is not a UUID', ['resume', 'not-a-uuid']],
    ['a short id prefix', ['resume', UUID.slice(0, 8)]],
    ['text before the UUID', ['resume', `x${UUID}`]],
    ['text after the UUID', ['resume', `${UUID}x`]],
    ['a prompt after the id', ['resume', UUID, 'continue please']],
    ['a prompt after -- ', ['resume', UUID, '--', 'continue']],
    ['a second resume', ['resume', UUID, 'resume', UUID]],
  ])('is refused with %s', (_name, args) => {
    expect(refusal(validateCodexArgs(args))).toMatch(/resume/);
  });
});

describe('validateCodexArgs: a Codex subcommand name as the first positional is refused clearly', () => {
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
    'agents',
    'queue',
    'archive',
    'unarchive',
    'delete',
    'migrate-rollouts',
    'plugin',
    'doctor',
    'features',
    'execpolicy',
    'exec-server',
    'responses-api-proxy',
    'stdio-to-uds',
    'cloud-tasks',
    'update',
    'app',
    'remote-control',
    'a',
  ];

  test.each(SUBCOMMANDS)('%s', (subcommand) => {
    const error = refusal(validateCodexArgs([subcommand]));
    expect(error).toContain('interactive TUI only');
    expect(error).toContain(`${subcommand} is a Codex subcommand`);
    expect(error).toContain('after --');
  });

  test('also after allowed flags and their values, and with a prompt behind it', () => {
    expect(refusal(validateCodexArgs(['-m', 'x', 'exec']))).toContain('exec is a Codex');
    expect(refusal(validateCodexArgs(['--model', 'x', '-a', 'never', 'login']))).toContain(
      'login is a Codex',
    );
    expect(refusal(validateCodexArgs(['exec', 'ls']))).toContain('exec is a Codex');
  });

  test('the same word is plain prompt text after the user typed --, or after another word', () => {
    expect(accepted(validateCodexArgs(['--', 'exec', 'ls'])).args).toEqual(['--', 'exec', 'ls']);
    expect(accepted(validateCodexArgs(['run', 'exec'])).args).toEqual(['--', 'run', 'exec']);
  });

  test('the list is only a message: a name it does not know is still safe behind the --', () => {
    expect(accepted(validateCodexArgs(['a-new-subcommand', 'x'])).args).toEqual([
      '--',
      'a-new-subcommand',
      'x',
    ]);
  });
});

describe('validateCodexArgs: flags remi knows it must not pass, with the reason', () => {
  const CWD_FLAGS = ['--cd', '--worktree'];
  const SERVER_FLAGS = [
    '--config',
    '--enable',
    '--disable',
    '--profile',
    '--strict-config',
    '--dangerously-bypass-hook-trust',
    '--no-daemon',
    '--remote',
    '--remote-auth-token-env',
  ];
  const APPROVAL_FLAGS = ['--approve-for-me', '--not-so-yolo'];
  const SETUP_FLAGS = ['--search', '--oss', '--local-provider'];

  function reasonedRefusal(args: string[], flag: string, reason: string): void {
    const error = refusal(validateCodexArgs(args));
    expect(error, JSON.stringify(args)).toContain(`remi codex refuses ${flag} on purpose`);
    expect(error, JSON.stringify(args)).toContain(reason);
  }

  const cwdReason = 'working directory';
  const serverReason = 'app-server';
  const approvalReason = 'approval requests';
  const setupReason = 'does not model yet';

  test.each(CWD_FLAGS)('%s: bare, joined, with a value, and after a valued flag', (flag) => {
    reasonedRefusal([flag], flag, cwdReason);
    reasonedRefusal([`${flag}=value`], flag, cwdReason);
    reasonedRefusal([flag, 'value'], flag, cwdReason);
    reasonedRefusal(['-m', 'x', flag, 'v', 'prompt'], flag, cwdReason);
  });

  test.each(SERVER_FLAGS)('%s: bare, joined, with a value, and after a valued flag', (flag) => {
    reasonedRefusal([flag], flag, serverReason);
    reasonedRefusal([`${flag}=value`], flag, serverReason);
    reasonedRefusal([flag, 'value'], flag, serverReason);
    reasonedRefusal(['-m', 'x', flag, 'v', 'prompt'], flag, serverReason);
  });

  test.each(APPROVAL_FLAGS)('%s: bare, joined, with a value, and after a valued flag', (flag) => {
    reasonedRefusal([flag], flag, approvalReason);
    reasonedRefusal([`${flag}=value`], flag, approvalReason);
    reasonedRefusal([flag, 'value'], flag, approvalReason);
    reasonedRefusal(['-m', 'x', flag, 'v', 'prompt'], flag, approvalReason);
  });

  test.each(SETUP_FLAGS)('%s: bare, joined, with a value, and after a valued flag', (flag) => {
    reasonedRefusal([flag], flag, setupReason);
    reasonedRefusal([`${flag}=value`], flag, setupReason);
    reasonedRefusal([flag, 'value'], flag, setupReason);
    reasonedRefusal(['-m', 'x', flag, 'v', 'prompt'], flag, setupReason);
  });

  test.each([
    ['c', serverReason],
    ['p', serverReason],
    ['C', cwdReason],
  ])('-%s: bare and in every attached form', (letter, reason) => {
    const flag = `-${letter}`;
    reasonedRefusal([flag], flag, reason);
    reasonedRefusal([flag, 'key=value'], flag, reason);
    reasonedRefusal([`${flag}key=value`], flag, reason);
    reasonedRefusal([`${flag}=value`], flag, reason);
  });

  test('-C, --cd and --worktree say why: the session is identified by its working directory', () => {
    for (const flag of ['-C', '--cd', '--worktree']) {
      expect(refusal(validateCodexArgs([flag, '/x']))).toContain('change directory first');
    }
  });

  test('a flag-shaped token after a valued flag is refused as a missing value, naming the valued flag', () => {
    expect(refusal(validateCodexArgs(['-m', '--profile', 'p']))).toContain('-m needs a value');
  });

  test('a denied flag is refused before a later valid resume or prompt is considered', () => {
    expect(refusal(validateCodexArgs(['resume', UUID, '--profile', 'p']))).toContain('--profile');
    expect(refusal(validateCodexArgs(['a prompt', '--worktree']))).toContain('--worktree');
  });

  test('a flag after the user typed -- is prompt text, not a denied flag', () => {
    expect(accepted(validateCodexArgs(['--', '--worktree', 'x'])).args).toEqual([
      '--',
      '--worktree',
      'x',
    ]);
  });
});

describe('validateCodexRemoteArgs: the default-deny allowlist', () => {
  function remoteOk(args: unknown) {
    const result = validateCodexRemoteArgs(args);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    return result;
  }
  function remoteRefused(args: unknown): string {
    const result = validateCodexRemoteArgs(args);
    if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.args)}`);
    return result.error;
  }

  test('no arguments is a fresh session', () => {
    expect(validateCodexRemoteArgs([])).toEqual({ ok: true, args: [], resumeThreadId: null });
  });

  test('accepts a model, a sandbox mode and resume; resume <uuid> is returned last', () => {
    const args = ['-s', 'read-only', 'resume', UUID, '--model', 'gpt-5.1'];
    expect(remoteOk(args)).toEqual({
      ok: true,
      args: ['-s', 'read-only', '--model', 'gpt-5.1', 'resume', UUID],
      resumeThreadId: UUID,
    });
  });

  test('both model spellings and the allowed value sets', () => {
    expect(remoteOk(['-m', 'a.b_c:d[1]-2']).args).toEqual(['-m', 'a.b_c:d[1]-2']);
    expect(remoteOk(['--model', 'x']).args).toEqual(['--model', 'x']);
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

  test('a remote request may only tighten the host posture: -s read-only, nothing looser (H3)', () => {
    // `workspace-write` was allowed until the Phase 5 review: a remote client must not loosen what
    // the host chose (widening needs a person at the terminal). `-a` has its own test, below.
    for (const bad of [
      'workspace-write',
      'danger-full-access',
      'workspace_write',
      'READ-ONLY',
      'read-only ',
      '',
    ]) {
      expect(remoteRefused(['-s', bad]), bad).toContain('-s may only be read-only');
    }
    expect(remoteRefused(['-s'])).toContain('-s may only be read-only');
  });

  test('a remote request carries no -a at all: no value of it can be shown to tighten the host (LV-4)', () => {
    // Codex 0.160.0 rejects `-a untrusted` (exit 2; it accepts only `on-request` and `never`), and
    // neither of those is known to be stricter than what the host chose, which may already ask for
    // more. So every spelling gets the one refusal that says why, wherever it stands in the list.
    const spellings = [
      ['-a'],
      ['-a', 'untrusted'],
      ['-a', 'on-request'],
      ['-a', 'never'],
      ['-a', ''],
      ['--ask-for-approval'],
      ['--ask-for-approval', 'on-request'],
      ['--ask-for-approval=never'],
      ['--ask-for-approval='],
      ['-aon-request'],
      ['-a=never'],
    ];
    for (const spelling of spellings) {
      for (const args of [
        spelling,
        ['-m', 'x', ...spelling],
        [...spelling, '-m', 'x'],
        ['-s', 'read-only', 'resume', UUID, ...spelling],
        [...spelling, ...spelling],
      ]) {
        const text = remoteRefused(args);
        expect(text, JSON.stringify(args)).toContain('-a/--ask-for-approval is not allowed');
        expect(text, JSON.stringify(args)).toContain('may only tighten');
        expect(text, JSON.stringify(args)).not.toContain('may only be untrusted');
      }
    }
  });

  test('the -a refusal is one whole sentence that says why, and names no Codex version', () => {
    expect(remoteRefused(['-a', 'never'])).toBe(
      "remote codex arguments: -a/--ask-for-approval is not allowed: a remote request may only tighten the host's posture, and no value of it can be shown to tighten it (Codex accepts only on-request and never, and the host's own setting may already be stricter); set it in the host's Codex configuration or at its terminal",
    );
  });

  test.each([
    [['-sa']],
    [['-ma']],
    [['-m', '-a']],
    [['-s', '-a']],
    [['resume', '-a']],
    [['-m', 'x', '-s', '-a']],
  ])(
    '%j cannot carry -a past the remote validator by hiding it as a value or in a cluster',
    (args) => {
      // Whatever the message, it is a refusal: none of these may come out `ok` with an -a in it.
      expect(remoteRefused(args)).toBeTypeOf('string');
    },
  );

  test('resume needs a UUID', () => {
    expect(remoteRefused(['resume'])).toContain('resume');
    expect(remoteRefused(['resume', 'last'])).toContain('resume');
    expect(remoteRefused(['resume', UUID.slice(0, 8)])).toContain('resume');
    expect(remoteRefused(['resume', `x${UUID}`])).toContain('resume');
    expect(remoteRefused(['resume', `${UUID}x`])).toContain('resume');
    expect(remoteOk(['resume', UUID.toUpperCase()]).resumeThreadId).toBe(UUID);
  });

  test('an accepted resume UUID comes out lowercase in the arguments too, whatever case it came in (G5)', () => {
    expect(remoteOk(['resume', UUID.toUpperCase()]).args).toEqual(['resume', UUID]);
    expect(remoteOk(['-m', 'x', 'resume', UUID.toUpperCase()]).args).toEqual([
      '-m',
      'x',
      'resume',
      UUID,
    ]);
  });

  test('each option at most once', () => {
    expect(remoteRefused(['-m', 'a', '--model', 'b'])).toContain('twice');
    expect(remoteRefused(['-s', 'read-only', '-s', 'read-only'])).toContain('twice');
    expect(remoteRefused(['resume', UUID, 'resume', UUID])).toContain('twice');
  });

  test('everything else is refused: a prompt, --, remi-owned flags, the = spelling, every local flag not on the list', () => {
    const others = [
      'a prompt',
      '--',
      '--no-alt-screen',
      '--model=gpt-5',
      '-mgpt-5',
      '--sandbox',
      '--dangerously-bypass-approvals-and-sandbox',
      '--yolo',
      '--full-auto',
      '--add-dir',
      '-i',
      '--image',
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
      '--not-so-yolo',
      '--remote',
      '--remote-auth-token-env',
      '--oss',
      '--local-provider',
      '--cd',
      '--worktree',
    ];
    for (const arg of others) {
      expect(remoteRefused([arg]), arg).toContain('not allowed');
      // And behind an otherwise valid prefix.
      expect(remoteRefused(['-m', 'x', arg]), arg).toContain('not allowed');
    }
  });

  test('at most 16 arguments, 256 characters each, no NUL, only strings', () => {
    const six = ['-m', 'x', '-s', 'read-only', 'resume', UUID];
    expect(remoteOk(six).args).toHaveLength(6);
    expect(remoteRefused([...six, ...six, ...six])).toContain('at most 16');
    expect(remoteRefused(new Array(17).fill('x'))).toContain('at most 16');
    expect(remoteRefused(['-m', 'x'.repeat(257)])).toContain('256');
    expect(remoteRefused(['-m', 'a\0b'])).toContain('NUL');
    expect(remoteRefused(['-m', 5])).toContain('strings');
    expect(remoteRefused([null])).toContain('strings');
    expect(remoteRefused([{}])).toContain('strings');
  });

  test('exactly 16 arguments pass the count and fail only on their content', () => {
    expect(remoteRefused(new Array(16).fill('-m'))).not.toContain('at most 16');
    expect(remoteRefused(new Array(16).fill('x'.repeat(256)))).not.toContain('256');
  });

  test('it is total: anything that is not an array of strings is a refusal, never a throw', () => {
    for (const bad of [
      undefined,
      null,
      5,
      true,
      'resume',
      {},
      { length: 0 },
      { length: 1, 0: '-m' },
      new Set(['-m']),
      () => [],
      Symbol('x'),
      10n,
    ]) {
      expect(() => validateCodexRemoteArgs(bad), String(typeof bad)).not.toThrow();
      expect(remoteRefused(bad), String(typeof bad)).toContain('must be an array');
    }
  });

  test('a sparse array or one with a hole is a refusal', () => {
    expect(remoteRefused(new Array(2))).toContain('strings');
    // biome-ignore lint/suspicious/noSparseArray: a hole is the case under test
    expect(remoteRefused(['-m', , 'x'])).toContain('strings');
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
    // A test below makes directories unreadable; restore before removing.
    for (const entry of fs.readdirSync(dir)) {
      try {
        fs.chmodSync(path.join(dir, entry), 0o755);
      } catch {
        // already gone or a dangling link
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function failure(directory: string, ops?: WorkingDirectoryFs): string {
    const result = resolveCodexWorkingDirectory(directory, ops);
    if (result.ok) throw new Error(`expected a refusal, got ${result.directory}`);
    return result.error;
  }

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

  test('the empty string is refused, not resolved to the process cwd', () => {
    expect(failure('')).toContain('empty');
    expect(failure(undefined as unknown as string)).toContain('empty');
  });

  test('a path that does not exist is refused as ENOENT', () => {
    expect(failure(path.join(dir, 'absent'))).toContain('does not exist');
  });

  test('a dangling symlink is refused as not existing', () => {
    const link = path.join(dir, 'dangling');
    fs.symlinkSync(path.join(dir, 'gone'), link);

    expect(failure(link)).toContain('does not exist');
  });

  test('a symlink loop is refused as ELOOP', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);

    expect(failure(a)).toContain('symlink loop');
  });

  test('a path through a file is refused as ENOTDIR', () => {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');

    expect(failure(path.join(file, 'child'))).toContain('path component that is not a directory');
  });

  test('a directory behind an unreadable parent is refused as a permission error', () => {
    const parent = path.join(dir, 'locked');
    fs.mkdirSync(path.join(parent, 'inner'), { recursive: true });
    fs.chmodSync(parent, 0o000);

    expect(failure(path.join(parent, 'inner'))).toContain('permission denied');
  });

  test('a directory this process cannot search is refused, though it resolves and is a directory', () => {
    const closed = path.join(dir, 'closed');
    fs.mkdirSync(closed);
    fs.chmodSync(closed, 0o600);

    expect(failure(closed)).toContain('permission denied');
  });

  test('a file is refused as not a directory', () => {
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x');

    expect(failure(file)).toContain('not a directory');
  });

  test('a symlink to a file is refused as not a directory', () => {
    const file = path.join(dir, 'file.txt');
    const link = path.join(dir, 'to-file');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(file, link);

    expect(failure(link)).toContain('not a directory');
  });

  test('a directory that vanishes between the checks is a refusal, not a throw', () => {
    const vanishing: WorkingDirectoryFs = {
      realpathSync: (p) => fs.realpathSync(p),
      statSync: () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      },
      accessSync: () => {},
    };

    expect(failure(dir, vanishing)).toContain('does not exist');
  });

  test('an access failure after a successful stat is a refusal naming its errno', () => {
    const denied: WorkingDirectoryFs = {
      realpathSync: (p) => fs.realpathSync(p),
      statSync: (p) => fs.statSync(p),
      accessSync: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };

    expect(failure(dir, denied)).toContain('permission denied');
  });

  test('an unexpected errno is a refusal that names it', () => {
    const odd: WorkingDirectoryFs = {
      realpathSync: () => {
        throw Object.assign(new Error('odd'), { code: 'EMFILE' });
      },
      statSync: (p) => fs.statSync(p),
      accessSync: () => {},
    };

    expect(failure(dir, odd)).toContain('EMFILE');
  });
});
