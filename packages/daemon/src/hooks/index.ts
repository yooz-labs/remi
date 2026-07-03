export { HookServer } from './hook-server.ts';
export type {
  HookServerConfig,
  HookServerEvents,
  PermissionDecision,
  PermissionResolver,
} from './hook-server.ts';
export { HookConfigManager } from './hook-config-manager.ts';
export { HookEventBridge } from './hook-event-bridge.ts';
export { ForeignSessionEscalator } from './foreign-session-escalator.ts';
export type { ForeignSessionEscalatorDeps } from './foreign-session-escalator.ts';
export type { HookBridgeEvents } from './hook-event-bridge.ts';
export type {
  HookInput,
  HookEventName,
  HookCommonInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  NotificationHookInput,
  StopHookInput,
  SessionStartHookInput,
  PermissionRequestHookInput,
  PostToolUseFailureHookInput,
  UserPromptSubmitHookInput,
  InstructionsLoadedHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  StopFailureHookInput,
  TeammateIdleHookInput,
  ConfigChangeHookInput,
  WorktreeCreateHookInput,
  WorktreeRemoveHookInput,
  PreCompactHookInput,
  PostCompactHookInput,
  ElicitationHookInput,
  ElicitationResultHookInput,
  SessionEndHookInput,
} from './hook-types.ts';
export { HOOK_EVENT_NAMES, isValidHookEvent } from './hook-types.ts';
