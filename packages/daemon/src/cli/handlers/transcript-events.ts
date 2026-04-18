/**
 * sharedEvents handler for one-shot transcript reads:
 *   onTranscriptLoadRequest, read an entire Claude Code JSONL transcript
 *     once (no long-lived watch), stream each message back to the caller,
 *     then send a transcript_load_complete envelope.
 *
 * Separate from the live streaming watchers that createNewSession sets up:
 * this handler serves clients asking for the *history* of an arbitrary
 * session (daemon-owned or external) by its UUID. If the UUID is a Remi
 * session ID, the handler falls back to the live watcher's file path so
 * callers don't need to know which naming scheme the session uses.
 */

import { createError, createTranscriptLoadComplete, errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';

import { MessageAPI } from '../../api/message-api.ts';
import type {
  TranscriptDiscovery,
  TranscriptWatcher as TranscriptWatcherType,
} from '../../transcript/index.ts';
import { TranscriptMessageBridge, TranscriptWatcher } from '../../transcript/index.ts';
import type { AssistantEntry } from '../../transcript/index.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface TranscriptHandlerDeps {
  transcriptDiscovery: TranscriptDiscovery;
  /** Live watchers keyed by Remi session ID (for Remi-UUID fallback resolution). */
  transcriptWatchers: Map<UUID, TranscriptWatcherType>;
  send: SendToConnection;
}

export type TranscriptHandlers = ReturnType<typeof createTranscriptHandlers>;

export function createTranscriptHandlers(deps: TranscriptHandlerDeps) {
  const { transcriptDiscovery, transcriptWatchers, send } = deps;

  return {
    onTranscriptLoadRequest: (connectionId: UUID, sessionId: string, requestId: UUID): void => {
      log(`Transcript load request from ${connectionId} for session ${sessionId}`);

      // First try finding by Claude session ID embedded in the filename.
      let filePath = transcriptDiscovery.findTranscriptBySessionId(sessionId);

      // If not found by Claude session ID, the request may be using a Remi UUID.
      // Daemon sessions are identified by Remi UUID, not Claude session ID.
      // Check if an active watcher exists for this session ID and use its path.
      if (!filePath) {
        const activeWatcher = transcriptWatchers.get(sessionId as UUID);
        if (activeWatcher) {
          filePath = activeWatcher.filePath;
          log(`[TranscriptLoad] Resolved Remi UUID ${sessionId} to path via active watcher`);
        }
      }

      if (!filePath) {
        send(
          connectionId,
          createError('NOT_FOUND', `Transcript for session ${sessionId} not found`),
        );
        return;
      }

      // Build a temporary MessageAPI + bridge to parse each entry and stream it.
      const messageApi = new MessageAPI({ sessionId: sessionId as UUID });
      let messageCount = 0;

      const bridge = new TranscriptMessageBridge({ sessionId: sessionId as UUID }, messageApi, {
        onTranscriptContent: (message) => {
          messageCount++;
          send(connectionId, message);
        },
      });

      const watcher = new TranscriptWatcher(
        {
          filePath,
          readExisting: true,
          pollIntervalMs: 0, // One-shot read, not a live watch.
        },
        {
          onAssistantMessage: (entry: AssistantEntry) => {
            bridge.handleAssistantEntry(entry);
          },
          onUserMessage: (entry) => {
            bridge.handleUserEntry(entry);
          },
          onError: (error) => {
            logError(`[TranscriptLoad] Error reading ${sessionId}:`, error.message);
          },
        },
      );

      watcher
        .start()
        .then(() => {
          // Stop immediately since we only wanted existing entries.
          watcher.stop();
          log(`Transcript load complete for ${sessionId}: ${messageCount} messages`);
          send(connectionId, createTranscriptLoadComplete(sessionId, messageCount, requestId));
        })
        .catch((error: Error) => {
          logError(`[TranscriptLoad] Failed to read ${sessionId}:`, error);
          send(
            connectionId,
            createError('LOAD_FAILED', `Failed to load transcript: ${errorToString(error)}`),
          );
        });
    },
  };
}
