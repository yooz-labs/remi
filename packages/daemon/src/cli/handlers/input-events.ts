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

import {
  PROMPT_WAITING_ERROR_CODE,
  PROMPT_WAITING_HELD_MESSAGE,
  PROMPT_WAITING_MESSAGE,
  createBulletExpandResponse,
  createError,
  createInputNotDeliveredError,
  createPromptWaitingError,
  errorToString,
} from '@remi/shared';
import type { AnswerExtras, AnswerSelection, Question, QuestionOption, UUID } from '@remi/shared';

import type { HeldAnswer, HeldAnswerOutcome } from '../../auto-approve/index.ts';
import type { ManagedSession, SessionBindingStore, SessionRegistry } from '../../session/index.ts';
import { traceQuestionEvent } from '../../session/question-trace.ts';
import { log, logError } from '../logger.ts';
import { ResolvedAnswerCache, answerCacheKey } from './resolved-answer-cache.ts';
import { isNumberedMenu } from './screen-menu.ts';
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
   * Apply a phone answer to a held permission prompt (#1126), backed by the
   * session's gate (`SessionGateHandle.answerHeld`, wired by
   * `gateAnswerDeps`). Asked before anything could be typed: a held prompt
   * is answered through its hook response, and a binary prompt whose hold
   * has ended (`closed`) is never typed into, its answer belongs to the
   * terminal. Absent (no hook server: no held prompts) reads as `unknown`.
   */
  answerHeld?: (sessionId: UUID, questionId: UUID, answer: HeldAnswer) => HeldAnswerOutcome;
  /**
   * Is a main-agent prompt's hook held for this session (#1126)? Its dialog
   * is on screen, so the chat guard refuses chat text even when the PTY
   * parser has not observed the menu. Wired by `gateAnswerDeps`. Absent
   * reads as false (no hook server: nothing is held).
   */
  isMainPromptHeld?: (sessionId: UUID) => boolean;
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
   * NOT backed by a "this tracker pushed a card off a PTY render" flag (the
   * tracker's former `isPromptVisibleOnPTY`, removed in #1125). Such a flag
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
  /**
   * The options of the prompt currently observed on this session's screen,
   * backed by `QuestionPresenceTracker.observedPromptOptions` (#1134). Null
   * when no prompt is observed; an empty array when the prompt on screen is
   * not an option menu.
   *
   * The screen-numbering guard in `handleAnswer` checks every option value
   * it is about to type against these, and refuses free text when these
   * show a menu and the card does not take text. A card's numbering is
   * not proof of the screen's: live, a 4-option card over a 3-option dialog
   * typed a phone "No" as `4`, Claude ignored the digit, and the Enter after
   * it confirmed the highlighted "1. Yes".
   *
   * Absent => no observed options, so an option answer is refused: the same
   * fail-toward-refusing default as `isPromptCurrent` and
   * `isPromptObservedOnPTY`.
   *
   * `onUserInput` reads it the other way round (#1140): a NUMBERED selection
   * box in the list (`isNumberedMenu`) means chat text is refused, while
   * absent or null (nothing observed, or the dep unwired) types the text as
   * before. In production `cli.ts` builds a tracker for every session, hook
   * server or not, so "no tracker" is effectively never the case there; the
   * fail-open default only matters to a caller that does not wire this dep
   * (tests, a future entry point), and it is the opposite of the answer
   * guards above, which fail closed.
   */
  observedPromptOptions?: (sessionId: UUID) => readonly QuestionOption[] | null;
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
 *   - `delivered`     — the answer reached Claude: through a held hook, or
 *                       submitted to the PTY.
 *   - `session-not-found` — no session matched the sessionId/connectionId.
 *   - `stale-binding` — the Claude session this answer targeted has rotated.
 *   - `stale`         — the answer was not applied: the question is no
 *                       longer active, or the answer was refused (not one the
 *                       card takes, or a typed answer the screen refutes).
 */
export type AnswerOutcome = 'delivered' | 'session-not-found' | 'stale-binding' | 'stale';

export type InputHandlers = ReturnType<typeof createInputHandlers>;

/** The tracker reads the answer guards use (`QuestionPresenceTracker`). */
export interface ScreenObserver {
  isPromptCurrent(questionId: string, ptyText?: string): boolean;
  isPromptObservedOnPTY(): boolean;
  observedPromptOptions(): readonly QuestionOption[] | null;
}

/**
 * The three screen deps (`isPromptCurrent`, `isPromptObservedOnPTY`,
 * `observedPromptOptions`) backed by each session's tracker. The ONE wiring
 * for them: `cli.ts` passes its per-session tracker map and the tests pass
 * their tracker, so a test exercising the guards exercises the production
 * wiring (#1134 review: a hand-copied line could be deleted from `cli.ts`
 * with every test still green). No tracker for the session reads as nothing
 * observed, which refuses a PTY submit.
 */
export function trackerScreenDeps(
  trackerFor: (sessionId: UUID) => ScreenObserver | undefined,
): Pick<InputHandlerDeps, 'isPromptCurrent' | 'isPromptObservedOnPTY' | 'observedPromptOptions'> {
  return {
    isPromptCurrent: (sessionId, questionId, ptyText) =>
      trackerFor(sessionId)?.isPromptCurrent(questionId, ptyText) ?? false,
    isPromptObservedOnPTY: (sessionId) => trackerFor(sessionId)?.isPromptObservedOnPTY() ?? false,
    observedPromptOptions: (sessionId) => trackerFor(sessionId)?.observedPromptOptions() ?? null,
  };
}

/** The gate reads the answer path uses (`SessionGateHandle`). */
export interface GateAnswerHandle {
  retireQuestion(questionId: UUID): void;
  answerHeld(questionId: UUID, answer: HeldAnswer): HeldAnswerOutcome;
  hasMainHold(): boolean;
}

/**
 * The gate deps (`retireQuestion`, `answerHeld`, `isMainPromptHeld`) backed by each session's
 * permission gate (#1126). The ONE wiring for them, shared by `cli.ts` and
 * the tests in the same way as `trackerScreenDeps`, so a test of the held
 * answer path exercises the production wiring. No gate for the session
 * reads as `unknown` (nothing held) and retires nothing.
 */
export function gateAnswerDeps(
  gateFor: (sessionId: UUID) => GateAnswerHandle | undefined,
): Pick<InputHandlerDeps, 'retireQuestion' | 'answerHeld' | 'isMainPromptHeld'> {
  return {
    retireQuestion: (sessionId, questionId) => gateFor(sessionId)?.retireQuestion(questionId),
    answerHeld: (sessionId, questionId, answer) =>
      gateFor(sessionId)?.answerHeld(questionId, answer) ?? 'unknown',
    isMainPromptHeld: (sessionId) => gateFor(sessionId)?.hasMainHold() ?? false,
  };
}

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

/** What a plain answer string names among a card's options (#1127 review
 *  S1): one option, none, or two different ones. */
type NamedOption =
  | { readonly kind: 'one'; readonly option: QuestionOption }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' };

/**
 * The option a plain answer string names on a held card. The lock screen
 * sends an option's LABEL and Telegram its VALUE, and `resolveOption` takes
 * the first option matching either; with numeric labels ("4", "2", "1") a
 * lock-screen tap on "1" would then answer the option whose value is "1",
 * labeled "4" (reproduced in review). A string that is one option's value
 * and a DIFFERENT option's label is therefore ambiguous: the held path
 * refuses it and keeps the card and the hold. Typed (non-held) cards keep
 * `resolveOption`.
 */
function namedOption(options: readonly QuestionOption[], answer: string): NamedOption {
  const byValue = options.find((o) => o.value === answer);
  const byLabel = options.find((o) => o.label === answer);
  if (byValue !== undefined && byLabel !== undefined && byValue !== byLabel) {
    return { kind: 'ambiguous' };
  }
  const option = byValue ?? byLabel;
  return option === undefined ? { kind: 'none' } : { kind: 'one', option };
}

/** The refusal of an answer that names two different options (see
 *  `namedOption`). */
const AMBIGUOUS_ANSWER_MESSAGE =
  'This answer matches one option by its number and another by its label; answer again from the card in the app';

/** A PTY submit the #1134 screen-numbering guard refuses, and how. */
interface ScreenRefusal {
  /** Trace `detail.reason`. */
  readonly reason:
    | 'option-not-on-screen'
    | 'option-mismatch'
    | 'free-text-into-menu'
    | 'free-text-on-held-card'
    | 'selections-not-held';
  /** `SessionRegistry.removeQuestion` signal for the refused card. */
  readonly removalReason: string;
  /** STALE_ANSWER message to the client. */
  readonly message: string;
  /** Daemon log fragment, given what would have been typed. */
  readonly logLine: (input: string) => string;
}

const SCREEN_REFUSALS = {
  optionNotOnScreen: {
    reason: 'option-not-on-screen',
    removalReason: 'user_answer:option_not_on_screen',
    message: 'This answer is not an option on the prompt on screen; refusing to submit',
    logLine: (input) => `"${input}" is not an option on screen`,
  },
  optionMismatch: {
    reason: 'option-mismatch',
    removalReason: 'user_answer:option_mismatch',
    message: 'The prompt on screen numbers a different option this way; refusing to submit',
    logLine: (input) => `"${input}" means a different option on screen`,
  },
  freeTextOnHeldCard: {
    reason: 'free-text-on-held-card',
    removalReason: 'user_answer:free_text_on_held_card',
    message: 'This prompt takes one of its options, not text; refusing to submit',
    logLine: (input) => `free text (${input.length} chars) on a held card that takes options`,
  },
  freeTextIntoMenu: {
    reason: 'free-text-into-menu',
    removalReason: 'user_answer:free_text_into_menu',
    message: 'The prompt on screen takes a choice, not text; refusing to submit',
    logLine: (input) => `free text (${input.length} chars) into the option menu on screen`,
  },
  // #1127: a structured answer exists only as a hook response. With no hold
  // behind the card (a question-shaped tool that is not AskUserQuestion,
  // whose dialog is Claude's permission prompt) it cannot be expressed, and
  // nothing is typed for it.
  selectionsNotHeld: {
    reason: 'selections-not-held',
    removalReason: 'user_answer:selections_not_held',
    message:
      'This prompt cannot take a structured answer from the phone; answer it in the terminal',
    logLine: () => 'a structured answer for a card no held hook stands behind',
  },
} as const satisfies Record<string, ScreenRefusal>;

/** A label reduced to what survives the PTY parse: lowercase, with ALL
 *  whitespace and box-drawing characters removed, so the parser's spacing
 *  loss (#1137) cannot make two spellings of one label disagree. */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[\s\u2500-\u257F|]/g, '');
}

/**
 * Whether the card option the user picked and the screen option with the
 * same value are the same choice (#1134 review). The value check alone only
 * proves the digit EXISTS on screen: a card numbered by the hook ([Yes, No])
 * over Claude's [Yes, Yes always, No] sends "No" as 2, which the screen
 * numbers as the standing allow.
 *
 * Exact on purpose: the normalized labels (`normalizeLabel`) must be EQUAL,
 * or, for a pick with a description (a question-shaped tool's), equal once
 * its description is appended
 * (the parser folds the description row into the screen label). Nothing
 * looser is safe. A Yes/No class lets "Yes" pass for "Yes, and don't ask
 * again" and "Yes, use pnpm" for "Yes, use npm"; a shared prefix lets
 * "Yes, allow reading from /tmp/x" pass for "/etc/...". This PR is a stopgap
 * until hook-backed prompts stop being answered by typing (epic #1123 Phase
 * 3), so it fails closed: a refusal means "answer at the terminal", a wrong
 * answer is not acceptable. The cost is false refusals when a label is short,
 * truncated by a partial frame, or reworded by Claude.
 */
function sameChoice(card: QuestionOption, screen: QuestionOption): boolean {
  const onScreen = normalizeLabel(screen.label);
  if (normalizeLabel(card.label) === onScreen) return true;
  return (
    card.description !== undefined &&
    card.description.length > 0 &&
    normalizeLabel(`${card.label}${card.description}`) === onScreen
  );
}

/**
 * The #1134 screen-numbering guard's verdict for a PTY submit, or null to
 * let it through. `screenOptions` is the
 * prompt the tracker last observed (null when none).
 */
function screenRefusal(
  active: Question,
  answer: string,
  ptyInput: string,
  screenOptions: readonly QuestionOption[] | null,
): ScreenRefusal | null {
  const chosen = resolveOption(active.options, answer);
  if (chosen !== undefined) {
    const onScreen = screenOptions?.find((o) => o.value === ptyInput);
    if (onScreen === undefined) return SCREEN_REFUSALS.optionNotOnScreen;
    return sameChoice(chosen, onScreen) ? null : SCREEN_REFUSALS.optionMismatch;
  }
  const screenIsMenu = (screenOptions?.length ?? 0) > 0;
  return active.options.length > 0 && !active.allowsFreeText && screenIsMenu
    ? SCREEN_REFUSALS.freeTextIntoMenu
    : null;
}

/** Every spelling of one answer to `active`: the raw answer (or its
 *  selections), plus the resolved option's value and label, because the
 *  in-app tap sends the value and a push action sends the label. */
function answerKeys(
  active: Question,
  answer: string,
  selections: readonly AnswerSelection[] | undefined,
): string[] {
  const option =
    Array.isArray(selections) && selections.length > 0
      ? undefined
      : resolveOption(active.options, answer);
  return [answerCacheKey(answer, selections), ...(option ? [option.value, option.label] : [])];
}

/** The answer's structured AskUserQuestion selections (#627), when it carries
 *  a non-empty list of them. Their entries are not validated here: the gate
 *  checks them against the tool input (#1127). */
function structuredSelections(
  extra: AnswerExtras | undefined,
): readonly AnswerSelection[] | undefined {
  const selections = extra?.selections;
  return Array.isArray(selections) && selections.length > 0 ? selections : undefined;
}

/** A phone answer to a held card as one log fragment, without the user's
 *  text (only its length). */
function describeHeldAnswer(held: HeldAnswer): string {
  switch (held.kind) {
    case 'option':
      return `"${held.option.label}"`;
    case 'text':
      return `free text (${held.text.length} chars)`;
    case 'selections':
      return `an answer to ${held.selections.length} question(s)`;
    case 'cancel':
      return 'Cancel';
    case 'ambiguous':
      return 'an answer naming one option by value and another by label';
  }
}

/** The Escape key, written exactly (no Enter) by a Cancel on a card no held
 *  hook stands behind. */
const ESC = '\x1b';

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
    answerHeld,
    isMainPromptHeld,
    onQuestionResolved,
    isPromptCurrent,
    isPromptObservedOnPTY,
    observedPromptOptions,
  } = deps;

  // #752: same-value duplicate deliveries of a successful answer (native POST +
  // Capacitor JS path + signaling relay all fire per tap) report 'delivered'
  // instead of 'stale', so the losing channel stops showing a false "Answer
  // not delivered" notification.
  const resolvedAnswers = new ResolvedAnswerCache();

  // #1134 review: questions whose answer is being applied right now, with
  // every spelling of that answer (see `answerKeys`) and the outcome it will
  // settle to. Claimed synchronously in `handleAnswer`, released when
  // `applyAnswer` settles.
  const answersInFlight = new Map<
    UUID,
    { readonly keys: ReadonlySet<string>; readonly outcome: Promise<AnswerOutcome> }
  >();

  /**
   * Shared answer-routing core for both the WebSocket `onAnswer` event and the
   * HTTP `/answer` relay (#575, P4a). Claims the question, then answers a held
   * prompt through its hook (#1126; AskUserQuestion and ExitPlanMode too,
   * #1127), or, for a prompt no held hook stands behind, checks the answer
   * against the screen (#920, #1002, #1134) and submits the answered option's
   * digit (or free text) to the PTY, where Claude's native prompt is waiting.
   * The card is removed once answered. A refusal means "answer at the
   * terminal" (or, for a held card, "answer again"). Returns the outcome; the
   * WebSocket path additionally surfaces errors over the connection via
   * `send` (suppressed when `viaRelay`).
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

    // #627 cancel/escape — the universal unstick. On a held card (#1126) it is
    // answered through the hook: a "No" for a permission, a dismissal for an
    // AskUserQuestion, "Keep planning" for a plan (#1127). On a card whose
    // hold has ended it only clears the card. Neither types Esc: nothing is
    // typed into a hook-backed prompt. On any other card still active (a
    // hook-less prompt, a multi-choice card) it sends Esc to the PTY so the
    // prompt cancels and Claude unblocks. The Esc is gated on the question
    // still being active: a delayed cancel for an already-resolved question
    // must NOT inject Esc into whatever Claude renders next (#631 review).
    // Cleanup (gate retirement, removeQuestion, broadcast) is unconditional so
    // the card always clears.
    if (extra?.cancel) {
      const held = answerHeld?.(session.sessionId, questionId, { kind: 'cancel' }) ?? 'unknown';
      const stillActive =
        held === 'unknown' && sessionRegistry.getQuestion(session.sessionId, questionId) !== null;
      if (held === 'resolved') {
        log(`[Answer] cancel: denied held prompt ${questionId.slice(0, 8)} through its hook`);
      } else if (held === 'closed') {
        log(
          `[Answer] cancel: ${questionId.slice(0, 8)} is no longer held; clearing the card, nothing typed`,
        );
      } else if (stillActive) {
        try {
          await session.pty.write(ESC);
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

    // #1134 review: claim the question synchronously, before anything awaits.
    // A lock-screen tap arrives on two channels by design (`RemiAnswerRelay`
    // POSTs to /answer AND hands the tap to the Capacitor handler), and the
    // card stays registered until `applyAnswer`'s submit finishes, so without
    // a claim both deliveries passed the lookup above and typed the digit
    // twice; the second Enter then answered whatever Claude showed next. A
    // same-choice duplicate types nothing and reports what the FIRST
    // delivery's answer came to (a refused or failed first answer must not
    // read as delivered on the other channel); a different answer while one
    // is in flight is refused.
    const claimKeys = answerKeys(active, answer, extra?.selections);
    const inFlight = answersInFlight.get(questionId);
    if (inFlight !== undefined) {
      if (claimKeys.some((k) => inFlight.keys.has(k))) {
        log(
          `[Answer] duplicate delivery for ${questionId.slice(0, 8)} while its answer is being applied; typing nothing, reporting the first delivery's outcome`,
        );
        // A first delivery that threw was not delivered; the thrower reports
        // that itself, the duplicate reports it as not delivered.
        return inFlight.outcome.catch((): AnswerOutcome => 'stale');
      }
      log(
        `[Answer] refusing a different answer for ${questionId.slice(0, 8)}: another answer is being applied`,
      );
      if (!viaRelay) {
        send(
          connectionId,
          createError('STALE_ANSWER', 'Another answer for this question is already being applied', {
            sessionId,
            questionId,
            pendingQuestionIds: [...session.currentQuestions.keys()],
          }),
        );
      }
      return 'stale';
    }
    // `applyAnswer` runs synchronously up to its first await, and nothing
    // else can run before this call returns, so the claim is in place before
    // any other delivery can look.
    const outcome = applyAnswer(
      connectionId,
      sessionId,
      questionId,
      answer,
      viaRelay,
      extra,
      session,
      active,
    );
    answersInFlight.set(questionId, { keys: new Set(claimKeys), outcome });
    try {
      return await outcome;
    } finally {
      answersInFlight.delete(questionId);
    }
  }

  /**
   * The held-prompt half of `applyAnswer` (#1126). Returns the outcome when
   * the gate held (or once held) this question, null when the caller's PTY
   * path applies (`unknown`). Synchronous: the hook response is settled
   * before anything else can run.
   *   - `resolved`: the hook answered; the card is consumed and dismissed.
   *   - `refused`: not an answer this card offers (free text on a permission,
   *     a stale label, an incomplete AskUserQuestion answer, #1127); the
   *     card and the hold stay so the user can answer again.
   *   - `closed`: the hold ended (deadline, terminal answer, abort); refused
   *     like a stale answer and the card is cleared. Nothing is typed.
   * A structured AskUserQuestion answer (`selections`, #1127) goes to the
   * gate as it came; the gate validates it against the tool input.
   */
  function applyHeldAnswer(
    connectionId: UUID,
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    viaRelay: boolean,
    extra: AnswerExtras | undefined,
    session: ManagedSession,
    active: Question,
  ): AnswerOutcome | null {
    if (!answerHeld) return null;
    const selections = structuredSelections(extra);
    const named = selections === undefined ? namedOption(active.options, answer) : undefined;
    const option = named?.kind === 'one' ? named.option : undefined;
    // `message` crosses a trust boundary unvalidated (the protocol checks only
    // the message type), so anything but a string is dropped here.
    const message = typeof extra?.message === 'string' ? extra.message : undefined;
    const held: HeldAnswer =
      selections !== undefined
        ? { kind: 'selections', selections }
        : named?.kind === 'ambiguous'
          ? { kind: 'ambiguous' }
          : option === undefined
            ? { kind: 'text', text: answer }
            : { kind: 'option', option, ...(message !== undefined ? { message } : {}) };
    const outcome = answerHeld(session.sessionId, questionId, held);
    if (outcome === 'unknown') return null;
    if (outcome === 'resolved') {
      resolvedAnswers.record(questionId, [
        answerCacheKey(answer, selections),
        ...(option ? [option.value, option.label] : []),
      ]);
      sessionRegistry.removeQuestion(session.sessionId, questionId, 'user_answer:hook');
      try {
        onQuestionResolved?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] question_resolved broadcast failed: ${errorToString(err)}`);
      }
      log(`[Answer] held prompt ${questionId.slice(0, 8)} answered through its hook`);
      return 'delivered';
    }
    const closed = outcome === 'closed';
    log(
      closed
        ? `[Answer] refusing ${questionId.slice(0, 8)}: its hold has ended, answer at the terminal; nothing typed`
        : `[Answer] refusing ${questionId.slice(0, 8)}: ${describeHeldAnswer(held)} is not an answer this held card offers; card and hold kept`,
    );
    traceQuestionEvent({
      action: 'stale_answer',
      sessionId: session.sessionId,
      questionId,
      promptId: active.promptId,
      signal: 'STALE_ANSWER',
      callSite: 'input-events.handleAnswer:heldPrompt',
      detail: {
        reason: closed
          ? 'hold-closed'
          : held.kind === 'ambiguous'
            ? 'ambiguous-option'
            : 'not-a-held-option',
        source: active.source,
      },
    });
    if (closed) {
      sessionRegistry.removeQuestion(session.sessionId, questionId, 'user_answer:hold_closed');
      try {
        onQuestionResolved?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] question_resolved broadcast failed: ${errorToString(err)}`);
      }
    }
    if (!viaRelay) {
      send(
        connectionId,
        createError(
          'STALE_ANSWER',
          closed
            ? 'This prompt is no longer waiting for the phone; answer it in the terminal'
            : held.kind === 'ambiguous'
              ? AMBIGUOUS_ANSWER_MESSAGE
              : selections !== undefined
                ? 'Answer every question: one choice, or your own text of up to 2000 characters, for each single-choice question, and at least one choice for each multiple-choice question'
                : 'This prompt takes one of its own options',
          {
            sessionId,
            // A refused answer leaves the card live, and a client drops the
            // card a STALE_ANSWER names; only a closed one is named. The
            // pending list still carries the refused card, so a client's
            // reconciliation keeps it.
            ...(closed ? { questionId } : {}),
            pendingQuestionIds: [...session.currentQuestions.keys()],
          },
        ),
      );
    }
    return 'stale';
  }

  /**
   * The part of `handleAnswer` that acts on a live, CLAIMED question (see the
   * in-flight claim there): answer a held prompt through its hook (a
   * binary permission, an AskUserQuestion, an ExitPlanMode), or type into the
   * PTY (behind the screen guards), then consume the card.
   */
  async function applyAnswer(
    connectionId: UUID,
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    viaRelay: boolean,
    extra: AnswerExtras | undefined,
    session: ManagedSession,
    active: Question,
  ): Promise<AnswerOutcome> {
    // #1126: a held prompt is answered through its hook response, and a
    // prompt whose hold has ended is answered only at the terminal. Both are
    // decided here, before anything could be typed. Since #1127 that covers
    // AskUserQuestion (its `selections` included) and ExitPlanMode.
    const heldOutcome = applyHeldAnswer(
      connectionId,
      sessionId,
      questionId,
      answer,
      viaRelay,
      extra,
      session,
      active,
    );
    if (heldOutcome !== null) return heldOutcome;

    // Submit the answer to the PTY, where Claude's native prompt is waiting.
    // Only prompts no held hook stands behind reach this point: hook-less
    // prompts (sandbox, trust, agent-team dialogs) and the multi-choice
    // cards pushed by id (a string-label permission, a question-shaped tool
    // that is not AskUserQuestion). AskUserQuestion and ExitPlanMode are
    // held and answered above (#1127).
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
    /** Refuse a PTY submit for the #1134 guard: log, trace, consume the card
     *  (in `finally`, under the refusal's own signal), tell the client, type
     *  nothing. */
    const refuseSubmit = (
      refusal: ScreenRefusal,
      input: string,
      screenOptions: readonly QuestionOption[] | null,
    ): 'stale' => {
      const screenValues = (screenOptions ?? []).map((o) => o.value);
      const typedText =
        refusal === SCREEN_REFUSALS.freeTextIntoMenu ||
        refusal === SCREEN_REFUSALS.freeTextOnHeldCard ||
        refusal === SCREEN_REFUSALS.selectionsNotHeld;
      log(
        `[Answer] refusing PTY submit for ${questionId.slice(0, 8)}: ${refusal.logLine(input)} [${screenValues.join(', ') || 'none'}]`,
      );
      traceQuestionEvent({
        action: 'stale_answer',
        sessionId: session.sessionId,
        questionId,
        promptId: active.promptId,
        signal: 'STALE_ANSWER',
        callSite: 'input-events.handleAnswer:screenNumberingGuard',
        detail: {
          reason: refusal.reason,
          source: active.source,
          // An option value is a digit; free text may be anything the user
          // typed, so only its length is recorded.
          ...(typedText ? { textLength: input.length } : { value: input }),
          screenValues,
        },
      });
      removalReason = refusal.removalReason;
      if (!viaRelay) {
        send(
          connectionId,
          createError('STALE_ANSWER', refusal.message, {
            sessionId,
            questionId,
            pendingQuestionIds: [...session.currentQuestions.keys()],
          }),
        );
      }
      return 'stale';
    };
    try {
      // The gate stops tracking this escalation: this path removes and
      // dismisses the card itself (the `finally` below).
      try {
        retireQuestion?.(session.sessionId, questionId);
      } catch (err) {
        logError(`[Answer] gate retirement failed: ${errorToString(err)}`);
      }
      // A structured AskUserQuestion answer (`selections`) for a card no hold
      // stands behind cannot be typed (#1127 deleted the keystroke runner):
      // refused, the prompt is answered at the terminal.
      if (structuredSelections(extra) !== undefined) {
        return refuseSubmit(SCREEN_REFUSALS.selectionsNotHeld, answer, null);
      }
      // Free text on a card pushed by id (`pushHeldHook`, stamped `held`) is
      // refused before anything is typed (#1134 review). A held binary card
      // never reaches this point: the gate answered it through its hook
      // above (#1126), as it does AskUserQuestion and ExitPlanMode (#1127).
      // What arrives here stamped `held` is a passthrough multi-choice card.
      // Only an option of this card can be expressed; text typed into the
      // dialog is ignored and the Enter after it confirms the highlighted
      // option, so free text is refused whether or not a menu has been
      // observed yet.
      if (
        active.held === true &&
        active.options.length > 0 &&
        !active.allowsFreeText &&
        resolveOption(active.options, answer) === undefined
      ) {
        return refuseSubmit(SCREEN_REFUSALS.freeTextOnHeldCard, answer, null);
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
          `[Answer] "${answer}" matched no option (${active.options.length}); treating it as free text`,
        );
      }

      // #920 prompt-currency guard, checked as late as possible (nothing else
      // runs between these checks and the injection below). The active-question
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
      // the transcript as a user message. (Before #1125 an answer that
      // released a held hook was exempt, because Claude was about to render.
      // A held prompt never reaches this path since #1126: it is answered
      // through its hook above, so every typed answer needs a prompt on
      // screen.)
      //
      // Absent deps (no tracker wired for this session) are treated as NOT
      // current: fail toward refusing the injection. A refused legitimate
      // answer costs the user a re-answer at the terminal; an accepted stale
      // one injects into a live session with nothing to undo it.
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

      // #1134 screen-numbering guard: an option value typed into the PTY
      // must be one of the values the menu on screen shows. Claude's menu
      // ignores any other digit, and the "\r" `submitInput` sends after it
      // then confirms whichever option is highlighted, usually "1. Yes".
      // That is how a phone "No" approved a command: the card numbered "No"
      // 4 over a 3-option dialog. The merge now gives render-born cards the
      // screen's options, but a card's numbering is not proof of the
      // screen's (a card pushed by id before its render carries the hook's;
      // a registered card keeps its options when the prompt later redraws
      // with different ones), so the check runs against the observed
      // screen itself. Existing is not enough either: the screen option
      // with that value must be the same choice as the card option
      // (`sameChoice`, exact normalized labels), or a hook-numbered "No"
      // lands on the screen's "Yes, and always ..." with the same digit.
      //
      // Free text gets the same treatment when it would land in a menu
      // (#1134 review): the card has options and does not take free text,
      // and the screen shows a numbered menu. The menu ignores the text the
      // same way, and the Enter confirms the highlighted option. Free text
      // is still typed when the card takes it (an elicitation) or when no
      // menu is on screen (a free-text prompt).
      //
      // Before #1125 an answer that released a held hook skipped this check
      // (nothing had rendered yet). Nothing typed here comes from a held
      // prompt since #1126, so every typed answer is checked. A refusal means
      // "answer at the terminal".
      const screenOptions = observedPromptOptions?.(session.sessionId) ?? null;
      const refusal = screenRefusal(active, answer, ptyInput, screenOptions);
      if (refusal !== null) return refuseSubmit(refusal, ptyInput, screenOptions);

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
          // Tell the sender (#1140 review). It used to be a log line only, so
          // a client that reports success on its Escape (Telegram's
          // "Interrupt sent") reported it falsely when the terminal was gone.
          send(connectionId, createInputNotDeliveredError(session.sessionId, messageId));
        }
        return;
      }

      // #1140: structured input is typed followed by Enter. While Claude
      // shows a numbered selection menu (a permission prompt, or a hook-less
      // one) it ignores the text and the Enter confirms the highlighted
      // option, usually "1. Yes", so a chat message or a Telegram text reply
      // sent while a prompt waits would approve the pending action. Refuse it
      // and say why. Raw input (above) stays unguarded: it is a person's
      // keystrokes at the terminal, which is how the menu gets answered.
      //
      // `observedPromptOptions` is the tracker's view of the screen, the same
      // signal the card-answer guards use (#1134). Only a NUMBERED selection
      // box refuses (`isNumberedMenu`): a subprocess `(y/n)` prompt is observed
      // too, with options "y"/"n", and it takes typed text. Absent, or null (no
      // prompt observed, or no tracker): nothing is known to be on screen, so
      // the text is typed as before.
      //
      // #1126: a held main-agent prompt's dialog is on screen too (it renders
      // during the hold), so it refuses as well, whether or not the parser
      // has recognized the menu: the hook says a dialog is up even when the
      // screen parse does not.
      const menu = observedPromptOptions?.(session.sessionId) ?? null;
      const menuOnScreen = menu !== null && isNumberedMenu(menu);
      const held = isMainPromptHeld?.(session.sessionId) ?? false;
      if (menuOnScreen || held) {
        const screenValues = (menu ?? []).map((o) => o.value);
        log(
          `[Input] refusing ${content.length} chars of chat text for session ${session.sessionId.slice(0, 8)}: ${menuOnScreen ? `a prompt menu is on screen [${screenValues.join(', ')}]` : 'a held prompt is on screen'}`,
        );
        traceQuestionEvent({
          action: 'input_refused',
          sessionId: session.sessionId,
          signal: PROMPT_WAITING_ERROR_CODE,
          callSite: 'input-events.onUserInput:chatIntoMenuGuard',
          // Only the length of what the user typed is recorded, never the text.
          detail: {
            reason: menuOnScreen ? 'chat-into-menu' : 'chat-into-held-prompt',
            textLength: content.length,
            screenValues,
          },
        });
        // While a hook is held the dialog may already be answered: a Yes in
        // the terminal ends the hold only when its tool finishes, so the
        // message must not claim a dialog is up (#1126, #1144).
        send(
          connectionId,
          createPromptWaitingError(
            session.sessionId,
            messageId,
            held ? PROMPT_WAITING_HELD_MESSAGE : PROMPT_WAITING_MESSAGE,
          ),
        );
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
     * deliver an answer over plain HTTP, then returns the
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
      // It carries one answer string (the tapped option's label), never
      // `selections`: a held one-question AskUserQuestion takes it as that
      // question's answer (#1127), anything else refuses it.
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
