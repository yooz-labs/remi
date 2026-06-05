/**
 * Transcript-watcher helper used during session creation.
 *
 * `startTranscriptWatcher` wires a `TranscriptMessageBridge` +
 * `TranscriptWatcher` for the given file and registers the watcher in the
 * shared `transcriptWatchers` map so other code (status refresh, cleanup,
 * fallback teardown) can find it by session id.
 *
 * Pure over its inputs — no module-level singletons — so tests can supply
 * tmpdir-backed stores and an in-memory Map. (The deprecated
 * `extractClaudeSessionId` filename-inference helper was removed in #469;
 * the daemon pre-assigns the Claude session id via `resolveClaudeBinding`
 * before spawn, so no runtime inference is needed.)
 */

import * as fs from 'node:fs';
import type { ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../api/message-api.ts';
import { TranscriptMessageBridge, TranscriptWatcher } from '../transcript/index.ts';
import type { AssistantEntry } from '../transcript/index.ts';
import { log, logError } from './logger.ts';

export interface StartTranscriptWatcherDeps {
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
}

/**
 * Start watching a transcript file for a session. Registers the watcher in
 * the shared map so other callers can look it up, stop it, or force a reread.
 */
export function startTranscriptWatcher(
  deps: StartTranscriptWatcherDeps,
  sessionId: UUID,
  transcriptPath: string,
  messageApi: MessageAPI,
  sendAndRecord: (message: ProtocolMessage) => void,
): void {
  log(`[Transcript] Watching: ${transcriptPath}`);
  log(`[Transcript] File exists: ${fs.existsSync(transcriptPath)}`);

  const bridge = new TranscriptMessageBridge({ sessionId }, messageApi, {
    onTranscriptContent: (message) => {
      log(`[Transcript] Delivering content (${message.type}) to clients`);
      sendAndRecord(message);
    },
  });

  const watcher = new TranscriptWatcher(
    {
      filePath: transcriptPath,
      readExisting: true,
      pollIntervalMs: 1000,
    },
    {
      onAssistantMessage: (entry: AssistantEntry) => {
        log(
          `[Transcript] Assistant entry: ${entry.uuid?.slice(0, 8)} (${entry.message?.content?.length ?? 0} blocks)`,
        );
        bridge.handleAssistantEntry(entry);
      },
      onUserMessage: (entry) => {
        log(`[Transcript] User entry: ${entry.uuid?.slice(0, 8)}`);
        bridge.handleUserEntry(entry);
      },
      onError: (error) => {
        logError(`[Transcript] Error for session ${sessionId}:`, error.message);
      },
    },
  );

  deps.transcriptWatchers.set(sessionId, watcher);
  watcher.start().catch((error) => {
    logError(`[Transcript] Failed to start watcher for session ${sessionId}:`, error);
  });
  log(`[Transcript] Watcher started for session ${sessionId}`);
}
