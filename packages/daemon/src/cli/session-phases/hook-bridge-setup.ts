/**
 * Wire the Claude Code hook event stream into our PTY's MessageAPI during
 * createNewSession.
 *
 * Two concerns live here, both depending on the same per-session locks
 * (claudeSessionId, mainSessionEnded, hasSiblingInDir()):
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
 * A third concern, the **auto-approve gate**, used to be inlined here; it is now
 * delegated to `AutoApproveGate` (#453 phase 1). The bridge does the session
 * filtering, then routes PermissionRequest to the gate, which runs the
 * auto-approve eval and injects "1"/"3"/pick into the PTY, escalates to the user,
 * or default-denies a subagent prompt no one can answer. The gate is wired with
 * the bridge's `isInSubagentContext` + the router's `onPermissionRequest` as
 * callbacks; Pre/PostToolUse/Stop/SessionEnd call `gate.cancelStale()` to abort a
 * stale in-flight eval once Claude has advanced past the prompt.
 *
 * This listener block IS the per-session hook router (admit-then-fan-out); a
 * formal HookRouter class is deferred until the shadow/drive dual path is
 * deleted (the `driveBinder ? … : oldPath` ternaries collapse first). The
 * function registers 11 hookServer listeners — the original 7 (SessionStart,
 * PreToolUse, PostToolUse, Notification, PermissionRequest, Stop, SessionEnd)
 * plus the 4 wired in phase 4 (StopFailure, PostToolUseFailure, SubagentStart,
 * SubagentStop) — and returns void. It runs once per session at
 * createNewSession time, only when a hookServer is configured.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSessionRotated, createSessionViews, errorToString } from '@remi/shared';
import type { AgentStatus, ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../../api/message-api.ts';
import type { QuestionPresenceTracker } from '../../api/question-presence-tracker.ts';
import type { SubagentViewRegistry } from '../../api/subagent-view-registry.ts';
import { AutoApproveGate } from '../../auto-approve/index.ts';
import type { AutoApproveService } from '../../auto-approve/index.ts';
import { HookEventBridge } from '../../hooks/index.ts';
import type { HookServer } from '../../hooks/index.ts';
import { classifySessionEvent } from '../../hooks/session-lock-classifier.ts';
import { claudeChildLooksAlive } from '../../session/index.ts';
import type {
  SessionBindingStore,
  SessionRegistry,
  SessionRegistryFile,
} from '../../session/index.ts';
import { TranscriptBinder, readTranscriptOwnerPort } from '../../transcript/index.ts';
import type { BinderDecision, BinderHookEvent } from '../../transcript/index.ts';
import type { TranscriptWatcher } from '../../transcript/index.ts';
import type { TranscriptDiscovery } from '../../transcript/transcript-discovery.ts';
import { log, logError } from '../logger.ts';
import type { TerminalIndicator } from '../terminal-indicator.ts';
import { startTranscriptWatcher } from '../transcript-watcher-setup.ts';

export interface HookBridgeDeps {
  sessionRegistry: SessionRegistry;
  bindingStore: SessionBindingStore;
  liveSessionsRegistry: SessionRegistryFile;
  transcriptWatchers: Map<UUID, TranscriptWatcher>;
  transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  autoApproveService: AutoApproveService | null;
  /** PORT is reassigned during daemon-mode port probing; read lazily. */
  currentPort: () => number;
  /**
   * #453 phase 3, commit 3 (SHADOW MODE). When true, a compute-only
   * `TranscriptBinder` runs alongside the old initFromHookEvent/onSessionInfo
   * path and logs control-plane disagreements. It is constructed with no-op
   * effect deps (no send, no store write, no watcher start, no rotation
   * callback) so it is PROVABLY side-effect-free; the old path stays the sole
   * driver. Default OFF (undefined) — zero behavior change when unset.
   */
  shadowBinder?: boolean;
  /**
   * #453 phase 3, commit 5 (DRIVE MODE). When true, a single drive-mode
   * `TranscriptBinder` per session OWNS the binding/watcher/rotation control
   * plane: each hook listener routes to `binder.onHookEvent` /
   * `binder.admits` / `binder.preemptOnSessionStart` / `binder.onSessionEnd`
   * INSTEAD of the old `initFromHookEvent` / `onSessionInfo` / `filterBySession`
   * bodies, and `binder.start()` arms the fallback poll + #452 dir-watch. The
   * binder's decisions are already proven equivalent to the old path by the
   * shadow differential harness (commit 3); this flag lets it DRIVE. Mutually
   * exclusive with `shadowBinder` (enabled wins; the caller never sets both).
   * Default OFF (undefined) — flag-off path is byte-identical to pre-commit.
   * Requires `transcriptDiscovery` (the binder's `start()` reads it).
   */
  binderEnabled?: boolean;
  /**
   * Required by the `TranscriptBinder` constructor (its `start()` reads it).
   * Shadow never calls `start()`, but drive mode does; the dep is part of the
   * binder's construction contract. Optional so callers/tests that use neither
   * binder mode are unaffected.
   */
  transcriptDiscovery?: TranscriptDiscovery;
  /**
   * Tracks the subagent conversations this session spawns (epic #499 phase 3).
   * Populated from SubagentStart/Stop; a `session_views` push tells the client
   * which subagent chats it can switch to. Optional so tests/old callers are
   * unaffected.
   */
  subagentViews?: SubagentViewRegistry;
  /**
   * Process-wide terminal cue (#513): animates the wrapper terminal title and
   * fires a desktop notification across the auto-approve lifecycle. Shared by
   * all sessions (one terminal). Optional; inert when absent or headless.
   */
  terminalIndicator?: TerminalIndicator | undefined;
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
  /**
   * Tear down the drive-mode `TranscriptBinder` for this session (its watcher,
   * fallback timer, and the #452 rotation dir-poll). No-op when binderEnabled is
   * off (no binder was constructed). The caller must invoke this on session
   * teardown so the binder's rotation dir-poll interval — which the shared
   * `transcriptWatchers` / `transcriptFallbackTimers` cleanup in cli.ts does NOT
   * reach — never outlives the session.
   */
  closeBinder: () => void;
}

export function setupHookBridge(
  deps: Readonly<HookBridgeDeps>,
  args: Readonly<HookBridgeArgs>,
): HookBridgeHandle {
  const {
    sessionRegistry,
    bindingStore,
    liveSessionsRegistry,
    transcriptWatchers,
    transcriptFallbackTimers,
    autoApproveService,
    currentPort,
    shadowBinder,
    binderEnabled,
    transcriptDiscovery,
    subagentViews,
  } = deps;
  const {
    hookServer,
    sessionId,
    workingDirectory,
    messageApi,
    sendAndRecord: rawSendAndRecord,
    tracker,
  } = args;

  // ---- Shadow-mode plumbing (#453 phase 3, commit 3) ----------------------
  // When shadowBinder is OFF (the default), `sendAndRecord` and the binding
  // writer below are the untouched originals: ZERO behavior change. When ON,
  // sendAndRecord is wrapped in a forwarding tap that records (per old-path
  // event) whether a session_rotated crossed the wire, then forwards EVERY
  // message untouched. The tap never alters or drops a message.
  let oldPathRotationEmitted = false;
  const sendAndRecord = shadowBinder
    ? (message: ProtocolMessage): void => {
        if (message.type === 'session_rotated') oldPathRotationEmitted = true;
        rawSendAndRecord(message);
      }
    : rawSendAndRecord;

  // Push the session's subagent views to clients (epic #499 phase 3). Declared
  // here (before the binder/handlers reference it) so there is no fragile
  // forward-reference. The SessionViewMeta omits the on-disk path: the client
  // echoes agentId back and the daemon resolves the path via the registry.
  const pushSubagentViews = (): void => {
    if (!subagentViews) return;
    sendAndRecord(
      createSessionViews(
        sessionId,
        subagentViews.list().map((v) => ({
          agentId: v.agentId,
          agentType: v.agentType,
          active: v.active,
        })),
      ),
    );
  };

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
      // Disk-backed read (no cache) via the binding accessor: a sibling/fallback
      // write is observed every call, which is what preserves the #430 re-adopt
      // and #321 no-wedge guarantees.
      const storedId = bindingStore.get(sessionId)?.claudeSessionId ?? null;
      if (storedId === null || storedId === claudeSessionId) return;
      const previous = claudeSessionId;
      claudeSessionId = storedId;
      log(
        `[Hooks] Lock ${previous === null ? 'adopted' : 'updated'} from binding store: claude=${storedId.slice(0, 8)}${previous ? ` (was ${previous.slice(0, 8)})` : ''}`,
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
      bindingStore.update(sessionId, claudeSessionId);

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
      // DRIVE: the binder's onHookEvent (fired from the SessionStart listener)
      // already subsumes this SessionInfo bind/rotation; skip the old body so we
      // never double-bind or double-emit. The bridge still fires this callback
      // (status/subagent tracking lives on handlers.onSessionStart), but the
      // binding control plane is the binder's alone.
      if (binderEnabled) return;
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
        bindingStore.update(sessionId, hookClaudeSessionId);

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

  // Auto-approve control plane (#453 phase 1): owns the PermissionRequest eval +
  // inject + escalate + cancelStale. Constructed after the bridge + handlers so it
  // can wrap the two outward couplings (isInSubagentContext, onPermissionRequest) as
  // injected callbacks, read live at inject time (async TOCTOU).
  const autoApproveGate = new AutoApproveGate(
    {
      service: autoApproveService,
      sessionRegistry,
      tracker,
      isInSubagentContext: () => hookBridge.isInSubagentContext(),
      escalate: (i) => handlers.onPermissionRequest?.(i),
      // #484: buffer the PTY prompt while the eval runs; release it only on an
      // escalate verdict, so silently auto-approved permissions never push APNS.
      // #513: the same lifecycle drives the terminal cue (spinner -> done / needs-you).
      onEvalStart: () => {
        tracker.onAutoApproveStart();
        deps.terminalIndicator?.start();
      },
      onEscalate: () => {
        tracker.onAutoApproveEscalate();
        deps.terminalIndicator?.resolve('escalate');
      },
      onHandled: () => deps.terminalIndicator?.resolve('handled'),
      onCancelled: () => deps.terminalIndicator?.stop(),
    },
    sessionId,
  );

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

  // ---- Shadow TranscriptBinder (#453 phase 3, commit 3) -------------------
  //
  // ONE compute-only binder per session, constructed only when shadowBinder is
  // on. It is provably side-effect-free:
  //   - `sendAndRecord: () => {}`  -> cannot emit (no session_rotated on the wire).
  //   - `bindingStore` wrapped read-only: `update()` is a no-op; `get(ourSession)`
  //     returns the PER-EVENT snapshot (the store as it stood before the old path
  //     ran) so the old path's same-event write cannot leak into the shadow's
  //     adoptLockFromStore and race the classifier; foreign ids delegate through.
  //   - `messageApi` no-op: `reset()` does nothing (the binder calls it on teardown).
  //   - `onRotation: () => {}` -> no presence-tracker / question side effects.
  //   - `start()` is a no-op in 'shadow' mode (no fs.watch, no fallback timer),
  //     and we never call it anyway.
  //
  // After each old-path listener body runs, the same input is fed to the shadow
  // binder mirroring the old listener order (preemptOnSessionStart + decide for
  // SessionStart; decide for the events that call initFromHookEvent; onSessionEnd
  // for SessionEnd), then we compare the binder's decision against the old path's
  // observable outcome captured live from state.

  // The real store's binding for OUR session as it stood at the START of the
  // current event (captured before the old path runs). The shadow reads THIS,
  // not the live store, so the old path's same-event write does not leak into
  // the shadow's adoptLockFromStore and race the classifier into 'match' when
  // the old path saw 'restart' (the #430/#433 snapshot invariant). For other
  // sessions the wrapper delegates straight through (the binder only ever reads
  // its own sessionId via get(), so this is exact).
  let oldPathStoreSnapshot: ReturnType<SessionBindingStore['get']> = null;

  const shadow: TranscriptBinder | null =
    shadowBinder && transcriptDiscovery
      ? new TranscriptBinder(
          {
            sessionRegistry,
            // Read-only wrapper: get() delegates to the real store but, for our
            // own session, returns the per-event entry snapshot taken before the
            // old path mutated it (so the shadow adopts the same value the old
            // path's adoptLockFromStore saw, not the old path's just-written id).
            // update() is a no-op — the shadow must never write the binding.
            bindingStore: {
              get: (id: UUID) => (id === sessionId ? oldPathStoreSnapshot : bindingStore.get(id)),
              getByClaudeSessionId: (id: string) => bindingStore.getByClaudeSessionId(id),
              update: () => {},
              preAssign: () => {},
            } as unknown as SessionBindingStore,
            liveSessionsRegistry,
            transcriptWatchers,
            transcriptFallbackTimers,
            transcriptDiscovery,
            // No-op MessageAPI: only reset() is reachable from the binder, and it
            // must do nothing in shadow.
            messageApi: { reset: () => {} } as unknown as MessageAPI,
            sendAndRecord: () => {},
            currentPort,
            onRotation: () => {},
          },
          { sessionId, workingDirectory },
          'shadow',
        )
      : null;

  if (shadowBinder && !transcriptDiscovery) {
    logError(
      `[ShadowBinder] shadowBinder=true but no transcriptDiscovery dep supplied for ${sessionId.slice(0, 8)}; shadow comparison disabled`,
    );
  }

  // ---- Drive TranscriptBinder (#453 phase 3, commit 5) --------------------
  //
  // ONE drive-mode binder per session, constructed only when binderEnabled is on
  // (mutually exclusive with shadowBinder; the caller never sets both). It OWNS
  // the binding/watcher/rotation control plane: the hook listeners below route to
  // its `onHookEvent` / `admits` / `preemptOnSessionStart` / `onSessionEnd`
  // INSTEAD of the old `initFromHookEvent` / `onSessionInfo` / `filterBySession`
  // bodies. Wired with the REAL effect deps (the same `sendAndRecord`,
  // `bindingStore`, `messageApi` the old path used) and the REAL rotation side
  // effect (clear the presence tracker's pending record + sessionRegistry
  // questions, exactly the old restart branch's
  // `tracker.clearPending(); sessionRegistry.clearQuestions(sessionId)`).
  //
  // `start()` arms BOTH the existing fallback poll (Case A: our pre-assigned file
  // appears) AND the #452 re-arming dir-watch (Case B: a no-hooks rotation), so
  // in drive mode the cli.ts-level `startTranscriptFallback` is NOT also called
  // (the caller skips it to avoid double-arming). The pre-assigned claudeSessionId
  // is the binding cli.ts wrote to the store before spawn (#427); read it here.
  const driveBinder: TranscriptBinder | null =
    binderEnabled && transcriptDiscovery
      ? new TranscriptBinder(
          {
            sessionRegistry,
            bindingStore,
            liveSessionsRegistry,
            transcriptWatchers,
            transcriptFallbackTimers,
            transcriptDiscovery,
            messageApi,
            sendAndRecord: rawSendAndRecord,
            currentPort,
            onRotation: () => {
              // The old restart branch's injected side effects: drop any hook
              // record stashed before the rotation so the new session's first
              // PTY prompt cannot merge stale option labels, and drop the
              // pending-question collection so stale answers are refused.
              tracker.clearPending();
              sessionRegistry.clearQuestions(sessionId);
              // The new session starts with no subagents (#499 phase 3).
              if (subagentViews) {
                subagentViews.clear();
                pushSubagentViews();
              }
            },
          },
          { sessionId, workingDirectory },
          'drive',
        )
      : null;

  if (binderEnabled && !transcriptDiscovery) {
    logError(
      `[Binder] binderEnabled=true but no transcriptDiscovery dep supplied for ${sessionId.slice(0, 8)}; drive mode disabled`,
    );
  }

  if (driveBinder) {
    // Arm the fallback poll + #452 dir-watch on the pre-assigned id (the binding
    // cli.ts wrote to the store before Bun.spawn). On a fresh store read this is
    // the deterministic claude id Claude will write under.
    const preAssignedClaudeId = bindingStore.get(sessionId)?.claudeSessionId ?? null;
    if (preAssignedClaudeId) {
      driveBinder.start(preAssignedClaudeId);
    } else {
      logError(
        `[Binder] No pre-assigned claudeSessionId for ${sessionId.slice(0, 8)}; fallback poll + dir-watch not armed`,
      );
    }
  }

  /**
   * Capture the old path's observable control-plane outcome from LIVE state,
   * read right after the old-path listener body ran. `boundId` is a disk-fresh
   * read of the binding the old path may have written; `watcherPath` is the
   * path of the watcher the old path may have (re)started; `rotationEmitted` is
   * the per-event flag set by the sendAndRecord tap above.
   */
  const observeOldState = (): {
    boundId: string | null;
    watcherPath: string | null;
    rotationEmitted: boolean;
  } => ({
    boundId: bindingStore.get(sessionId)?.claudeSessionId ?? null,
    watcherPath: transcriptWatchers.get(sessionId)?.filePath ?? null,
    rotationEmitted: oldPathRotationEmitted,
  });

  /**
   * Emit a single structured DISAGREE line ONLY when the binder's decision and
   * the old path's observed outcome diverge on a LOAD-BEARING control-plane
   * field: the DURABLE store binding after the event, or whether a rotation was
   * emitted. watcherPath is compared path-normalized but is advisory (the binder
   * reports intent, the old path reports the live watcher). Silent on agreement.
   *
   * The compared "bound id" is the DURABLE store binding, not the binder's
   * in-memory lock. The two diverge intentionally on a path-less restart: the
   * old path NULLs its in-closure lock but does NOT write the store (no path to
   * rebind on), so the store keeps the prior id; the binder likewise drops its
   * in-memory `currentBoundId` to null WITHOUT writing the store. So the binder's
   * store-after = `boundIdAfter` when it (re)bound this event, else the prior
   * snapshot (it wrote nothing). That reconstruction matches the old path's
   * post-event store exactly — which is the #430/#433 invariant we are pinning.
   */
  const compareAndLog = (
    eventName: string,
    input: BinderHookEvent,
    decision: BinderDecision,
    old: { boundId: string | null; watcherPath: string | null; rotationEmitted: boolean },
  ): void => {
    const diffs: string[] = [];
    // The binder writes the store only when it (re)binds (boundIdAfter non-null);
    // otherwise it leaves the durable binding untouched at its pre-event value.
    const binderStoreAfter = decision.boundIdAfter ?? oldPathStoreSnapshot?.claudeSessionId ?? null;
    if (binderStoreAfter !== old.boundId) {
      diffs.push(`boundId binder=${binderStoreAfter ?? 'null'} old=${old.boundId ?? 'null'}`);
    }
    if (decision.wouldEmitRotation !== old.rotationEmitted) {
      diffs.push(`rotation binder=${decision.wouldEmitRotation} old=${old.rotationEmitted}`);
    }
    const binderWatcher = decision.watcherPath ? path.resolve(decision.watcherPath) : null;
    const oldWatcher = old.watcherPath ? path.resolve(old.watcherPath) : null;
    if (decision.wouldStartWatcher && binderWatcher !== oldWatcher) {
      diffs.push(`watcherPath binder=${binderWatcher ?? 'null'} old=${oldWatcher ?? 'null'}`);
    }
    if (diffs.length > 0) {
      logError(
        `[ShadowBinder] DISAGREE ${eventName}: ${diffs.join('; ')} (class=${decision.classification} incoming=${input.session_id?.slice(0, 8) ?? 'none'})`,
      );
    }
  };

  /**
   * Run at the TOP of every listener (before the old path executes). Resets the
   * per-event rotation tap and snapshots the real store's current binding for
   * our session so the shadow's read reflects the pre-event truth. No-op when
   * shadow is off.
   */
  const shadowEnterEvent = (): void => {
    if (!shadow) return;
    oldPathRotationEmitted = false;
    oldPathStoreSnapshot = bindingStore.get(sessionId);
  };

  /**
   * Feed an event that went through the `initFromHookEvent` old path to the
   * shadow binder via `decide()`, then compare. `shadowEnterEvent` must have run
   * at handler entry; here we just read the captured outcome. Called at the END
   * of each old-path listener body.
   */
  const shadowDecide = (eventName: string, input: BinderHookEvent): void => {
    if (!shadow) return;
    const decision = shadow.decide(input);
    compareAndLog(eventName, input, decision, observeOldState());
  };

  hookServer.on('SessionStart', (input) => {
    shadowEnterEvent(); // reset rotation tap + snapshot store (shadow-only)
    if (driveBinder) {
      // DRIVE: the binder owns the pre-empt + bind. Mirror the old listener
      // order — pre-empt (flip its own mainSessionEnded) BEFORE onHookEvent.
      // The old closure pre-empt + initFromHookEvent below are skipped; the
      // bridge's onSessionInfo body is also skipped (binder subsumes it).
      driveBinder.preemptOnSessionStart(input);
      driveBinder.onHookEvent(input);
      handlers.onSessionStart?.(input);
      return;
    }
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
    // Shadow: mirror the old listener order — pre-empt BEFORE decide so the
    // binder flips its own mainSessionEnded exactly like the closure above did.
    if (shadow) {
      shadow.preemptOnSessionStart(input);
      shadowDecide('SessionStart', input);
    }
  });

  hookServer.on('PreToolUse', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('PreToolUse', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    if (isSubagentEvent(input)) return;
    autoApproveGate.cancelStale('PreToolUse');
    handlers.onPreToolUse?.(input);
  });
  hookServer.on('PostToolUse', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('PostToolUse', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    if (isSubagentEvent(input)) return;
    autoApproveGate.cancelStale('PostToolUse');
    handlers.onPostToolUse?.(input);
  });
  hookServer.on('Notification', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('Notification', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    // SessionEnd already cleared status to 'idle'; a late
    // Notification(permission_prompt) for the dying session would
    // re-populate tracker.pending and a final PTY echo could fire a
    // spurious push the user cannot answer. Gate at the listener
    // boundary; restart resets mainSessionEnded so legitimate
    // post-restart notifications still pass. In drive mode the binder owns
    // mainSessionEnded (and resets it on restart via rotate()), so read it
    // there as the single source of truth; the closure flag is the old path's.
    if (driveBinder ? driveBinder.isMainEnded() : mainSessionEnded) {
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
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('PermissionRequest', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    // Auto-approve eval + inject, or escalate to the user (#453 phase 1). The gate
    // owns the PTY injection, the subagent PTY-presence gate, the default-deny
    // safety net, and the escalate fallback; session filtering above stays here in
    // the bridge. isInSubagentContext / onPermissionRequest are injected into the
    // gate and read live at inject time (async TOCTOU).
    autoApproveGate.handlePermissionRequest(input);
  });
  hookServer.on('Stop', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('Stop', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    autoApproveGate.cancelStale('Stop');
    handlers.onStop?.(input);
  });
  hookServer.on('SessionEnd', (input) => {
    shadowEnterEvent();
    if (driveBinder) {
      // DRIVE: the binder owns mainSessionEnded on id-match (and resets it on
      // restart via rotate()). The post-SessionEnd Notification drop reads
      // driveBinder.isMainEnded() directly, so there is no closure flag to keep
      // in sync here — the binder is the single source of truth.
      driveBinder.onSessionEnd(input);
      if (!driveBinder.admits(input)) return;
      autoApproveGate.cancelStale('SessionEnd');
      handlers.onSessionEnd?.(input);
      return;
    }
    // Only mark our main as ended when the session_id matches what we locked.
    // Foreign SessionEnds (subagents, siblings) must not unlock our tracking.
    if (input.session_id && claudeSessionId && input.session_id === claudeSessionId) {
      mainSessionEnded = true;
    }
    // Shadow: SessionEnd does NOT run initFromHookEvent/decide; it only flips
    // mainSessionEnded on id-match. Mirror with onSessionEnd (no decide, no
    // compare — there is no binding/rotation outcome to diff on this event).
    shadow?.onSessionEnd(input);
    if (!filterBySession(input)) return;
    autoApproveGate.cancelStale('SessionEnd');
    handlers.onSessionEnd?.(input);
  });

  // ---- The 4 previously-dropped events (#453 phase 4) -----------------------
  // These were registered with Claude Code (REMI_REGISTERED_HOOK_EVENTS) but had
  // NO listener here, so they reached only (absent) dynamic listeners — a silent
  // no-op. Wired now, each following the same admit-then-fan-out template as the
  // tool listeners (drive the binder first so admits() sees an up-to-date lock,
  // then the per-event policy). The bridge handlers already exist + are tested.

  hookServer.on('StopFailure', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('StopFailure', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    // Question event: a failed Stop hook leaves the agent in an unknown state, so
    // the bridge emits a "Retry?" card via onQuestion. Like PermissionRequest it
    // is NOT agent_id-dropped — PTY-presence gating happens downstream in the
    // tracker (#419).
    handlers.onStopFailure?.(input);
  });

  hookServer.on('PostToolUseFailure', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('PostToolUseFailure', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    // Status event: a subagent's tool failure must not flip MAIN's status, so
    // drop on agent_id — the same split policy as Pre/PostToolUse (#419).
    if (isSubagentEvent(input)) return;
    handlers.onPostToolUseFailure?.(input);
  });

  // SubagentStart/SubagentStop are subagent-LIFECYCLE events: they ALWAYS carry
  // agent_id by definition, so the isSubagentEvent drop would discard them
  // entirely. The whole point is to surface subagent activity as a status
  // breadcrumb, so gate them with admits() ONLY (the sibling defer + session
  // scoping still apply via session_id) — a deliberate divergence from the
  // Pre/PostToolUse agent_id drop (#453 phase 4).
  hookServer.on('SubagentStart', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('SubagentStart', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    // input.transcript_path is the MAIN transcript; the subagent file is the
    // deterministic <main>/subagents/agent-<id>.jsonl (registry derives it).
    // Wrapped so a send/registry throw can't escape into the hook dispatch loop
    // (mirrors initFromHookEvent/onSessionInfo) (#499 phase 3).
    try {
      subagentViews?.recordStart(input.agent_id, input.agent_type, input.transcript_path);
      pushSubagentViews();
      handlers.onSubagentStart?.(input);
    } catch (err) {
      logError(
        `[Hooks] SubagentStart view-tracking failed for ${sessionId}: ${errorToString(err)}`,
      );
    }
  });

  hookServer.on('SubagentStop', (input) => {
    shadowEnterEvent();
    if (driveBinder) driveBinder.onHookEvent(input);
    else initFromHookEvent(input);
    shadowDecide('SubagentStop', input);
    if (!(driveBinder ? driveBinder.admits(input) : filterBySession(input))) return;
    try {
      subagentViews?.recordStop(input.agent_id);
      pushSubagentViews();
      handlers.onSubagentStop?.(input);
    } catch (err) {
      logError(`[Hooks] SubagentStop view-tracking failed for ${sessionId}: ${errorToString(err)}`);
    }
  });

  log(`[Hooks] Event bridge active for session ${sessionId}`);

  return {
    bridge: hookBridge,
    closeBinder: () => driveBinder?.close(),
  };
}
