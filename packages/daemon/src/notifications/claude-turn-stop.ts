/**
 * Claude's way into the turn-event sink (#1180): the handler `cli.ts` registers as the
 * second `Stop` listener (#914). It decides whether a `Stop` is this daemon's turn and how long
 * the turn ran, and hands both to the sink, which owns the gate, the text and the fan-out
 * (`turn-events.ts`).
 *
 * It was a function inside `cli.ts`, which only source pins could reach; it is built from what it
 * needs so a test can run it with the real timer and the real sink.
 *
 * The order matters and is pinned:
 * 1. The #914 session filter FIRST. Claude Code broadcasts every event to every daemon
 *    registered for the directory, so an unfiltered Stop is very likely a sibling's. The timer
 *    cannot save us: `onAnyEvent` observes sibling events too, so `elapsedMs` comes back
 *    populated and plausible for a turn that was never ours. Fail closed: no admitting session
 *    means this turn is not claimed, and nothing is read or cleared.
 * 2. The turn's elapsed time, then the mark is cleared. A stop-hook re-entry means the turn is
 *    still going, not finished, so the mark stays: the eventual real Stop still needs the turn's
 *    original first-seen time to measure the full duration.
 *
 * Fire-and-forget, mirroring `deliverSubagentAlert`: a notification bug must never delay or break
 * the hook response Claude is blocking on. It deliberately does NOT check
 * `hook-bridge-setup.ts`'s `binder.admits()` (the transcript-binding validity gate its own Stop
 * listener uses): that state lives inside that file's closure, and this listener is a second,
 * additive registration that never touches it (#914 scope). remi is one session per daemon, so
 * every Stop this process's own hook server sees is this session's once the filter has passed.
 */

import type { UUID } from '@remi/shared';

import type { StopHookInput } from '../hooks/hook-types.ts';
import type { TurnEventSink } from './turn-events.ts';
import type { TurnTimer } from './turn-timer.ts';

export interface ClaudeTurnStopDeps {
  /** The #914 session filter: does some live session of this daemon claim the event? */
  admits: (input: StopHookInput) => boolean;
  /** The daemon-wide turn timer, fed by every hook event's `prompt_id`. */
  timer: Pick<TurnTimer, 'elapsedMs' | 'clear'>;
  /** The session the daemon hosts, once it is known; read when the Stop arrives. */
  primarySessionId: () => UUID | null;
  sink: Pick<TurnEventSink, 'turnCompleted'>;
}

/** What a session id is called before the daemon knows its session: it names none, so the push is titled "Agent". */
const UNBOUND = 'unbound';

export function createClaudeTurnStop(deps: ClaudeTurnStopDeps): (input: StopHookInput) => void {
  return (input: StopHookInput): void => {
    if (!deps.admits(input)) return;

    const elapsedMs = deps.timer.elapsedMs(input.prompt_id);
    if (!input.stop_hook_active) {
      deps.timer.clear(input.prompt_id);
    }

    deps.sink.turnCompleted({
      sessionId: deps.primarySessionId() ?? UNBOUND,
      elapsedMs,
      lastAssistantMessage: input.last_assistant_message,
      reentry: input.stop_hook_active,
    });
  };
}
