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
import { traceQuestionEvent } from '../../session/question-trace.ts';
import { log, logError } from '../logger.ts';
import { ResolvedAnswerCache, answerCacheKey } from './resolved-answer-cache.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface InputHandlerDeps {
  sessionRegistry: SessionRegistry;
  bindingStore: SessionBindingStore;
  send: SendToConnection;
  /**
   * Tell this session's permission gate that `questionId` was answered here,
   * so it stops tracking the escalation's tool signature (#673): the answer
   * path removes and dismisses the card itself, and a later matching
   * PreToolUse must not resolve (and dismiss) it a second time. Session-keyed
   * by cli.ts. Absent => no-op (tests, or no hook server).
   */
  retireQuestion?: (sessionId: UUID, questionId: UUID) => void;
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
  /**
   * Prompt-currency check for a resolved card-answer PTY submit (#920).
   * Backed by the session's `QuestionPresenceTracker.isPromptCurrent`, so
   * answering a card whose on-screen prompt is gone is refused instead of
   * typing into whatever Claude is doing now. Consulted ONLY for `Question.source === 'pty'`
   * cards (the genuinely hook-less cohort #920 traced the leak to); every
   * other source is left alone, see the call site's comment for why a
   * blanket check would misfire on hook-paired questions. Absent (no
   * tracker wired for this session) is treated as "not current" — fail
   * toward refusing, matching `isQuestionLive`'s own default in
   * question-presence-tracker.ts.
   */
  isPromptCurrent?: (sessionId: UUID, questionId: UUID, ptyText: string) => boolean;
  /**
   * Weaker companion to `isPromptCurrent`: "is this session rendering ANY
   * interactive prompt right now?", backed by
   * `QuestionPresenceTracker.isPromptObservedOnPTY` (#1002).
   *
   * NOT backed by that class's `isPromptVisibleOnPTY`, despite the closer
   * name. That flag means "this tracker pushed a card off a PTY render", which
   * is false for the most common cohort of all: a gate-owned hook card whose
   * native prompt renders is recognised as an echo and suppressed without ever
   * setting it. Probing the real tracker showed `recordPendingHook` +
   * `onOrphanPTYPrompt` leaving it false while a prompt is genuinely on
   * screen, so a guard built on it would have refused legitimate answers —
   * trading a stray-injection bug for a cannot-answer-at-all bug.
   *
   * Exists because `isPromptCurrent` cannot serve hook-paired cards at all. A
   * hook-paired question's `id`/`text` are the HOOK's (tool + command text),
   * never the raw PTY parse, so its id/text match would fail for that whole
   * cohort — which is why the #920 guard is scoped to `source === 'pty'` and
   * why widening it on id/text would refuse legitimate answers rather than fix
   * anything.
   *
   * But the scoping left a real hole: a hook-sourced card whose prompt is
   * ALREADY gone still reached `pty.submitInput` with nothing checked, and
   * typed its option digit into whatever Claude was doing. Observed live — a bare `1`
   * landed in an unrelated session as a chat message, recorded in the
   * transcript as a user entry (#1002).
   *
   * Two different questions were being conflated: "is THIS prompt on screen?"
   * (needs id/text, genuinely impossible for hook-paired cards) and "is ANY
   * prompt on screen?" (all that is needed before typing a digit, and
   * perfectly answerable for them). This dep answers the second.
   *
   * Absent => treated as NOT visible, the same fail-toward-refusing default
   * `isPromptCurrent` documents.
   */
  isPromptObservedOnPTY?: (sessionId: UUID) => boolean;
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
 *   - `delivered`     — the answer was submitted to the PTY (or drove the AskUserQuestion runner).
 *   - `session-not-found` — no session matched the sessionId/connectionId.
 *   - `stale-binding` — the Claude session this answer targeted has rotated.
 *   - `stale`         — the question is no longer active (already answered or resolved).
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

export function createInputHandlers(deps: InputHandlerDeps) {
  const {
    sessionRegistry,
    bindingStore,
    send,
    retireQuestion,
    onQuestionResolved,
    isPromptCurrent,
    isPromptObservedOnPTY,
  } = deps;

  // #627: in-flight AskUserQuestion runs, keyed `${sessionId}:${questionId}`, so a
  // cancel can ABORT the runner immediately — it stops before its next keystroke,
  // so the cancel's Esc is never followed by a stray queued key landing on Claude's
  // next state.
  const auqRuns = new Map<string, AbortController>();
  const auqRunKey = (sessionId: UUID, questionId: UUID): string => `${sessionId}:${questionId}`;

  // #752: same-value duplicate deliveries of a successful answer (native POST +
  // Capacitor JS path + signaling relay all fire per tap) report 'delivered'
  // instead of 'stale', so the losing channel stops showing a false "Answer
  // not delivered" notification.
  const resolvedAnswers = new ResolvedAnswerCache();

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
      // #752: the selections were applied; a duplicate delivery of this same
      // tap must report 'delivered', not 'stale'.
      resolvedAnswers.record(questionId, [answerCacheKey('', selections)]);
      sessionRegistry.removeQuestion(session.sessionId, questionId, 'user_answer:auq');
      try {
        onQuestionResolved?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[AUQ] question_resolved broadcast failed: ${errorToString(err)}`);
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
   * HTTP `/answer` relay (#575, P4a). Submits the answered option's digit (or
   * free text) to the PTY, where Claude's native prompt is waiting, then
   * removes the question. Returns the outcome; the WebSocket path additionally
   * surfaces errors over the connection via `send` (suppressed when
   * `viaRelay`).
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
    // into whatever Claude renders next (#631 review). Cleanup (gate retirement,
    // removeQuestion, broadcast) is unconditional so the card always clears.
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
      // Guarded (#661 review): a throw from the gate retirement must never skip
      // removeQuestion/onQuestionResolved below, or the card zombifies.
      try {
        retireQuestion?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] cancel: gate retirement failed: ${errorToString(err)}`);
      }
      sessionRegistry.removeQuestion(session.sessionId, questionId, 'user_answer:cancel');
      try {
        onQuestionResolved?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] cancel: question_resolved broadcast failed: ${errorToString(err)}`);
      }
      return 'delivered';
    }

    // Drop stale answers. APNS tokens persist across disconnect (#286), so a
    // delayed lock-screen tap can deliver an answer for a question that has
    // since been resolved. Membership in the pending set
    // (not equality with a single slot) is the check, so answering one of
    // several concurrent prompts (main + subagent, #419) never invalidates
    // the others. Surface the drop so the iOS user gets a "not delivered"
    // signal instead of silent failure — EXCEPT for a same-value duplicate of
    // an answer that already applied (#752), which reports 'delivered'.
    const active = sessionRegistry.getQuestion(session.sessionId, questionId);
    if (active === null) {
      // #752: a same-value duplicate of an answer that already applied is a
      // SUCCESS, not a failure — the tap worked; this is just the losing
      // delivery channel (native POST vs JS path vs signaling relay). Report
      // 'delivered' so the client does not fire a false "Answer not
      // delivered" notification. A different value (a genuine conflicting
      // late answer) or an unknown/expired question still falls through to
      // 'stale' below.
      if (resolvedAnswers.matches(questionId, answerCacheKey(answer, extra?.selections))) {
        log(
          `[Answer] duplicate delivery for resolved question ${questionId.slice(0, 8)}; reporting delivered`,
        );
        return 'delivered';
      }
      const pendingIds = [...session.currentQuestions.keys()];
      // The question is gone from the registry (evicted under the
      // pending-question cap, or already removed). The answer is stale (we no
      // longer hold the options to map it), so it is refused; the gate stops
      // tracking the escalation, matching what the pre-#1125 hold release did.
      try {
        retireQuestion?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] stale: gate retirement failed: ${errorToString(err)}`);
      }
      log(
        `Ignoring stale answer: questionId ${questionId} not in pending [${pendingIds.join(', ') || 'none'}]`,
      );
      // #808: informational -- nothing was removed (it is already gone), but
      // recording what WAS still pending at this moment is exactly the
      // evidence needed to tell "client is showing a stale card" (Shape 1/2)
      // apart from "client and daemon agree, this really is a bad answer".
      traceQuestionEvent({
        action: 'stale_answer',
        sessionId: session.sessionId,
        questionId,
        // No promptId: by construction the question is already gone from the
        // registry (that is what makes this a stale answer), so there is no
        // Question object left to read it from.
        signal: 'STALE_ANSWER',
        callSite: 'input-events.handleAnswer',
        detail: { pendingQuestionIds: pendingIds },
      });
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

    // Submit the answer to the PTY, where Claude's native prompt is waiting
    // (#1125: remi no longer holds the hook, so this is the only answer path).
    //
    // The submit + question removal are wrapped so the question is ALWAYS
    // consumed exactly once: if `submitInput` throws, the `finally` still
    // removes it (no zombie question that a retry could double-submit), and
    // the throw still propagates (relay -> HTTP 500, WS -> caller-logged).
    //
    // Overridden below only on the #920 prompt-currency refusal, so the
    // `finally` block's removal carries an honest signal instead of the
    // default 'user_answer' (this card was never actually answered).
    let removalReason = 'user_answer';
    try {
      // The gate stops tracking this escalation: this path removes and
      // dismisses the card itself (the `finally` below).
      try {
        retireQuestion?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] gate retirement failed: ${errorToString(err)}`);
      }
      // The phone may send a label for display (#574), but Claude's native
      // numbered prompt expects the option's VALUE (the 1-based index). Resolve
      // the answer back to its option and submit the index; a free-text answer
      // (no option match) is submitted verbatim.
      const answeredOption = resolveOption(active.options, answer);
      const ptyInput = answeredOption?.value ?? answer;
      if (ptyInput !== answer) {
        log(`[Answer] resolved "${answer}" -> "${ptyInput}" for q ${questionId.slice(0, 8)}`);
      } else if (active.options.length > 0 && answeredOption === undefined) {
        log(
          `[Answer] "${answer}" matched no option (${active.options.length}); submitting verbatim`,
        );
      }

      // #920 prompt-currency guard, checked as late as possible (nothing else
      // runs between this check and the injection below). The active-question
      // lookup above only proves the CARD is still registered; a
      // `source: 'pty'` question has no hook and so no other staleness signal
      // (#920's own diagnosis), meaning a card can sit in the store, still
      // "active", long after its prompt scrolled off screen. Answering it
      // would type the resolved option value (or free text verbatim, per the
      // review comment on #920) into whatever Claude is doing right now.
      //
      // Scoped to `source === 'pty'` ONLY for the id/text check: a
      // hook-paired question's merged `id`/`text` are the HOOK's (tool +
      // command text), never the raw PTY parse (`consumeAndMerge` in
      // question-presence-tracker.ts), so `isPromptCurrent`'s id/text match
      // would almost never succeed for that cohort. Free-form `user_input`
      // (#795) is a completely different handler and never reaches this
      // branch at all.
      //
      // #1002 extends the same principle to every other card with the weaker
      // "is ANY prompt on screen" check: if no prompt is on screen, the digit
      // would land in whatever Claude is doing. That is not hypothetical: it
      // was observed typing a bare `1` into an unrelated session, recorded in
      // the transcript as a user message.
      //
      // Absent deps (no tracker wired for this session) are treated as NOT
      // current: fail toward refusing the injection. A refused legitimate
      // answer costs the user a re-answer with the question still visible;
      // an accepted stale one injects into a live session with nothing to
      // undo it.
      const promptGone =
        active.source === 'pty'
          ? !(isPromptCurrent?.(session.sessionId, questionId, active.text) ?? false)
          : !(isPromptObservedOnPTY?.(session.sessionId) ?? false);
      if (promptGone) {
        log(
          `[Answer] refusing PTY submit for ${questionId.slice(0, 8)}: no prompt on screen (source=${active.source})`,
        );
        traceQuestionEvent({
          action: 'stale_answer',
          sessionId: session.sessionId,
          questionId,
          promptId: active.promptId,
          signal: 'STALE_ANSWER',
          callSite: 'input-events.handleAnswer:promptCurrencyGuard',
          detail: {
            reason: active.source === 'pty' ? 'prompt-not-current' : 'no-prompt-on-screen',
            source: active.source,
          },
        });
        removalReason = 'user_answer:stale_prompt';
        if (!viaRelay) {
          send(
            connectionId,
            createError(
              'STALE_ANSWER',
              'The prompt for this question is no longer on screen; refusing to submit',
              {
                sessionId,
                questionId,
                pendingQuestionIds: [...session.currentQuestions.keys()],
              },
            ),
          );
        }
        return 'stale';
      }

      await session.pty.submitInput(ptyInput);

      // #752: the answer applied (PTY submit succeeded) — recorded directly
      // after application, so a throwing submit is never recorded (its
      // duplicate must keep reporting 'stale'). Recorded under every spelling
      // of the same decision: the in-app tap sends the option VALUE while a
      // push action sends the LABEL, and the duplicate may arrive on the other
      // surface (review #759 finding 1). The options are unavailable by the
      // time the duplicate hits the stale check, so the equivalence is
      // captured here.
      resolvedAnswers.record(questionId, [
        answerCacheKey(answer),
        ...(answeredOption ? [answeredOption.value, answeredOption.label] : []),
      ]);
    } finally {
      // Remove only the answered question; sibling prompts remain answerable.
      // In `finally` so a throwing submit cannot leave a zombie question, AND
      // so the #920 prompt-currency refusal above (which `return`s from
      // inside this `try`) still clears the stale card — `removalReason`
      // carries the honest signal for that path.
      sessionRegistry.removeQuestion(session.sessionId, questionId, removalReason);
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
      messageId?: UUID,
    ): Promise<void> => {
      log(`User input from ${connectionId}${raw ? ' (raw)' : ''}: ${content}`);

      const session = sessionRegistry.getSessionForConnection(connectionId);
      if (!session) {
        // #795: there is no more exclusive write lock, so every attached
        // (non-query) connection already finds its session above. Landing
        // here now only means this connectionId was never attached at all —
        // a query-mode client (ls/kill) sending input it should not, or a
        // connection that already explicitly detached. New daemons no longer
        // emit NOT_ACTIVE_CONNECTION (kept only so a newer client still
        // understands an OLDER daemon that still queues); SESSION_NOT_FOUND
        // covers both "session missing" and "this connection isn't attached
        // to it" since from this connection's perspective there is no
        // session to write to either way. Previously this dropped the input
        // with only a server-side log line, so the sender's UI showed the
        // message as "sent" while it silently vanished; still surface an
        // error instead.
        const sessionExists = sessionRegistry.getSession(sessionId) !== undefined;
        log(
          `No session found for connection ${connectionId} (session ${sessionExists ? 'exists but this connection is not attached' : 'not found'})`,
        );
        send(
          connectionId,
          createError(
            'SESSION_NOT_FOUND',
            sessionExists
              ? `This connection is not attached to session ${sessionId}; input was not delivered.`
              : `Session ${sessionId} not found on this daemon`,
            // #681: carry the rejected input's own message id so the client
            // can flip that SPECIFIC bubble to 'failed' -- the daemon acks
            // user_input unconditionally before this check runs (connection.ts
            // handleUserInput), so the sender otherwise sees a false
            // "delivered" with only silence as a signal.
            { sessionId, ...(messageId !== undefined && { messageId }) },
          ),
        );
        return;
      }

      if (!guardBinding(bindingStore, send, connectionId, sessionId, claudeSessionId)) {
        return;
      }

      if (raw) {
        // Raw terminal input from attach client: write directly without
        // Enter. Awaited (#795) so it queues onto the same per-session write
        // chain as submitInput() and a failure from a queued write is still
        // caught here.
        try {
          await session.pty.write(content);
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
