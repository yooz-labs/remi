/**
 * Bridges Claude Code hook events to Remi's status/question system.
 *
 * Maps hook events to the same AgentStatus and Question types that
 * the OutputProcessor previously produced from terminal parsing.
 * This is the hook-based replacement for terminal output parsing.
 *
 * Permission question flow (verified from real hook logs 2026-04-12):
 *   - PermissionRequest fires with tool_name, tool_input, and optionally
 *     permission_suggestions (e.g. ["Yes","Always","No"] for Edit).
 *   - Notification(permission_prompt) fires shortly after with a plain-text
 *     message like "Claude needs your permission to use Bash" (no numbered
 *     options; those appear only in the terminal UI).
 *   - We emit the question immediately from PermissionRequest using either
 *     the provided suggestions or a default 3-option set, then suppress
 *     the redundant Notification.
 */

import { generateId } from '@remi/shared';
import type { AgentStatus, Question, QuestionOption, UUID } from '@remi/shared';
import type { HookServerEvents } from './hook-server.ts';
import type {
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from './hook-types.ts';

export interface HookBridgeEvents {
  onStatusChange: (status: AgentStatus, context?: string) => void;
  onQuestion: (question: Question) => void;
  onSessionInfo: (claudeSessionId: string, transcriptPath: string) => void;
}

/** Default permission options. Claude Code always offers these for tool
 *  permissions; the Notification hook message never contains numbered options. */
const DEFAULT_PERMISSION_OPTIONS: readonly QuestionOption[] = [
  { label: 'Yes', value: '1', isRecommended: true, isYes: true, isNo: false },
  { label: 'Yes, always', value: '2', isRecommended: false, isYes: true, isNo: false },
  { label: 'No', value: '3', isRecommended: false, isYes: false, isNo: true },
];

/** Dedup window: suppress Notification(permission_prompt) arriving within
 *  this many ms after a PermissionRequest already emitted a question. */
const PERMISSION_DEDUP_WINDOW_MS = 5000;

export class HookEventBridge {
  private readonly sessionId: UUID;
  private readonly events: HookBridgeEvents;
  /** Timestamp of last question emitted from handlePermissionRequest */
  private lastPermissionEmitAt = 0;

  constructor(sessionId: UUID, events: HookBridgeEvents) {
    this.sessionId = sessionId;
    this.events = events;
  }

  /** Returns HookServerEvents handlers wired to this bridge */
  hookHandlers(): Partial<HookServerEvents> {
    return {
      onPreToolUse: (input) => this.handlePreToolUse(input),
      onPostToolUse: (input) => this.handlePostToolUse(input),
      onNotification: (input) => this.handleNotification(input),
      onStop: (input) => this.handleStop(input),
      onSessionStart: (input) => this.handleSessionStart(input),
      onPermissionRequest: (input) => this.handlePermissionRequest(input),
      onPostToolUseFailure: (input) => this.handlePostToolUseFailure(input),
      onSubagentStart: (input) => this.handleSubagentStart(input),
      onSubagentStop: (input) => this.handleSubagentStop(input),
      onStopFailure: (input) => this.handleStopFailure(input),
      onSessionEnd: (input) => this.handleSessionEnd(input),
    };
  }

  handlePreToolUse(input: PreToolUseHookInput): void {
    this.events.onStatusChange('executing', input.tool_name);
  }

  handlePostToolUse(_input: PostToolUseHookInput): void {
    this.events.onStatusChange('thinking');
  }

  handleNotification(input: NotificationHookInput): void {
    if (input.notification_type === 'permission_prompt') {
      // PermissionRequest already emitted the question; suppress duplicate.
      if (Date.now() - this.lastPermissionEmitAt < PERMISSION_DEDUP_WINDOW_MS) {
        console.debug(
          `[HookEventBridge] Suppressed duplicate Notification(permission_prompt): ${(input.message || '').substring(0, 80)}`,
        );
        return;
      }
      // Standalone Notification without a preceding PermissionRequest.
      // Emit with default 3-option set (message has no numbered options).
      const question: Question = {
        id: generateId(),
        text: input.message || 'Allow this action?',
        options: [...DEFAULT_PERMISSION_OPTIONS],
        allowsFreeText: false,
        isAnswered: false,
      };
      this.lastPermissionEmitAt = Date.now();
      this.events.onQuestion(question);
      this.events.onStatusChange('waiting');
    } else if (input.notification_type === 'idle_prompt') {
      this.events.onStatusChange('idle');
    } else {
      // Intentionally unhandled notification types:
      // - 'auth_success': informational only, no status change needed
      // - 'elicitation_dialog': not yet supported by Remi
    }
  }

  handleStop(input: StopHookInput): void {
    // When stop_hook_active is true, the stop hook is intercepting and the
    // session is NOT actually stopping; it remains active.
    if (!input.stop_hook_active) {
      this.events.onStatusChange('idle');
    }
  }

  handleSessionStart(input: SessionStartHookInput): void {
    if (!input.session_id || !input.transcript_path) {
      console.warn(
        `[HookEventBridge] SessionStart missing required fields: session_id=${input.session_id}, transcript_path=${input.transcript_path}`,
      );
      return;
    }
    this.events.onSessionInfo(input.session_id, input.transcript_path);
  }

  handlePermissionRequest(input: PermissionRequestHookInput): void {
    const toolName = input.tool_name || 'unknown tool';
    const inputSummary = this.summarizeToolInput(toolName, input.tool_input);
    const promptText = inputSummary ? `Allow ${toolName}: ${inputSummary}` : `Allow ${toolName}?`;

    let options: QuestionOption[];

    if (input.permission_suggestions && input.permission_suggestions.length >= 2) {
      // Use the suggestions provided by Claude Code (e.g. Edit sends ["Yes","Always","No"])
      options = input.permission_suggestions.map((suggestion, idx) => {
        const lower = suggestion.toLowerCase();
        const isYes = lower.startsWith('yes') || lower === 'allow' || lower === 'always';
        const isNo = lower.startsWith('no') || lower === 'deny' || lower === 'reject';
        return {
          label: suggestion,
          value: String(idx + 1),
          isRecommended: idx === 0,
          isYes,
          isNo,
        };
      });
    } else {
      // No suggestions (e.g. Bash). Use default 3-option set.
      // The Notification hook that follows has no numbered options either
      // (just plain text like "Claude needs your permission to use Bash"),
      // so waiting for it adds latency without gaining information.
      options = [...DEFAULT_PERMISSION_OPTIONS];
    }

    this.lastPermissionEmitAt = Date.now();
    this.events.onQuestion({
      id: generateId(),
      text: promptText,
      options,
      allowsFreeText: false,
      isAnswered: false,
    });
    this.events.onStatusChange('waiting');
  }

  handlePostToolUseFailure(input: PostToolUseFailureHookInput): void {
    this.events.onStatusChange('executing', `${input.tool_name} failed: ${input.error}`);
  }

  handleSubagentStart(input: SubagentStartHookInput): void {
    this.events.onStatusChange('executing', `subagent:${input.agent_type}`);
  }

  handleSubagentStop(_input: SubagentStopHookInput): void {
    this.events.onStatusChange('thinking');
  }

  handleStopFailure(input: StopFailureHookInput): void {
    // Emit a question so the user is notified of the stop failure
    const question: Question = {
      id: generateId(),
      text: `Session stop failed (${input.error_type}). Retry?`,
      options: [
        { label: 'Yes', value: 'y', isRecommended: true, isYes: true, isNo: false },
        { label: 'No', value: 'n', isRecommended: false, isYes: false, isNo: true },
      ],
      allowsFreeText: false,
      isAnswered: false,
    };
    this.events.onQuestion(question);
    this.events.onStatusChange('waiting');
  }

  handleSessionEnd(_input: SessionEndHookInput): void {
    this.events.onStatusChange('idle');
  }

  /** Extract a short summary from tool input for the question prompt. */
  private summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string | null {
    if (!toolInput || typeof toolInput !== 'object') return null;
    const lower = toolName.toLowerCase();

    const get = (key: string): unknown => toolInput[key];

    // Bash: show the command
    if (lower === 'bash' || lower === 'terminal') {
      const cmd = get('command') ?? get('cmd');
      if (typeof cmd === 'string') {
        return cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd;
      }
    }

    // Read/Write/Edit: show the file path
    if (lower === 'read' || lower === 'write' || lower === 'edit') {
      const path = get('file_path') ?? get('path');
      if (typeof path === 'string') return path;
    }

    // Glob/Grep: show the pattern
    if (lower === 'glob' || lower === 'grep') {
      const pattern = get('pattern') ?? get('glob');
      if (typeof pattern === 'string') return pattern;
    }

    // WebFetch: show the URL
    if (lower.includes('fetch') || lower.includes('web')) {
      const url = get('url');
      if (typeof url === 'string') return url;
    }

    // Generic: try common field names
    for (const key of ['command', 'file_path', 'path', 'url', 'description']) {
      const val = get(key);
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 120 ? `${val.slice(0, 117)}...` : val;
      }
    }

    return null;
  }
}
