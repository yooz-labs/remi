/**
 * Sub-phase C of createNewSession: wire the Claude Code hook event stream
 * into our PTY's MessageAPI.
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
 *      2s mtime poll. A restart (/clear /compact /resume) tears down the
 *      old watcher and starts a fresh one.
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
import { createSessionReset, errorToString } from '@remi/shared';
import type { AgentStatus, ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../../api/message-api.ts';
import type { AutoApproveService } from '../../auto-approve/index.ts';
import { HookEventBridge } from '../../hooks/index.ts';
import type { HookServer } from '../../hooks/index.ts';
import { classifySessionEvent } from '../../hooks/session-lock-classifier.ts';
import type { SessionRegistry, SessionRegistryFile, SessionStore } from '../../session/index.ts';
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
}

export function setupHookBridge(
  deps: Readonly<HookBridgeDeps>,
  args: Readonly<HookBridgeArgs>,
): void {
  const {
    sessionRegistry,
    sessionStore,
    liveSessionsRegistry,
    transcriptWatchers,
    transcriptFallbackTimers,
    autoApproveService,
    currentPort,
  } = deps;
  const { hookServer, sessionId, workingDirectory, messageApi, sendAndRecord } = args;

  // ---- Per-session locks (mutable across event callbacks) -----------------

  // Track the Claude session ID so we can filter hook events by session.
  // Before SessionStart fires, we let events through (claudeSessionId is null).
  let claudeSessionId: string | null = null;

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
  // gives us the transcript path, bypassing the slower mtime fallback.
  //
  // GUARD: when sibling daemons serve the same directory, all Claudes POST
  // to all hook URLs (shared settings.local.json), so a sibling's event may
  // arrive before our own Claude fires. Skip hook-based discovery and let
  // the mtime fallback handle it. Re-evaluated per event so a sibling dying
  // (or a fresh sibling appearing) is reflected immediately. Issue #321:
  // a stale `null`-once cache wedged this state and permanently disabled
  // hook-driven discovery for both daemons.

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
    return liveSessionsRegistry
      .listLive()
      .some(
        (e) =>
          e.projectPath === workingDirectory &&
          e.sessionId !== sessionId &&
          e.wsPort !== currentPort(),
      );
  };

  /**
   * Safely tear down an existing transcript watcher, reset messages, and
   * notify clients. Errors from stop() and sendAndRecord() are swallowed so
   * they never prevent the new watcher from being created. Shared by
   * initFromHookEvent and onSessionInfo.
   */
  function teardownWatcher(reason: string, label: string): void {
    const watcher = transcriptWatchers.get(sessionId);
    if (!watcher) return;
    transcriptWatchers.delete(sessionId); // Remove FIRST to unblock the new watcher.
    try {
      watcher.stop();
    } catch (stopErr) {
      logError(`[Hooks] Failed to stop watcher (${label}): ${errorToString(stopErr)}`);
    }
    messageApi.reset();
    try {
      sendAndRecord(createSessionReset(sessionId, reason));
    } catch (sendErr) {
      logError(`[Hooks] Failed to send ${reason} for ${sessionId}: ${errorToString(sendErr)}`);
    }
  }

  function initFromHookEvent(input: {
    session_id?: string;
    transcript_path?: string;
    hook_event_name?: string;
  }): void {
    if (!input.session_id) return;

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
      teardownWatcher('claude_restarted', 'restart');
      claudeSessionId = null;
      mainSessionEnded = false;
    }
    // classification === 'match': either our tracked session or first-time lock.
    if (claudeSessionId) return; // already initialized
    if (!input.transcript_path) return;

    if (hasSiblingInDir()) {
      // Cannot trust which Claude sent this event; defer to fallback.
      return;
    }

    try {
      claudeSessionId = input.session_id;
      log(
        `[Hooks] Transcript from ${input.hook_event_name ?? 'hook'}: claude=${claudeSessionId}, transcript=${input.transcript_path}`,
      );
      sessionStore.updateClaudeSessionId(sessionId, claudeSessionId);

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
        teardownWatcher('transcript_changed', 'stale-replace');
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
    },
    onQuestion: (question) => {
      messageApi.handleQuestion(question);
    },
    onSessionInfo: (hookClaudeSessionId: string, transcriptPath: string) => {
      // Guard: skip if sibling daemons share this directory (event may be from sibling's Claude).
      if (hasSiblingInDir()) return;

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
      if (classification === 'restart') {
        log(
          `[Hooks] Claude restart (SessionInfo, ended=${mainSessionEnded}): ${claudeSessionId} -> ${hookClaudeSessionId}`,
        );
        teardownWatcher('claude_restarted', 'restart-sessioninfo');
        claudeSessionId = null;
        mainSessionEnded = false;
      }

      try {
        claudeSessionId = hookClaudeSessionId;
        log(`[Hooks] SessionStart: claude=${hookClaudeSessionId}, transcript=${transcriptPath}`);
        sessionStore.updateClaudeSessionId(sessionId, hookClaudeSessionId);

        const existingWatcher = transcriptWatchers.get(sessionId);
        if (
          existingWatcher &&
          path.resolve(existingWatcher.filePath) !== path.resolve(transcriptPath)
        ) {
          log(
            `[Hooks] Replacing stale watcher (SessionInfo): ${existingWatcher.filePath} -> ${transcriptPath}`,
          );
          teardownWatcher('transcript_changed', 'stale-replace-sessioninfo');
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
    if (claudeSessionId) return input.session_id === claudeSessionId;
    return !hasSiblingInDir();
  };

  // Subagent/team-member events carry `agent_id` (confirmed via
  // REMI_HOOK_DEBUG capture 2026-04-16). They share main's session_id and
  // transcript, so session-id filtering cannot distinguish them. Drop these
  // at the hook layer so status updates, auto-approve, question emission,
  // and PTY injection all stay scoped to the main interactive session.
  const isSubagentEvent = (input: { agent_id?: string }): boolean =>
    typeof input.agent_id === 'string' && input.agent_id.length > 0;

  hookServer.on('SessionStart', (input) => {
    // SessionStart with an explicit main-transition source (/clear /compact
    // /resume) is the authoritative signal that our main Claude took a new
    // session_id while our PTY kept running. Pre-empt the classifier by
    // treating the old session as ended, so the classifier sees a 'restart'
    // and cleanly switches the lock.
    if (input.source === 'clear' || input.source === 'compact' || input.source === 'resume') {
      if (claudeSessionId && input.session_id && input.session_id !== claudeSessionId) {
        log(
          `[Hooks] Main lifecycle transition (${input.source}): ${claudeSessionId} -> ${input.session_id}`,
        );
        mainSessionEnded = true; // classifier will pick this up as 'restart'
      }
    }
    initFromHookEvent(input);
    handlers.onSessionStart?.(input);
  });

  hookServer.on('PreToolUse', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    if (isSubagentEvent(input)) return;
    handlers.onPreToolUse?.(input);
  });
  hookServer.on('PostToolUse', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    if (isSubagentEvent(input)) return;
    handlers.onPostToolUse?.(input);
  });
  hookServer.on('Notification', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    // Subagent notifications must not bubble up to the user (phantom prompts).
    if (isSubagentEvent(input)) {
      log(`[Hooks] Dropped subagent Notification: agent=${input.agent_id?.slice(0, 8)}`);
      return;
    }
    handlers.onNotification?.(input);
  });
  hookServer.on('PermissionRequest', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;

    // Subagent PermissionRequest: Claude Code sets `agent_id` on events
    // originating from Task/Agent-spawned subagents or team members. Those
    // events share the main session_id and transcript but are handled
    // internally by Claude Code, so they MUST NOT be injected into our main PTY.
    if (isSubagentEvent(input)) {
      log(
        `[Hooks] Dropped subagent PermissionRequest: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
      return;
    }

    // Legacy nested-Task context kept as a secondary safety net for the
    // rare case where agent_id is absent but the hook bridge's nested-task
    // tracker caught the descent.
    const inSubagent = hookBridge.isInSubagentContext();
    const sessionTag = sessionId.slice(0, 8);

    // Inject an answer into the PTY. Returns true on success. On failure
    // (session missing, PTY not running, submitInput throws) it logs and
    // returns false so callers can fall back to escalating the prompt.
    const inject = async (value: '1' | '3', reason: string): Promise<boolean> => {
      try {
        const session = sessionRegistry.getSession(sessionId);
        if (!session) {
          logError(`[AutoApprove ${sessionTag}] Session not found; cannot inject "${value}"`);
          return false;
        }
        await session.pty.submitInput(value);
        log(`[AutoApprove ${sessionTag}] Injected "${value}" into PTY (${reason})`);
        sessionRegistry.updateStatus(sessionId, value === '1' ? 'executing' : 'thinking');
        hookBridge.markPermissionHandled();
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
      // Pre-emptively mark this PermissionRequest as in-flight so the
      // Notification(permission_prompt) hook that Claude Code emits a few ms
      // later is suppressed by the bridge's dedup window. Without this, slow
      // LLM evaluation (>tens of ms) lets Notification slip through and emit
      // a phantom Question with the default 3-option set, firing a push for
      // a prompt auto-approve is about to handle silently. See #379 (race)
      // and #377 (resulting duplicate push).
      // The inject() path below ALSO calls markPermissionHandled() on success,
      // which refreshes the timestamp; the escalateToUser() path emits the
      // canonical question via handlePermissionRequest, which itself sets
      // lastPermissionEmitAt. Calling here is purely additive coverage for
      // the eval-in-progress window.
      hookBridge.markPermissionHandled();
      const aaService = autoApproveService;
      aaService
        .evaluate(input.tool_name, input.tool_input, sessionTag)
        .then(async (result) => {
          if (result.decision === 'approve') {
            if (!(await inject('1', 'approved'))) escalateToUser();
            return;
          }
          if (result.decision === 'deny') {
            if (!(await inject('3', 'denied'))) escalateToUser();
            return;
          }
          // escalate: in a subagent context, default-deny to avoid hanging
          // the subagent. The user could not answer it anyway.
          if (inSubagent) {
            log(`[AutoApprove ${sessionTag}] Subagent context; escalate->deny to prevent hang`);
            // If inject fails, the subagent is hung regardless (no main
            // PTY to escalate to). Log and accept.
            await inject('3', 'subagent-escalate-default-deny');
            return;
          }
          escalateToUser();
        })
        .catch(async (err) => {
          // Last line of defense; must not leave an unhandled rejection.
          try {
            logError(`[AutoApprove ${sessionTag}] Unexpected error:`, err);
            if (inSubagent) {
              await inject('3', 'subagent-error-default-deny');
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
    // subagent: default-deny rather than emit a question the user can't answer.
    if (inSubagent) {
      log(`[${sessionTag}] Subagent context without auto-approve; default-deny`);
      inject('3', 'subagent-no-aa-default-deny').catch((err) => {
        logError(`[${sessionTag}] Failed to inject default-deny:`, err);
      });
      return;
    }

    escalateToUser();
  });
  hookServer.on('Stop', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    handlers.onStop?.(input);
  });
  hookServer.on('SessionEnd', (input) => {
    // Only mark our main as ended when the session_id matches what we locked.
    // Foreign SessionEnds (subagents, siblings) must not unlock our tracking.
    if (input.session_id && claudeSessionId && input.session_id === claudeSessionId) {
      mainSessionEnded = true;
    }
    if (!filterBySession(input)) return;
    handlers.onSessionEnd?.(input);
  });

  log(`[Hooks] Event bridge active for session ${sessionId}`);
}
