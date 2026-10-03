/**
 * How a session holds a binary permission prompt for the phone (#1126, ADR
 * 0031), chosen once from whether the session has a local terminal.
 *
 * - A wrapper session (local terminal) hands an unanswered prompt to its own
 *   terminal after `[prompts] hold_seconds`, and registers the
 *   PermissionRequest hook at 600 s, well above that.
 * - A daemon or hub session has no terminal of its own, so it keeps the
 *   prompt for the phone for `[prompts] daemon_hold_seconds` and registers
 *   the hook at 3600 s, which Claude honors (measured).
 *
 * One function so the four values cannot drift apart:
 * `harness/claude-session.ts` reads the gate's hold and hook timeout and the
 * subagent routing from here, `cli.ts` reads the hook registration (one call
 * in the daemon branch, one in the wrapper branch), and a test pins each mode.
 */

import type { PromptsConfig } from '../config/index.ts';
import {
  DAEMON_PERMISSION_REQUEST_HOOK_TIMEOUT,
  PERMISSION_REQUEST_HOOK_TIMEOUT,
} from '../hooks/index.ts';

export interface PermissionHoldPolicy {
  /** Routes a subagent's prompt (`AutoApproveGateDeps.hasLocalTerminal`). */
  readonly hasLocalTerminal: boolean;
  /** How long a prompt is held for the phone, in ms. */
  readonly holdMs: number;
  /** The PermissionRequest hook timeout registered with Claude, in seconds. */
  readonly permissionRequestTimeoutSec: number;
  /** The same timeout in ms, for the gate's timeout-abort check. */
  readonly hookTimeoutMs: number;
}

export function permissionHoldPolicy(
  hasLocalTerminal: boolean,
  prompts: Pick<PromptsConfig, 'hold_seconds' | 'daemon_hold_seconds'>,
): PermissionHoldPolicy {
  const permissionRequestTimeoutSec = hasLocalTerminal
    ? PERMISSION_REQUEST_HOOK_TIMEOUT
    : DAEMON_PERMISSION_REQUEST_HOOK_TIMEOUT;
  return {
    hasLocalTerminal,
    holdMs: (hasLocalTerminal ? prompts.hold_seconds : prompts.daemon_hold_seconds) * 1000,
    permissionRequestTimeoutSec,
    hookTimeoutMs: permissionRequestTimeoutSec * 1000,
  };
}
