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

import type { SessionRegistry } from '../../session/index.ts';
import { log } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface InputHandlerDeps {
  sessionRegistry: SessionRegistry;
  send: SendToConnection;
}

export type InputHandlers = ReturnType<typeof createInputHandlers>;

export function createInputHandlers(deps: InputHandlerDeps) {
  const { sessionRegistry, send } = deps;

  return {
    onUserInput: async (
      connectionId: UUID,
      _sessionId: UUID,
      content: string,
      raw?: boolean,
    ): Promise<void> => {
      log(`User input from ${connectionId}${raw ? ' (raw)' : ''}: ${content}`);

      const session = sessionRegistry.getSessionForConnection(connectionId);
      if (!session) {
        log(`No session found for connection ${connectionId}`);
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

      // Drop stale answers. APNS tokens persist across disconnect (#286), so a
      // delayed lock-screen tap can deliver an answer for a question that has
      // since been auto-approved or replaced. Without this guard, the digit
      // would inject into whatever Claude prompt is currently live. Surface
      // the drop to the client so the iOS user gets a "not delivered" signal
      // instead of silent failure.
      const active = session.currentQuestion;
      if (active === null || active.id !== questionId) {
        log(
          `Ignoring stale answer: questionId ${questionId} does not match active ${active?.id ?? 'none'}`,
        );
        send(
          connectionId,
          createError('STALE_ANSWER', 'The question this answer was for is no longer active', {
            sessionId,
            questionId,
            activeQuestionId: active?.id ?? null,
          }),
        );
        return;
      }

      await session.pty.submitInput(answer);
      sessionRegistry.updateQuestion(session.sessionId, null);
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
