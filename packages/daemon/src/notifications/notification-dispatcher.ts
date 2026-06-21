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

import type { Question, QuestionOption, UUID } from '@remi/shared';

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import { log, logError } from '../cli/logger.ts';
import type { SessionRegistry } from '../session/index.ts';
import { sendPushTrigger } from './push-client.ts';
import { PushDedup } from './push-dedup.ts';

export interface PushConfig {
  /**
   * Signaling server base URL. Always provided by the caller; `sendPushTrigger`'s
   * `string | undefined` first parameter is wider (it has its own fallback), but
   * the dispatcher never passes undefined here.
   */
  signalingUrl: string;
  pushSecret?: string | undefined;
}

/**
 * Select the APNS notification category from the number of question options.
 * iOS renders action buttons matching the category; watchOS mirrors them.
 */
export function selectPushCategory(options: readonly QuestionOption[]): string | undefined {
  if (options.length === 2) return 'REMI_YN';
  if (options.length === 3) return 'REMI_YNA';
  if (options.length === 4) return 'REMI_MULTI';
  return undefined;
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
 * its positional index, so it stays accurate for non-indexed values like the
 * StopFailure y/n set ("y. Yes  n. No"). Empty when there are no options
 * (free-text prompt) so the body is just the ask.
 */
function formatOptionList(options: readonly QuestionOption[]): string {
  if (options.length === 0) return '';
  return options.map((o) => `${o.value}. ${o.label || o.value}`).join('  ');
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
  const ask = normalizeNotificationText(question.text) || 'Allow this action?';
  const title = `${sessionName}: ${ask}`.slice(0, TITLE_MAX);
  const optionList = formatOptionList(question.options);
  const body = (optionList ? `${ask}\n${optionList}` : ask).slice(0, BODY_MAX);
  return { title, body };
}

/** Signature of the APNS-relay push call; injectable so the push branch is
 *  observable in tests without mocking a network module. */
export type PushFn = typeof sendPushTrigger;

/**
 * The outcome of attempting to deliver a question's notification (epic #603
 * Phase 1). The gate consumes this via `awaitDelivery` to decide whether a held
 * hook should keep blocking Claude or fail open fast:
 *   - `in_app`     a client is attached, so the question shows in-app (the only
 *                  case where `maybePush` deliberately does NOT push — but the
 *                  user IS reachable).
 *   - `pushed`     at least one APNS push returned 2xx.
 *   - `deduped`    the push was suppressed because an identical one already went
 *                  out (the earlier push is the delivery).
 *   - `no_channel` no client attached AND no device tokens — nobody can be told.
 *   - `failed`     tokens exist but every push failed (e.g. BadDeviceToken).
 */
export type DeliveryOutcome = 'in_app' | 'pushed' | 'deduped' | 'no_channel' | 'failed';

/** Whether a delivery outcome means the user can actually be notified (epic
 *  #603 Phase 1). `in_app` / `pushed` reach the user. `deduped` is deliberately
 *  NOT treated as confirmed: PushDedup suppresses a second identical push
 *  WITHOUT tracking whether the push it deduped against actually succeeded, so a
 *  held hook must not keep blocking on it — fail open (always safe) instead.
 *  (Phase 3 makes held escalations bypass dedup, so a held push is never deduped
 *  in the first place.) `no_channel` / `failed` obviously do not reach anyone. */
export function isDelivered(outcome: DeliveryOutcome): boolean {
  return outcome === 'in_app' || outcome === 'pushed';
}

/** Transient push failures retried with backoff (epic #603 Phase 1). */
const MAX_PUSH_RETRIES = 2;
/** Backoff base; attempt N waits BASE * 2^N (400ms, 800ms). Kept short so the
 *  per-token result settles well within the gate's delivery_confirm_timeout. */
const PUSH_RETRY_BASE_MS = 400;
/** How long a recorded delivery outcome stays probeable before cleanup. The
 *  gate probes within ~ms of the push; this is a generous upper bound so the
 *  map never grows unbounded across a long-lived session. */
const DELIVERY_OUTCOME_TTL_MS = 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * Whether a failed push is worth retrying (epic #603 Phase 1). The signaling
 * Worker wraps a permanent APNS token rejection (BadDeviceToken / Unregistered /
 * DeviceTokenNotForTopic) as an HTTP 502, so a naive "retry all 5xx" would spin
 * on a dead token. Treat those reasons as permanent (no retry -> fail open
 * fast); retry only a genuine rate-limit (429) or a transient 5xx with no
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

export interface NotificationDispatcherDeps {
  sessionRegistry: SessionRegistry;
  deviceTokens: Map<string, DeviceTokenEntry>;
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
  /** Resolved once at construction: the real sendPushTrigger unless a test
   *  injected an override. Fixed for the instance lifetime. */
  private readonly pushFn: PushFn;

  /**
   * Delivery outcome per question id (epic #603 Phase 1), recorded by every
   * `maybePush` so the gate can `awaitDelivery` to decide a held hook's fate.
   * Entries self-evict after `DELIVERY_OUTCOME_TTL_MS` so the map stays bounded.
   */
  private readonly deliveryOutcomes = new Map<UUID, Promise<DeliveryOutcome>>();

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
   * Returns the resolved DELIVERY OUTCOME (epic #603 Phase 1) and records it
   * keyed by `question.id` so a held hook can `awaitDelivery` to decide whether
   * to keep blocking Claude or fail open fast. Callers that do not care about
   * delivery (the regular PTY-prompt path) can ignore the returned promise; the
   * recording still happens.
   */
  maybePush(
    questionSessionId: UUID,
    question: Question,
    opts: { held?: boolean } = {},
  ): Promise<DeliveryOutcome> {
    const outcome = this.computeDelivery(questionSessionId, question, opts.held ?? false);
    this.recordDelivery(question.id, outcome);
    return outcome;
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

    const sessionForPush = sessionRegistry.getSession(questionSessionId);
    const hasActiveClient =
      sessionForPush !== undefined && sessionForPush.activeConnectionId !== null;
    // A non-held question with a client attached: it is seen in-app over the
    // WebSocket; no push (as before), and the user IS reachable -> in_app. A HELD
    // escalation does NOT short-circuit here — it also pushes to the lock screen
    // because the attached client may be backgrounded (#603 Phase 3), like
    // dismiss(). Its outcome still reports in_app (reachable) below.
    if (!held && hasActiveClient) return Promise.resolve('in_app');
    // No device tokens: nobody can be pushed. If a client is attached the user
    // is still reachable in-app (held case); otherwise there is no channel.
    if (deviceTokens.size === 0) {
      if (!hasActiveClient) log(`Push skipped: no device tokens for session ${questionSessionId}`);
      return Promise.resolve(hasActiveClient ? 'in_app' : 'no_channel');
    }

    if (!held && !this.pushDedup.shouldPush(question)) {
      log(`Push suppressed by dedup for session ${questionSessionId}`);
      // An identical push already went out; the earlier one is the delivery.
      return Promise.resolve('deduped');
    }

    const session = sessionRegistry.getSession(this.sessionId);
    const sessionName = session?.name || 'Agent';
    const cfg = pushConfig();
    const pushSessionId = this.deps.getPrimarySessionId() ?? this.sessionId;
    const pushCategory = selectPushCategory(question.options);
    // Send the human-readable LABELS for DISPLAY (#574, issue 4); answer
    // routing in input-events resolves an incoming label OR value back to the
    // option, then submits the option's index when a PTY submit is required, so
    // sending labels here does not break delivery. Fall back to the value when a
    // label is empty so the button still carries something answerable.
    const pushOptions = question.options.map((o) => o.label || o.value);
    const { title, body } = buildPushText(sessionName, question);
    const opts = {
      title,
      body,
      ...(cfg.pushSecret !== undefined ? { pushSecret: cfg.pushSecret } : {}),
      sessionId: pushSessionId,
      questionId: question.id,
      ...(pushCategory !== undefined ? { category: pushCategory } : {}),
      ...(pushOptions.length > 0 ? { options: pushOptions } : {}),
    };

    const perToken = [...deviceTokens.values()].map((dt) =>
      this.pushOnceWithRetry(cfg.signalingUrl, dt.token, opts, pushSessionId),
    );
    const pushed = Promise.all(perToken).then((rs) => (rs.some(Boolean) ? 'pushed' : 'failed'));
    // A HELD escalation with an attached client is reachable in-app regardless
    // of the APNS result, so report `in_app` (delivered) — but the push still
    // fired above to cover a backgrounded client (#603 Phase 3). Otherwise the
    // outcome IS the push result: delivered if ANY device accepted it.
    return held && hasActiveClient ? pushed.then((): DeliveryOutcome => 'in_app') : pushed;
  }

  /**
   * Push to one device token, retrying a TRANSIENT failure (429 / transient
   * 5xx) with short backoff (epic #603 Phase 1). A permanent token rejection
   * (BadDeviceToken etc., which the Worker wraps as 502) is NOT retried — it
   * fails fast so the gate can fail the hold open. Resolves true on a 2xx.
   */
  private async pushOnceWithRetry(
    signalingUrl: string,
    token: string,
    opts: Parameters<PushFn>[2],
    pushSessionId: UUID,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.pushFn(signalingUrl, token, opts);
        log(`Push notification sent for session ${pushSessionId}`);
        return true;
      } catch (err) {
        if (isRetriablePushError(err) && attempt < MAX_PUSH_RETRIES) {
          const delay = PUSH_RETRY_BASE_MS * 2 ** attempt;
          log(
            `Push transient failure (retry ${attempt + 1}/${MAX_PUSH_RETRIES} in ${delay}ms): ${err}`,
          );
          await sleep(delay);
          continue;
        }
        // Loud: a real push attempt failed (permanent token rejection, network
        // error, or exhausted retries). This is the root cause behind a held
        // hook's fail-open, so it must be visible at error level, not buried.
        logError(`Push notification failed for session ${pushSessionId}: ${err}`);
        return false;
      }
    }
  }

  /** Record (and schedule cleanup of) a question's delivery outcome so the gate
   *  can `awaitDelivery` it (epic #603 Phase 1). */
  private recordDelivery(questionId: UUID, outcome: Promise<DeliveryOutcome>): void {
    this.deliveryOutcomes.set(questionId, outcome);
    // Evict after a fixed TTL regardless of whether `outcome` ever settles: a
    // push whose fetch hangs (unreachable Worker, no AbortSignal yet) must not
    // leak a map entry until the OS TCP timeout. The gate probes within ms of
    // recording, so a 60s TTL is a generous upper bound.
    const t = setTimeout(() => this.deliveryOutcomes.delete(questionId), DELIVERY_OUTCOME_TTL_MS);
    t.unref?.();
  }

  /**
   * The delivery outcome recorded for `questionId` by `maybePush` (epic #603
   * Phase 1). The gate races this against `delivery_confirm_timeout` to decide a
   * held hook's fate. `undefined` when no push was attempted for the id (e.g. the
   * held push found no pending hook record) — the gate then keeps its legacy
   * behavior (hold to hold_timeout) rather than failing open on a missing signal.
   */
  awaitDelivery(questionId: UUID): Promise<DeliveryOutcome> | undefined {
    return this.deliveryOutcomes.get(questionId);
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
   * `questionSessionId` is the primary id the client knows (from hello_ack), kept
   * symmetric with `maybePush` so the dismissal carries the same routing id.
   */
  dismiss(questionSessionId: UUID, questionId: UUID): void {
    const { deviceTokens, pushConfig } = this.deps;
    if (deviceTokens.size === 0) return;
    const cfg = pushConfig();
    const pushSessionId = this.deps.getPrimarySessionId() ?? questionSessionId;
    for (const dt of deviceTokens.values()) {
      this.pushFn(cfg.signalingUrl, dt.token, {
        // No title/body: a dismissal is a silent content-available push, and the
        // relay skips the title/body requirement for it (#585, P7).
        ...(cfg.pushSecret !== undefined ? { pushSecret: cfg.pushSecret } : {}),
        sessionId: pushSessionId,
        questionId,
        dismiss: true,
      })
        .then(() => log(`Push dismissal sent for question ${questionId}`))
        .catch((err) =>
          logError(`Push dismissal failed (signaling worker redeploy needed?): ${err}`),
        );
    }
  }
}
