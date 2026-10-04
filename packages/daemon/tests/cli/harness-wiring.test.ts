/**
 * `cli.ts` hands the harness to the handlers that name it on the wire (#1179).
 * The values are only reached on paths a black-box run rarely takes (a daemon
 * whose session record cannot be read, a resume of a Codex daemon), so these are
 * source-text pins, read through `stripComments` so a commented-out line cannot
 * satisfy them. The behavior each one feeds is pinned where it is used:
 * `handlers/connection-events-identity.test.ts`, `handlers/resume-session-events-wire.test.ts`
 * and the `integration/*-wire-identity.test.ts` files.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '../helpers/strip-comments.ts';

const cli = stripComments(
  readFileSync(resolve(import.meta.dir, '..', '..', 'src', 'cli.ts'), 'utf8'),
);

/** The text of the call that starts at `opener`, up to its closing `});`. */
function call(opener: string): string {
  const start = cli.indexOf(opener);
  if (start === -1) throw new Error(`cli.ts has no ${opener}`);
  return cli.slice(start, cli.indexOf('\n});', start));
}

describe('cli.ts passes the harness to its handlers (#1179)', () => {
  test("the connection handlers get the daemon's harness and the available harnesses", () => {
    const block = call('createConnectionHandlers({');
    expect(block).toContain('\n  harnessId,');
    expect(block).toContain('harnesses: () => harnessRegistry.available(),');
    // A hub hosts no session, so its session-less ack must not name a harness (G9).
    expect(block).toContain('hubMode: serveMode,');
  });

  test("the resume handlers get the daemon's harness and the available harnesses", () => {
    const block = call('createResumeSessionHandlers({');
    expect(block).toContain('\n  harnessId,');
    expect(block).toContain('harnesses: () => harnessRegistry.available(),');
  });

  test("the current-session resolver gets the daemon's harness", () => {
    expect(call('makeCurrentSessionResolver({')).toContain('\n  harnessId,');
  });

  test('the create-session handlers get the registry', () => {
    expect(call('createCreateSessionHandlers({')).toContain('harnesses: harnessRegistry,');
  });

  test('both live-sessions registrations name the harness', () => {
    const registrations = cli.split('liveSessionsRegistry.register({').slice(1);
    expect(registrations).toHaveLength(2);
    for (const rest of registrations) {
      expect(rest.slice(0, rest.indexOf('});'))).toContain('...liveEntryHarness(),');
    }
  });
});
