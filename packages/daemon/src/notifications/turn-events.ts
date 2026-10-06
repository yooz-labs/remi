/**
 * The turn-event sink (#1180, Phase 6 of the Codex epic #1175): the one place a
 * finished turn becomes a push, whichever harness ran it.
 *
 * Before this, `cli.ts`'s `onTurnStop` held the whole decision for Claude's
 * `Stop` hook: the gate (`shouldNotifyTurnComplete`), who wants the push
 * (`tokensWanting`), the text and the fan-out. A Codex turn ends with the
 * app-server's `turn/completed` instead, which carries the same facts (how long
 * the turn ran, the final answer) and a failure that Claude reports through
 * `StopFailure`. The sink takes those facts as events and does what `onTurnStop`
 * did, so the two harnesses share one gate, one text and one fan-out:
 *
 * - `turnCompleted`: pushes `turn_complete` when the turn was long enough and
 *   nothing says to stay quiet (`notifications.on_turn_complete`, the minimum
 *   duration, a stop-hook re-entry, an empty message, the per-device
 *   preference). Any unknown signal fails toward silence (#914).
 * - `turnFailed`: pushes the session's `turn_failed` notice (#1153). No config
 *   gate: `on_turn_complete = false` does NOT silence a failure; only the
 *   per-device `turnFailed` preference does, inside the dispatcher.
 * - `turnSucceeded`: clears a failure notice that is still outstanding, once a
 *   later turn proves it stale. Sends nothing when none is outstanding.
 *
 * What stays with the caller: whether the event is this session's at all. For
 * Claude that is the #914 session filter in `onTurnStop`
 * (`ClaudeHarness.admitsAnySession`) and the timer lookup; for Codex it is the
 * thread's role (`codex-turns.ts`). Claude's own `StopFailure` wiring
 * (`createTurnFailedRoutes`, called from the hook bridge) is untouched; the sink
 * uses the same routes for the failure it is given.
 *
 * Everything is read through getters when an event arrives, never when the sink
 * is built: the config, the device list, the signaling endpoint and the secret
 * can all change while the daemon runs.
 */

import type { UUID } from '@remi/shared';

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import {
  type LegacyPushPolicy,
  legacyChannelOpen,
  legacyPushFields,
} from './legacy-push-policy.ts';
import { type PushTriggerOptions, isLegacyPushRetired } from './push-client.ts';
import { tokensWanting } from './push-preferences.ts';
import type { SecureSessionPush } from './secure-push-service.ts';
import {
  type TurnFailedInput,
  type TurnFailedNotifier,
  createTurnFailedRoutes,
} from './turn-failed.ts';
import { buildTurnCompleteText, shouldNotifyTurnComplete } from './turn-timer.ts';

export interface TurnCompletedEvent {
  readonly sessionId: UUID;
  /** Actual harness occurrence, retained across duplicate frames; never sent in outer metadata. */
  readonly eventId?: string;
  /** How long the turn ran. Undefined when unknown, which fails toward silence. */
  readonly elapsedMs: number | undefined;
  /** What the agent said last. Empty or absent means nothing to show, so no push. */
  readonly lastAssistantMessage: string | undefined;
  /** A stop-hook re-entry: the turn is still going, never a finished turn. */
  readonly reentry: boolean;
}

export interface TurnFailedEvent {
  readonly sessionId: UUID;
  /** A short code for what went wrong (shown as a phrase when known, as is otherwise). */
  readonly error?: string | undefined;
  /** The words the agent or its API gave with the failure. */
  readonly errorDetails?: string | undefined;
  /** Who stopped: "Claude" or "Codex". It names the agent in the notice's title. */
  readonly agentName: string;
}

export interface TurnEventSink {
  turnCompleted(event: TurnCompletedEvent): void;
  turnFailed(event: TurnFailedEvent): void;
  /** A turn ended without failing: clears an outstanding `turn_failed` notice of the session. */
  turnSucceeded(sessionId: UUID): void;
}

export interface TurnEventSinkDeps {
  /** `config.notifications.on_turn_complete` and `turn_complete_min_seconds`, read per event. */
  config: () => { onTurnComplete: boolean; turnCompleteMinSeconds: number };
  /** The registered devices (their per-class preferences decide who is pushed). */
  deviceTokens: () => Iterable<DeviceTokenEntry>;
  /** The session's display name for the push title; blank or undefined reads as "Agent". */
  sessionName: (sessionId: UUID) => string | undefined;
  /** Each session's dispatcher, which owns the `turn_failed` push and its dismissal. */
  notifiers: ReadonlyMap<UUID, TurnFailedNotifier>;
  signalingUrl: () => string;
  pushSecret: () => string | undefined;
  /** Per-session secure fan-out, resolved fresh for each completed event (#1200). */
  securePush?: (sessionId: UUID) => SecureSessionPush | undefined;
  /** Explicit plaintext compatibility only; resolved fresh with the event. */
  legacyPolicy?: () => LegacyPushPolicy;
  send: (signalingUrl: string, token: string, opts: PushTriggerOptions) => Promise<void>;
  log: (message: string) => void;
  /** A push that failed; never thrown (a notification bug must not delay or break the caller). */
  onError: (err: unknown) => void;
}

export function createTurnEventSink(deps: TurnEventSinkDeps): TurnEventSink {
  const failedRoutes = createTurnFailedRoutes(deps.notifiers);

  return {
    turnCompleted: (event) => {
      // Devices that want turn-complete pushes (#968), resolved BEFORE the gate so that
      // `hasDeviceTokens` means "someone will actually receive this", not merely "a token
      // exists": a machine whose every device muted turn-complete stops at the gate instead of
      // building text and fanning out to nobody. The machine-wide switch still wins over any
      // per-device preference; the gate checks it first.
      const legacy = { ...deps.legacyPolicy?.(), pushSecret: deps.pushSecret() };
      // A legacy channel that is off or has no secret has no recipients (#1200, B6).
      const wanting = legacyChannelOpen(legacy)
        ? tokensWanting(deps.deviceTokens(), 'turn_complete')
        : [];
      const secure = deps.securePush?.(event.sessionId);
      const secureRecipients = secure?.hasRecipients('turn_complete') === true;
      const { onTurnComplete, turnCompleteMinSeconds } = deps.config();
      if (
        !shouldNotifyTurnComplete({
          onTurnComplete,
          stopHookActive: event.reentry,
          elapsedMs: event.elapsedMs,
          minSeconds: turnCompleteMinSeconds,
          lastAssistantMessage: event.lastAssistantMessage,
          hasDeviceTokens: wanting.length > 0 || secureRecipients,
        })
      ) {
        return;
      }

      const sessionName = deps.sessionName(event.sessionId) || 'Agent';
      // Non-empty: shouldNotifyTurnComplete already required a message.
      const { title, body } = buildTurnCompleteText(sessionName, event.lastAssistantMessage ?? '');
      deps.log('[TurnComplete] push requested');

      if (secureRecipients) {
        void secure
          ?.send({
            kind: 'turn_complete',
            logicalId: `turn-complete-${event.sessionId}`,
            ...(event.eventId === undefined ? {} : { eventId: event.eventId }),
            title,
            body,
          })
          .then((outcome) => {
            if (outcome === 'failed') deps.onError(new Error('TURN_COMPLETE_PUSH_FAILED'));
          })
          .catch(() => deps.onError(new Error('TURN_COMPLETE_PUSH_FAILED')));
      }

      const signalingUrl = deps.signalingUrl();
      const legacyFields = legacyPushFields(legacy);
      for (const device of wanting) {
        // Dismiss-only: no `category` or `questionId`, it answers nothing. `kind` is what makes it
        // distinguishable from a subagent alert, which is otherwise identical on the wire (#968).
        void deps
          .send(signalingUrl, device.token, {
            title,
            body,
            ...legacyFields,
            kind: 'turn_complete',
          })
          .catch((error) => {
            if (!isLegacyPushRetired(error)) deps.onError(new Error('TURN_COMPLETE_PUSH_FAILED'));
          });
      }
    },

    turnFailed: (event) => {
      const input: TurnFailedInput = {
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.errorDetails !== undefined ? { error_details: event.errorDetails } : {}),
      };
      failedRoutes.push(event.sessionId, input, event.agentName);
    },

    turnSucceeded: (sessionId) => {
      failedRoutes.dismiss(sessionId);
    },
  };
}
