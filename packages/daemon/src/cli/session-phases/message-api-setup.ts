/**
 * Build the MessageAPI + its callbacks for createNewSession.
 *
 * The MessageAPI owns bullet assembly, question detection, and status flow.
 * This module wires it to:
 *   - the outgoing-message channel (sendMessage + registry recordOutgoing)
 *   - the SessionRegistry's question and status maps
 *   - the StatusWriter's sessionStatus patch
 *   - the live transcript watcher (forceRead on status change so the UI
 *     reflects the latest transcript frame without waiting for the next
 *     2s poll)
 *   - the push-notification client, used only when no client is actively
 *     viewing the session (attached clients see the question in-app)
 *
 * Returns both the configured MessageAPI and the `sendAndRecord` closure
 * because the hook bridge and PTY setup also dispatch through
 * it and need the same replay semantics (record under the primary session
 * id so replays re-emit with the id the client knows).
 */

import { createQuestion, createStructuredAgentOutput, generateId, now } from '@remi/shared';
import type { AgentStatus, ProtocolMessage, Question, SessionIdentity, UUID } from '@remi/shared';

import type { MessageAPIEvents, QuestionPushOptions } from '../../api/message-api.ts';
import { MessageAPI } from '../../api/message-api.ts';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher.ts';
import type { PushConfig } from '../../notifications/notification-dispatcher.ts';
import type { SessionRegistry } from '../../session/index.ts';
import type { TranscriptWatcher } from '../../transcript/index.ts';
import type { DeviceTokenEntry } from '../handlers/trivial-events.ts';
import { log, logError } from '../logger.ts';
import { getPrimarySessionId } from '../session-state.ts';

export type { PushConfig };

export interface MessageApiSetupDeps {
  sessionRegistry: SessionRegistry;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  deviceTokens: Map<string, DeviceTokenEntry>;
  /** Prune a permanently-invalid device token (epic #603 Phase 6). Forwarded to
   *  the dispatcher so a BadDeviceToken push removes the dead token. */
  pruneToken?: (token: string) => void;
  /** Pull in a sibling daemon's token removal/registration before a push
   *  decision (#690). Forwarded to the dispatcher. */
  refreshDeviceTokens?: () => void;
  /**
   * Called on every question emission so the caller can swap config sources
   * without re-wiring the factory. MUST be synchronous and non-throwing: it
   * runs inside the MessageAPI onQuestion callback with no try/catch around it.
   */
  pushConfig: () => PushConfig;
  updateRemiStatus: (patch: { sessionStatus: AgentStatus }) => void;
  maxBulletLength: number;
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void;
  /**
   * Returns the session's current harness identity (#429, #1179): Claude's
   * bound session UUID, or another harness's own id, null until it is learned.
   * Called on every question emission; returns null if the session has no
   * record (the normal spawn path writes one pre-spawn, so null is rare in
   * production). Same synchronous/non-throwing contract as pushConfig:
   * implementations must absorb their own I/O errors rather than throwing
   * into the emission path.
   */
  getIdentity?: () => SessionIdentity | null;
  /**
   * Log a detected question's length, not its first 50 characters (#1178): a Codex approval
   * card's text is the command Codex asks to run, which a log must not carry. Default: the text.
   */
  redactQuestionLogs?: boolean;
}

export interface MessageApiHandle {
  messageApi: MessageAPI;
  sendAndRecord: (message: ProtocolMessage) => void;
  /**
   * This session's APNS dispatcher (#585, P7). Exposed so the daemon's
   * question-resolved path can fire a quiet lock-screen dismissal for a resolved
   * question through the SAME device-token fan-out that pushed it.
   */
  notifications: NotificationDispatcher;
}

export function createMessageApiForSession(
  deps: MessageApiSetupDeps,
  sessionId: UUID,
): MessageApiHandle {
  const {
    sessionRegistry,
    transcriptWatchers,
    deviceTokens,
    pruneToken,
    refreshDeviceTokens,
    pushConfig,
    updateRemiStatus,
    maxBulletLength,
    sendMessage,
    getIdentity,
    redactQuestionLogs,
  } = deps;

  const sendAndRecord = (message: ProtocolMessage): void => {
    // Always record under primarySessionId so replay works correctly. The
    // client only knows the primary id (from hello_ack), so replay must use
    // it regardless of which session-id the message originated from.
    const recordId = getPrimarySessionId() ?? sessionId;
    sendMessage(sessionId, message);
    sessionRegistry.recordOutgoingMessage(recordId, message);
  };

  // APNS push for this session's questions (#453 phase 1). Owns the
  // active-client gate, the per-prompt PushDedup baseline (#409), and the
  // device-token fan-out; the MessageAPI callback just hands it the question.
  const notifications = new NotificationDispatcher(
    {
      sessionRegistry,
      deviceTokens,
      pushConfig,
      getPrimarySessionId,
      ...(pruneToken ? { pruneToken } : {}),
      ...(refreshDeviceTokens ? { refreshDeviceTokens } : {}),
    },
    sessionId,
  );

  const callbacks: MessageAPIEvents = {
    onStructuredMessage: (structured) => {
      try {
        sendAndRecord(createStructuredAgentOutput(structured, false));
      } catch (err) {
        logError(`[Session ${sessionId}] Failed to send structured message:`, err);
      }
    },
    onStructuredMessageUpdate: (_messageId, structured, changedBulletIds) => {
      try {
        sendAndRecord(createStructuredAgentOutput(structured, true, changedBulletIds));
      } catch (err) {
        logError(`[Session ${sessionId}] Failed to send structured message update:`, err);
      }
    },
    onMessageFinalized: (msgId) => {
      log(`Message ${msgId} finalized`);
    },
    onQuestion: (question: Question, opts?: QuestionPushOptions) => {
      log(
        redactQuestionLogs
          ? `Question detected (${question.text.length} chars)`
          : `Question detected: ${question.text.substring(0, 50)}...`,
      );
      const questionSessionId = getPrimarySessionId() ?? sessionId;
      const identity = getIdentity?.() ?? null;
      // #753: stamp held-ness onto the question itself so every downstream
      // copy (live message, registry entry, attach-time re-send) carries it.
      // A `held` push is a card pushed by id at hook time: a held binary
      // permission prompt (#1126) or an AskUserQuestion / ExitPlanMode /
      // multi-choice card. The stamp keys `handleAnswer`'s refusal of free
      // text on a card that takes options (#1134, `free-text-on-held-card`)
      // and the terminal attach client's banner.
      // #1235: and how its answer is applied. A terminal-only card takes no phone answer whatever
      // its source said; with no path given the field stays absent (unknown), never guessed.
      const answerPath = question.terminalOnly === true ? 'none' : opts?.answerPath;
      const stamped: Question = {
        ...question,
        ...(opts?.held === true && { held: true }),
        ...(answerPath !== undefined && { answerPath }),
      };
      const msg: ProtocolMessage = createQuestion(stamped, questionSessionId, identity);
      sendAndRecord(msg);
      // #808: `source` (QuestionSource: 'permission_request' | 'notification' |
      // 'pty' | 'elicitation', #889) is the richest "why did this appear"
      // signal already on the Question, and free to pass through -- no extra
      // threading needed.
      sessionRegistry.addQuestion(questionSessionId, stamped, stamped.source ?? 'unknown');

      // Push: a non-held question only pushes when no client is attached (the
      // client sees it in-app). A `held` push (`pushHeldHook`, #603 Phase 3)
      // always also pushes to the lock screen — the attached client may be
      // backgrounded. The question path does not await the delivery outcome
      // maybePush returns. Fire-and-forget
      // from this synchronous hook callback, so guard against a future
      // pushConfig/refreshDeviceTokens contract change surfacing as an
      // unhandled rejection (matches the escalator's #672 push guard).
      void notifications
        .maybePush(questionSessionId, stamped, { held: opts?.held === true })
        .catch((err) => {
          logError(`[Session ${sessionId}] Question push threw:`, err);
        });
    },
    onStatusChange: (status: AgentStatus, context?: string) => {
      log(`Status: ${status}${context ? ` (${context})` : ''}`);
      // Reset the push-dedup baseline whenever Claude moves past the
      // 'waiting' state — same lifecycle as QuestionDedup so a new
      // prompt cycle starts fresh and is not silently absorbed by a
      // stale prior push (#409).
      if (status !== 'waiting') {
        notifications.resetDedup();
      }
      const msg: ProtocolMessage = {
        type: 'session_update',
        id: generateId(),
        timestamp: now(),
        session: {
          id: sessionId,
          name: '',
          startedAt: now(),
          status,
          isActive: status !== 'idle',
        },
      };
      sendAndRecord(msg);
      sessionRegistry.updateStatus(sessionId, status);
      updateRemiStatus({ sessionStatus: status });

      const watcher = transcriptWatchers.get(sessionId);
      if (watcher) {
        watcher.forceRead().catch((err) => {
          logError(`[Transcript] forceRead failed for session ${sessionId}:`, err);
        });
      }
    },
  };

  const messageApi = new MessageAPI({ sessionId, initialBulletId: 1, maxBulletLength }, callbacks);

  return { messageApi, sendAndRecord, notifications };
}
