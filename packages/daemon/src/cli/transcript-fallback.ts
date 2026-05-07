/**
 * Transcript-watcher fallback poll for the hook-miss case.
 *
 * Normally the Claude Code hook event stream tells us the exact transcript
 * path (SessionStart carries `transcript_path`). When sibling daemons share
 * the same project directory, hook events are intentionally skipped because
 * all Claudes POST to all hook URLs and we can't tell which one we own.
 * This poll becomes the primary discovery path in that case.
 *
 * Every 2 seconds, look for a transcript file whose mtime is recent or is
 * newer than the PTY startup. If found, start the watcher and cancel the
 * poll. Give up after 30 seconds and log the reason.
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../api/message-api.ts';
import type { SessionRegistry, SessionStore } from '../session/index.ts';
import type { TranscriptDiscovery } from '../transcript/index.ts';
import type { TranscriptWatcher } from '../transcript/index.ts';
import { log, logError } from './logger.ts';
import { extractClaudeSessionId, startTranscriptWatcher } from './transcript-watcher-setup.ts';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 30000;
const RECENT_THRESHOLD_MS = 5 * 60 * 1000;

export interface TranscriptFallbackDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  transcriptDiscovery: TranscriptDiscovery;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  /** Override for tests. Defaults to 2000ms. */
  pollIntervalMs?: number;
  /** Override for tests. Defaults to 30000ms. */
  pollTimeoutMs?: number;
}

/**
 * Start polling for a transcript path to watch. Registers the interval in
 * `transcriptFallbackTimers` so cleanup can cancel it; the poll self-clears
 * on success, on session loss, or after the timeout.
 */
export function startTranscriptFallback(
  deps: TranscriptFallbackDeps,
  sessionId: UUID,
  workingDirectory: string,
  messageApi: MessageAPI,
  sendAndRecord: (message: ProtocolMessage) => void,
): void {
  const {
    sessionRegistry,
    sessionStore,
    transcriptDiscovery,
    transcriptWatchers,
    transcriptFallbackTimers,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = deps;

  const startupTime = Date.now();

  const attachWatcher = (transcriptPath: string): void => {
    startTranscriptWatcher(
      { transcriptWatchers },
      sessionId,
      transcriptPath,
      messageApi,
      sendAndRecord,
    );
    extractClaudeSessionId({ sessionStore }, transcriptPath, sessionId);
  };

  const stopPoll = (): void => {
    clearInterval(fallbackInterval);
    transcriptFallbackTimers.delete(sessionId);
  };

  const fallbackInterval = setInterval(() => {
    if (transcriptWatchers.has(sessionId)) {
      stopPoll();
      return;
    }
    if (!sessionRegistry.hasSession(sessionId)) {
      stopPoll();
      return;
    }

    // Exclude transcripts already claimed by sibling daemons (their
    // claudeSessionId is stored in sessions.json) to avoid double-watching.
    const siblingClaudeIds = new Set<string>();
    for (const entry of sessionStore.list()) {
      if (entry.remiSessionId !== sessionId && entry.claudeSessionId && !entry.exitedAt) {
        siblingClaudeIds.add(entry.claudeSessionId);
      }
    }
    const transcriptPath =
      siblingClaudeIds.size > 0
        ? transcriptDiscovery.findLatestTranscriptExcluding(workingDirectory, siblingClaudeIds)
        : transcriptDiscovery.findLatestTranscript(workingDirectory);

    if (transcriptPath) {
      try {
        const stat = fs.statSync(transcriptPath);
        if (stat.mtimeMs >= startupTime || Date.now() - stat.mtimeMs < RECENT_THRESHOLD_MS) {
          stopPoll();
          log(`[Hooks] Found new transcript via fallback: ${transcriptPath}`);
          attachWatcher(transcriptPath);
          return;
        }
      } catch (err) {
        log(`[Hooks] Fallback stat failed for ${transcriptPath}: ${errorToString(err)}`);
      }
    }

    // Timeout branch. Still accept the transcript if it became recent
    // during the final interval, otherwise log and give up.
    if (Date.now() - startupTime > pollTimeoutMs) {
      stopPoll();
      if (transcriptPath) {
        try {
          const stat = fs.statSync(transcriptPath);
          const isRecent =
            stat.mtimeMs >= startupTime || Date.now() - stat.mtimeMs < RECENT_THRESHOLD_MS;
          if (isRecent) {
            log('[Hooks] Transcript fallback: found recent transcript on final check.');
            attachWatcher(transcriptPath);
            return;
          }

          logError(
            `[Hooks] Transcript fallback timed out without a fresh transcript. Skipping stale file: ${transcriptPath}`,
          );
          return;
        } catch {
          logError(
            '[Hooks] Transcript fallback timed out and transcript stat failed on final check.',
          );
          return;
        }
      }

      logError('[Hooks] Transcript fallback timed out without any transcript file.');
    }
  }, pollIntervalMs);

  transcriptFallbackTimers.set(sessionId, fallbackInterval);
}
