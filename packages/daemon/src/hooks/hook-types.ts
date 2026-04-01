/**
 * TypeScript types for Claude Code hook event payloads.
 *
 * Claude Code HTTP hooks POST JSON to a configured URL when events fire.
 * These types match the documented hook input schemas.
 * Reference: Claude Code hooks documentation (claude --help or docs.anthropic.com)
 */

/** Fields present in all hook event payloads */
export interface HookCommonInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: HookEventName;
}

// --- Original 5 events ---

export interface PreToolUseHookInput extends HookCommonInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseHookInput extends HookCommonInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
}

export interface NotificationHookInput extends HookCommonInput {
  hook_event_name: 'Notification';
  message: string;
  title?: string;
  notification_type: 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog';
}

export interface StopHookInput extends HookCommonInput {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
}

export interface SessionStartHookInput extends HookCommonInput {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  model: string;
}

// --- 20 new events ---

/** Fired when a permission dialog is about to show */
export interface PermissionRequestHookInput extends HookCommonInput {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: string[];
}

/** Fired after a tool call fails */
export interface PostToolUseFailureHookInput extends HookCommonInput {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
}

/** Fired when the user submits a prompt */
export interface UserPromptSubmitHookInput extends HookCommonInput {
  hook_event_name: 'UserPromptSubmit';
}

/** Fired when instructions are loaded */
export interface InstructionsLoadedHookInput extends HookCommonInput {
  hook_event_name: 'InstructionsLoaded';
  source: string;
}

/** Fired when a subagent starts */
export interface SubagentStartHookInput extends HookCommonInput {
  hook_event_name: 'SubagentStart';
  agent_type: string;
}

/** Fired when a subagent stops */
export interface SubagentStopHookInput extends HookCommonInput {
  hook_event_name: 'SubagentStop';
  agent_type: string;
}

/** Fired when a task completes */
export interface TaskCompletedHookInput extends HookCommonInput {
  hook_event_name: 'TaskCompleted';
}

/** Fired when the stop hook itself fails */
export interface StopFailureHookInput extends HookCommonInput {
  hook_event_name: 'StopFailure';
  error_type: string;
}

/** Fired when a teammate agent becomes idle */
export interface TeammateIdleHookInput extends HookCommonInput {
  hook_event_name: 'TeammateIdle';
}

/** Fired when configuration changes */
export interface ConfigChangeHookInput extends HookCommonInput {
  hook_event_name: 'ConfigChange';
  config_type: string;
}

/** Fired when a git worktree is created */
export interface WorktreeCreateHookInput extends HookCommonInput {
  hook_event_name: 'WorktreeCreate';
}

/** Fired when a git worktree is removed */
export interface WorktreeRemoveHookInput extends HookCommonInput {
  hook_event_name: 'WorktreeRemove';
}

/** Fired before context compaction */
export interface PreCompactHookInput extends HookCommonInput {
  hook_event_name: 'PreCompact';
  source: string;
}

/** Fired after context compaction */
export interface PostCompactHookInput extends HookCommonInput {
  hook_event_name: 'PostCompact';
  source: string;
}

/** Fired when an MCP server requests input via elicitation */
export interface ElicitationHookInput extends HookCommonInput {
  hook_event_name: 'Elicitation';
  mcp_server_name: string;
}

/** Fired after an elicitation result is collected */
export interface ElicitationResultHookInput extends HookCommonInput {
  hook_event_name: 'ElicitationResult';
  mcp_server_name: string;
}

/** Fired when the session ends */
export interface SessionEndHookInput extends HookCommonInput {
  hook_event_name: 'SessionEnd';
  reason: string;
}

/** Discriminated union of all hook event inputs */
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | NotificationHookInput
  | StopHookInput
  | SessionStartHookInput
  | PermissionRequestHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | InstructionsLoadedHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | TaskCompletedHookInput
  | StopFailureHookInput
  | TeammateIdleHookInput
  | ConfigChangeHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | SessionEndHookInput;

/** Valid hook event names */
export const HOOK_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionStart',
  'PermissionRequest',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'InstructionsLoaded',
  'SubagentStart',
  'SubagentStop',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** Type guard for valid hook event names */
export function isValidHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(name);
}
