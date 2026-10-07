/**
 * The part of a session's close that dismisses its cards (#1223), in its order: dispose the
 * harness session first, then dismiss every card the session still held that the disposal did not
 * already dismiss. `closeSession` clears the registry before it announces the close, so the
 * harness's own teardown cannot look those cards up; a card that teardown did dismiss (Codex's)
 * is in `alreadyResolved` by the time the loop reads it, and is not sent twice. A disposal that
 * throws is reported and the dismissals still run (#1268 review): before, the throw skipped them
 * and every step of the close after them.
 */
import type { UUID } from '@remi/shared';

export interface DisposeAndDismissInput {
  /** The harness session's teardown. */
  readonly dispose: () => void;
  /** The ids of the cards the registry still held when the session closed. */
  readonly pendingQuestionIds: readonly UUID[];
  /** Filled while `dispose` runs with every card it dismissed; read after it. */
  readonly alreadyResolved: ReadonlySet<UUID>;
  /** Dismiss one card on every client and lock screen. */
  readonly dismiss: (questionId: UUID) => void;
  /** Report a disposal that threw; the close goes on. */
  readonly onDisposeError: (error: unknown) => void;
}

export function disposeAndDismiss(input: DisposeAndDismissInput): void {
  try {
    input.dispose();
  } catch (error) {
    input.onDisposeError(error);
  }
  for (const questionId of input.pendingQuestionIds) {
    if (!input.alreadyResolved.has(questionId)) input.dismiss(questionId);
  }
}
