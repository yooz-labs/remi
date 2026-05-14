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
 *   - Both events forward their question to onQuestion. The push gate is
 *     QuestionPresenceTracker (cli.ts wiring): hook events stash the
 *     metadata; PTY confirms presence and fires the push. If both events
 *     arrive before PTY (typical), the second simply replaces the first
 *     in the tracker — Claude only renders one prompt at a time.
 */

import { DEFAULT_PERMISSION_LABELS, generateId } from '@remi/shared';
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
import { SubagentContextTracker } from './subagent-context-tracker.ts';

export interface HookBridgeEvents {
  onStatusChange: (status: AgentStatus, context?: string) => void;
  onQuestion: (question: Question) => void;
  onSessionInfo: (claudeSessionId: string, transcriptPath: string) => void;
}

/** Default permission options. Claude Code always offers these for tool
 *  permissions; the Notification hook message never contains numbered options.
 *  Labels are imported from `@remi/shared` so the web client's question-merge
 *  guard recognises them as the bland fallback (#396). */
const DEFAULT_PERMISSION_OPTIONS: readonly QuestionOption[] = [
  {
    label: DEFAULT_PERMISSION_LABELS[0],
    value: '1',
    isRecommended: true,
    isYes: true,
    isNo: false,
  },
  {
    label: DEFAULT_PERMISSION_LABELS[1],
    value: '2',
    isRecommended: false,
    isYes: true,
    isNo: false,
  },
  {
    label: DEFAULT_PERMISSION_LABELS[2],
    value: '3',
    isRecommended: false,
    isYes: false,
    isNo: true,
  },
];

export class HookEventBridge {
  private readonly sessionId: UUID;
  private readonly events: HookBridgeEvents;
  /** Tracks active Task tool_use_ids — secondary safety net for subagent
   *  filtering (primary is agent_id check in cli.ts hook listeners). */
  private readonly subagentContext = new SubagentContextTracker();

  constructor(sessionId: UUID, events: HookBridgeEvents) {
    this.sessionId = sessionId;
    this.events = events;
  }

  /** True when the main agent is inside a Task tool call (subagent running).
   *  Callers can use this to short-circuit auto-approve entirely during team work. */
  isInSubagentContext(): boolean {
    return this.subagentContext.isInSubagentContext();
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
    this.subagentContext.onPreToolUse(input.tool_name, input.tool_use_id);
    this.events.onStatusChange('executing', input.tool_name);
  }

  handlePostToolUse(input: PostToolUseHookInput): void {
    this.subagentContext.onPostToolUse(input.tool_name, input.tool_use_id);
    this.events.onStatusChange('thinking');
  }

  handleNotification(input: NotificationHookInput): void {
    if (input.notification_type === 'permission_prompt') {
      // Phase 4 (#419): the subagentContext drop previously sat here.
      // It was redundant defense: cli.ts hook-bridge-setup already
      // forwards subagent events (phase 4 removed the agent_id gate)
      // and the tracker handles presence by PTY confirmation. Keep
      // SubagentContextTracker for the auto-approve default-deny path
      // (still consumed via hookBridge.isInSubagentContext()).
      //
      // Forward the question — push semantics live in the tracker
      // (cli.ts wiring). A trailing Notification arriving after
      // PermissionRequest replaces the pending record, which is fine
      // (Claude renders one prompt at a time).
      const question: Question = {
        id: generateId(),
        text: input.message || 'Allow this action?',
        options: [...DEFAULT_PERMISSION_OPTIONS],
        allowsFreeText: false,
        isAnswered: false,
      };
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
      // Agent turn is done; clear any orphaned subagent tracking so a dropped
      // PostToolUse(Task) can't permanently block the user's permission prompts.
      this.subagentContext.reset();
    }
  }

  handleSessionStart(input: SessionStartHookInput): void {
    if (!input.session_id || !input.transcript_path) {
      console.warn(
        `[HookEventBridge] SessionStart missing required fields: session_id=${input.session_id}, transcript_path=${input.transcript_path}`,
      );
      return;
    }
    // Reset tracker for a fresh session (also covers daemon restart mid-Task).
    this.subagentContext.reset();
    this.events.onSessionInfo(input.session_id, input.transcript_path);
  }

  handlePermissionRequest(input: PermissionRequestHookInput): void {
    // Phase 4 (#419): the subagentContext drop previously sat here.
    // After phase 3 wired in the QuestionPresenceTracker, push semantics
    // are presence-gated regardless of subagent context — a subagent
    // prompt that does not render on the user's PTY does not push, and
    // one that does is genuinely answerable. The tracker handles both
    // cases; this method now only builds the question payload.
    const toolName = input.tool_name || 'unknown tool';
    const inputSummary = this.summarizeToolInput(toolName, input.tool_input);
    const promptText = inputSummary ? `Allow ${toolName}: ${inputSummary}` : `Allow ${toolName}?`;

    let options: QuestionOption[];

    // permission_suggestions is a union of string labels and structured
    // object entries (e.g. {type:"addDirectories",...}, {type:"setMode",...}).
    // The iOS question card renders text labels only, so filter to strings.
    const suggestions = input.permission_suggestions;
    const stringSuggestions = Array.isArray(suggestions)
      ? suggestions.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : [];

    if (stringSuggestions.length >= 2) {
      options = stringSuggestions.map((suggestion, idx) => {
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
      // Either no suggestions (Bash) or only structured object entries
      // that the iOS card cannot render. Fall back to the default 3-set.
      options = [...DEFAULT_PERMISSION_OPTIONS];
    }

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
    // Stop failed: agent may be in an unknown state. Reset subagent tracking
    // so orphaned Task IDs don't permanently block user permissions.
    this.subagentContext.reset();
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
    this.subagentContext.reset();
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
