/**
 * `App.tsx` copies the daemon's harness onto the session it shows (#1179): from
 * a `hello_ack` (an existing session's patch and a new session's entry) and from
 * each `session_list_response` entry. `App.tsx` has no component test, so this
 * is a source-wiring pin, the repo's idiom for a wiring line nothing else
 * exercises: it reads each handler's text and requires the copy in it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'App.tsx'),
  'utf-8',
);

/** The text of one `case '<type>': {` block, up to the next `case` at the same indent. */
function caseBlock(type: string): string {
  const start = SOURCE.indexOf(`      case '${type}': {`);
  if (start === -1) throw new Error(`no case for ${type}`);
  const next = SOURCE.indexOf('\n      case ', start + 1);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

describe('App.tsx copies the harness onto the sessions it shows (#1179)', () => {
  test('hello_ack: onto an existing session and onto a new one', () => {
    const copy = '...(message.harness !== undefined && { harness: message.harness })';
    // Two copies split the block into three parts.
    expect(caseBlock('hello_ack').split(copy)).toHaveLength(3);
  });

  test('session_list_response: onto every listed session', () => {
    expect(caseBlock('session_list_response')).toContain(
      '...(ds.harness !== undefined && { harness: ds.harness })',
    );
  });
});
