/**
 * Every question the daemon builds carries the session's harness identity (#1179 review, G15).
 *
 * `createQuestion` makes `harness`, `harnessSessionId` and, for Claude, `claudeSessionId` from ONE
 * identity value, so the ids cannot differ. That holds for a path only if the path passes an
 * identity, and two transport adapters had a `sendQuestion` that did not (and that nothing called,
 * outside Telegram's own method): a future caller of either would have emitted a question naming no
 * harness, which a client reads as Claude. They are gone, and this reads the daemon's source so a
 * new call without an identity fails here.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { WebSocketAdapter } from '../src/adapters/websocket-adapter.ts';
import { RelayAdapter } from '../src/remote/relay-adapter.ts';
import { stripComments } from './helpers/strip-comments.ts';

const SRC = resolve(import.meta.dir, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** The arguments of each `createQuestion(...)` call in `source`, as the text between its parentheses. */
function callArguments(source: string): string[] {
  const out: string[] = [];
  for (
    let at = source.indexOf('createQuestion(');
    at !== -1;
    at = source.indexOf('createQuestion(', at + 1)
  ) {
    let depth = 0;
    for (let i = at + 'createQuestion'.length; i < source.length; i++) {
      const c = source[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      if (c === ')' || c === ']' || c === '}') depth--;
      if (depth === 0) {
        out.push(source.slice(at + 'createQuestion('.length, i));
        break;
      }
    }
  }
  return out;
}

/** The number of top-level arguments in `args`. */
function argumentCount(args: string): number {
  let depth = 0;
  let count = args.trim() === '' ? 0 : 1;
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) count++;
  }
  // A trailing comma ends the list; it does not start another argument.
  return /,\s*$/.test(args) ? count - 1 : count;
}

describe('the protocol createQuestion in the daemon (G15)', () => {
  // The parser has its own, unrelated `createQuestion`; only the protocol's is imported from shared.
  const files = sourceFiles(SRC).filter((file) =>
    /import\s*\{[^}]*\bcreateQuestion\b[^}]*\}\s*from\s*'@remi\/shared/.test(
      stripComments(readFileSync(file, 'utf8')),
    ),
  );

  test('there are production callers to read (the scan is not vacuous)', () => {
    expect(files.map((file) => relative(SRC, file)).sort()).toEqual([
      'cli/handlers/pending-question-resend.ts',
      'cli/session-phases/message-api-setup.ts',
    ]);
  });

  test('every call passes an identity as its third argument', () => {
    const bare: string[] = [];
    for (const file of files) {
      for (const args of callArguments(stripComments(readFileSync(file, 'utf8')))) {
        if (argumentCount(args) < 3) bare.push(`${relative(SRC, file)}: createQuestion(${args})`);
      }
    }
    expect(bare).toEqual([]);
  });

  test('the scan can fail: it counts the arguments of a call that has none to spare', () => {
    expect(argumentCount('question, sessionId')).toBe(2);
    expect(argumentCount('question, sessionId, identity')).toBe(3);
    expect(argumentCount('question, sessionId, identityFor(sessionId, a),')).toBe(3);
    expect(callArguments('const m = createQuestion(a, b);')).toEqual(['a, b']);
  });

  test('no transport adapter offers a way to send a question that names no identity', () => {
    expect('sendQuestion' in WebSocketAdapter.prototype).toBe(false);
    expect('sendQuestion' in RelayAdapter.prototype).toBe(false);
  });
});
