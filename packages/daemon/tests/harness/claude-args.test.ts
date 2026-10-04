/**
 * The remote argument allowlist for Claude (#1179, #1165 B). Default deny: each
 * allowed form has a case that accepts it (so removing an allowlist entry
 * fails), and every flag the issue names as dangerous has a case that refuses it.
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
    expect(accepted(['--resume', UUID.toUpperCase()])).toEqual(['--resume', UUID.toUpperCase()]);
  });

  test('--continue and -c', () => {
    expect(accepted(['--continue'])).toEqual(['--continue']);
    expect(accepted(['-c'])).toEqual(['-c']);
  });

  test('--fork-session', () => {
    expect(accepted(['--fork-session'])).toEqual(['--fork-session']);
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
    refused(['--continue', token]);
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

  test('--resume needs a UUID', () => {
    refused(['--resume']);
    refused(['--resume', 'not-a-uuid']);
    refused(['--resume', `${UUID}-extra`]);
    refused(['--resume', '--continue']);
    refused(['-r']);
  });

  test('an allowed slot given twice, by either spelling', () => {
    refused(['--continue', '-c']);
    refused(['--resume', UUID, '-r', UUID]);
    refused(['--model', 'a', '--model', 'b']);
    refused(['--fork-session', '--fork-session']);
  });

  test('more than 16 arguments, an argument over 256 characters, NUL', () => {
    refused(Array.from({ length: 17 }, () => '--fork-session'));
    refused(['--model', 'a'.repeat(257)]);
    refused(['--model', 'a\0b']);
    refused(['--cont\0inue']);
  });

  test('anything that is not an array of strings, without throwing', () => {
    for (const bad of [undefined, null, 'x', 7, {}, { length: 0 }, [1], [null], [['--continue']]]) {
      expect(() => validateClaudeRemoteArgs(bad)).not.toThrow();
      refused(bad);
    }
  });
});
