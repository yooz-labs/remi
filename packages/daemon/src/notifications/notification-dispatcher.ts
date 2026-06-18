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
import { log } from '../cli/logger.ts';
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
   */
  maybePush(questionSessionId: UUID, question: Question): void {
    const { sessionRegistry, deviceTokens, pushConfig } = this.deps;

    const sessionForPush = sessionRegistry.getSession(questionSessionId);
    const hasActiveClient =
      sessionForPush !== undefined && sessionForPush.activeConnectionId !== null;
    if (deviceTokens.size === 0 || hasActiveClient) return;

    if (!this.pushDedup.shouldPush(question)) {
      log(`Push suppressed by dedup for session ${questionSessionId}`);
      return;
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

    for (const dt of deviceTokens.values()) {
      this.pushFn(cfg.signalingUrl, dt.token, {
        title,
        body,
        ...(cfg.pushSecret !== undefined ? { pushSecret: cfg.pushSecret } : {}),
        sessionId: pushSessionId,
        questionId: question.id,
        ...(pushCategory !== undefined ? { category: pushCategory } : {}),
        ...(pushOptions.length > 0 ? { options: pushOptions } : {}),
      })
        .then(() => log(`Push notification sent for session ${pushSessionId}`))
        .catch((err) => log(`Push notification failed: ${err}`));
    }
  }
}
