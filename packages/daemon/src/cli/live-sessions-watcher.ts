/**
 * Watches the `~/.remi/live-sessions/` directory for sibling daemons
 * registering (or unregistering) and pushes an updated session list to
 * connected clients, so a client auto-discovers a new sibling daemon in the
 * same directory without polling.
 *
 * Debounced: macOS FSEvents fires multiple events per rename (tmp -> final),
 * so a single registration can otherwise trigger several redundant broadcasts.
 *
 * Extracted from the wrapper-mode inline block in cli.ts (#542) so the same
 * watcher can also run in daemon mode, which previously never broadcast new
 * siblings at all.
 */

import * as fs from 'node:fs';
import { createSessionListResponse, errorToString, generateId } from '@remi/shared';
import type { DiscoverableSession, ProtocolMessage, UUID } from '@remi/shared';

export interface LiveSessionsCollectResult {
  readonly sessions: readonly DiscoverableSession[];
  readonly newPorts: readonly number[];
}

export interface LiveSessionsWatcherDeps {
  /** Directory to watch (typically `SessionRegistryFile#dirPath`). */
  readonly dirPath: string;
  /**
   * Gather the current session list + newly-seen sibling ports. Return null
   * (or an empty `newPorts`) to skip broadcasting for this fs event.
   */
  readonly collect: () => LiveSessionsCollectResult | null;
  /** Broadcast the resulting `session_list_response` to connected clients. */
  readonly broadcast: (message: ProtocolMessage) => void;
  readonly logError: (message: string) => void;
  /** Debounce window in ms. Default 300 (tests override to a small value). */
  readonly debounceMs?: number;
  /**
   * Fired on EVERY debounced flush, regardless of whether `collect()`
   * produced a broadcast (#650): session REMOVALS change the hub census but
   * never yield `newPorts`, so the hub's client tracker hooks here.
   */
  readonly onDirChange?: (() => void) | undefined;
}

/**
 * Start watching. Returns a closer that stops the watcher and clears any
 * pending debounce timer; safe to call multiple times.
 */
export function startLiveSessionsWatcher(deps: LiveSessionsWatcherDeps): () => void {
  const debounceMs = deps.debounceMs ?? 300;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

  const flush = (): void => {
    debounceTimer = null;
    try {
      deps.onDirChange?.();
      const result = deps.collect();
      if (!result || result.newPorts.length === 0) return;
      const message = createSessionListResponse(
        result.sessions,
        generateId() as UUID,
        result.newPorts,
      );
      deps.broadcast(message);
    } catch (err) {
      deps.logError(`[LiveSessions] Error pushing session update: ${errorToString(err)}`);
    }
  };

  try {
    // On a fresh install (no session has ever registered), the directory may
    // not exist yet. A long-running hub that hits ENOENT here would never
    // re-arm the watcher for its entire lifetime, so ensure it up front.
    fs.mkdirSync(deps.dirPath, { recursive: true });
    watcher = fs.watch(deps.dirPath, { persistent: false }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, debounceMs);
    });
    // An FSWatcher emitting 'error' with no listener throws out of the event
    // loop as an uncaughtException, which the process guards treat as fatal —
    // killing the whole (possibly launchd-managed, unattended) hub over a
    // recoverable fs hiccup in a peripheral notify-siblings feature. Degrade
    // to "watcher dead, logged" instead. (Cast: bun-types' FSWatcher omits
    // the EventEmitter surface the runtime object actually has.)
    (watcher as unknown as import('node:events').EventEmitter).on('error', (err: unknown) => {
      deps.logError(
        `[LiveSessions] Watcher error; sibling-daemon broadcasts disabled: ${errorToString(err)}`,
      );
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    deps.logError(`[LiveSessions] Could not watch live-sessions dir: ${errorToString(err)}`);
  }

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  };
}
