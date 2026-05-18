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

import { createStructuredAgentOutput, generateId, now } from '@remi/shared';
import type { AgentStatus, ProtocolMessage, Question, QuestionOption, UUID } from '@remi/shared';

import type { MessageAPIEvents } from '../../api/message-api.ts';
import { MessageAPI } from '../../api/message-api.ts';
import { sendPushTrigger } from '../../notifications/push-client.ts';
import { PushDedup } from '../../notifications/push-dedup.ts';
import type { SessionRegistry } from '../../session/index.ts';
import type { TranscriptWatcher } from '../../transcript/index.ts';
import type { DeviceTokenEntry } from '../handlers/trivial-events.ts';
import { log, logError } from '../logger.ts';
import { getPrimarySessionId } from '../session-state.ts';

export interface PushConfig {
  signalingUrl: string;
  pushSecret?: string | undefined;
}

export interface MessageApiSetupDeps {
  sessionRegistry: SessionRegistry;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  deviceTokens: Map<string, DeviceTokenEntry>;
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
   * Returns the current Claude session UUID this PTY is bound to (#429).
   * Called on every question emission; returns null if no binding is
   * recorded for this session (the normal spawn path sets one pre-spawn,
   * so null is rare in production). Same synchronous/non-throwing
   * contract as pushConfig — implementations must absorb their own I/O
   * errors rather than throwing into the emission path.
   */
  getClaudeSessionId?: () => UUID | null;
}

export interface MessageApiHandle {
  messageApi: MessageAPI;
  sendAndRecord: (message: ProtocolMessage) => void;
}

/**
 * Select the APNS notification category based on the number of question
 * options. iOS renders action buttons matching the category; watchOS mirrors
 * them automatically.
 */
export function selectPushCategory(options: readonly QuestionOption[]): string | undefined {
  if (options.length === 2) return 'REMI_YN';
  if (options.length === 3) return 'REMI_YNA';
  if (options.length === 4) return 'REMI_MULTI';
  return undefined;
}

export function createMessageApiForSession(
  deps: MessageApiSetupDeps,
  sessionId: UUID,
): MessageApiHandle {
  const {
    sessionRegistry,
    transcriptWatchers,
    deviceTokens,
    pushConfig,
    updateRemiStatus,
    maxBulletLength,
    sendMessage,
    getClaudeSessionId,
  } = deps;

  const sendAndRecord = (message: ProtocolMessage): void => {
    // Always record under primarySessionId so replay works correctly. The
    // client only knows the primary id (from hello_ack), so replay must use
    // it regardless of which session-id the message originated from.
    const recordId = getPrimarySessionId() ?? sessionId;
    sendMessage(sessionId, message);
    sessionRegistry.recordOutgoingMessage(recordId, message);
  };

  // Per-session push-dedup baseline. PTY + Hook double-emit one prompt
  // with different ids; without this, the user gets two lock-screen
  // notifications per prompt (#409). Reset whenever status leaves
  // 'waiting' so a fresh prompt cycle starts with a clean baseline.
  const pushDedup = new PushDedup();

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
    onQuestion: (question: Question) => {
      log(`Question detected: ${question.text.substring(0, 50)}...`);
      const questionSessionId = getPrimarySessionId() ?? sessionId;
      const claudeSessionId = getClaudeSessionId?.() ?? undefined;
      const msg: ProtocolMessage = {
        type: 'question',
        id: generateId(),
        timestamp: now(),
        question,
        sessionId: questionSessionId,
        ...(claudeSessionId !== undefined && claudeSessionId !== null && { claudeSessionId }),
      };
      sendAndRecord(msg);
      sessionRegistry.updateQuestion(questionSessionId, question);

      // Push only when no client is attached; attached clients see it in-app.
      const sessionForPush = sessionRegistry.getSession(questionSessionId);
      const hasActiveClient =
        sessionForPush !== undefined && sessionForPush.activeConnectionId !== null;
      if (deviceTokens.size > 0 && !hasActiveClient) {
        // Push-dedup gate (#409): suppress the PTY/Hook double-emission
        // for one prompt cycle. Mirrors the client's richer-wins guard
        // so phone and in-app converge on the same option set.
        if (!pushDedup.shouldPush(question)) {
          log(`Push suppressed by dedup for session ${questionSessionId}`);
          return;
        }
        const session = sessionRegistry.getSession(sessionId);
        const sessionName = session?.name || 'Agent';
        const cfg = pushConfig();
        const pushSessionId = getPrimarySessionId() ?? sessionId;
        const pushCategory = selectPushCategory(question.options);
        const pushOptions = question.options.map((o) => o.value);
        for (const dt of deviceTokens.values()) {
          sendPushTrigger(cfg.signalingUrl, dt.token, {
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
    },
    onStatusChange: (status: AgentStatus, context?: string) => {
      log(`Status: ${status}${context ? ` (${context})` : ''}`);
      // Reset the push-dedup baseline whenever Claude moves past the
      // 'waiting' state — same lifecycle as QuestionDedup so a new
      // prompt cycle starts fresh and is not silently absorbed by a
      // stale prior push (#409).
      if (status !== 'waiting') {
        pushDedup.reset();
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

  return { messageApi, sendAndRecord };
}
