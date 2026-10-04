/**
 * The remote argument allowlist for Claude (#1179, #1165 B, amended by the Phase 5
 * review, ADR 0033). Default deny: each allowed form has a case that accepts it (so
 * removing an allowlist entry fails), and every flag the issue names as dangerous has
 * a case that refuses it. `--continue` is not allowed at all (the launch injects
 * `--session-id`, which Claude very likely rejects beside it) and `--fork-session`
 * only beside `--resume <uuid>`.
 */

import { describe, expect, test } from 'bun:test';
import { validateClaudeRemoteArgs } from '../../src/harness/claude-args.ts';

const UUID = '3f9c2a1e-0000-4000-8000-000000000001';

const accepted = (args: unknown) => {
  const result = validateClaudeRemoteArgs(args);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.args;
};
const refused = (args: unknown): string => {
  const result = validateClaudeRemoteArgs(args);
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(result.args)}`);
  return result.error;
};

describe('validateClaudeRemoteArgs: what is allowed', () => {
  test('nothing at all', () => {
    expect(accepted([])).toEqual([]);
  });

  test('--resume <uuid> and -r <uuid>', () => {
    expect(accepted(['--resume', UUID])).toEqual(['--resume', UUID]);
    expect(accepted(['-r', UUID])).toEqual(['-r', UUID]);
  });

  test('an accepted UUID comes out lowercase, whatever case it came in', () => {
    expect(accepted(['--resume', UUID.toUpperCase()])).toEqual(['--resume', UUID]);
    expect(accepted(['-r', UUID.toUpperCase(), '--fork-session'])).toEqual([
      '-r',
      UUID,
      '--fork-session',
    ]);
  });

  test('a model name keeps its case: only a UUID is lowercased', () => {
    expect(accepted(['--model', 'Claude-Opus-4.5'])).toEqual(['--model', 'Claude-Opus-4.5']);
  });

  test('--fork-session beside --resume <uuid>, in either order', () => {
    expect(accepted(['--resume', UUID, '--fork-session'])).toEqual([
      '--resume',
      UUID,
      '--fork-session',
    ]);
    expect(accepted(['--fork-session', '-r', UUID])).toEqual(['--fork-session', '-r', UUID]);
  });

  test('--model with a plain model name, bounded to 64 characters', () => {
    expect(accepted(['--model', 'opus'])).toEqual(['--model', 'opus']);
    expect(accepted(['--model', 'claude-sonnet-4.5:beta[1m]'])).toEqual([
      '--model',
      'claude-sonnet-4.5:beta[1m]',
    ]);
    expect(accepted(['--model', 'a'.repeat(64)])).toHaveLength(2);
    refused(['--model', 'a'.repeat(65)]);
  });

  test('every allowed flag together, in the order given', () => {
    const args = ['--model', 'opus', '--resume', UUID, '--fork-session'];
    expect(accepted(args)).toEqual(args);
  });
});

describe('validateClaudeRemoteArgs: what is refused', () => {
  test.each([
    '--dangerously-skip-permissions',
    '--settings',
    '--mcp-config',
    '--add-dir',
    '--append-system-prompt',
    '--session-id',
    '--permission-mode',
    '--allowedTools',
    '--print',
    '-p',
    '-n',
    '--name',
    '--bare',
    '--no-auth',
    '--daemon',
    '--bind',
    'a prompt',
    '',
  ])('%j', (token) => {
    expect(refused([token])).toContain('is not allowed');
    // A refused flag is refused after an allowed one too, and with a value after it.
    refused(['--model', 'opus', token]);
    refused([token, 'value']);
  });

  test('the =value spelling of an allowed flag', () => {
    refused(['--model=opus']);
    refused([`--resume=${UUID}`]);
  });

  test('--model needs a name that cannot be read as a flag', () => {
    refused(['--model']);
    refused(['--model', '']);
    refused(['--model', '--dangerously-skip-permissions']);
    refused(['--model', '-x']);
    refused(['--model', 'has space']);
    refused(['--model', 'semi;colon']);
    refused(['--model', '../path']);
  });

  test('--resume needs a UUID, and the whole value must be one (both ends are anchored)', () => {
    refused(['--resume']);
    refused(['--resume', 'not-a-uuid']);
    refused(['--resume', `${UUID}-extra`]);
    refused(['--resume', `${UUID}x`]);
    refused(['--resume', `x${UUID}`]);
    refused(['--resume', `-${UUID}`]);
    refused(['--resume', `${UUID}\n`]);
    refused(['--resume', '--continue']);
    refused(['-r']);
  });

  test('--continue and -c are refused on their own, by name, whatever follows', () => {
    // Claude's launch injects --session-id, which Claude very likely rejects beside --continue;
    // unverified, so refused. The message points at what is allowed.
    for (const flag of ['--continue', '-c']) {
      expect(refused([flag]), flag).toContain('--resume <uuid>');
      expect(refused([flag, '--resume', UUID]), flag).toContain('--resume <uuid>');
      expect(refused(['--resume', UUID, flag]), flag).toContain('--resume <uuid>');
      expect(refused(['--model', 'opus', flag]), flag).toContain('--resume <uuid>');
      expect(refused([flag, '--fork-session']), flag).toContain('--resume <uuid>');
    }
  });

  test('--fork-session without --resume <uuid> is refused, alone or with other flags, in either order', () => {
    expect(refused(['--fork-session'])).toContain('--fork-session needs --resume');
    expect(refused(['--model', 'opus', '--fork-session'])).toContain(
      '--fork-session needs --resume',
    );
    expect(refused(['--fork-session', '--model', 'opus'])).toContain(
      '--fork-session needs --resume',
    );
  });

  test('flag names are matched exactly, never case-folded', () => {
    for (const flag of ['--RESUME', '--Resume', '-R', '--MODEL', '--Model', '--CONTINUE', '-C']) {
      expect(refused([flag, UUID]), flag).toContain('is not allowed');
    }
    expect(refused(['--resume', UUID, '--FORK-SESSION'])).toContain('is not allowed');
    expect(refused(['--resume', UUID, '--Fork-Session'])).toContain('is not allowed');
  });

  test('an allowed slot given twice, by either spelling', () => {
    expect(refused(['--resume', UUID, '-r', UUID])).toContain('given twice');
    expect(refused(['--model', 'a', '--model', 'b'])).toContain('given twice');
    expect(refused(['--resume', UUID, '--fork-session', '--fork-session'])).toContain(
      'given twice',
    );
  });

  test('more than 16 arguments, an argument over 256 characters and NUL are refused by their own checks', () => {
    // Each input would be refused by a later rule too (a repeated slot, the model pattern, the
    // default deny), so only the message says which check fired: a removed bound must fail here.
    expect(refused(Array.from({ length: 17 }, () => '--fork-session'))).toContain('at most 16');
    expect(refused(['--model', 'a'.repeat(257)])).toContain('at most 256 characters');
    expect(refused(['--model', 'a\0b'])).toContain('NUL');
    expect(refused(['--cont\0inue'])).toContain('NUL');
    // Sixteen is the limit, not fifteen: a list of exactly 16 gets past the count check.
    expect(refused(Array.from({ length: 16 }, () => '--fork-session'))).toContain('given twice');
  });

  test('anything that is not an array of strings, without throwing', () => {
    for (const bad of [undefined, null, 'x', 7, {}, { length: 0 }, [1], [null], [['--model']]]) {
      expect(() => validateClaudeRemoteArgs(bad)).not.toThrow();
      refused(bad);
    }
  });
});
