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
import type { QuestionOption, UUID } from '@remi/shared';

import type { SessionBindingStore, SessionRegistry } from '../../session/index.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface InputHandlerDeps {
  sessionRegistry: SessionRegistry;
  bindingStore: SessionBindingStore;
  send: SendToConnection;
  /**
   * Resolve a HELD binary PermissionRequest hook with the user's answer (Model
   * B, #573), routed to the gate for `sessionId`. Returns true when a hold
   * existed and was resolved — `onAnswer` then SKIPS the PTY inject (Claude is
   * blocked on the hook, not rendering a prompt). Absent / false => the answer
   * takes the existing PTY-submit path (multi-choice pick, non-AA session, or
   * Part-B-disabled escalation that passed through). Session-keyed by cli.ts.
   */
  resolveHeldPermission?: (
    sessionId: UUID,
    questionId: UUID,
    decision: 'allow' | 'deny',
  ) => boolean;
  /**
   * Release a HELD binary PermissionRequest hook to 'passthrough' for `sessionId`
   * (#573) when the user's answer cannot be expressed by the binary hook
   * response — a "Yes, always" or a multi-choice pick. Claude then renders its
   * native numbered prompt and `onAnswer` submits the digit (the only way to
   * express "always" / a specific pick). Returns true iff a hold existed.
   * Session-keyed by cli.ts.
   */
  releaseHeldAsPassthrough?: (sessionId: UUID, questionId: UUID) => boolean;
  /**
   * Cancel the in-flight auto-approve eval (and release holds) for `sessionId`
   * when the user answers a HELD permission from any channel (#573, issue 2): a
   * stale eval would otherwise keep running and could inject a phantom decision.
   * Fired ONLY when a hold was actually resolved/released, so answering an
   * unrelated passthrough question does not abort a different binary permission's
   * in-flight eval. Session-keyed.
   */
  cancelAutoApprove?: (sessionId: UUID, reason: string) => void;
  /**
   * Cross-client question dismissal (#585, P7). Called after a question is
   * answered here so the daemon broadcasts `question_resolved` to every client and
   * fires the APNS dismissal — answering on one device clears the card (and the
   * lock-screen notification) on the others. Fired ONCE per answered question, on
   * the delivered path only (not for stale/session-not-found/stale-binding, where
   * nothing was consumed). Must be throw-safe: a broadcast failure must never
   * break answer handling. Absent => no dismissal broadcast (tests/old callers).
   */
  onQuestionResolved?: (sessionId: UUID, questionId: UUID) => void;
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
  bindingStore: SessionBindingStore,
  send: SendToConnection,
  connectionId: UUID,
  sessionId: UUID,
  claudeSessionId: UUID | undefined,
): boolean {
  if (claudeSessionId === undefined) return true;
  let bound: string | undefined;
  try {
    bound = bindingStore.get(sessionId)?.claudeSessionId ?? undefined;
  } catch (err) {
    logError(`[Binding] binding lookup failed; accepting message: ${errorToString(err)}`);
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

/**
 * Outcome of routing an answer to a pending Question. Returned by the shared
 * answer core so the connection-independent HTTP `/answer` relay (#575, P4a)
 * can map it to a clear JSON status without re-implementing the routing logic.
 *   - `delivered`     — the answer was resolved via the held hook OR submitted to the PTY.
 *   - `session-not-found` — no session matched the sessionId/connectionId.
 *   - `stale-binding` — the Claude session this answer targeted has rotated.
 *   - `stale`         — the question is no longer active (already answered/auto-approved).
 */
export type AnswerOutcome = 'delivered' | 'session-not-found' | 'stale-binding' | 'stale';

export type InputHandlers = ReturnType<typeof createInputHandlers>;

/**
 * Resolve an incoming answer string to the active Question's matching option
 * (#574). The phone now sends the option LABEL for display (e.g. "Yes", "Yes,
 * always", "No") rather than only the numeric `value` ("1"/"2"/"3"), so match
 * EITHER field. The in-app WebSocket path may still send a `value`; both
 * resolve to the same option. Returns the option, or undefined for a free-text
 * answer that matches neither.
 */
function resolveOption(
  options: readonly QuestionOption[],
  answer: string,
): QuestionOption | undefined {
  return options.find((o) => o.value === answer || o.label === answer);
}

/**
 * No-op `send` for the connection-independent `/answer` relay (#575, P4a),
 * which has no WebSocket connection to write error frames to. The relay reports
 * status via its `AnswerOutcome` return value instead.
 */
const noopSend: SendToConnection = () => false;

/**
 * Map a resolved option to a binary allow/deny decision (#573). Reads the
 * option's `isYes` / `isNo` flags. Returns:
 *   - 'deny' for a no-shaped option;
 *   - 'allow' for a yes-shaped option ONLY when it is a one-time "Yes" — an
 *     "always"-shaped label ("Yes, always") is NOT mapped, because the binary
 *     PermissionRequest hook response can only express allow/deny, never the
 *     session-wide "always" the user picked. Downgrading it to a one-time allow
 *     would silently lose that choice, so it returns null and the caller takes
 *     the native PTY path (which can express "always" via the digit);
 *   - null otherwise (always-shaped, unknown value/label, or free text) -> PTY path.
 */
function mapAnswerToDecision(
  options: readonly QuestionOption[],
  answer: string,
): 'allow' | 'deny' | null {
  const option = resolveOption(options, answer);
  if (!option) return null;
  if (option.isNo) return 'deny';
  // "always" cannot be expressed in the binary hook response, so a yes-shaped
  // "always" option must NOT collapse to a one-time allow.
  if (option.isYes && !option.label.toLowerCase().includes('always')) return 'allow';
  return null;
}

export function createInputHandlers(deps: InputHandlerDeps) {
  const {
    sessionRegistry,
    bindingStore,
    send,
    resolveHeldPermission,
    releaseHeldAsPassthrough,
    cancelAutoApprove,
    onQuestionResolved,
  } = deps;

  /**
   * Shared answer-routing core for both the WebSocket `onAnswer` event and the
   * HTTP `/answer` relay (#575, P4a). Resolves a held permission hook (Model B),
   * releases to passthrough + submits a PTY digit for picks / "always", or
   * submits free text — then cancels the in-flight eval and removes the
   * question. Returns the outcome; the WebSocket path additionally surfaces
   * errors over the connection via `send` (suppressed when `viaRelay`).
   */
  async function handleAnswer(
    connectionId: UUID,
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    claudeSessionId: UUID | undefined,
    viaRelay = false,
  ): Promise<AnswerOutcome> {
    log(
      `Answer ${viaRelay ? '(relay) ' : ''}from ${connectionId} for session ${sessionId}: ${answer}`,
    );

    // Prefer lookup by sessionId (from push-action answers) so reconnected clients
    // can answer even before the connection is fully mapped in the registry.
    const session =
      sessionRegistry.getSession(sessionId) ??
      sessionRegistry.getSessionForConnection(connectionId);
    if (!session) {
      log(`No session found for connection ${connectionId} or session ${sessionId}`);
      if (!viaRelay) {
        send(
          connectionId,
          createError('SESSION_NOT_FOUND', `Session ${sessionId} not found on this daemon`),
        );
      }
      return 'session-not-found';
    }

    if (
      !guardBinding(
        bindingStore,
        viaRelay ? noopSend : send,
        connectionId,
        sessionId,
        claudeSessionId,
      )
    ) {
      return 'stale-binding';
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
      if (!viaRelay) {
        send(
          connectionId,
          createError('STALE_ANSWER', 'The question this answer was for is no longer active', {
            sessionId,
            questionId,
            pendingQuestionIds: pendingIds,
          }),
        );
      }
      return 'stale';
    }

    // Model B (#573): if the auto-approve gate is HOLDING this permission's
    // hook, a binary (one-time Yes / No) answer resolves it via the hook
    // response — Claude is blocked on the hook and is NOT rendering a prompt,
    // so a PTY submit would land in the wrong place. An answer the binary
    // response cannot express ("Yes, always", a multi-choice pick, free text)
    // first RELEASES the held hook to passthrough so Claude renders its native
    // numbered prompt, then submits the digit (the only way to express
    // "always" / a specific pick).
    //
    // The submit/hold-resolution + question removal are wrapped so the question
    // is ALWAYS consumed exactly once: if `submitInput` throws, the `finally`
    // still removes it (no zombie question that a retry could double-submit),
    // and the throw still propagates (relay -> HTTP 500, WS -> caller-logged).
    const decision = mapAnswerToDecision(active.options, answer);
    let hadHold = false;
    try {
      if (decision !== null) {
        hadHold = resolveHeldPermission?.(session.sessionId, questionId, decision) ?? false;
      }
      if (!hadHold) {
        // decision === null (always/pick/free-text) OR no hold for this question:
        // if a hold exists, pop it to passthrough so the native prompt renders,
        // then submit the digit. If no hold, this is the normal PTY path.
        const released = releaseHeldAsPassthrough?.(session.sessionId, questionId) ?? false;
        hadHold = hadHold || released;
        // The phone may send a label for display (#574), but Claude's native
        // numbered prompt expects the option's VALUE (the 1-based index). Resolve
        // the answer back to its option and submit the index; a free-text answer
        // (no option match) is submitted verbatim.
        const ptyInput = resolveOption(active.options, answer)?.value ?? answer;
        if (ptyInput !== answer) {
          log(`[Answer] resolved "${answer}" -> "${ptyInput}" for q ${questionId.slice(0, 8)}`);
        } else if (
          active.options.length > 0 &&
          resolveOption(active.options, answer) === undefined
        ) {
          log(
            `[Answer] "${answer}" matched no option (${active.options.length}); submitting verbatim`,
          );
        }
        await session.pty.submitInput(ptyInput);
      } else {
        log(
          `Resolved held permission ${questionId.slice(0, 8)} via hook response: ${decision} (no PTY submit)`,
        );
      }

      // Cancel the in-flight eval ONLY when a held permission was actually
      // resolved/released (#573, issue 2): a stale verdict for THIS permission
      // must not inject a phantom decision. Answering an unrelated passthrough
      // question must NOT abort a different binary permission's eval, so this is
      // gated on hadHold rather than firing on every answer.
      if (hadHold) cancelAutoApprove?.(session.sessionId, 'user-answered');
    } finally {
      // Remove only the answered question; sibling prompts remain answerable.
      // In `finally` so a throwing submit cannot leave a zombie question.
      sessionRegistry.removeQuestion(session.sessionId, questionId);
      // Cross-client dismissal (#585, P7): tell every client this question is
      // resolved so its card clears and the lock-screen push is dismissed.
      // Throw-safe: a broadcast/push failure must never break answer handling,
      // and it lives in `finally` so even a throwing submit still clears the card
      // (the question was consumed). Idempotent on the client side.
      try {
        onQuestionResolved?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] question_resolved broadcast failed: ${errorToString(err)}`);
      }
    }
    return 'delivered';
  }

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

      if (!guardBinding(bindingStore, send, connectionId, sessionId, claudeSessionId)) {
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

    // The WebSocket path: route the answer and reply over the connection on
    // error. Returns void to match the adapter event signature. The HTTP
    // `/answer` relay (#575, P4a) calls `relayAnswer` instead, which shares the
    // exact same routing core but reports a structured outcome.
    onAnswer: async (
      connectionId: UUID,
      sessionId: UUID,
      questionId: UUID,
      answer: string,
      claudeSessionId?: UUID,
    ): Promise<void> => {
      await handleAnswer(connectionId, sessionId, questionId, answer, claudeSessionId);
    },

    /**
     * Connection-independent answer relay (#575, P4a). Routes an answer through
     * the SAME core as the WebSocket `onAnswer` so a cold-start push tap can
     * deliver a held-hook decision / PTY pick over plain HTTP, then returns the
     * structured outcome for the caller to JSON-encode. There is no WebSocket
     * connection to reply on, so `send` error frames are suppressed here; the
     * outcome carries the same information.
     */
    relayAnswer: async (
      sessionId: UUID,
      questionId: UUID,
      answer: string,
      claudeSessionId?: UUID,
    ): Promise<AnswerOutcome> => {
      // The relay has no connection; use the sessionId as the synthetic id so
      // logging stays meaningful and the registry's sessionId-first lookup wins.
      return handleAnswer(sessionId as UUID, sessionId, questionId, answer, claudeSessionId, true);
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
