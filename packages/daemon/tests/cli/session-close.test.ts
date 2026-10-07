/**
 * `disposeAndDismiss` (#1223): a closing session's teardown dismisses the cards it still held,
 * after the harness's own teardown, and never twice.
 */
import { describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import { disposeAndDismiss } from '../../src/cli/session-close.ts';

const A = 'a0000000-0000-4000-8000-000000000001' as UUID;
const B = 'b0000000-0000-4000-8000-000000000002' as UUID;

describe('disposeAndDismiss (#1223)', () => {
  test('disposes first, then dismisses each held card the disposal did not', () => {
    const events: string[] = [];
    const resolved = new Set<UUID>();
    disposeAndDismiss({
      dispose: () => {
        events.push('dispose');
        // The harness's own teardown dismisses one card itself (Codex does).
        resolved.add(A);
      },
      pendingQuestionIds: [A, B],
      alreadyResolved: resolved,
      dismiss: (id) => events.push(`dismiss ${id}`),
    });
    expect(events).toEqual(['dispose', `dismiss ${B}`]);
  });

  test('a disposal that throws is reported, and the held cards are still dismissed (#1268 review)', () => {
    const dismissed: UUID[] = [];
    const reported: unknown[] = [];
    const failure = new Error('dispose failed');
    expect(() =>
      disposeAndDismiss({
        dispose: () => {
          throw failure;
        },
        pendingQuestionIds: [A, B],
        alreadyResolved: new Set<UUID>(),
        dismiss: (id) => dismissed.push(id),
        onDisposeError: (error) => reported.push(error),
      }),
    ).not.toThrow();
    expect(dismissed).toEqual([A, B]);
    expect(reported).toEqual([failure]);
  });
});
