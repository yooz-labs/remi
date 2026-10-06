/**
 * NotificationDispatcher — owns APNS push for a session's questions.
 *
 * Epic #453 phase 1: extracted from `cli/session-phases/message-api-setup.ts`
 * so the push concern (active-client gate + per-prompt dedup + the device-token
 * fan-out) is a named member of the future `QuestionPipeline`, not inlined in
 * the MessageAPI question callback.
 *
 * Push fires only when no client is actively viewing the session (attached
 * clients see the question in-app over the WebSocket). The per-session
 * PushDedup baseline suppresses the PTY+Hook double-emission of one prompt so
 * the user does not get two lock-screen notifications per prompt (#409); it is
 * reset whenever the agent leaves the 'waiting' state.
 */

import { type Question, type QuestionOption, type UUID, generateId } from '@remi/shared';

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import { log, logError } from '../cli/logger.ts';
import type { SessionRegistry } from '../session/index.ts';
import { type LegacyPushPolicy, legacyPushFields } from './legacy-push-policy.ts';
import { sendPushTrigger } from './push-client.ts';
import { PushDedup } from './push-dedup.ts';
import { tokensWanting } from './push-preferences.ts';
import type { SecureSessionPush } from './secure-push-service.ts';
import { type TurnFailedInput, buildTurnFailedText, turnFailedCollapseId } from './turn-failed.ts';

export interface PushConfig extends LegacyPushPolicy {
  /**
   * Signaling server base URL. Always provided by the caller; `sendPushTrigger`'s
   * `string | undefined` first parameter is wider (it has its own fallback), but
   * the dispatcher never passes undefined here.
   */
  signalingUrl: string;
  pushSecret?: string | undefined;
}

/** A label as the PTY parse leaves it comparable: lowercase, with all
 *  whitespace and box-drawing characters removed (#1137 spacing loss). */
function normalizedLabel(option: QuestionOption): string {
  return option.label.toLowerCase().replace(/[\s\u2500-\u257F|]/g, '');
}

/**
 * A one-time Yes, by allowlist (#1134 review): an option labeled exactly
 * "Yes" (after `normalizedLabel`). Every other Yes ("Yes, auto-accept
 * edits", "Yes, proceed and trust this folder", "Yes, and bypass
 * permissions") grants something beyond this one action, and a denylist of
 * grant wordings cannot keep up with Claude's.
 */
function isOneTimeYes(option: QuestionOption): boolean {
  return option.sessionGrant === undefined && !option.isNo && normalizedLabel(option) === 'yes';
}

function isPlainNo(option: QuestionOption): boolean {
  return option.isNo && !option.isYes;
}

/**
 * Whether option `index` grants something standing (#1134 review). Any Yes
 * after the first option counts, whatever its label says ("Yes, allow reading
 * from <dir> during this session", "Yes, switch to acceptEdits mode"); so
 * does a first Yes that is not exactly "Yes" (`isOneTimeYes`), and a
 * session-grant action.
 */
function isStanding(option: QuestionOption, index: number): boolean {
  if (option.sessionGrant !== undefined) return true;
  return option.isYes && (index > 0 || !isOneTimeYes(option));
}

/**
 * Select the APNS notification category from what the options MEAN, not how
 * many there are (#1134 review). iOS renders the category's action buttons
 * (watchOS mirrors them) and each is POSITIONAL: `OPT_i` sends option i
 * (`AppDelegate.swift`, `RemiAnswerRelay.swift`). The two permission
 * categories have hardcoded titles, so they are chosen only when those titles
 * are true:
 *   - REMI_YN ("Yes" / "No"): exactly [one-time Yes, No].
 *   - REMI_YNA ("Yes" / "Yes, always" / "No"): exactly [one-time Yes, an
 *     always-allow rule, No], the middle option marked `standingGrant:
 *     'addRules'` (#1126 lead decision: only there is the static "Yes, always"
 *     title true; a `setMode` or an unmarked standing option gets no
 *     category). Its middle button is the only static action that requires
 *     an unlocked device, so a standing grant is offered on the lock screen
 *     ONLY in this layout, and only through this static category: no
 *     standing card gets the `dynOptions` hint (`selectDynOptions`).
 * A one-time Yes is an option labeled exactly "Yes" (`isOneTimeYes`).
 * A card with any other standing option (`isStanding`) gets NO category: a
 * plain notification, answered in the app, because REMI_MULTI's buttons do
 * not require an unlocked device. Every other 2-4 option card gets
 * REMI_MULTI, whose generic "Option N" titles the Notification Service
 * Extension replaces with the real labels when it runs (`dynOptions`); when
 * it does not, the four static buttons show, and one with no option behind it
 * sends nothing the answer path accepts. Counting alone gave a 2-option card
 * whose second option is not a No (a parse that dropped "No") a "No" button
 * that sent option 2. Outside 2-4 options there is no category, as before.
 */
export function selectPushCategory(options: readonly QuestionOption[]): string | undefined {
  if (options.length < 2 || options.length > 4) return undefined;
  const [first, second, third] = options as [QuestionOption, QuestionOption, QuestionOption?];
  if (options.length === 2 && isOneTimeYes(first) && isPlainNo(second)) return 'REMI_YN';
  if (
    options.length === 3 &&
    third !== undefined &&
    isOneTimeYes(first) &&
    second.isYes &&
    !second.isNo &&
    second.standingGrant === 'addRules' &&
    isPlainNo(third)
  ) {
    return 'REMI_YNA';
  }
  return options.some(isStanding) ? undefined : 'REMI_MULTI';
}

/**
 * Whether an AskUserQuestion card can be answered with one lock-screen tap
 * (#1127 lead decision): exactly one question, single-select. The tap sends
 * its option's label, and the held answer path takes it only when it names
 * exactly one option (a label that is another option's value is refused,
 * review S1) that matches the parsed input by value and label, so a
 * positional button answers that option or nothing. Any other
 * AskUserQuestion (several questions, a multi-select) is answered in the
 * app.
 */
function isOneTapAskUserQuestion(question: Question): boolean {
  const steps = question.questions;
  return steps !== undefined && steps.length === 1 && steps[0]?.multiSelect === false;
}

/**
 * A card that carries more than its push can show (#1178): a permission card with `detail`, which
 * only a Codex command longer than the push budget has (the text is cut head and tail, the whole
 * command is in `detail`). Its Yes must not be one tap on a locked phone, because the person has
 * not seen what the command does in between, so it gets no category and no dynamic buttons and
 * is answered in the app, where `detail` is shown in full. A plan approval has `detail` too and
 * already gets neither (`pushCategoryFor`).
 */
function hasUnseenDetail(question: Question): boolean {
  return question.kind !== 'plan_approval' && (question.detail?.length ?? 0) > 0;
}

/**
 * The APNS category for a question card. A plan approval (#1127) never gets
 * one: approving a plan is not a lock-screen tap; nor does a card no phone
 * answer can be applied to (`terminalOnly`, review S7). An AskUserQuestion card
 * gets REMI_MULTI only when it is one single-select question
 * (`isOneTapAskUserQuestion`), and none otherwise. Every other card is
 * chosen by what its options mean (`selectPushCategory`).
 */
export function pushCategoryFor(question: Question): string | undefined {
  if (question.kind === 'plan_approval' || question.terminalOnly === true) return undefined;
  // A card whose push cannot show what it asks in full (`hasUnseenDetail`) is never one lock-screen tap.
  if (hasUnseenDetail(question)) return undefined;
  if (question.kind === 'multi_question') {
    return isOneTapAskUserQuestion(question) ? selectPushCategory(question.options) : undefined;
  }
  return selectPushCategory(question.options);
}

/**
 * Whether a question qualifies for the NSE's per-notification dynamic
 * category (#719): a single-question prompt (never a multi-sub-question or
 * multi-select AskUserQuestion form, which stays app-routed via its summary,
 * #1127, and never a plan approval) with 2-4 options, each carrying a REAL
 * label (not just a fallback value — the entire point of the dynamic
 * category is showing the true option text).
 *
 * This is an ADDITIVE hint alongside `selectPushCategory`'s STATIC category,
 * which is always sent unconditionally as the fallback. A client without the
 * Notification Service Extension (or one where the NSE fails, races, or is
 * simply not yet installed) ignores `dynOptions` entirely and falls back to
 * the static category exactly as before #719 — never worse.
 *
 * INVARIANT CHAIN (#719 review): this gate is the narrowest of three — the
 * signaling worker's `wantsDynCategory` check and the NSE's own option-count
 * ceiling both allow up to 6 options, a defensive upper bound so loosening
 * THIS gate (2-4 -> up to 6) needs no worker/NSE change. Keep all three in
 * sync if the ceiling itself ever moves: packages/signaling/src/index.ts
 * (`wantsDynCategory`) and packages/web/ios/App/RemiNotificationService/
 * NotificationService.swift (`buildDynamicCategory`'s `0...5` loop).
 */
export function selectDynOptions(question: Question): boolean {
  if (question.kind === 'plan_approval' || question.terminalOnly === true) return false;
  if (hasUnseenDetail(question)) return false;
  if (question.kind === 'multi_question' && !isOneTapAskUserQuestion(question)) return false;
  const { options } = question;
  if (options.length < 2 || options.length > 4) return false;
  // #1134 review: the extension builds its dynamic buttons without
  // `.authenticationRequired`, so a standing grant offered through them
  // could be tapped while the phone is locked, REMI_YNA's middle option
  // included. No hint for any card with a standing option: it keeps its
  // static category (REMI_YNA's "Yes, always" requires an unlocked device)
  // or, outside that layout, none at all.
  if (options.some(isStanding)) return false;
  return options.every((o) => o.label.trim().length > 0);
}

/** Cap for the APNS title; iOS truncates visually but a hard cap keeps the
 *  payload bounded for long Bash commands. */
const TITLE_MAX = 120;
/** Cap for the APNS body (ask + option list). */
const BODY_MAX = 200;

/**
 * Normalize text for the notification surface (#574, issue 3). Collapses every
 * run of whitespace (including the zero-width gaps that the PTY's column-
 * aligned permission box leaves after ANSI stripping, which produced the
 * "Doyouwanttoproceed?" garble) into a single ASCII space, then trims. A bare
 * run-together token with no separators (the worst PTY case) is left as-is by
 * this pass — but the dispatcher prefers the clean hook text for the body, so
 * the raw PTY string never reaches the user (see `buildPushText`).
 */
function normalizeNotificationText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The compact option list shown in the body, e.g. "1. Yes  2. Yes, always
 * 3. No". Uses the real option LABELS (#574, issue 4) so the user sees what
 * they are actually choosing. The prefix is the option's actual `value`, not
 * its positional index, so it stays accurate for non-indexed values like a
 * y/n set ("y. Yes  n. No"). A value longer than three characters is a word
 * the person would not read as a choice (a Codex option's `accept`,
 * `cancel`, `acceptForSession`), so that option shows its label alone. Empty
 * when there are no options (free-text prompt) so the body is just the ask.
 */
function formatOptionList(options: readonly QuestionOption[]): string {
  if (options.length === 0) return '';
  return options
    .map((o) => (o.value.length <= 3 ? `${o.value}. ${o.label || o.value}` : o.label || o.value))
    .join('  ');
}

/**
 * Build the APNS title + body from the question (#574, issues 3+4).
 *   - title: session context + the clean hook ask (tool + command), never the
 *     raw PTY screen text.
 *   - body: the ask repeated as the leading line plus the real option labels,
 *     so the lock screen shows the choices even where the static action-button
 *     titles cannot (REMI_MULTI). Whitespace is normalized so a column-aligned
 *     PTY prompt can never collapse into a run-together string.
 */
export function buildPushText(
  sessionName: string,
  question: Question,
): { title: string; body: string } {
  // #626: a multi-question AskUserQuestion can't fit a per-question option list on
  // the lock screen, so summarize the SCOPE — "<N> questions" + a numbered list of
  // each sub-question's topic (header, or its text) — and route the user to the
  // in-app form. A single-question AUQ falls through to the normal option-list body.
  if (question.kind === 'multi_question' && question.questions && question.questions.length > 1) {
    const steps = question.questions;
    const title = `${sessionName}: ${steps.length} questions`.slice(0, TITLE_MAX);
    const body = steps
      .map((s, i) => `${i + 1}. ${normalizeNotificationText(s.header || s.text)}`)
      .join('\n')
      .slice(0, BODY_MAX);
    return { title, body };
  }
  // #628's lock-screen one-liner (`Question.summary`) came from the
  // auto-approve LLM, removed in #1125; the push reads the question text.
  const ask = normalizeNotificationText(question.text) || 'Allow this action?';
  const title = `${sessionName}: ${ask}`.slice(0, TITLE_MAX);
  // #1127: a card about a long text (a plan) shows the start of that text;
  // the app shows all of it, and the options are chosen there.
  // A plan's push shows the start of the plan; a permission card's `detail` (a long Codex command)
  // is not shown from its start, because the cut text above already shows both of its ends.
  const detail =
    question.kind === 'plan_approval' && question.detail !== undefined
      ? normalizeNotificationText(question.detail)
      : '';
  if (detail.length > 0) return { title, body: detail.slice(0, BODY_MAX) };
  const optionList = formatOptionList(question.options);
  const body = (optionList ? `${ask}\n${optionList}` : ask).slice(0, BODY_MAX);
  return { title, body };
}

/** Why the phone is told to answer at the terminal (#1126); see
 *  `NotificationDispatcher.pushTerminalNotice`. */
export type TerminalNoticeReason =
  | 'hold_deadline'
  | 'hold_deadline_no_terminal'
  | 'released'
  | 'released_no_terminal'
  | 'subagent';

/** The collapse key (`questionId` on the wire) of a terminal notice for a
 *  question (#1126): distinct from the card's, so dismissing the card leaves
 *  the notice and dismissing the notice leaves any card. */
export function terminalNoticeId(questionId: string): string {
  return `notice-${questionId}`;
}

/** Signature of the APNS-relay push call; injectable so the push branch is
 *  observable in tests without mocking a network module. */
export type PushFn = typeof sendPushTrigger;

/**
 * The outcome of attempting to deliver a question's notification (epic #603
 * Phase 1), returned by `maybePush`. Before #1125 the permission gate raced it
 * to decide whether a held hook kept blocking Claude. A hold since #1126 has
 * a fixed deadline instead (`[prompts] hold_seconds`) and never waits on
 * delivery, so this is diagnostic only:
 *   - `in_app`     a client is attached, so the question shows in-app (the only
 *                  case where `maybePush` deliberately does NOT push — but the
 *                  user IS reachable).
 *   - `pushed`     at least one APNS push returned 2xx.
 *   - `deduped`    the push was suppressed because an identical one already went
 *                  out (the earlier push is the delivery).
 *   - `no_channel` no client attached AND no device tokens — nobody can be told.
 *   - `failed`     tokens exist but every push failed (e.g. BadDeviceToken).
 *   - `uncertain`  no push was accepted and at least one result is unknown;
 *                  a lost response is never permission to send a fresh event.
 */
export type DeliveryOutcome =
  | 'in_app'
  | 'pushed'
  | 'deduped'
  | 'no_channel'
  | 'failed'
  | 'uncertain';

function fanoutOutcome(results: readonly (boolean | DeliveryOutcome)[]): DeliveryOutcome {
  if (results.some((result) => result === true || result === 'pushed')) return 'pushed';
  return results.includes('uncertain') ? 'uncertain' : 'failed';
}

/** Transient push failures retried with backoff (epic #603 Phase 1). */
const MAX_PUSH_RETRIES = 2;
/** Backoff base; attempt N waits BASE * 2^N (400ms, 800ms). Kept short so a
 *  lock-screen card is not delayed by a transient failure. */
const PUSH_RETRY_BASE_MS = 400;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * Whether a failed push is worth retrying (epic #603 Phase 1). The signaling
 * Worker wraps a permanent APNS token rejection (BadDeviceToken / Unregistered /
 * DeviceTokenNotForTopic) as an HTTP 502, so a naive "retry all 5xx" would spin
 * on a dead token. Treat those historical reasons as permanent (no retry);
 * retry only a genuine rate-limit (429) or a transient 5xx with no
 * permanent reason.
 */
export function isRetriablePushError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  // Permanent APNS token rejections (the Worker wraps these as HTTP 502): never
  // retry. `Unregistered` is word-boundaried so a generic 5xx body that happens
  // to contain the word is not misclassified as a permanent token failure.
  if (/BadDeviceToken|DeviceTokenNotForTopic|\bUnregistered\b/i.test(msg)) return false;
  // Network-level failures (no HTTP response received at all) are transient —
  // a Worker cold-start, a brief flap, DNS hiccup — so retry them.
  if (
    err instanceof TypeError ||
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|Failed to fetch/i.test(msg)
  ) {
    return true;
  }
  const m = msg.match(/failed: (\d{3})/);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Whether a push error means the DEVICE TOKEN itself is permanently invalid
 * (epic #603 Phase 6) — so the daemon should PRUNE it, not just stop retrying.
 * Matches the Worker's structured `tokenInvalid` flag (#603 Phase 2) and the raw
 * APNS reasons. Distinct from `isRetriablePushError`: a 401/auth error or an
 * exhausted transient failure is non-retriable but does NOT invalidate the token.
 */
export function isTokenInvalidError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return (
    /"tokenInvalid"\s*:\s*true/.test(msg) ||
    /BadDeviceToken|DeviceTokenNotForTopic|\bUnregistered\b/i.test(msg)
  );
}

export interface NotificationDispatcherDeps {
  /** Verified relay subscriptions; never inferred from legacy device tokens. */
  securePush?: SecureSessionPush;
  sessionRegistry: SessionRegistry;
  deviceTokens: Map<string, DeviceTokenEntry>;
  /**
   * Prune a permanently-invalid device token (epic #603 Phase 6). Called when a
   * push fails with `isTokenInvalidError` (BadDeviceToken / Unregistered), so the
   * daemon stops retrying a dead token on every future escalation. Wired to
   * `DeviceTokenStore.prune` (removes + persists). Absent => no pruning (the
   * token stays in the map; tests / old callers). */
  pruneToken?: (token: string) => void;
  /**
   * Pull in a removal/registration recorded by another daemon on this machine
   * since the shared store last read the file (#690). Wired to
   * `DeviceTokenStore.refreshFromDisk` (read + reconcile, no write). Called at
   * the top of every push decision so a server the user just removed stops
   * getting pushed without waiting for this dispatcher's own next unrelated
   * register/prune call. Absent => no refresh (tests / old callers); must be
   * synchronous and non-throwing.
   */
  refreshDeviceTokens?: () => void;
  /**
   * Current push config; read on every dispatch so the caller can swap the
   * source without re-wiring. Must be synchronous and non-throwing.
   */
  pushConfig: () => PushConfig;
  /**
   * Reads the primary session id the client knows (from hello_ack) so pushes
   * carry the id the phone can route on. Injected (not imported) so the
   * dispatcher has no upward dependency on cli/session-state.
   */
  getPrimarySessionId: () => UUID | null;
  /** Defaults to the real sendPushTrigger; overridden in tests. */
  pushFn?: PushFn;
}

export class NotificationDispatcher {
  private readonly pushDedup = new PushDedup();
  /** A `turn_failed` push went out and no later turn has cleared it (#1153).
   *  In memory only: after a daemon restart a stale notice stays until the
   *  user clears it, which is the safe direction. */
  private turnFailedOutstanding = false;
  /** A new failure after dismissal must not reopen its absorbing context (#1200). */
  private turnFailedSecureId: string | undefined;
  /** Resolved once at construction: the real sendPushTrigger unless a test
   *  injected an override. Fixed for the instance lifetime. */
  private readonly pushFn: PushFn;

  constructor(
    private readonly deps: NotificationDispatcherDeps,
    private readonly sessionId: UUID,
  ) {
    this.pushFn = deps.pushFn ?? sendPushTrigger;
  }

  /**
   * Reset the dedup baseline when the prompt cycle ends (status != 'waiting'),
   * same lifecycle as QuestionDedup so a new prompt starts fresh (#409).
   */
  resetDedup(): void {
    this.pushDedup.reset();
  }

  /**
   * Push `question` to all registered devices, unless a client is actively
   * attached (they see it in-app) or the dedup gate suppresses it.
   * `questionSessionId` is the primary id the client knows (from hello_ack).
   *
   * Returns the resolved DELIVERY OUTCOME (epic #603 Phase 1). The question
   * path does not await it.
   */
  maybePush(
    questionSessionId: UUID,
    question: Question,
    opts: { held?: boolean } = {},
  ): Promise<DeliveryOutcome> {
    return this.computeDelivery(questionSessionId, question, opts.held ?? false);
  }

  /** Resolve the delivery outcome for one question (fanning out the per-token
   *  pushes when a push is actually warranted). See `DeliveryOutcome`. A HELD
   *  escalation (#603 Phase 3) skips the attached-client short-circuit and the
   *  dedup gate — its lock-screen card is load-bearing. */
  private computeDelivery(
    questionSessionId: UUID,
    question: Question,
    held: boolean,
  ): Promise<DeliveryOutcome> {
    const { sessionRegistry, deviceTokens, pushConfig } = this.deps;

    // #690: pick up a token removal/registration a sibling daemon on this
    // machine recorded since our last read, so a just-removed server stops
    // pushing promptly instead of on this dispatcher's own next unrelated
    // register/prune call.
    this.deps.refreshDeviceTokens?.();

    const sessionForPush = sessionRegistry.getSession(questionSessionId);
    const hasActiveClient =
      sessionForPush !== undefined && sessionForPush.attachedConnections.size > 0;
    // A non-held question with a client attached: it is seen in-app over the
    // WebSocket; no push (as before), and the user IS reachable -> in_app. A HELD
    // escalation does NOT short-circuit here — it also pushes to the lock screen
    // because the attached client may be backgrounded (#603 Phase 3), like
    // dismiss(). Its outcome still reports in_app (reachable) below.
    if (!held && hasActiveClient) return Promise.resolve('in_app');
    // Devices that want question pushes (#968). A device muted for questions is
    // as unreachable for this question as one that never registered, so it is
    // filtered HERE — above the no-channel check — and not at the fan-out.
    //
    // Reporting `pushed` for a fan-out of zero would claim a card reached a
    // lock screen it never appears on; `no_channel` is the honest outcome.
    const wanting = tokensWanting(deviceTokens.values(), 'question');
    const secure = this.deps.securePush;
    // No reachable device: nobody can be pushed. If a client is attached the
    // user is still reachable in-app (held case); otherwise there is no channel.
    if (wanting.length === 0 && !secure?.hasRecipients('question')) {
      if (!hasActiveClient) {
        log('[QuestionPush] no recipient');
      }
      return Promise.resolve(hasActiveClient ? 'in_app' : 'no_channel');
    }

    if (!held && !this.pushDedup.shouldPush(question)) {
      log('[QuestionPush] duplicate suppressed');
      // An identical push already went out; the earlier one is the delivery.
      return Promise.resolve('deduped');
    }

    const session = sessionRegistry.getSession(this.sessionId);
    const sessionName = session?.name || 'Agent';
    const cfg = pushConfig();
    const pushSessionId = this.deps.getPrimarySessionId() ?? this.sessionId;
    // #626, #1127: an AskUserQuestion with several questions or a
    // multi-select, and a plan approval, get no category at all: none can be
    // answered by one positional tap (and a plan is never approved from the
    // lock screen). With no category the lock screen shows the summary and
    // opens the app, where the card renders the real options. A
    // one-question, single-select AskUserQuestion gets REMI_MULTI: its tap
    // names one option, which the held hook answers (`pushCategoryFor`).
    const pushCategory = pushCategoryFor(question);
    // Send the human-readable LABELS for DISPLAY (#574, issue 4); answer
    // routing in input-events resolves an incoming label OR value back to the
    // option, then submits the option's index when a PTY submit is required, so
    // sending labels here does not break delivery. Fall back to the value when a
    // label is empty so the button still carries something answerable.
    const pushOptions = question.options.map((o) => o.label || o.value);
    // #719: hint the NSE to build a per-notification dynamic category with the
    // real option labels as action titles. `pushCategory` above is untouched —
    // it remains the static fallback the NSE (and any client without one)
    // falls back to.
    const dynOptions = selectDynOptions(question);
    const { title, body } = buildPushText(sessionName, question);
    const opts = {
      title,
      body,
      ...legacyPushFields(cfg),
      sessionId: pushSessionId,
      questionId: question.id,
      ...(pushCategory !== undefined ? { category: pushCategory } : {}),
      ...(pushOptions.length > 0 ? { options: pushOptions } : {}),
      ...(dynOptions ? { dynOptions: true } : {}),
      kind: 'question' as const,
    };

    const perToken: Promise<boolean | DeliveryOutcome>[] = wanting.map((dt) =>
      this.pushOnceWithRetry(cfg.signalingUrl, dt.token, opts, {
        sent: '[QuestionPush] legacy accepted',
        failed: '[QuestionPush] legacy failed',
      }),
    );
    if (secure)
      perToken.push(
        secure.send({ kind: 'question', logicalId: question.id, question, title, body }),
      );
    // Diagnostic APNs acceptance only. Held hooks keep their own captured
    // deadline and resolve only through the harness's human-answer paths (#1126).
    return Promise.all(perToken).then(fanoutOutcome);
  }

  /**
   * Push to one device token, retrying a TRANSIENT failure (429 / transient
   * 5xx) with short backoff (epic #603 Phase 1). A permanent token rejection
   * (BadDeviceToken etc., which the Worker wraps as 502) is NOT retried — it
   * fails fast. Delivery never resolves a held hook (#1200).
   * A 2xx means acceptance, not handset delivery.
   *
   * Shared by alert pushes (`maybePush`) and quiet dismissals (`dismiss`, #723);
   * `logCtx` carries fixed operation/result messages, never personal selectors.
   */
  private async pushOnceWithRetry(
    signalingUrl: string,
    token: string,
    opts: Parameters<PushFn>[2],
    logCtx: { sent: string; failed: string },
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pushFn(signalingUrl, token, opts);
        log(logCtx.sent);
        return true;
      } catch (err) {
        if (isRetriablePushError(err) && attempt < MAX_PUSH_RETRIES) {
          const delay = PUSH_RETRY_BASE_MS * 2 ** attempt;
          log(`Legacy push retry ${attempt + 1}/${MAX_PUSH_RETRIES}`);
          await sleep(delay);
          continue;
        }
        // Loud: a real push attempt failed (permanent token rejection, network
        // error, or exhausted retries). This is the root cause behind a card
        // that never reached the phone, so it must be visible at error level,
        // not buried.
        logError(logCtx.failed);
        // Self-heal (epic #603 Phase 6): a PERMANENTLY invalid token (dead /
        // unregistered / wrong-app) is pruned so it is never retried again. A
        // network error or exhausted-transient failure is NOT a token problem,
        // so the token survives.
        if (isTokenInvalidError(err)) {
          this.deps.pruneToken?.(token);
        }
        return false;
      }
    }
  }

  /**
   * Alert push telling the user a prompt must be answered in the terminal
   * (#1126), never a card: no category, no options, nothing to answer from
   * the lock screen, and nothing registered in-app. Its reasons:
   *   - `hold_deadline`: a held prompt waited `[prompts] hold_seconds` with no
   *     answer (or reached Claude's hook timeout), so remi released its hold;
   *     Claude's dialog is still up (the #733 handoff, restored for held
   *     hooks).
   *   - `released`: remi released a live hold early, with no answer (an
   *     ambiguous signal that the hold may be stale, or `remi unstick`).
   *   - `hold_deadline_no_terminal`, `released_no_terminal`: the same in a
   *     daemon or hub session, which has no terminal of its own: the dialog
   *     is reached with `remi attach`, and the notice says so.
   *   - `subagent`: a background subagent's dialog rendered in a session with
   *     a local terminal; its hook was answered 'passthrough' so it could
   *     render at all, so only the terminal can answer it.
   * Called while the question is still registered, so the body names the
   * actual ask.
   *
   * Deliberate differences from `maybePush`:
   *  - always pushes (no attached-client skip, no dedup): an attached client
   *    only sees its card vanish, and this is a one-shot state change;
   *  - collapse key `notice-<questionId>`, never the question id, so the
   *    card's own quiet dismissal cannot collapse this notice away;
   *    `dismissTerminalNotice` clears it once the prompt is answered.
   *
   * Filtered by per-device push preferences as a `question` push (#968): it
   * buzzes, about a question, so a device that muted questions does not get
   * it. It clears nothing, so skipping it strands nothing.
   */
  pushTerminalNotice(
    questionSessionId: UUID,
    question: Question,
    reason: TerminalNoticeReason,
  ): void {
    const { deviceTokens, pushConfig } = this.deps;
    this.deps.refreshDeviceTokens?.();
    const wanting = tokensWanting(deviceTokens.values(), 'question');
    const secure = this.deps.securePush;
    if (wanting.length === 0 && !secure?.hasRecipients('question')) return;
    const session = this.deps.sessionRegistry.getSession(this.sessionId);
    const sessionName = session?.name || 'Agent';
    const ask = normalizeNotificationText(question.text) || 'a permission request';
    const noTerminal = reason === 'hold_deadline_no_terminal' || reason === 'released_no_terminal';
    const title = (
      noTerminal
        ? `${sessionName}: answer with remi attach`
        : `${sessionName}: answer in the terminal`
    ).slice(0, TITLE_MAX);
    // A release notice must not say the prompt is still waiting: a Yes
    // answered in the terminal shows up only when its tool finishes, so the
    // prompt may already be answered (#1126 lead decision).
    const why =
      reason === 'hold_deadline' || reason === 'hold_deadline_no_terminal'
        ? 'No answer from the phone in time'
        : 'This prompt was handed back to the terminal';
    const how = noTerminal ? 'reach it with remi attach' : 'answer it in the terminal';
    const body = (
      reason === 'subagent' ? ask : `${why}; if it is still open, ${how}: ${ask}`
    ).slice(0, BODY_MAX);
    const cfg = pushConfig();
    const pushSessionId = this.deps.getPrimarySessionId() ?? questionSessionId;
    if (secure)
      void secure.send({ kind: 'question', logicalId: terminalNoticeId(question.id), title, body });
    for (const dt of wanting) {
      void this.pushOnceWithRetry(
        cfg.signalingUrl,
        dt.token,
        {
          title,
          body,
          ...legacyPushFields(cfg),
          sessionId: pushSessionId,
          questionId: terminalNoticeId(question.id),
          kind: 'question' as const,
        },
        {
          sent: '[TerminalNoticePush] legacy accepted',
          failed: '[TerminalNoticePush] legacy failed',
        },
      );
    }
  }

  /**
   * Notify every device that wants it that a turn ended on an API error
   * (Claude's `StopFailure`, #1153, or a failed Codex turn, #1180; `agentName`
   * says which stopped, Claude when absent): a usage or rate limit,
   * authentication, and similar. Informational, never a card: no `category`, no `options`, and
   * nothing is registered in-app (the card this replaced had Yes/No that no
   * answer could reach). Its `questionId` is the session's collapse key
   * (`turnFailedCollapseId`), so a repeat replaces the previous notification
   * instead of stacking, and `sessionId` lets a tap open the session.
   *
   * Deliberate differences from `maybePush`:
   *  - always pushes (no attached-client skip, no dedup): the app shows no
   *    card for a failure, so an attached client would otherwise be told
   *    nothing, and a backgrounded one is exactly who the push is for;
   *  - filtered by `pushPrefs.turnFailed` ONLY. `notifications.on_turn_complete`
   *    is not consulted: a failed turn is the one turn end a user must not
   *    miss by default, and the machine-wide switch is about the "done"
   *    notification, not about the agent being stuck.
   *
   * Resolves `no_channel` when no device wants it (none registered, or every
   * one muted `turnFailed`): claiming `pushed` for a fan-out of zero would
   * report a notification that reached nobody. Otherwise `pushed` when any
   * device accepted it, `failed` when every push failed. Fire-and-forget for
   * callers: the promise never rejects.
   */
  pushTurnFailed(input: TurnFailedInput, agentName?: string): Promise<DeliveryOutcome> {
    const { sessionRegistry, deviceTokens, pushConfig } = this.deps;
    // #690: pick up a device a sibling daemon removed or muted since our last
    // read, as every other push does.
    this.deps.refreshDeviceTokens?.();
    const wanting = tokensWanting(deviceTokens.values(), 'turn_failed');
    const secure = this.deps.securePush;
    if (wanting.length === 0 && !secure?.hasRecipients('turn_failed')) {
      log('[TurnFailedPush] no recipient');
      return Promise.resolve('no_channel');
    }
    if (!this.turnFailedOutstanding) this.turnFailedSecureId = `turn-failed-${generateId()}`;
    this.turnFailedOutstanding = true;
    const sessionName = sessionRegistry.getSession(this.sessionId)?.name || 'Agent';
    const { title, body } = buildTurnFailedText(sessionName, input, agentName);
    const cfg = pushConfig();
    const pushSessionId = this.deps.getPrimarySessionId() ?? this.sessionId;
    const perToken: Promise<boolean | DeliveryOutcome>[] = wanting.map((dt) =>
      this.pushOnceWithRetry(
        cfg.signalingUrl,
        dt.token,
        {
          title,
          body,
          ...legacyPushFields(cfg),
          sessionId: pushSessionId,
          questionId: turnFailedCollapseId(this.sessionId),
          kind: 'turn_failed' as const,
        },
        {
          sent: '[TurnFailedPush] legacy accepted',
          failed: '[TurnFailedPush] legacy failed',
        },
      ),
    );
    if (secure)
      perToken.push(
        secure.send({
          kind: 'turn_failed',
          logicalId: this.turnFailedSecureId as string,
          title,
          body,
        }),
      );
    return Promise.all(perToken).then(fanoutOutcome);
  }

  /**
   * Clear the `turn_failed` notice this session pushed (#1153), once a later
   * turn proves the failure is stale: the quiet `dismiss` sharing its
   * collapse key (`turnFailedCollapseId`), never filtered by preferences, so
   * even a device that muted failed turns after receiving one is cleared.
   * Sends nothing when no `turn_failed` push is outstanding, so the hook
   * wiring can call it on every main `Stop` and `UserPromptSubmit` without a
   * silent push per turn.
   */
  dismissTurnFailed(): void {
    if (!this.turnFailedOutstanding) return;
    this.turnFailedOutstanding = false;
    this.dismiss(
      this.sessionId,
      turnFailedCollapseId(this.sessionId) as UUID,
      this.turnFailedSecureId,
    );
    this.turnFailedSecureId = undefined;
  }

  /** Clear a notice `pushTerminalNotice` sent, once its prompt is answered
   *  (#1126). Same quiet, never-filtered dismissal as `dismiss`. */
  dismissTerminalNotice(questionSessionId: UUID, questionId: UUID): void {
    this.dismiss(questionSessionId, terminalNoticeId(questionId) as UUID);
  }

  /**
   * Fire a QUIET APNS dismissal for a resolved question (#585, P7). Sends a
   * `content-available` push (no alert, no sound) keyed by `apns-collapse-id` =
   * questionId so a suspended device replaces/clears the earlier lock-screen card
   * for that exact question. Fans out to every registered device — unlike
   * `maybePush`, it deliberately does NOT skip when a client is attached: the
   * card may still sit on another device's lock screen, and the collapse-id makes
   * a no-op dismissal harmless. No dedup gate (a repeat dismissal is idempotent at
   * the device). No-op when no tokens are registered.
   *
   * Deliberately NOT filtered by per-device push preferences (#968): a device
   * that mutes question pushes can still be holding a card delivered before the
   * mute, and dropping its dismissal would strand that card on the lock screen
   * of the very device that asked for less noise.
   *
   * `questionSessionId` is the primary id the client knows (from hello_ack), kept
   * symmetric with `maybePush` so the dismissal carries the same routing id.
   */
  dismiss(questionSessionId: UUID, questionId: UUID, secureLogicalId: string = questionId): void {
    const { deviceTokens, pushConfig } = this.deps;
    if (this.deps.securePush)
      void this.deps.securePush.send({ kind: 'dismiss', logicalId: secureLogicalId });
    if (deviceTokens.size === 0) return;
    const cfg = pushConfig();
    const pushSessionId = this.deps.getPrimarySessionId() ?? questionSessionId;
    for (const dt of deviceTokens.values()) {
      // #723: same transient-retry path as alert pushes — a 429/5xx dismissal
      // is retried with backoff (a LATE dismissal still clears the stale card),
      // and a permanently-invalid token is pruned here too. Fire-and-forget:
      // the helper never rejects, it resolves false after logging.
      void this.pushOnceWithRetry(
        cfg.signalingUrl,
        dt.token,
        {
          // No title/body: a dismissal is a silent content-available push, and
          // the relay skips the title/body requirement for it (#585, P7).
          ...legacyPushFields(cfg),
          sessionId: pushSessionId,
          questionId,
          dismiss: true,
          kind: 'dismiss' as const,
        },
        {
          sent: '[DismissPush] legacy accepted',
          failed: '[DismissPush] legacy failed',
        },
      );
    }
  }
}
