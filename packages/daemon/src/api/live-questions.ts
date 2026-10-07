/**
 * The tracker's live-question check (#712, `hasLiveQuestions`), as `cli.ts`
 * wires it: is a registered card standing for a prompt that may be on
 * screen? While one is, a PTY render is treated as that prompt's echo, not a
 * hook-less orphan.
 *
 * A held SUBAGENT card does not count (#1126 review): in daemon or hub mode a
 * subagent prompt is held for the phone, and its dialog does not render while
 * held, so a render then is something else, for example a main-agent sandbox
 * network or trust dialog. Counting it suppressed that dialog's card for up
 * to `daemon_hold_seconds`. Every other registered card still counts.
 */

import type { Question } from '@remi/shared';

export function hasLiveQuestionOnScreen(
  questions: Iterable<Pick<Question, 'id' | 'agentId'>>,
  isHeld: (questionId: string) => boolean,
): boolean {
  for (const q of questions) {
    if (q.agentId !== undefined && isHeld(q.id)) continue;
    return true;
  }
  return false;
}
