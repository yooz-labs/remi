/**
 * Transcript-watcher helper used during session creation.
 *
 * `startTranscriptWatcher` wires a `TranscriptMessageBridge` +
 * `TranscriptWatcher` for the given file and registers the watcher in the
 * shared `transcriptWatchers` map so other code (status refresh, cleanup,
 * fallback teardown) can find it by session id.
 *
 * `extractClaudeSessionId` is **deprecated** (post-#427/phase 1): the
 * daemon now pre-assigns the Claude session id via `resolveClaudeBinding`
 * before spawn and persists it directly to `SessionStore`, so no
 * filename-based inference is needed. The function is kept only because
 * the test suite still exercises it; remove once tests are migrated.
 *
 * Both helpers are pure over their inputs — no module-level singletons — so
 * tests can supply tmpdir-backed stores and an in-memory Map.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../api/message-api.ts';
import type { SessionStore } from '../session/index.ts';
import { TranscriptMessageBridge, TranscriptWatcher } from '../transcript/index.ts';
import type { AssistantEntry } from '../transcript/index.ts';
import { log, logError } from './logger.ts';

export interface ExtractClaudeSessionIdDeps {
  sessionStore: SessionStore;
}

/**
 * @deprecated Superseded by `resolveClaudeBinding` (#427/phase 1). The
 * daemon now pre-assigns the Claude session id before spawn; no
 * filename-based inference happens at runtime. Retained only for the
 * legacy test surface; not called from any production code path.
 *
 * Extracts the Claude session id from a transcript filename and persists
 * it. Returns the extracted id, or null if the filename does not expose
 * one. Filenames are plain UUIDs (`abc123-def456.jsonl`); the underscore
 * split is defensive in case a prefixed format is ever introduced.
 */
export function extractClaudeSessionId(
  deps: ExtractClaudeSessionIdDeps,
  transcriptPath: string,
  sessionId: UUID,
): string | null {
  const basename = path.basename(transcriptPath, '.jsonl');
  const parts = basename.split('_');
  const candidateId = parts[parts.length - 1];
  if (candidateId && candidateId.length >= 8) {
    deps.sessionStore.updateClaudeSessionId(sessionId, candidateId);
    log(`Claude session ID: ${candidateId}`);
    return candidateId;
  }
  return null;
}

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
