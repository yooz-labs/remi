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

/** Discriminated union of all hook event inputs */
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | NotificationHookInput
  | StopHookInput
  | SessionStartHookInput;

/** Valid hook event names */
export const HOOK_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionStart',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** Type guard for valid hook event names */
export function isValidHookEvent(name: string): name is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(name);
}
