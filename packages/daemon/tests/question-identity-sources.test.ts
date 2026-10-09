/**
 * Every question the daemon builds carries the session's harness identity (#1179 review, G15;
 * the scan widened in round 2 of #1204, P8).
 *
 * `createQuestion` makes `harness`, `harnessSessionId` and, for Claude, `claudeSessionId` from ONE
 * identity value, so the ids cannot differ. That holds for a path only if the path passes an
 * identity, and two transport adapters had a `sendQuestion` that did not (and that nothing called,
 * outside Telegram's own method): a future caller of either would have emitted a question naming no
 * harness, which a client reads as Claude. They are gone, and this reads the daemon's source so a
 * new call without an identity fails here.
 *
 * The scan reads EVERY `.ts` file under `packages/daemon/src` for the identifier, whatever way it was
 * imported (a named import, `import * as shared`, a re-export), and a use is clean only when it is a
 * direct call with an identity as its third argument that is not the literal `undefined` or `null`.
 * An aliased import, a use as a value and a spread argument are refused because the scan cannot tell
 * what they pass. The parser's own, unrelated `createQuestion` is the one allowlisted file.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { WebSocketAdapter } from '../src/adapters/websocket-adapter.ts';
import { HubRelay } from '../src/remote/hub-relay.ts';
import { callArguments } from './helpers/call-arguments.ts';
import { stripComments } from './helpers/strip-comments.ts';

const SRC = resolve(import.meta.dir, '..', 'src');

/** The parser builds a different, local `createQuestion` of its own (an options list, not a message). */
const OWN_CREATE_QUESTION = ['parser/question-parser.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * What is wrong with the uses of `createQuestion` in `source` (comments already stripped), one
 * line each; empty when every use is a direct call that passes an identity.
 */
function offences(source: string): string[] {
  const out: string[] = [];
  // An import specifier list: `createQuestion` inside it is the import itself, which is fine unless aliased.
  const importSpans = [
    ...source.matchAll(/import\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g),
  ].map((m) => [m.index as number, (m.index as number) + m[0].length] as const);
  for (const match of source.matchAll(/\bcreateQuestion\b/g)) {
    const at = match.index as number;
    const end = at + 'createQuestion'.length;
    const rest = source.slice(end);
    if (importSpans.some(([from, to]) => at >= from && at < to)) {
      if (/^\s+as\s/.test(rest)) out.push('an aliased import of createQuestion');
      continue;
    }
    if (!rest.trimStart().startsWith('(')) {
      out.push('a use of createQuestion that is not a direct call');
      continue;
    }
    const open = end + rest.indexOf('(');
    const { args, spread } = callArguments(source, open);
    if (spread) out.push('a call with a spread argument');
    else if (args.length < 3) out.push(`a call with ${args.length} arguments`);
    else if (args[2] === 'undefined' || args[2] === 'null') {
      out.push(`a call whose identity is the literal ${args[2]}`);
    }
  }
  return out;
}

describe('every createQuestion in the daemon passes an identity (G15, P8)', () => {
  const files = sourceFiles(SRC).filter(
    (file) => !OWN_CREATE_QUESTION.includes(relative(SRC, file)),
  );
  const scanned = files.map((file) => ({
    name: relative(SRC, file),
    source: stripComments(readFileSync(file, 'utf8')),
  }));

  test('there are production callers to read (the scan is not vacuous), among every file scanned', () => {
    expect(scanned.length).toBeGreaterThan(150);
    const callers = scanned
      .filter(({ source }) => /\bcreateQuestion\s*\(/.test(source))
      .map(({ name }) => name)
      .sort();
    expect(callers).toEqual([
      'cli/handlers/pending-question-resend.ts',
      'cli/session-phases/message-api-setup.ts',
    ]);
  });

  test('every use in the daemon is a direct call with an identity', () => {
    const bad = scanned.flatMap(({ name, source }) => offences(source).map((o) => `${name}: ${o}`));
    expect(bad).toEqual([]);
  });

  test('the parser file that is skipped really is a separate createQuestion', () => {
    const parser = readFileSync(join(SRC, 'parser/question-parser.ts'), 'utf8');
    expect(parser).toMatch(/function createQuestion\(/);
    expect(parser).not.toMatch(
      /from '@remi\/shared[^']*'[^;]*createQuestion|createQuestion[^;]*from '@remi\/shared/,
    );
  });

  test('no transport adapter offers a way to send a question that names no identity', () => {
    expect('sendQuestion' in WebSocketAdapter.prototype).toBe(false);
    expect('sendQuestion' in HubRelay.prototype).toBe(false);
  });
});

describe('the scan itself can fail: synthetic offending source', () => {
  test.each([
    ['too few arguments', 'send(createQuestion(question, sessionId));', 'a call with 2 arguments'],
    [
      'a third argument that is the literal undefined',
      'createQuestion(question, sessionId, undefined)',
      'a call whose identity is the literal undefined',
    ],
    [
      'a third argument that is the literal null',
      'createQuestion(question, sessionId, null)',
      'a call whose identity is the literal null',
    ],
    [
      'a call through a namespace import',
      "import * as shared from '@remi/shared';\nshared.createQuestion(question, sessionId);",
      'a call with 2 arguments',
    ],
    [
      'an aliased import',
      "import { createQuestion as make } from '@remi/shared';\nmake(question, sessionId);",
      'an aliased import of createQuestion',
    ],
    [
      'a use as a value',
      'const build = createQuestion;\nitems.map(build);',
      'a use of createQuestion that is not a direct call',
    ],
    [
      'a re-export',
      "export { createQuestion } from '@remi/shared';",
      'a use of createQuestion that is not a direct call',
    ],
    ['a spread argument', 'createQuestion(...args)', 'a call with a spread argument'],
  ])('%s is reported', (_name, source, expected) => {
    expect(offences(source)).toContain(expected);
  });

  test.each([
    ['a plain call', 'createQuestion(question, sessionId, identity)'],
    [
      'a call through a namespace import, with an identity',
      'shared.createQuestion(q, s, identity)',
    ],
    [
      'an identity that is itself a call, over several lines, with commas in a string',
      "createQuestion(\n  makeQuestion('a, b', [1, 2]),\n  sessionId,\n  identityOf(sessionId, { a: 1, b: 2 }),\n)",
    ],
    ['a trailing comma', 'createQuestion(question, sessionId, identity,)'],
    ['the import itself', "import { createQuestion, generateId } from '@remi/shared';"],
    ['a type import', "import type { createQuestion } from '@remi/shared';"],
  ])('%s is clean', (_name, source) => {
    expect(offences(source)).toEqual([]);
  });

  test('a mention in a comment is not a use', () => {
    expect(offences(stripComments('// createQuestion(q, s)\n/* createQuestion(q) */'))).toEqual([]);
  });
});
