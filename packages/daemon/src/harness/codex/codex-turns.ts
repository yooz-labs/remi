/**
 * Codex turn events (#1180, Phase 6 of the Codex epic #1175): what the
 * app-server's `turn/completed` becomes in the turn-event sink
 * (`notifications/turn-events.ts`), the same sink Claude's `Stop` hook ends in.
 *
 * `turn/completed` carries the whole turn: `status` (`completed`, `interrupted`,
 * `failed`), `durationMs`, `error` (`message`, `codexErrorInfo`) and, in
 * `items`, the turn's final `agentMessage` with `phase: "final_answer"`
 * (a real frame: `expA-accept.jsonl:74`). The mapping:
 *
 * - `completed`: `turnCompleted` with the turn's duration and its final answer,
 *   then `turnSucceeded` (a later good turn clears a stale failure notice). The
 *   sink applies the same gates as for Claude: `notifications.on_turn_complete`,
 *   `turn_complete_min_seconds`, the per-device preference, a message to show.
 *   A turn with no `final_answer` message (a model that sends no phase) has
 *   nothing to show, so it stays silent, as an empty `last_assistant_message`
 *   does for Claude; one line without content says so (and the items view).
 * - `failed`: `turnFailed` naming Codex, with `error.message` as the details and
 *   `codexErrorInfo` as the code when it is a string. Never gated by
 *   `on_turn_complete` (a failed turn is the one turn end a user must not miss).
 * - `interrupted`: `turnSucceeded` only. Someone stopped the turn; that is neither
 *   a "done" push nor a failure, and it proves a failure notice stale. The bounded
 *   LV-5 capture showed this status after phone No (`cancel`), TUI Esc and
 *   `turn/interrupt`; the earlier decline run answered `decline` and reported
 *   `completed`, so it is not evidence for those stop paths.
 *
 * Only the session's own thread counts (`threadRole` is `main`): a subagent's
 * turn ends many times inside the main turn, and another window's thread is not
 * this session's. A turn id that was already announced is not announced again
 * (the last 64 are remembered): nothing shows that Codex repeats a
 * `turn/completed`, but a re-attach must not push twice if it does. An id longer
 * than 200 characters (`ID_MAX_LENGTH`) is no id: such a turn is announced each time
 * and never remembered, so a hostile frame cannot fill the memory.
 *
 * What Codex chose is made safe before it leaves remi (`safe-text.ts`): a failure's
 * details and code are written out with every control, invisible and bidirectional
 * character visible (`escapeUnsafeText`'s set), cut to what the push shows
 * AFTER counting the escapes so a cut never lands inside one, and the final answer
 * in the push has those characters removed except the zero-width joiner, which an
 * emoji sequence needs. Tag characters (U+E0020 to U+E007F) are among the removed, so a
 * subdivision-flag emoji loses its tags. An answer with nothing left to see (only joiners,
 * whitespace or removed characters) is no answer: no `turn_complete` push, and one line
 * without content says so. Chat prose is NOT touched here (`codex-chat.ts` leaves it
 * as the model wrote it, deliberately). Claude's `last_assistant_message` has the
 * same exposure today and is not changed by this phase.
 *
 * Nothing a turn says is logged: the answer, the error text and the thread id
 * stay out of the log, and a status remi does not know is logged without its
 * value. A turn that ended while remi was not attached (before the first attach,
 * or while the link was down) is never seen, so it pushes nothing, and a stale
 * "Codex stopped" stays until the next completed or interrupted turn.
 *
 * Real completed, interrupted and failed frames from the bounded Codex 0.160.0
 * LV-5 capture are pinned in `fixtures/codex-app-server/lv5.jsonl`. Synthetic
 * schema-shaped cases remain in the tests for edge conditions not captured live.
 */

import type { UUID } from '@remi/shared';

import type { TurnEventSink } from '../../notifications/turn-events.ts';
import { describeError } from './describe-error.ts';
import { boundedEscape, hasVisibleText, pushProse } from './safe-text.ts';
import { parseTurnCompleted } from './thread-protocol.ts';

/** Who the failure notice says stopped. */
const AGENT_NAME = 'Codex';
/** What the notice shows of a failure's own words, and of an unknown code (the lengths `turn-failed.ts` cuts to). */
const ERROR_DETAILS_MAX = 140;
const ERROR_CODE_MAX = 40;
/** How many announced turn ids are remembered, to drop a `turn/completed` that is delivered again. */
const RECENT_TURNS = 64;

export interface CodexTurnsDeps {
  /** The remi session whose turns these are. */
  sessionId: UUID;
  sink: TurnEventSink;
  /** `ThreadTracker.role`: `main` for the tracked thread, `subagent` for a descendant, null for any other. */
  threadRole: (threadId: string) => 'main' | 'subagent' | null;
  log: (message: string) => void;
}

export interface CodexTurns {
  /** Feed every notification of the app-server; only a `turn/completed` of the main thread does anything. */
  handleNotification(method: string, params: unknown): void;
}

export function createCodexTurns(deps: CodexTurnsDeps): CodexTurns {
  const { sessionId, sink } = deps;
  /** Ids of the turns announced, oldest first. */
  const announced = new Set<string>();

  const remember = (turnId: string | null): void => {
    if (turnId === null) return;
    announced.add(turnId);
    if (announced.size > RECENT_TURNS) {
      const oldest = announced.values().next().value;
      if (oldest !== undefined) announced.delete(oldest);
    }
  };

  /** One sink call: a throw is logged by name only and never stops the next call or leaves the handler. */
  const guarded = (what: string, call: () => void): void => {
    try {
      call();
    } catch (error) {
      deps.log(`turn event ${what} failed (${describeError(error)})`);
    }
  };

  return {
    handleNotification: (method, params) => {
      if (method !== 'turn/completed') return;
      const turn = parseTurnCompleted(params);
      if (turn === null) {
        deps.log('ignored a turn/completed that did not parse');
        return;
      }
      if (deps.threadRole(turn.threadId) !== 'main') return;
      if (turn.turnId !== null && announced.has(turn.turnId)) return;

      switch (turn.status) {
        case 'completed': {
          remember(turn.turnId);
          // The answer as the push will show it; an answer with nothing left to see is no answer.
          let message: string | undefined;
          if (turn.finalAnswer === null) {
            // Nothing to push: say so once, so a model that sends no phase is not a silent mystery.
            const view = turn.itemsView === null ? '' : ` (items view: ${turn.itemsView})`;
            deps.log(
              `a completed turn has no final_answer message, so no turn_complete push${view}`,
            );
          } else {
            const safe = pushProse(turn.finalAnswer);
            if (hasVisibleText(safe)) message = safe;
            else
              deps.log(
                'the final answer of a completed turn has no visible text once made safe, so no turn_complete push',
              );
          }
          guarded('turnCompleted', () =>
            sink.turnCompleted({
              sessionId,
              elapsedMs: turn.durationMs ?? undefined,
              lastAssistantMessage: message,
              reentry: false,
            }),
          );
          guarded('turnSucceeded', () => sink.turnSucceeded(sessionId));
          break;
        }
        case 'failed':
          remember(turn.turnId);
          guarded('turnFailed', () =>
            sink.turnFailed({
              sessionId,
              ...(turn.errorCode !== null
                ? { error: boundedEscape(turn.errorCode, ERROR_CODE_MAX) }
                : {}),
              ...(turn.errorMessage !== null
                ? { errorDetails: boundedEscape(turn.errorMessage, ERROR_DETAILS_MAX) }
                : {}),
              agentName: AGENT_NAME,
            }),
          );
          break;
        case 'interrupted':
          remember(turn.turnId);
          guarded('turnSucceeded', () => sink.turnSucceeded(sessionId));
          break;
        default:
          // `inProgress` is not an end, and a new status is not ours to guess at; the value is the peer's.
          deps.log('ignored a turn that ended with a status remi does not handle');
      }
    },
  };
}
