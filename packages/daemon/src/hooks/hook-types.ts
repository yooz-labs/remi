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
  /** Set ONLY on events originating from a subagent (background Task/Agent).
   *  Main-agent events have this absent. Confirmed via REMI_HOOK_DEBUG capture
   *  2026-04-16: subagent PermissionRequest/PreToolUse/PostToolUse/SubagentStart
   *  /SubagentStop carry agent_id, main events do not. This is the reliable
   *  discriminator to prevent subagent PermissionRequests from being misrouted
   *  through auto-approve into main's PTY. */
  agent_id?: string;
  /** Subagent type identifier (e.g. "general-purpose", "feature-dev:code-architect").
   *  Only present when agent_id is set. */
  agent_type?: string;
}

// --- Original 5 events ---

export interface PreToolUseHookInput extends HookCommonInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Unique ID for this tool invocation. Claude Code sends this so Pre/PostToolUse
   *  pairs can be matched even when calls nest (e.g. Task inside another Task). */
  tool_use_id?: string;
}

export interface PostToolUseHookInput extends HookCommonInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id?: string;
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
  /** Documented values at time of writing: 'startup' | 'resume' | 'clear' |
   *  'compact'. Typed as an open optional string because Claude Code rotates
   *  session_id through flows that emit other source values (or omit the
   *  field entirely), and restart detection downstream is source-agnostic. */
  source?: string;
  model: string;
}

// --- 20 new events ---

/**
 * One entry in `permission_suggestions`. Strings are the binary-label
 * shape (e.g. Edit's `["Yes", "Always", "No"]`). Objects carry tool-
 * specific structured options discriminated by `type` — for example
 * `{type:"addDirectories",...}` or `{type:"setMode",...}`. The wider
 * shape is open: callers must treat unknown `type` values as opaque.
 */
export type PermissionSuggestion = string | { type: string; [k: string]: unknown };

/** Fired when a permission dialog is about to show */
export interface PermissionRequestHookInput extends HookCommonInput {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_suggestions?: PermissionSuggestion[];
  /**
   * Cheap future-proofing (#673): NOT sent by Claude Code today (confirmed
   * against the cc-ref reference source — the PermissionRequest struct there
   * carries only tool_name/input/modes/reason, no tool_use_id), unlike
   * PreToolUse/PostToolUse which already do. Declared as an optional
   * passthrough field so that if a future Claude Code version adds it, the
   * external-resolution correlation in AutoApproveGate can prefer an exact
   * id match over the tool_name+tool_input signature fallback with zero
   * further plumbing.
   */
  tool_use_id?: string;
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

/**
 * Subset of hook events that remi actually consumes — these are the only
 * events written into `.claude/settings.local.json` by HookConfigManager.
 *
 * The remaining HOOK_EVENT_NAMES entries (`WorktreeCreate`, `WorktreeRemove`,
 * `UserPromptSubmit`, etc.) are accepted by HookServer for forward
 * compatibility, but registering them in Claude Code's settings turns every
 * such event into a synchronous HTTP roundtrip that gates the underlying
 * Claude Code action. The most painful symptom: a stale (or just slow)
 * remi daemon makes Claude Code unable to create a worktree, even though
 * remi has no business gating that operation. See issue #203.
 *
 * Treat this list as the source of truth for "things remi cares about." If
 * you add a new typed handler in HookServer.dispatch or a dynamic listener
 * in setupHookBridge, also add the event name here so the registration
 * actually fires.
 */
export const REMI_REGISTERED_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionStart',
  'PermissionRequest',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'StopFailure',
  'SessionEnd',
] as const satisfies readonly HookEventName[];

export type RemiRegisteredHookEvent = (typeof REMI_REGISTERED_HOOK_EVENTS)[number];

/** Type guard for valid hook event names */
export function isValidHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(name);
}
