/**
 * How cli.ts wires the question resolver (#1235, #1292 review). cli.ts is a module-level script
 * with no seam to drive these lines, so they are pinned in its source, as other cli.ts wiring is.
 * The behavior behind each line is tested where it lives (`question-resolution.test.ts`, the
 * answer handler, the gate, the hook bridge).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLI = fs.readFileSync(path.join(import.meta.dir, '../../src/cli.ts'), 'utf-8');

/** The source of the block that starts at `start`, up to the first `end` after it. */
function block(start: string, end: string): string {
  const from = CLI.indexOf(start);
  if (from < 0) throw new Error(`not found: ${start}`);
  const to = CLI.indexOf(end, from);
  if (to < 0) throw new Error(`no end after: ${start}`);
  return CLI.slice(from, to);
}

describe('cli.ts wires the question resolver (#1235)', () => {
  test('every dismissal goes through the one resolver, with its cause', () => {
    const fn = block('const onQuestionResolved = (', '\n};');
    expect(fn).toContain('resolvedBy?: ResolvedBy');
    expect(fn).toContain('questionResolver.resolve(sessionId, questionId, reason, resolvedBy)');
    // Nothing else builds a question_resolved.
    expect(CLI).not.toContain('createQuestionResolved(');
  });

  test("a session's close names the cause its reason gives", () => {
    const loop = block('disposeAndDismiss({', '\n        });');
    expect(loop).toContain(
      "onQuestionResolved(sessionId, questionId, 'cancelled', causeOfSessionClose(reason))",
    );
  });

  test("the answer handler's resolution is passed through as it is", () => {
    expect(CLI).toContain(
      'onQuestionResolved(sessionId, questionId, resolution.reason, resolution.resolvedBy)',
    );
  });

  test('a card the registry holds again can be resolved again', () => {
    const changed = block(
      'onQuestionsChanged: (sessionId, questions) => {',
      'liveSessionsRegistry',
    );
    expect(changed).toContain('questionResolver.noteLive(questions.map((q) => q.id))');
  });
});
