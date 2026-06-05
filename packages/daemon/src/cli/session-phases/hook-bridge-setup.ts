/**
 * Wire the Claude Code hook event stream into our PTY's MessageAPI during
 * createNewSession.
 *
 * Three concerns are tangled here and kept together because they all depend
 * on the same per-session locks (claudeSessionId, mainSessionEnded,
 * hasSiblingInDir()):
 *
 *   1. **Session filtering.** Claude Code fires hook events that may belong
 *      to our PTY, a subagent inside it, or a sibling daemon's PTY in the
 *      same project directory. Without filtering, subagent/sibling events
 *      would hijack status/questions/transcript watching.
 *
 *   2. **Transcript discovery via hooks.** Most events carry
 *      `transcript_path`; when present (and not shadowed by a sibling), we
 *      can start the watcher immediately instead of waiting for the
 *      2s mtime poll. A rotation (/clear or /resume — NOT /compact, which
 *      keeps the same session id) tears down the old watcher, starts a fresh
 *      one, and emits a single session_rotated event.
 *
 *   3. **Auto-approve gate.** PermissionRequest events are intercepted
 *      before they reach the user. If auto-approve returns approve/deny we
 *      inject "1"/"3" into the PTY; otherwise (or on subagent PTY failure)
 *      we escalate to the user or default-deny to avoid hanging a subagent
 *      with no one to answer.
 *
 * The function registers 7 hookServer listeners (SessionStart, PreToolUse,
 * PostToolUse, Notification, PermissionRequest, Stop, SessionEnd) and
 * returns void. It runs once per session at createNewSession time, only
 * when a hookServer is configured.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSessionRotated, errorToString } from '@remi/shared';
import type { AgentStatus, ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../../api/message-api.ts';
import type { QuestionPresenceTracker } from '../../api/question-presence-tracker.ts';
import type { AutoApproveService } from '../../auto-approve/index.ts';
import { HookEventBridge } from '../../hooks/index.ts';
import type { HookServer } from '../../hooks/index.ts';
import { classifySessionEvent } from '../../hooks/session-lock-classifier.ts';
import { claudeChildLooksAlive } from '../../session/index.ts';
import type { SessionRegistry, SessionRegistryFile, SessionStore } from '../../session/index.ts';
import { readTranscriptOwnerPort } from '../../transcript/index.ts';
import type { TranscriptWatcher } from '../../transcript/index.ts';
import { log, logError } from '../logger.ts';
import { startTranscriptWatcher } from '../transcript-watcher-setup.ts';

export interface HookBridgeDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  liveSessionsRegistry: SessionRegistryFile;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  autoApproveService: AutoApproveService | null;
  /** PORT is reassigned during daemon-mode port probing; read lazily. */
  currentPort: () => number;
}

export interface HookBridgeArgs {
  /** Required; caller must verify non-null before invoking. */
  hookServer: HookServer;
  sessionId: UUID;
  workingDirectory: string;
  messageApi: MessageAPI;
  sendAndRecord: (message: ProtocolMessage) => void;
  /** Pairs hook metadata with PTY screen presence: hook events stash the
   *  question via recordPendingHook (no push), the PTY parser fires the
   *  push on confirmation, and status transitions out of 'waiting' drop
   *  stale pending records. Required when wired into the createNewSession
   *  flow; tests construct their own per-bridge tracker. */
  tracker: QuestionPresenceTracker;
}

export interface HookBridgeHandle {
  /** Live bridge instance. Callers can read `isInSubagentContext()` to gate
   *  alternate question sources (e.g. PTY parser) so subagent prompts are
   *  not surfaced to the user. */
  bridge: HookEventBridge;
}

export function setupHookBridge(
  deps: Readonly<HookBridgeDeps>,
  args: Readonly<HookBridgeArgs>,
): HookBridgeHandle {
  const {
    sessionRegistry,
    sessionStore,
    liveSessionsRegistry,
    transcriptWatchers,
    transcriptFallbackTimers,
    autoApproveService,
    currentPort,
  } = deps;
  const { hookServer, sessionId, workingDirectory, messageApi, sendAndRecord, tracker } = args;

  // ---- Per-session locks (mutable across event callbacks) -----------------

  // Track the Claude session ID so we can filter hook events by session.
  // Before SessionStart fires, we let events through (claudeSessionId is null).
  let claudeSessionId: string | null = null;

  /**
   * Adopt the canonical claudeSessionId from `sessionStore`. After phase 1
   * (#427), `cli.ts:createNewSession` pre-writes the binding to the store
   * BEFORE Bun.spawn, so the value is authoritative the moment the bridge
   * starts receiving hook events — no inference from filesystem mtime,
   * no risk of latching a sibling daemon's id. The same call also covers
   * subsequent rotations: if a hook-driven restart (/clear, /resume) flips
   * the closure to null and writes a new id to the store, the next event
   * re-adopts the new value. Logs only on change to avoid spam on
   * steady-state hooks. Wrapped in try/catch so an EMFILE / permission
   * flake on the sessions file does not propagate into the hook dispatch
   * loop; on failure we leave the closure untouched.
   */
  const adoptLockFromStore = (): void => {
    try {
      const stored = sessionStore.findByRemiSessionId(sessionId);
      const storedId = stored?.claudeSessionId ?? null;
      if (storedId === null || storedId === claudeSessionId) return;
      const previous = claudeSessionId;
      claudeSessionId = storedId;
      log(
        `[Hooks] Lock ${previous === null ? 'adopted' : 'updated'} from sessionStore: claude=${storedId.slice(0, 8)}${previous ? ` (was ${previous.slice(0, 8)})` : ''}`,
      );
    } catch (err) {
      logError(`[Hooks] adoptLockFromStore failed: ${errorToString(err)}`);
    }
  };

  // Our PTY is the ground truth for "main interactive session". A hook event
  // with a different session_id is NEVER our main:
  //  - Subagent spawn (TaskCreate/TeamCreate), different session_id, no own PTY
  //  - Sibling daemon's Claude, different session_id, different PTY elsewhere
  //  - Actual Claude restart in our PTY, only possible after our PTY exited
  // So while our PTY is running, treat any different session_id as foreign.
  // Once our PTY exits, a new session_id represents a genuine new Claude.
  // Flag set on explicit SessionEnd so we don't wait for PTY exit if Claude
  // shut down cleanly.
  let mainSessionEnded = false;

  // Extract transcript info from hook events. Most Claude Code hook events
  // include session_id and transcript_path. When present, the first event
  // gives us the transcript path immediately, bypassing the deterministic-
  // path fallback poll in transcript-fallback.ts.
  //
  // GUARD: when sibling daemons serve the same directory, all Claudes POST
  // to all hook URLs (shared settings.local.json), so a sibling's event may
  // arrive before our own Claude fires. Skip hook-based discovery and let
  // the deterministic-path fallback handle it (post-#427 the fallback waits
  // for our pre-assigned UUID rather than racing on mtime). Re-evaluated
  // per event so a sibling dying (or a fresh sibling appearing) is
  // reflected immediately. Issue #321: a stale `null`-once cache wedged
  // this state and permanently disabled hook-driven discovery for both
  // daemons.

  /**
   * Cancel any in-flight auto-approve LLM eval. Called on hook events that
   * unambiguously confirm Claude advanced past a prompt: PreToolUse /
   * PostToolUse / Stop / SessionEnd. At that point the user has already
   * answered (probably in the local terminal) and a stale LLM result would
   * either inject into the wrong PTY position or emit a phantom question.
   *
   * Deliberately NOT called on Notification events: idle_prompt can fire
   * while a permission eval is still legitimately in flight, and
   * auth_success / elicitation_dialog don't carry "user answered" semantics
   * either.
   */
  const cancelStaleAutoApprove = (reason: string): void => {
    if (autoApproveService === null) return;
    if (autoApproveService.cancel(reason)) {
      log(`[AutoApprove] Cancelled stale LLM eval: ${reason}`);
    }
  };

  // ---- Helpers ------------------------------------------------------------

  const hasSiblingInDir = (): boolean => {
    // listLive() catches readdir/parse errors internally and returns []
    // (review on PR #358 surfaced the silent-failure risk: an empty array
    // could mean "no siblings" OR "I couldn't tell". Probe the directory
    // ourselves first so any enumeration failure flips the answer to the
    // safe default of "siblings present" — preventing the daemon from
    // latching onto a stranger's Claude during a transient I/O hiccup).
    try {
      fs.readdirSync(liveSessionsRegistry.dirPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false; // dir not yet created => first daemon
      logError(
        `[Hooks] Could not enumerate live-sessions; assuming sibling present: ${errorToString(err)}`,
      );
      return true;
    }
    return liveSessionsRegistry.listLive().some(
      (e) =>
        e.projectPath === workingDirectory &&
        e.sessionId !== sessionId &&
        e.wsPort !== currentPort() &&
        // A daemon whose process is alive but whose Claude child has died
        // (a zombie) must not count as a sibling: it posts no hook events,
        // yet its lingering registry entry would otherwise permanently
        // defer our rotation handling (#451). Legacy entries with no
        // recorded child pid stay fail-safe "live".
        claudeChildLooksAlive(e),
    );
  };

  /**
   * Whether the transcript named by a hook event was written by OUR claude.
   * Each daemon spawns `claude -n remi:<wsPort>`, so the transcript head's
   * `custom-title` marker carries the owning port — content the owning daemon
   * caused Claude to write. When a genuine sibling shares the directory, this
   * is what lets us adopt our OWN rotation without latching onto the sibling's
   * (its transcript carries the sibling's port). Returns false when the marker
   * is absent (older Claude/remi, or a user-supplied `-n`), in which case the
   * caller falls back to the sibling-guard default.
   */
  const ownsTranscript = (transcriptPath: string | undefined): boolean =>
    typeof transcriptPath === 'string' && readTranscriptOwnerPort(transcriptPath) === currentPort();

  /**
   * Safely tear down an existing transcript watcher and reset message state.
   * Errors from stop() are swallowed so they never prevent the new watcher
   * from being created. Does NOT emit a wire message: a rotation is announced
   * by a single atomic `session_rotated` from the adopt path (#438), so the
   * client clears + rebinds + re-fetches in one step rather than reacting to a
   * separate reset. Shared by initFromHookEvent and onSessionInfo.
   */
  function teardownWatcher(label: string): void {
    const watcher = transcriptWatchers.get(sessionId);
    if (!watcher) return;
    transcriptWatchers.delete(sessionId); // Remove FIRST to unblock the new watcher.
    try {
      watcher.stop();
    } catch (stopErr) {
      logError(`[Hooks] Failed to stop watcher (${label}): ${errorToString(stopErr)}`);
    }
    messageApi.reset();
  }

  /**
   * Start the transcript watcher for our own session if one is not already
   * running. Self-heals the case where the lock was adopted from the store
   * (so first-init never ran) but no watcher exists because the fallback poll
   * gave up after its 30s window — common when Claude writes its first
   * transcript line late on an idle start (observed across many sessions:
   * "[Fallback] Timed out ..."). Only called for events whose session_id
   * matches our lock (classification 'match'), i.e. our own Claude's events,
   * whose transcript_path is therefore ours.
   */
  function ensureWatcher(transcriptPath: string | undefined): void {
    // Steady-state no-op: a watcher is already running. Checked first so a
    // healthy session never logs the "no path" warning below.
    if (transcriptWatchers.has(sessionId)) return;
    if (!sessionRegistry.hasSession(sessionId)) return;
    if (!transcriptPath) {
      // We need a watcher (none running) but this match event carried no path,
      // so we can't self-heal on it. Normally the next event supplies one; log
      // so a SYSTEMATIC absence (e.g. a changed hook payload) is visible rather
      // than an invisible locked-but-unwatched wedge.
      logError(
        `[Hooks] ensureWatcher: match event without transcript_path for ${sessionId.slice(0, 8)}; watcher still missing`,
      );
      return;
    }
    // We have the exact path now; cancel any lingering fallback poll.
    const fallbackTimer = transcriptFallbackTimers.get(sessionId);
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      transcriptFallbackTimers.delete(sessionId);
    }
    log(`[Hooks] Ensuring watcher (self-heal) for ${sessionId.slice(0, 8)}: ${transcriptPath}`);
    startTranscriptWatcher(
      { transcriptWatchers },
      sessionId,
      transcriptPath,
      messageApi,
      sendAndRecord,
    );
  }

  function initFromHookEvent(input: {
    session_id?: string;
    transcript_path?: string;
    hook_event_name?: string;
  }): void {
    if (!input.session_id) return;

    // Snapshot the closure BEFORE adoptLockFromStore mutates it.
    // adoptLockFromStore can race-pull the new id from sessionStore when
    // the transcript-fallback wrote it first; without this snapshot the
    // classifier sees the post-adopt value, returns 'match', and the
    // rotation event silently never emits (#430 review #433).
    const previousClaudeSessionId = claudeSessionId;
    let isRotation = false;
    let rotationAnnounced = false;

    // If the transcript-fallback has already discovered our Claude
    // session ID (the multi-wrapper-in-same-dir case), adopt it before
    // classifying so the classifier sees the right currentLock instead
    // of a stale null.
    adoptLockFromStore();

    // Detect rotation by comparing the pre-adopt snapshot against the
    // incoming id. We do this here (independent of classifySessionEvent)
    // so the rotation is observable even when adoptLockFromStore raced
    // ahead and the classifier returns 'match'.
    if (previousClaudeSessionId !== null && previousClaudeSessionId !== input.session_id) {
      isRotation = true;
    }

    const classification = classifySessionEvent({
      currentLock: claudeSessionId,
      incomingSessionId: input.session_id,
      mainPtyRunning: sessionRegistry.getSession(sessionId)?.pty.isRunning ?? false,
      mainSessionEnded,
    });

    if (classification === 'foreign') {
      // Subagent or sibling daemon event. Drop to avoid hijacking our lock.
      // Log so operators can observe misclassification.
      log(
        `[Hooks] Dropped foreign ${input.hook_event_name ?? 'event'}: lock=${claudeSessionId?.slice(0, 8)} incoming=${input.session_id.slice(0, 8)}`,
      );
      return;
    }
    if (classification === 'restart') {
      log(
        `[Hooks] Claude restart detected (ended=${mainSessionEnded}): ${claudeSessionId} -> ${input.session_id}`,
      );
      teardownWatcher('restart');
      // Drop any hook record stashed before /clear or /compact: the new
      // Claude session's first PTY prompt must not merge stale option
      // labels from the dying session. Also drop the pending-question
      // collection so answers to the dead session's prompts are refused.
      tracker.clearPending();
      sessionRegistry.clearQuestions(sessionId);
      // Announce the rotation NOW, before the sibling / no-transcript_path
      // guards below can early-return. teardownWatcher already reset the
      // client's view, so the client must learn of the rotation (clear +
      // rebind + re-fetch) even when we can't (re)start the watcher yet — the
      // sibling guard only defers WATCHER setup, not this notification. The
      // flag suppresses the duplicate emit in the adopt block.
      if (isRotation && input.transcript_path) {
        try {
          sendAndRecord(
            createSessionRotated(
              sessionId,
              input.session_id as UUID,
              input.transcript_path,
              'restart',
              previousClaudeSessionId ?? undefined,
            ),
          );
          rotationAnnounced = true;
        } catch (err) {
          logError(`[Hooks] Failed to emit session_rotated (restart): ${errorToString(err)}`);
        }
      }
      claudeSessionId = null;
      mainSessionEnded = false;
      // isRotation was already computed above against the pre-adopt
      // snapshot; restart is a stricter signal but does not override
      // a true value coming from the race-detector path.
    }
    // classification === 'match': either our tracked session or first-time lock.
    if (claudeSessionId) {
      // Lock already held (typically adopted from the store before first-init
      // ran). This event is from our own Claude (session_id matches our lock),
      // so its transcript_path is ours — make sure a watcher is running. Without
      // this, a session whose fallback poll timed out before Claude wrote its
      // transcript stays locked-but-unwatched: no live stream and
      // transcript_load returns NOT_FOUND.
      ensureWatcher(input.transcript_path);
      return;
    }
    if (!input.transcript_path) return;

    if (hasSiblingInDir() && !ownsTranscript(input.transcript_path)) {
      // A sibling shares the directory and the transcript's port marker does
      // not prove this event is ours — cannot trust which Claude sent it;
      // defer to the deterministic-path fallback. When the marker DOES match
      // our port (the common rotation case, #451) we fall through and adopt,
      // so an in-process rotation is not wedged by the sibling guard.
      return;
    }

    try {
      claudeSessionId = input.session_id;
      log(
        `[Hooks] Transcript from ${input.hook_event_name ?? 'hook'}: claude=${claudeSessionId}, transcript=${input.transcript_path}`,
      );
      sessionStore.updateClaudeSessionId(sessionId, claudeSessionId);

      // Announce the rotation as ONE atomic event so the client clears, swaps
      // the binding, and re-fetches the new transcript in a single step (#438).
      // Skip on first-init (not a rotation): that's covered by
      // session_list_response / the queue-promotion hello_ack. Also skip if the
      // restart branch already announced it (the common path); this covers the
      // race-detector case where isRotation is true without a 'restart'
      // classification (adoptLockFromStore got ahead of us).
      if (isRotation && !rotationAnnounced) {
        try {
          sendAndRecord(
            createSessionRotated(
              sessionId,
              claudeSessionId as UUID,
              input.transcript_path,
              'restart',
              previousClaudeSessionId ?? undefined,
            ),
          );
        } catch (err) {
          logError(`[Hooks] Failed to emit session_rotated: ${errorToString(err)}`);
        }
      }

      // Cancel the fallback timer since we have the exact path.
      const fallbackTimer = transcriptFallbackTimers.get(sessionId);
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        transcriptFallbackTimers.delete(sessionId);
      }

      // If a fallback watcher claimed the slot with a different (stale) file,
      // replace it with the authoritative hook-provided path.
      const existingWatcher = transcriptWatchers.get(sessionId);
      if (
        existingWatcher &&
        path.resolve(existingWatcher.filePath) !== path.resolve(input.transcript_path)
      ) {
        log(
          `[Hooks] Replacing stale watcher: ${existingWatcher.filePath} -> ${input.transcript_path}`,
        );
        teardownWatcher('stale-replace');
      }

      if (!transcriptWatchers.has(sessionId) && sessionRegistry.hasSession(sessionId)) {
        startTranscriptWatcher(
          { transcriptWatchers },
          sessionId,
          input.transcript_path,
          messageApi,
          sendAndRecord,
        );
      }
    } catch (err) {
      logError(`[Hooks] initFromHookEvent failed for session ${sessionId}: ${errorToString(err)}`);
      claudeSessionId = null; // Reset so fallback can take over.
    }
  }

  // ---- Bridge + hook handler registration ---------------------------------

  const hookBridge = new HookEventBridge(sessionId, {
    onStatusChange: (status: AgentStatus, context?: string) => {
      messageApi.handleStatusChange(status, context);
      tracker.onStatusChange(status);
    },
    onQuestion: (question) => {
      tracker.recordPendingHook(question);
    },
    onSessionInfo: (hookClaudeSessionId: string, transcriptPath: string) => {
      // Guard: skip if sibling daemons share this directory AND the transcript's
      // port marker does not prove this SessionStart is ours (#451). When the
      // marker matches our port we proceed so our own rotation rebinds even
      // with a genuine sibling co-located.
      if (hasSiblingInDir() && !ownsTranscript(transcriptPath)) return;

      // Use the same classifier as initFromHookEvent so both paths share
      // one rule for distinguishing foreign (subagent/sibling) from restart.
      const classification = classifySessionEvent({
        currentLock: claudeSessionId,
        incomingSessionId: hookClaudeSessionId,
        mainPtyRunning: sessionRegistry.getSession(sessionId)?.pty.isRunning ?? false,
        mainSessionEnded,
      });
      if (classification === 'foreign') {
        log(
          `[Hooks] Dropped foreign SessionInfo: lock=${claudeSessionId?.slice(0, 8)} incoming=${hookClaudeSessionId.slice(0, 8)}`,
        );
        return;
      }
      const previousClaudeSessionId = claudeSessionId;
      let isRotation = false;
      if (classification === 'restart') {
        log(
          `[Hooks] Claude restart (SessionInfo, ended=${mainSessionEnded}): ${claudeSessionId} -> ${hookClaudeSessionId}`,
        );
        teardownWatcher('restart-sessioninfo');
        // Mirror the initFromHookEvent restart branch: drop any hook
        // record and the pending-question collection so the new session's
        // first PTY prompt cannot merge stale options, and stale answers
        // are refused.
        tracker.clearPending();
        sessionRegistry.clearQuestions(sessionId);
        claudeSessionId = null;
        mainSessionEnded = false;
        isRotation = previousClaudeSessionId !== null;
      }

      try {
        claudeSessionId = hookClaudeSessionId;
        log(`[Hooks] SessionStart: claude=${hookClaudeSessionId}, transcript=${transcriptPath}`);
        sessionStore.updateClaudeSessionId(sessionId, hookClaudeSessionId);

        if (isRotation) {
          try {
            sendAndRecord(
              createSessionRotated(
                sessionId,
                hookClaudeSessionId as UUID,
                transcriptPath,
                'restart',
                previousClaudeSessionId ?? undefined,
              ),
            );
          } catch (err) {
            logError(`[Hooks] Failed to emit session_rotated (SessionInfo): ${errorToString(err)}`);
          }
        }

        const existingWatcher = transcriptWatchers.get(sessionId);
        if (
          existingWatcher &&
          path.resolve(existingWatcher.filePath) !== path.resolve(transcriptPath)
        ) {
          log(
            `[Hooks] Replacing stale watcher (SessionInfo): ${existingWatcher.filePath} -> ${transcriptPath}`,
          );
          teardownWatcher('stale-replace-sessioninfo');
        }

        if (!transcriptWatchers.has(sessionId) && sessionRegistry.hasSession(sessionId)) {
          startTranscriptWatcher(
            { transcriptWatchers },
            sessionId,
            transcriptPath,
            messageApi,
            sendAndRecord,
          );
        }
      } catch (err) {
        logError(`[Hooks] onSessionInfo failed for ${sessionId}: ${errorToString(err)}`);
        claudeSessionId = null;
      }
    },
  });

  const handlers = hookBridge.hookHandlers();

  // Filter: accept events only from our own Claude. Before claudeSessionId
  // is known, block events when siblings exist (they could be from the
  // sibling's Claude).
  const filterBySession = (input: { session_id?: string }): boolean => {
    adoptLockFromStore();
    if (claudeSessionId) return input.session_id === claudeSessionId;
    return !hasSiblingInDir();
  };

  // Subagent/team-member events carry `agent_id` (confirmed via
  // REMI_HOOK_DEBUG capture 2026-04-16). They share main's session_id and
  // transcript, so session-id filtering cannot distinguish them.
  //
  // Split policy:
  //   - `PreToolUse` / `PostToolUse` / `SessionStart`: dropped here so
  //     status updates and Task-tool tracking stay scoped to the main
  //     interactive session.
  //   - `PermissionRequest` / `Notification(permission_prompt)`: forwarded
  //     (phase 4, #419). Push is gated by PTY presence in the tracker,
  //     not by agent_id. A hot-switched subagent view that renders a
  //     permission prompt IS user-answerable; dropping the hook loses
  //     the rich tool/option metadata for that case.
  const isSubagentEvent = (input: { agent_id?: string }): boolean =>
    typeof input.agent_id === 'string' && input.agent_id.length > 0;

  hookServer.on('SessionStart', (input) => {
    // Pre-empt the classifier into 'restart' on any session_id rotation while
    // our PTY is alive, regardless of `source` (Claude Code rotates session_id
    // through flows that omit source or carry undocumented values; the narrow
    // source-allowlist that used to gate this would wedge the lock).
    // isSubagentEvent guard mirrors the pattern used by other hookServer
    // handlers: subagents share the main session_id today, but if a future
    // version ever fires SessionStart with agent_id set and a different
    // session_id, we must not tear down main's watcher.
    if (
      !isSubagentEvent(input) &&
      claudeSessionId &&
      input.session_id &&
      input.session_id !== claudeSessionId &&
      // Only treat this as OUR lifecycle transition when there is no genuine
      // sibling, or the new transcript's port marker proves it is ours (#451).
      // Otherwise a sibling's SessionStart, fanned out via the shared
      // settings.local.json hook URLs, would wrongly flip mainSessionEnded and
      // make us tear down our own (still-live) session.
      (!hasSiblingInDir() || ownsTranscript(input.transcript_path))
    ) {
      log(
        `[Hooks] Main lifecycle transition (source=${input.source ?? 'unknown'}): ${claudeSessionId} -> ${input.session_id}`,
      );
      mainSessionEnded = true; // classifier will pick this up as 'restart'
    }
    initFromHookEvent(input);
    handlers.onSessionStart?.(input);
  });

  hookServer.on('PreToolUse', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    if (isSubagentEvent(input)) return;
    cancelStaleAutoApprove('PreToolUse');
    handlers.onPreToolUse?.(input);
  });
  hookServer.on('PostToolUse', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    if (isSubagentEvent(input)) return;
    cancelStaleAutoApprove('PostToolUse');
    handlers.onPostToolUse?.(input);
  });
  hookServer.on('Notification', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    // SessionEnd already cleared status to 'idle'; a late
    // Notification(permission_prompt) for the dying session would
    // re-populate tracker.pending and a final PTY echo could fire a
    // spurious push the user cannot answer. Gate at the listener
    // boundary; restart resets mainSessionEnded so legitimate
    // post-restart notifications still pass.
    if (mainSessionEnded) {
      log(`[Hooks] Dropped post-SessionEnd Notification: type=${input.notification_type}`);
      return;
    }
    // Phase 4 (#419): subagent notifications previously dropped here
    // based on agent_id presence. Now we forward; QuestionPresenceTracker
    // gates the push by PTY presence. A hot-switched subagent view that
    // renders a permission prompt on the user's PTY produces a push;
    // a background subagent does not (PTY never confirms presence).
    handlers.onNotification?.(input);
  });
  hookServer.on('PermissionRequest', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;

    // Phase 4 (#419): subagent PermissionRequest events (events with
    // agent_id set, originating from Task/Agent-spawned subagents) used
    // to be dropped at this seam. Under phase 3's PTY-presence model,
    // "what's on screen" is the truth: a hot-switched subagent view
    // that renders a permission prompt IS user-answerable, and dropping
    // the hook here loses the rich tool/option metadata. Forward the
    // event; the tracker pairs it with PTY confirmation. Auto-approve
    // and the inSubagent default-deny safety net below still gate
    // injection independently.
    if (isSubagentEvent(input)) {
      log(
        `[Hooks] Subagent PermissionRequest forwarded: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
    }

    // Nested-Task context (secondary safety net for cases where
    // agent_id is absent). Used by the auto-approve default-deny path
    // below to avoid hanging a subagent whose only escalation route is
    // a main-PTY prompt the user cannot see.
    //
    // Read live (not captured) at each branch: auto-approve evaluate()
    // is async, so the Task context can open or close between when this
    // listener fires and when the .then()/.catch() runs. Capturing
    // would TOCTOU — a Task that closed mid-eval would still trigger
    // default-deny, and a Task that opened mid-eval would escape it.
    const sessionTag = sessionId.slice(0, 8);

    // Inject an answer into the PTY. Returns true on success. On failure
    // (session missing, PTY not running, submitInput throws, subagent
    // off-screen gate trips) it logs and returns false so callers can
    // fall back to escalating the prompt.
    //
    // Value is a 1-based numeric option index serialised as a string. Most
    // permissions only need '1' (approve) or '3' (deny); multi-choice picks
    // can land any index in the prompt's option range (#399).
    //
    // PTY-presence gate (subagent-only): a background subagent emits
    // PermissionRequest hooks for its own tool calls, but its prompts
    // never render on the main PTY — only a hot-switched subagent view
    // does. Without this gate, auto-approve would type "1"/"3" into the
    // MAIN AGENT's input every time a background subagent asked for
    // permission.
    //
    // Detect subagent context two ways: (a) explicit `agent_id` on the
    // hook event (Task tool with agent_id set), and (b)
    // `hookBridge.isInSubagentContext()` (nested-Task tracker — the
    // secondary safety net for legacy events without agent_id). Both
    // are read at inject time, not captured, so the hot-switched case
    // (PTY has rendered the subagent prompt between the hook firing
    // and the LLM eval returning) still injects.
    //
    // Asymmetry: the default-deny path (subagent-escalate / subagent-
    // error) passes `bypassSubagentPtyGate=true` to keep firing even
    // without PTY confirmation, because the alternative is hanging the
    // subagent indefinitely with no one to answer. That is a
    // deliberately-different trade-off from the approve/deny/pick path,
    // which falls through to escalateToUser when gated.
    const inject = async (
      value: string,
      reason: string,
      bypassSubagentPtyGate = false,
    ): Promise<boolean> => {
      try {
        const session = sessionRegistry.getSession(sessionId);
        if (!session) {
          logError(`[AutoApprove ${sessionTag}] Session not found; cannot inject "${value}"`);
          return false;
        }
        const inSubagentContext = isSubagentEvent(input) || hookBridge.isInSubagentContext();
        if (!bypassSubagentPtyGate && inSubagentContext && !tracker.isPromptVisibleOnPTY()) {
          log(
            `[AutoApprove ${sessionTag}] Subagent ${input.tool_name}: skipping inject "${value}" (${reason}); no prompt visible on main PTY (agent=${input.agent_id?.slice(0, 8) ?? 'nested'} type=${input.agent_type ?? 'n/a'})`,
          );
          return false;
        }
        await session.pty.submitInput(value);
        log(`[AutoApprove ${sessionTag}] Injected "${value}" into PTY (${reason})`);
        sessionRegistry.updateStatus(sessionId, value === '1' ? 'executing' : 'thinking');
        return true;
      } catch (err) {
        logError(`[AutoApprove ${sessionTag}] inject("${value}") threw:`, err);
        return false;
      }
    };

    // Safe escalation to the user. Used when inject fails or when auto-approve
    // is off and we're in main context. Wrapped so bridge/push failures don't
    // leave the hook handler with a dangling unhandled rejection.
    const escalateToUser = () => {
      try {
        handlers.onPermissionRequest?.(input);
      } catch (err) {
        logError(`[AutoApprove ${sessionTag}] escalateToUser threw:`, err);
      }
    };

    // Auto-approve gate: evaluate before creating a Question object.
    if (autoApproveService) {
      const aaService = autoApproveService;
      // Pass the raw suggestions array; AutoApproveService does its own
      // strict-string filtering before feeding the LLM. We forward the
      // raw shape (rather than coercing) so the multi-choice classifier
      // can see "non-string entry" and route through escalate instead
      // of crashing on a future Claude Code permission_suggestions
      // schema change.
      aaService
        .evaluate(
          input.tool_name,
          input.tool_input,
          sessionTag,
          input.permission_suggestions as readonly unknown[] | undefined,
        )
        .then(async (result) => {
          if (result.decision === 'cancelled') {
            // User already advanced past the prompt (terminal answer or
            // hook event confirmed the tool ran). Do not inject, do not
            // escalate. Drop the pending hook record so its stale option
            // labels cannot merge onto the next unrelated PTY prompt
            // (e.g. user typed /compact, no PreToolUse fires).
            tracker.clearPending();
            log(`[AutoApprove ${sessionTag}] Decision dropped: ${result.reasoning}`);
            return;
          }
          if (result.decision === 'approve') {
            if (!(await inject('1', 'approved'))) escalateToUser();
            return;
          }
          if (result.decision === 'deny') {
            if (!(await inject('3', 'denied'))) escalateToUser();
            return;
          }
          if (result.decision === 'pick' && result.pickIndex !== undefined) {
            // Multi-choice pick (#399): inject the 1-based index Claude Code
            // expects on the terminal. parseMultiChoiceDecision already
            // validated the index against options length, so out-of-range
            // values cannot reach this branch.
            if (!(await inject(String(result.pickIndex), `multichoice-pick-${result.pickIndex}`))) {
              escalateToUser();
            }
            return;
          }
          // escalate: in a subagent context, default-deny to avoid hanging
          // the subagent. The user could not answer it anyway. Bypass the
          // subagent PTY gate (`bypassSubagentPtyGate=true`) because the
          // alternative is letting the subagent hang forever; typing '3'
          // into the parent PTY is accepted as the lesser evil here. The
          // approve/deny/pick branches above use the gate because they
          // have a fallback (escalateToUser); this branch does not.
          if (hookBridge.isInSubagentContext()) {
            log(`[AutoApprove ${sessionTag}] Subagent context; escalate->deny to prevent hang`);
            await inject('3', 'subagent-escalate-default-deny', true);
            return;
          }
          escalateToUser();
        })
        .catch(async (err) => {
          // Last line of defense; must not leave an unhandled rejection.
          try {
            logError(`[AutoApprove ${sessionTag}] Unexpected error:`, err);
            if (hookBridge.isInSubagentContext()) {
              await inject('3', 'subagent-error-default-deny', true);
              return;
            }
            escalateToUser();
          } catch (inner) {
            logError(`[AutoApprove ${sessionTag}] catch handler threw:`, inner);
          }
        });
      return;
    }

    // No auto-approve. In a subagent context, still must not hang the
    // subagent: default-deny rather than emit a question the user can't
    // answer. Synchronous fallback — read live for symmetry with the
    // async branches above; no TOCTOU here but the consistent shape
    // helps a future maintainer.
    if (hookBridge.isInSubagentContext()) {
      log(`[${sessionTag}] Subagent context without auto-approve; default-deny`);
      inject('3', 'subagent-no-aa-default-deny', true).catch((err) => {
        logError(`[${sessionTag}] Failed to inject default-deny:`, err);
      });
      return;
    }

    escalateToUser();
  });
  hookServer.on('Stop', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    cancelStaleAutoApprove('Stop');
    handlers.onStop?.(input);
  });
  hookServer.on('SessionEnd', (input) => {
    // Only mark our main as ended when the session_id matches what we locked.
    // Foreign SessionEnds (subagents, siblings) must not unlock our tracking.
    if (input.session_id && claudeSessionId && input.session_id === claudeSessionId) {
      mainSessionEnded = true;
    }
    if (!filterBySession(input)) return;
    cancelStaleAutoApprove('SessionEnd');
    handlers.onSessionEnd?.(input);
  });

  log(`[Hooks] Event bridge active for session ${sessionId}`);

  return { bridge: hookBridge };
}
