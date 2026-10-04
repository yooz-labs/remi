/**
 * The `remi attach` address that Codex messages and the hub's notice name (#1179 review, G11, G12):
 * the form `resolveTarget` reads, so what a person pastes (with the host filled in) reaches THIS
 * session and not the newest one on the machine.
 */

import { describe, expect, test } from 'bun:test';
import { resolveTarget } from '../../../src/cli/target-resolver.ts';
import { attachCommand } from '../../../src/harness/codex/attach-hint.ts';

const SESSION_ID = '55555555-5555-4555-8555-555555555555';

describe('attachCommand', () => {
  test('names the host as a placeholder, the port and the first eight characters of the session', () => {
    expect(attachCommand(19999, SESSION_ID)).toBe('remi attach <host>:19999/55555555');
  });

  test('with the host filled in, the real attach target resolver reads that session and port', () => {
    const address = attachCommand(19999, SESSION_ID)
      .replace('remi attach ', '')
      .replace('<host>', 'box');
    expect(
      resolveTarget({
        subcommandArg: address,
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: 8765,
      }),
    ).toEqual({ host: 'box', port: 19999, targetId: '55555555' });
  });
});
