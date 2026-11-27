/**
 * Hold and hook registration policy (#1126, #1837, ADR 0031).
 * Wrapper permission prompts use hold_seconds; AskUserQuestion and ExitPlanMode
 * use daemon_hold_seconds as a safety cap, as do all daemon/hub prompts.
 * All sessions register a 3600 s hook so it outlasts either configured hold.
 * The session gate and both CLI hook registrations read this policy.
 */
import { ALWAYS_ESCALATE_TOOLS } from '../auto-approve/multichoice.ts';
import type { PromptsConfig } from '../config/index.ts';
import { DAEMON_PERMISSION_REQUEST_HOOK_TIMEOUT } from '../hooks/index.ts';

export interface PermissionHoldPolicy {
  readonly hasLocalTerminal: boolean;
  readonly terminalPromptMs: number;
  readonly holdMsFor: (toolName: string) => number;
  readonly permissionRequestTimeoutSec: number;
  readonly hookTimeoutMs: number;
}

export function permissionHoldPolicy(
  hasLocalTerminal: boolean,
  prompts: Pick<PromptsConfig, 'hold_seconds' | 'daemon_hold_seconds'>,
): PermissionHoldPolicy {
  const permissionRequestTimeoutSec = DAEMON_PERMISSION_REQUEST_HOOK_TIMEOUT;
  return {
    hasLocalTerminal,
    terminalPromptMs: prompts.hold_seconds * 1000,
    holdMsFor: (toolName) =>
      (!hasLocalTerminal || ALWAYS_ESCALATE_TOOLS.has(toolName)
        ? prompts.daemon_hold_seconds
        : prompts.hold_seconds) * 1000,
    permissionRequestTimeoutSec,
    hookTimeoutMs: permissionRequestTimeoutSec * 1000,
  };
}
