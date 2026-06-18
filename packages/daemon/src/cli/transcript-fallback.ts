/**
 * Transcript-watcher fallback poll for the hook-miss case.
 *
 * Since #427 / phase 1, the daemon pre-assigns a `claudeSessionId` and passes
 * `--session-id <uuid>` to `claude` so Claude writes to a known path. This
 * poll waits for that exact file to appear under
 * `~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl` and then starts
 * the watcher. No mtime sort, no sibling exclusion, no inference.
 *
 * Normally the Claude Code hook event stream tells us the exact transcript
 * path (SessionStart carries `transcript_path`), in which case the hook
 * bridge starts the watcher and this poll self-cancels on the next tick. The
 * poll is the primary path only when hook events are unavailable (e.g.
 * settings.local.json absent, hook server disabled, or in the sibling-in-dir
 * case where the bridge defers to filesystem ground-truth).
 *
 * Poll every 2 seconds. Give up after 120 seconds and log the reason. Claude
 * routinely takes 30-90s to write its first transcript line on a large context,
 * so a 30s window timed out on nearly every session (the self-heal path still
 * covered it, but noisily, and left a race window for a client that loaded
 * during startup). 120s covers the common slow-start case (#577).
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../api/message-api.ts';
import type { SessionRegistry } from '../session/index.ts';
import type { TranscriptDiscovery } from '../transcript/index.ts';
import type { TranscriptWatcher } from '../transcript/index.ts';
import { log, logError } from './logger.ts';
import { startTranscriptWatcher } from './transcript-watcher-setup.ts';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 120000;

export interface TranscriptFallbackDeps {
  sessionRegistry: SessionRegistry;
  transcriptDiscovery: TranscriptDiscovery;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  /** Override for tests. Defaults to 2000ms. */
  pollIntervalMs?: number;
  /** Override for tests. Defaults to 120000ms. */
  pollTimeoutMs?: number;
}

/**
 * Build the deterministic transcript path Claude will write to for a given
 * (projectPath, claudeSessionId) pair. Exposed so callers (and tests) can
 * agree on the same encoding rule as Claude Code itself.
 */
export function expectedTranscriptPath(
  transcriptDiscovery: TranscriptDiscovery,
  projectPath: string,
  claudeSessionId: string,
): string {
  return `${transcriptDiscovery.getProjectTranscriptDir(projectPath)}/${claudeSessionId}.jsonl`;
}

/**
 * Start polling for the pre-assigned transcript path to appear. Registers
 * the interval in `transcriptFallbackTimers` so cleanup can cancel it; the
 * poll self-clears on success, on session loss, or after the timeout.
 */
export function startTranscriptFallback(
  deps: TranscriptFallbackDeps,
  sessionId: UUID,
  workingDirectory: string,
  claudeSessionId: string,
  messageApi: MessageAPI,
  sendAndRecord: (message: ProtocolMessage) => void,
): void {
  const {
    sessionRegistry,
    transcriptDiscovery,
    transcriptWatchers,
    transcriptFallbackTimers,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = deps;

  const startupTime = Date.now();
  const expectedPath = expectedTranscriptPath(
    transcriptDiscovery,
    workingDirectory,
    claudeSessionId,
  );

  // Emit one "still waiting" log at the halfway mark so a genuine early failure
  // is visible during the longer 120s window instead of an ~85s silent gap (#577).
  let midLogged = false;

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

    const elapsed = Date.now() - startupTime;
    if (!midLogged && elapsed >= pollTimeoutMs / 2) {
      midLogged = true;
      log(
        `[Fallback] Still waiting for transcript after ${Math.round(elapsed / 1000)}s: ${expectedPath} (claude=${claudeSessionId.slice(0, 8)}). Claude is likely still loading context; self-heal via hooks remains primary.`,
      );
    }

    if (fs.existsSync(expectedPath)) {
      // Do NOT stopPoll before the watcher is wired. A throw inside
      // startTranscriptWatcher (e.g. transient EMFILE on the watcher's
      // openSync) used to kill the poll while leaving the session
      // unwatched — silent failure with no retry.
      try {
        log(
          `[Fallback] Bound transcript appeared: ${expectedPath} (claude=${claudeSessionId.slice(0, 8)})`,
        );
        startTranscriptWatcher(
          { transcriptWatchers },
          sessionId,
          expectedPath,
          messageApi,
          sendAndRecord,
        );
        stopPoll();
      } catch (err) {
        logError(
          `[Fallback] Failed to start watcher for ${expectedPath}; will retry: ${errorToString(err)}`,
        );
        // Fall through without stopping the poll so the next tick retries.
      }
      return;
    }

    if (elapsed > pollTimeoutMs) {
      stopPoll();
      logError(
        `[Fallback] Timed out waiting for transcript: ${expectedPath} (claude=${claudeSessionId.slice(0, 8)}). Claude may have failed to start, or wrote to an unexpected path.`,
      );
    }
  }, pollIntervalMs);

  transcriptFallbackTimers.set(sessionId, fallbackInterval);
}
