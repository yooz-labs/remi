/**
 * sharedEvents handlers for client-to-PTY input flows:
 *   onUserInput, terminal keystrokes (raw or line-buffered)
 *   onAnswer, response to a pending Question
 *   onBulletExpandRequest, expand a truncated bullet from the MessageAPI
 *
 * All three look up a session from `sessionRegistry` and interact with its
 * PTY or MessageAPI. `send` writes back error responses on onAnswer (when an
 * answer is dropped because the question changed) and onBulletExpandRequest.
 */

import { createBulletExpandResponse, createError, errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';

import type { SessionRegistry, SessionStore } from '../../session/index.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface InputHandlerDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  send: SendToConnection;
}

/**
 * Compare an incoming message's claudeSessionId against the daemon's
 * current binding for the target remi session (#429). Returns true when
 * the message is safe to forward to the PTY, false when stale.
 *
 * Stale-binding semantics:
 *   - If the client did not send claudeSessionId (pre-#429 client),
 *     accept the message unconditionally. The client cannot have known
 *     the binding to check against.
 *   - If the client sent it but no daemon binding is recorded yet
 *     (extreme race: message arrived before the pre-spawn save in
 *     cli.ts:createNewSession completed), accept rather than refuse.
 *   - If both are present and differ, the user typed against an old
 *     view (e.g. /resume rotated the binding between question and
 *     answer); refuse and emit STALE_BINDING with both ids so the
 *     client can rekey its UI.
 *   - If the sessionStore lookup throws (I/O error on the sessions
 *     file): fail-open with a logError. Refusing on a transient store
 *     hiccup would silently swallow legitimate input; accepting at
 *     least surfaces the problem in logs while letting the user work.
 */
function guardBinding(
  sessionStore: SessionStore,
  send: SendToConnection,
  connectionId: UUID,
  sessionId: UUID,
  claudeSessionId: UUID | undefined,
): boolean {
  if (claudeSessionId === undefined) return true;
  let bound: string | undefined;
  try {
    bound = sessionStore.findByRemiSessionId(sessionId)?.claudeSessionId ?? undefined;
  } catch (err) {
    logError(`[Binding] sessionStore lookup failed; accepting message: ${errorToString(err)}`);
    return true;
  }
  if (!bound) return true;
  if (bound === claudeSessionId) return true;
  log(
    `[Binding] STALE_BINDING refused for session ${sessionId.slice(0, 8)}: incoming=${claudeSessionId.slice(0, 8)} bound=${bound.slice(0, 8)}`,
  );
  send(
    connectionId,
    createError(
      'STALE_BINDING',
      'The Claude session this message was for has rotated; the binding has moved',
      {
        sessionId,
        incomingClaudeSessionId: claudeSessionId,
        boundClaudeSessionId: bound,
      },
    ),
  );
  return false;
}

export type InputHandlers = ReturnType<typeof createInputHandlers>;

export function createInputHandlers(deps: InputHandlerDeps) {
  const { sessionRegistry, sessionStore, send } = deps;

  return {
    onUserInput: async (
      connectionId: UUID,
      sessionId: UUID,
      content: string,
      raw?: boolean,
      claudeSessionId?: UUID,
    ): Promise<void> => {
      log(`User input from ${connectionId}${raw ? ' (raw)' : ''}: ${content}`);

      const session = sessionRegistry.getSessionForConnection(connectionId);
      if (!session) {
        log(`No session found for connection ${connectionId}`);
        return;
      }

      if (!guardBinding(sessionStore, send, connectionId, sessionId, claudeSessionId)) {
        return;
      }

      if (raw) {
        // Raw terminal input from attach client: write directly without Enter
        try {
          session.pty.write(content);
        } catch (err) {
          log(`[PTY] raw write failed: ${errorToString(err)}`);
        }
        return;
      }

      // Structured input from web/mobile client: append Enter
      await session.pty.submitInput(content);
    },

    onAnswer: async (
      connectionId: UUID,
      sessionId: UUID,
      questionId: UUID,
      answer: string,
      claudeSessionId?: UUID,
    ): Promise<void> => {
      log(`Answer from ${connectionId} for session ${sessionId}: ${answer}`);

      // Prefer lookup by sessionId (from push-action answers) so reconnected clients
      // can answer even before the connection is fully mapped in the registry.
      const session =
        sessionRegistry.getSession(sessionId) ??
        sessionRegistry.getSessionForConnection(connectionId);
      if (!session) {
        log(`No session found for connection ${connectionId} or session ${sessionId}`);
        send(
          connectionId,
          createError('SESSION_NOT_FOUND', `Session ${sessionId} not found on this daemon`),
        );
        return;
      }

      if (!guardBinding(sessionStore, send, connectionId, sessionId, claudeSessionId)) {
        return;
      }

      // Drop stale answers. APNS tokens persist across disconnect (#286), so a
      // delayed lock-screen tap can deliver an answer for a question that has
      // since been auto-approved or resolved. Membership in the pending set
      // (not equality with a single slot) is the check, so answering one of
      // several concurrent prompts (main + subagent, #419) never invalidates
      // the others. Surface the drop so the iOS user gets a "not delivered"
      // signal instead of silent failure.
      const active = sessionRegistry.getQuestion(session.sessionId, questionId);
      if (active === null) {
        const pendingIds = [...session.currentQuestions.keys()];
        log(
          `Ignoring stale answer: questionId ${questionId} not in pending [${pendingIds.join(', ') || 'none'}]`,
        );
        send(
          connectionId,
          createError('STALE_ANSWER', 'The question this answer was for is no longer active', {
            sessionId,
            questionId,
            pendingQuestionIds: pendingIds,
          }),
        );
        return;
      }

      await session.pty.submitInput(answer);
      // Remove only the answered question; sibling prompts remain answerable.
      sessionRegistry.removeQuestion(session.sessionId, questionId);
    },

    onBulletExpandRequest: (
      connectionId: UUID,
      sessionId: UUID,
      bulletId: number,
      requestId: UUID,
    ): void => {
      const session = sessionRegistry.getSession(sessionId);
      if (!session) {
        send(connectionId, createError('NOT_FOUND', `Session ${sessionId} not found`));
        return;
      }

      const fullContent = session.messageApi.getFullBulletContent(bulletId);
      if (fullContent === null) {
        send(
          connectionId,
          createError('CONTENT_EXPIRED', `Content for bullet ${bulletId} not found or expired`),
        );
        return;
      }

      send(connectionId, createBulletExpandResponse(bulletId, fullContent, requestId));
    },
  };
}
