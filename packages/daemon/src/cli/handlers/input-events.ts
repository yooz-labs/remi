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
import type { AnswerExtras, AnswerSelection, Question, QuestionOption, UUID } from '@remi/shared';

import { clearAuqRunActive, markAuqRunActive } from '../../hooks/auq-active-runs.ts';
import { AUQ_KEYS } from '../../hooks/auq-answer.ts';
import { type AuqRunOutcome, runAuqAnswer } from '../../hooks/auq-runner.ts';
import { readPtyOutput, resetPtyOutput } from '../../pty/output-buffer.ts';
import type { ManagedSession, SessionBindingStore, SessionRegistry } from '../../session/index.ts';
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
   * Cancel ONLY the eval for the question the user just answered (#617), freeing
   * the GPU without touching the session's other holds. Per-eval scoping makes it
   * safe to fire on every answer (a no-op when no eval is in flight for the
   * question, and it never aborts a different permission's eval). Session-keyed.
   */
  cancelAutoApproveForQuestion?: (sessionId: UUID, questionId: UUID, reason: string) => void;
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
export type AnswerOutcome =
  | 'delivered'
  | 'session-not-found'
  | 'stale-binding'
  | 'stale'
  /** #627: a structured AskUserQuestion answer could not be auto-driven safely;
   *  the prompt is left up so the user can Cancel (Esc) or answer in the terminal. */
  | 'escalated';

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
    cancelAutoApproveForQuestion,
    onQuestionResolved,
  } = deps;

  // #627: in-flight AskUserQuestion runs, keyed `${sessionId}:${questionId}`, so a
  // cancel can ABORT the runner immediately — it stops before its next keystroke,
  // so the cancel's Esc is never followed by a stray queued key landing on Claude's
  // next state.
  const auqRuns = new Map<string, AbortController>();
  const auqRunKey = (sessionId: UUID, questionId: UUID): string => `${sessionId}:${questionId}`;

  /**
   * Answer a structured AskUserQuestion (#627) by driving its interactive TUI.
   * The prompt is already on screen (Phase 1 escalates AUQ as passthrough), so the
   * runner sends keystrokes from the per-sub-question `selections`, verifies the
   * review screen against the chosen option LABELS, and only then submits. On
   * success the question is consumed + dismissed everywhere. On escalate (mismatch
   * / timeout / unexpected variant) the prompt is LEFT UP — never a wrong submit,
   * never an auto-Esc — so the user can Cancel (Esc) or answer in the terminal.
   */
  async function handleAuqAnswer(
    connectionId: UUID,
    session: ManagedSession,
    questionId: UUID,
    active: Question,
    selections: readonly AnswerSelection[],
    viaRelay: boolean,
  ): Promise<AnswerOutcome> {
    const steps = active.questions;
    if (!steps || steps.length === 0) {
      log(`[AUQ] selections for a non-structured question ${questionId.slice(0, 8)}; escalating`);
      if (!viaRelay) {
        send(
          connectionId,
          createError('AUQ_NOT_STRUCTURED', 'This question is not a structured AskUserQuestion', {
            sessionId: session.sessionId,
            questionId,
          }),
        );
      }
      return 'escalated';
    }

    const byIndex = new Map(selections.map((s) => [s.questionIndex, s.optionIndices]));
    const questions = steps.map((s) => ({
      multiSelect: s.multiSelect,
      optionCount: s.options.length,
    }));
    const targets: number[][] = [];
    const expectedLabels: string[][] = [];
    for (let k = 0; k < steps.length; k++) {
      const picks = byIndex.get(k) ?? [];
      targets.push([...picks]);
      const opts = steps[k]?.options ?? [];
      expectedLabels.push(picks.map((i) => opts[i]?.label ?? '').filter((l) => l.length > 0));
    }

    const runKey = auqRunKey(session.sessionId, questionId);
    const controller = new AbortController();
    auqRuns.set(runKey, controller);
    // #661 review: mark this question as ACTIVELY driven before the first
    // keystroke so pty-session-setup.ts's terminal-answer detector skips it —
    // otherwise the detector races this same drive's own success path (both
    // read the same rolling PTY buffer) and double-resolves the question.
    markAuqRunActive(session.sessionId, questionId);
    let outcome: AuqRunOutcome;
    try {
      outcome = await runAuqAnswer(
        { questions, targets, expectedLabels },
        {
          write: (d) => session.pty.write(d),
          readRecentOutput: () => readPtyOutput(session.sessionId),
          resetOutput: () => resetPtyOutput(session.sessionId),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          nowMs: () => Date.now(),
          signal: controller.signal,
          log: (m) => log(m),
        },
      );
    } finally {
      auqRuns.delete(runKey);
      clearAuqRunActive(session.sessionId, questionId);
    }

    if (outcome === 'closed' || outcome === 'submitted') {
      // Wrapped like the plain-answer path (below): if cancelAutoApproveForQuestion
      // throws, the question must still be consumed exactly once — removeQuestion +
      // the resolved broadcast run in `finally` so a throw here can never leave a
      // zombie question the phone thinks is still pending.
      try {
        cancelAutoApproveForQuestion?.(session.sessionId, questionId, 'user-answered-auq');
      } finally {
        sessionRegistry.removeQuestion(session.sessionId, questionId);
        try {
          onQuestionResolved?.(session.sessionId, questionId);
        } catch (err) {
          logError(`[AUQ] question_resolved broadcast failed: ${errorToString(err)}`);
        }
      }
      log(`[AUQ] answered question ${questionId.slice(0, 8)} (${outcome})`);
      return 'delivered';
    }

    // Escalated: leave the question up (the user can Cancel or use the terminal).
    log(`[AUQ] could not auto-answer ${questionId.slice(0, 8)}; left for manual (Cancel/terminal)`);
    if (!viaRelay) {
      const delivered = send(
        connectionId,
        createError(
          'AUQ_AUTOANSWER_FAILED',
          'Could not auto-answer the question; cancel it or answer in the terminal',
          { sessionId: session.sessionId, questionId },
        ),
      );
      // The run can take seconds; the connection may have dropped meanwhile. The
      // question stays registered, so a reconnect replay re-renders an answerable
      // card — but log the undelivered signal so there is a trace (#631 review).
      if (!delivered) {
        logError(
          `[AUQ] AUQ_AUTOANSWER_FAILED undelivered for ${questionId.slice(0, 8)} (connection ${connectionId.slice(0, 8)} gone); question left registered for reconnect replay`,
        );
      }
    }
    return 'escalated';
  }

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
    extra?: AnswerExtras,
  ): Promise<AnswerOutcome> {
    log(
      `Answer ${viaRelay ? '(relay) ' : ''}from ${connectionId} for session ${sessionId}: ${extra?.cancel ? '[cancel]' : extra?.selections ? `[selections×${extra.selections.length}]` : answer}`,
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

    // #627 cancel/escape — the universal unstick. First ABORT any in-flight AUQ
    // run so it stops before its next keystroke (otherwise a queued key could land
    // after our Esc). Then send Esc to the PTY so the active interactive prompt
    // cancels and Claude unblocks. The Esc is gated on the question still being
    // active: a delayed cancel for an already-resolved question must NOT inject Esc
    // into whatever Claude renders next (#631 review). Cleanup (hold release, eval
    // cancel, removeQuestion, broadcast) is unconditional so the card always clears.
    if (extra?.cancel) {
      auqRuns.get(auqRunKey(session.sessionId, questionId))?.abort();
      const stillActive = sessionRegistry.getQuestion(session.sessionId, questionId) !== null;
      if (stillActive) {
        try {
          await session.pty.write(AUQ_KEYS.ESC);
          log(`[Answer] cancel: sent Esc to session ${session.sessionId.slice(0, 8)}`);
        } catch (err) {
          logError(`[Answer] cancel: Esc write failed: ${errorToString(err)}`);
        }
      } else {
        log(
          `[Answer] cancel: question ${questionId.slice(0, 8)} already gone; skipping Esc, clearing card`,
        );
      }
      // Guarded like the AUQ success branch (#661 review): a throw from hold
      // release or eval cancel must never skip removeQuestion/onQuestionResolved
      // below, or the card zombifies exactly like the bug this file just fixed.
      try {
        releaseHeldAsPassthrough?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] cancel: hold release failed: ${errorToString(err)}`);
      }
      try {
        cancelAutoApproveForQuestion?.(session.sessionId, questionId, 'user-cancelled');
      } catch (err) {
        logError(`[Answer] cancel: eval cancel failed: ${errorToString(err)}`);
      }
      sessionRegistry.removeQuestion(session.sessionId, questionId);
      try {
        onQuestionResolved?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] cancel: question_resolved broadcast failed: ${errorToString(err)}`);
      }
      return 'delivered';
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
      // #603 Phase 3: the question is gone from the registry (evicted under the
      // pending-question cap, or already removed), but its PermissionRequest hook
      // may STILL be held (Model B). Pop that hold to passthrough so Claude
      // renders its native prompt and unblocks NOW, rather than stalling to
      // hold_timeout. The answer itself is stale (we no longer hold the options
      // to map it), so it is still refused — but the terminal can take over.
      const freedHeld = releaseHeldAsPassthrough?.(session.sessionId, questionId) ?? false;
      // Free the GPU for this specific orphaned question (#617), scoped so a stale
      // tap never fails the session's OTHER holds open (cancelStale's releaseAllHolds
      // belongs to teardown/force-release only).
      if (freedHeld)
        cancelAutoApproveForQuestion?.(session.sessionId, questionId, 'user-answered-stale');
      log(
        `Ignoring stale answer: questionId ${questionId} not in pending [${pendingIds.join(', ') || 'none'}]${freedHeld ? ' (freed an orphaned held hook -> passthrough)' : ''}`,
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

    // #627 structured AskUserQuestion answer: drive the interactive TUI from the
    // per-sub-question selections (the existing single-digit path can't express a
    // tabbed multi-question form). The runner verifies the review before submitting
    // and escalates (leaving the prompt for Cancel / terminal) on any mismatch.
    if (extra?.selections && extra.selections.length > 0) {
      return await handleAuqAnswer(
        connectionId,
        session,
        questionId,
        active,
        extra.selections,
        viaRelay,
      );
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

      // Free the GPU on EVERY answer (#617): cancel the eval for THIS question
      // unconditionally. Per-eval scoping (the eval id captured when the question
      // was held) makes this safe where the old `hadHold`-gated cancelStale was
      // not — it aborts only this question's eval, never another permission's,
      // and is a no-op when no eval is in flight for it. It deliberately does NOT
      // release the session's other holds (cancelStale's releaseAllHolds), which
      // belongs to teardown/force-release, not a single answer.
      cancelAutoApproveForQuestion?.(session.sessionId, questionId, 'user-answered');
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
        // #662: this connection does not hold the exclusive write lock —
        // either it's read-only (queued behind the active connection: a
        // second client, or this same client's new connection racing the
        // pong-reaper's eviction of its own stale one) or the session no
        // longer exists. Previously this dropped the input with only a
        // server-side log line, so the sender's UI showed the message as
        // "sent" while it silently vanished. Surface it as an error instead.
        const sessionExists = sessionRegistry.getSession(sessionId) !== undefined;
        log(
          `No session found for connection ${connectionId} (session ${sessionExists ? 'exists but this connection is not active' : 'not found'})`,
        );
        send(
          connectionId,
          sessionExists
            ? createError(
                'NOT_ACTIVE_CONNECTION',
                'This connection is read-only (another connection holds the session); input was not delivered.',
                { sessionId },
              )
            : createError('SESSION_NOT_FOUND', `Session ${sessionId} not found on this daemon`),
        );
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
      extra?: AnswerExtras,
    ): Promise<void> => {
      await handleAnswer(
        connectionId,
        sessionId,
        questionId,
        answer,
        claudeSessionId,
        false,
        extra,
      );
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
    ): Promise<Exclude<AnswerOutcome, 'escalated'>> => {
      // The relay has no connection; use the sessionId as the synthetic id so
      // logging stays meaningful and the registry's sessionId-first lookup wins.
      const outcome = await handleAnswer(
        sessionId as UUID,
        sessionId,
        questionId,
        answer,
        claudeSessionId,
        true,
      );
      // The relay path never carries AskUserQuestion selections, so 'escalated' is
      // unreachable; coerce defensively so the HTTP outcome stays in the legacy set.
      return outcome === 'escalated' ? 'stale' : outcome;
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
