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
import { getPrimarySessionId } from '../cli/session-state.ts';
import type { SessionRegistry } from '../session/index.ts';
import { sendPushTrigger } from './push-client.ts';
import { PushDedup } from './push-dedup.ts';

export interface PushConfig {
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
  /** Defaults to the real sendPushTrigger; overridden in tests. */
  pushFn?: PushFn;
}

export class NotificationDispatcher {
  private readonly pushDedup = new PushDedup();

  constructor(
    private readonly deps: NotificationDispatcherDeps,
    private readonly sessionId: UUID,
  ) {}

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
    const pushSessionId = getPrimarySessionId() ?? this.sessionId;
    const pushCategory = selectPushCategory(question.options);
    const pushOptions = question.options.map((o) => o.value);
    const push = this.deps.pushFn ?? sendPushTrigger;

    for (const dt of deviceTokens.values()) {
      push(cfg.signalingUrl, dt.token, {
        title: `${sessionName} needs input`,
        body: question.text.slice(0, 100),
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
