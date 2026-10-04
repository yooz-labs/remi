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
 *   does for Claude.
 * - `failed`: `turnFailed` naming Codex, with `error.message` as the details and
 *   `codexErrorInfo` as the code when it is a string. Never gated by
 *   `on_turn_complete` (a failed turn is the one turn end a user must not miss),
 *   and it carries no `lastAssistantMessage`: a failed turn's earlier answer is
 *   not what went wrong.
 * - `interrupted`: `turnSucceeded` only. Someone stopped the turn (the phone's
 *   No ends it, ADR 0033 Phase 4 item 2, so does Esc); that is neither a "done"
 *   push nor a failure, and it proves a failure notice stale.
 *
 * Only the session's own thread counts (`threadRole` is `main`): a subagent's
 * turn ends many times inside the main turn, and another window's thread is not
 * this session's. Nothing a turn says is logged: the answer, the error text and
 * the thread id stay out of the log, and a status remi does not know is logged
 * without its value.
 *
 * What no real frame has shown yet: a `failed` or an `interrupted` turn (live
 * step LV-5). The shapes here follow the generated schema (`Turn`, `TurnError`).
 */

import type { UUID } from '@remi/shared';

import type { TurnEventSink } from '../../notifications/turn-events.ts';
import { parseTurnCompleted } from './thread-protocol.ts';

/** Who the failure notice says stopped. */
const AGENT_NAME = 'Codex';

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createCodexTurns(deps: CodexTurnsDeps): CodexTurns {
  const { sessionId, sink } = deps;

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

      switch (turn.status) {
        case 'completed':
          guarded('turnCompleted', () =>
            sink.turnCompleted({
              sessionId,
              elapsedMs: turn.durationMs ?? undefined,
              lastAssistantMessage: turn.finalAnswer ?? undefined,
              reentry: false,
            }),
          );
          guarded('turnSucceeded', () => sink.turnSucceeded(sessionId));
          break;
        case 'failed':
          guarded('turnFailed', () =>
            sink.turnFailed({
              sessionId,
              ...(turn.errorCode !== null ? { error: turn.errorCode } : {}),
              ...(turn.errorMessage !== null ? { errorDetails: turn.errorMessage } : {}),
              agentName: AGENT_NAME,
            }),
          );
          break;
        case 'interrupted':
          guarded('turnSucceeded', () => sink.turnSucceeded(sessionId));
          break;
        default:
          // `inProgress` is not an end, and a new status is not ours to guess at; the value is the peer's.
          deps.log('ignored a turn that ended with a status remi does not handle');
      }
    },
  };
}
