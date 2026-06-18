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

import * as fs from 'node:fs';
import { createError, createTranscriptLoadComplete, errorToString } from '@remi/shared';
import type { StaleSessionErrorDetails, UUID } from '@remi/shared';

import { MessageAPI } from '../../api/message-api.ts';
import type { SubagentViewRegistry } from '../../api/subagent-view-registry.ts';
import type { SessionBindingStore, TranscriptIndex } from '../../session/index.ts';
import type {
  TranscriptDiscovery,
  TranscriptWatcher as TranscriptWatcherType,
} from '../../transcript/index.ts';
import { TranscriptMessageBridge, TranscriptWatcher } from '../../transcript/index.ts';
import type { AssistantEntry } from '../../transcript/index.ts';
import type { CurrentOwnedSession } from '../current-session.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface TranscriptHandlerDeps {
  transcriptDiscovery: TranscriptDiscovery;
  /** Live watchers keyed by Remi session ID (for Remi-UUID fallback resolution). */
  transcriptWatchers: Map<UUID, TranscriptWatcherType>;
  /** Authoritative Remi-UUID -> claudeSessionId binding, used as a last-resort
   *  resolver when no live watcher exists (e.g. a wedged/rotated session). */
  bindingStore: SessionBindingStore;
  /** Durable, long-TTL remiUUID -> {claudeSessionId, projectPath} index that
   *  outlives sessions.json's 100-entry cap / 7-day purge, so an old session's
   *  transcript still resolves after the liveness store has dropped it (#577). */
  transcriptIndex: TranscriptIndex;
  /** Resolves the daemon's current owned session, so a stale/unknown request is
   *  redirected to the current session instead of dead-ending on NOT_FOUND (#499). */
  currentOwnedSession: () => CurrentOwnedSession | null;
  /** Resolves a subagent agentId -> its transcript file so the client can load a
   *  subagent view by the agentId it got in `session_views` (#499 phase 3). */
  subagentViews: Pick<SubagentViewRegistry, 'resolvePath'>;
  send: SendToConnection;
}

export type TranscriptHandlers = ReturnType<typeof createTranscriptHandlers>;

export function createTranscriptHandlers(deps: TranscriptHandlerDeps) {
  const {
    transcriptDiscovery,
    transcriptWatchers,
    bindingStore,
    transcriptIndex,
    currentOwnedSession,
    subagentViews,
    send,
  } = deps;

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

      // Last resort: no live watcher (e.g. a session wedged or torn down mid
      // rotation). Resolve through the authoritative store binding, which the
      // rotation handler keeps current (#451), so history loads even when the
      // streaming watcher is absent rather than failing with NOT_FOUND.
      if (!filePath) {
        // A disk hiccup on the binding lookup must not throw out of this void
        // handler (the client would hang with no response). Fail soft: log and
        // fall through to the NOT_FOUND path below.
        try {
          const boundClaudeId = bindingStore.get(sessionId as UUID)?.claudeSessionId;
          if (boundClaudeId) {
            filePath = transcriptDiscovery.findTranscriptBySessionId(boundClaudeId);
            if (filePath) {
              log(
                `[TranscriptLoad] Resolved Remi UUID ${sessionId} to path via store binding ${boundClaudeId.slice(0, 8)}`,
              );
            }
          }
        } catch (err) {
          logError(
            `[TranscriptLoad] binding lookup failed for ${sessionId}; proceeding without store resolution: ${errorToString(err)}`,
          );
        }
      }

      // Durable index fallback (#577): the session was purged from sessions.json
      // (100-entry cap or 7-day TTL), so bindingStore.get returned null, but the
      // long-TTL transcript-index still holds its claude id + project path. Rebuild
      // the deterministic transcript path and load it from disk if it exists. This
      // is what stops the recurring "Transcript for session <id> not found" for an
      // old-but-still-on-disk session.
      if (!filePath) {
        try {
          const indexed = transcriptIndex.get(sessionId as UUID);
          if (indexed) {
            const candidate = `${transcriptDiscovery.getProjectTranscriptDir(indexed.projectPath)}/${indexed.claudeSessionId}.jsonl`;
            if (fs.existsSync(candidate)) {
              filePath = candidate;
              log(
                `[TranscriptLoad] Resolved Remi UUID ${sessionId} to path via durable index ${indexed.claudeSessionId.slice(0, 8)}`,
              );
            } else {
              // Indexed but the .jsonl is gone (Claude transcript deleted/moved).
              // Distinct from "never indexed" so the failure is diagnosable: the
              // binding survived but the content did not.
              log(
                `[TranscriptLoad] Durable index hit for ${sessionId} (claude=${indexed.claudeSessionId.slice(0, 8)}) but transcript is absent on disk: ${candidate}`,
              );
            }
          } else {
            log(`[TranscriptLoad] No durable index entry for ${sessionId}`);
          }
        } catch (err) {
          logError(
            `[TranscriptLoad] transcript-index lookup failed for ${sessionId}; proceeding: ${errorToString(err)}`,
          );
        }
      }

      // A subagent view: the client echoes the agent_id back from session_views;
      // resolve its deterministic <main>/subagents/agent-<id>.jsonl (#499 phase 3).
      if (!filePath) {
        const subPath = subagentViews.resolvePath(sessionId);
        if (subPath) {
          // The path is derived from the hook, not verified — the subagent may
          // not have written its first line yet (tapped right after start).
          // Send a plain NOT_FOUND (no current-session redirect, which would
          // wrongly bounce the user to the main session); the client clears its
          // loaded marker on the error so a re-tap retries once it's written.
          if (!fs.existsSync(subPath)) {
            log(`[TranscriptLoad] Subagent ${sessionId} transcript not written yet: ${subPath}`);
            send(
              connectionId,
              createError('NOT_FOUND', `Subagent transcript not ready: ${sessionId}`),
            );
            return;
          }
          filePath = subPath;
          log(`[TranscriptLoad] Resolved subagent ${sessionId} to ${subPath}`);
        }
      }

      if (!filePath) {
        // Don't dead-end: tell the client the daemon's current authoritative
        // session so it can re-bind + re-fetch instead of getting stuck on a
        // stale id (the "Transcript for session X not found" screenshot) (#499).
        const current = currentOwnedSession();
        const details: Record<string, unknown> | undefined = current
          ? ({
              currentSessionId: current.sessionId,
              currentClaudeSessionId: current.claudeSessionId,
              currentTranscriptPath: current.transcriptPath,
            } satisfies StaleSessionErrorDetails)
          : undefined;
        send(
          connectionId,
          createError('NOT_FOUND', `Transcript for session ${sessionId} not found`, details),
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
