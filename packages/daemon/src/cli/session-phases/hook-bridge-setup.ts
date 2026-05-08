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
  /** Override the default inject ack timeout. Tests use a short value to
   *  exercise the timeout path without slowing the suite. */
  injectAckTimeoutMs?: number;
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
  const { hookServer, sessionId, workingDirectory, messageApi, sendAndRecord } = args;
  const PERMISSION_INJECT_ACK_TIMEOUT_MS = args.injectAckTimeoutMs ?? 1000;

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

  // ---- Inject ack tracking ------------------------------------------------
  //
  // session.pty.submitInput() is fire-and-forget: it writes the byte (and
  // 50 ms later the carriage return) without confirming Claude consumed
  // them. If the PTY drops the input (mid-render, buffer overflow, raw-mode
  // glitch), `inject()` would still report success and refresh the dedup
  // mark, leaving the user with no PTY answer, no question, and no push.
  //
  // To detect this, we register a PendingAck right before submitInput. Any
  // qualifying hook event for our session resolves it (see ackAllPending()
  // call sites below) -- those are ground truth that Claude advanced past
  // the prompt. If no such event arrives within the ack timeout, we assume
  // the inject was lost: clear the dedup mark and escalate so the user
  // actually sees the question on iOS.
  //
  // The PendingAck Set is per-session (closure-scoped). Multiple injects
  // in flight share the set; ackAllPending() resolves them all on any
  // qualifying event. KNOWN LIMITATION: with two injects in flight, the
  // qualifying event for inject-A also resolves inject-B's ack -- if
  // inject-B's PTY write was actually lost, the silent failure is masked.
  // Same-tick double-prompts are rare; per-tool_use_id correlation is the
  // long-term fix.

  type PendingAck = {
    timer: ReturnType<typeof setTimeout> | null;
    resolved: boolean;
    onTimeout: () => void;
  };
  const pendingAcks: Set<PendingAck> = new Set();

  const startPendingAck = (onTimeout: () => void): PendingAck => {
    const ack: PendingAck = { timer: null, resolved: false, onTimeout };
    ack.timer = setTimeout(() => {
      ack.timer = null;
      if (ack.resolved) return;
      ack.resolved = true;
      pendingAcks.delete(ack);
      try {
        ack.onTimeout();
      } catch (err) {
        logError(`[Hooks] PendingAck onTimeout threw: ${errorToString(err)}`);
      }
    }, PERMISSION_INJECT_ACK_TIMEOUT_MS);
    pendingAcks.add(ack);
    return ack;
  };

  const resolvePendingAck = (ack: PendingAck): void => {
    if (ack.resolved) return;
    ack.resolved = true;
    if (ack.timer !== null) {
      clearTimeout(ack.timer);
      ack.timer = null;
    }
    pendingAcks.delete(ack);
  };

  const ackAllPending = (): void => {
    if (pendingAcks.size === 0) return;
    for (const ack of pendingAcks) {
      resolvePendingAck(ack);
    }
  };

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
    ackAllPending();
    cancelStaleAutoApprove('PreToolUse');
    handlers.onPreToolUse?.(input);
  });
  hookServer.on('PostToolUse', (input) => {
    initFromHookEvent(input);
    if (!filterBySession(input)) return;
    if (isSubagentEvent(input)) return;
    ackAllPending();
    cancelStaleAutoApprove('PostToolUse');
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
    // permission_prompt is the same prompt our inject is answering; do
    // NOT treat it as ack. All other notification types (idle_prompt,
    // auth_success, etc.) are evidence Claude moved on -- without this,
    // an Edit-style approve where Claude doesn't re-emit PreToolUse
    // would time out into a phantom escalation.
    if (input.notification_type !== 'permission_prompt') {
      // Ack pending injects (idle/auth/elicitation are evidence Claude
      // moved on after our PTY write), but do NOT cancel a live LLM eval:
      // idle_prompt in particular can fire concurrently with a still-valid
      // PermissionRequest evaluation we want to complete normally.
      ackAllPending();
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
    //
    // Registers a PendingAck around the submitInput call. The next
    // qualifying hook event for our session resolves it. If the timeout
    // fires first, the inject is treated as silently lost -- the dedup
    // mark is cleared and we escalate so the user still gets a question.
    const inject = async (value: '1' | '3', reason: string): Promise<boolean> => {
      let ack: PendingAck | null = null;
      try {
        const session = sessionRegistry.getSession(sessionId);
        if (!session) {
          logError(`[AutoApprove ${sessionTag}] Session not found; cannot inject "${value}"`);
          return false;
        }
        // Register the pending ack BEFORE the await so a hook event that
        // races with submitInput (Claude responding faster than the 50 ms
        // CR delay) finds the ack already pending and resolves it cleanly.
        ack = startPendingAck(() => {
          // Suppress the phantom escalation if our session has already
          // ended (Claude exited, PTY torn down, etc.). Without this
          // gate the timer fires a stale question + push for a session
          // that no longer exists.
          if (mainSessionEnded || claudeSessionId === null) {
            log(
              `[AutoApprove ${sessionTag}] inject ack timeout fired post-teardown; suppressing phantom escalation`,
            );
            return;
          }
          log(
            `[AutoApprove ${sessionTag}] inject("${value}") ack timeout (${PERMISSION_INJECT_ACK_TIMEOUT_MS}ms); clearing dedup + escalating`,
          );
          hookBridge.clearPermissionHandled();
          escalateToUser();
        });
        await session.pty.submitInput(value);
        log(`[AutoApprove ${sessionTag}] Injected "${value}" into PTY (${reason})`);
        sessionRegistry.updateStatus(sessionId, value === '1' ? 'executing' : 'thinking');
        hookBridge.markPermissionHandled();
        return true;
      } catch (err) {
        logError(`[AutoApprove ${sessionTag}] inject("${value}") threw:`, err);
        // submitInput failed: caller will escalate via inject() returning
        // false, so we must NOT also let the ack timeout fire its own
        // escalation. Cancel before returning.
        if (ack !== null) resolvePendingAck(ack);
        return false;
      }
    };

    // Safe escalation to the user. Used when inject fails or when auto-approve
    // is off and we're in main context. Wrapped so bridge/push failures don't
    // leave the hook handler with a dangling unhandled rejection.
    // On throw we clear the pre-emptive dedup mark so the trailing
    // Notification(permission_prompt) can surface a fallback question
    // instead of being silently suppressed for 5 s.
    const escalateToUser = () => {
      try {
        handlers.onPermissionRequest?.(input);
      } catch (err) {
        logError(`[AutoApprove ${sessionTag}] escalateToUser threw:`, err);
        hookBridge.clearPermissionHandled();
      }
    };

    // Auto-approve gate: evaluate before creating a Question object.
    if (autoApproveService) {
      // Pre-empt the Notification(permission_prompt) dedup window before
      // kicking off async evaluation: Claude Code emits Notification ~10 ms
      // after PermissionRequest, well inside any LLM eval latency, and
      // without this mark a phantom 3-option question + push would fire
      // for a prompt auto-approve is about to handle silently.
      // Refresh after eval is the inject()/handlePermissionRequest's
      // responsibility; this call only covers the eval-in-progress gap.
      // Failure paths must call clearPermissionHandled() to keep the
      // Notification fallback usable.
      hookBridge.markPermissionHandled();
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
            // escalate. Clear the pre-emptive dedup mark we set above so a
            // genuinely independent Notification(permission_prompt) within
            // the 5 s window is not silently suppressed.
            hookBridge.clearPermissionHandled();
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
            // Both eval AND escalation failed: clear the dedup mark so the
            // trailing Notification(permission_prompt) becomes the fallback
            // question. Otherwise the user sees nothing for 5 s.
            hookBridge.clearPermissionHandled();
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
    ackAllPending();
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
    // Resolve pending acks before SessionEnd handlers run; otherwise a
    // timeout could fire a phantom escalation after shutdown.
    ackAllPending();
    cancelStaleAutoApprove('SessionEnd');
    handlers.onSessionEnd?.(input);
  });

  log(`[Hooks] Event bridge active for session ${sessionId}`);

  return { bridge: hookBridge };
}
