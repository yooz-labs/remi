/**
 * Whether the prompt the PTY parser observed is a NUMBERED selection box
 * (#1140): the shape where typed text is ignored and the Enter after it
 * confirms the highlighted option. Shared by the chat guard
 * (`onUserInput`) and the Stop handler (`/exit` typed into a menu).
 *
 * The test is on the option VALUES, which the parser takes from the screen's
 * own numbering: a Claude selection box yields "1", "2", "3", while a
 * subprocess `(y/n)` prompt (and Claude prose that ends in "(y/n)") yields
 * "y" and "n". Those take typed text, so they must stay typeable; a refusal
 * there would block the one reply the prompt is waiting for.
 *
 * An empty or absent list is not a menu: a free-text prompt, or nothing
 * observed.
 */

import type { QuestionOption } from '@remi/shared';

const NUMBERED_VALUE = /^\d+$/;

export function isNumberedMenu(options: readonly QuestionOption[] | null | undefined): boolean {
  return (
    options !== null &&
    options !== undefined &&
    options.length > 0 &&
    options.every((o) => NUMBERED_VALUE.test(o.value))
  );
}
