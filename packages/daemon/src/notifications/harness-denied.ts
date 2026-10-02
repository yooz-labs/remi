/**
 * The `harness_denied` push (#1126): Claude Code's auto-mode classifier
 * blocked a tool call. Claude fires `PermissionDenied` (tool name, input,
 * `tool_use_id`, `reason`) and no `PermissionRequest`, so nothing waits for
 * an answer: this is informational, never a card. It tells the user why the
 * agent changed course, or why it may soon fall back to asking (three blocks
 * in a row bring a fallback dialog that remi holds like any other prompt).
 *
 * Mutable per device through `pushPrefs.harnessDenied` (default on), like
 * `turn_complete` (#968): a classifier can block often, and a notification
 * class a user cannot turn off gets the whole app muted instead.
 */

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import type { PermissionDeniedHookInput } from '../hooks/hook-types.ts';
import { summarizeToolInput } from '../hooks/tool-summary.ts';
import type { PushTriggerOptions } from './push-client.ts';
import { tokensWanting } from './push-preferences.ts';

/** Same caps as the question push (`notification-dispatcher.ts`). */
const TITLE_MAX = 120;
const BODY_MAX = 200;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Title and body for one blocked call. The body names the call the way a
 *  permission card does, then the classifier's reason. */
export function buildHarnessDeniedText(
  sessionName: string,
  input: Pick<PermissionDeniedHookInput, 'tool_name' | 'tool_input' | 'reason' | 'agent_type'>,
): { title: string; body: string } {
  const toolName = input.tool_name || 'a tool';
  const summary = summarizeToolInput(toolName, input.tool_input ?? {});
  const call = summary ? `${toolName}: ${summary}` : toolName;
  const who = input.agent_type ? `${input.agent_type} · ` : '';
  const reason = oneLine(input.reason ?? '');
  const title = `${sessionName}: auto mode blocked ${toolName}`.slice(0, TITLE_MAX);
  const body = oneLine(`${who}${call}${reason ? `. ${reason}` : ''}`).slice(0, BODY_MAX);
  return { title, body };
}

/**
 * The collapse key of a session's `harness_denied` notices (#1126 review):
 * one per session, so a blocked loop (Claude retrying a call the classifier
 * keeps refusing) replaces the previous notice on the lock screen instead of
 * stacking one per attempt. Sent as the push's `questionId`, which the
 * signaling Worker turns into `apns-collapse-id`, as the terminal notice's
 * `notice-<id>` is; the prefix keeps it from ever naming a real card. 51
 * bytes for a UUID, under APNS's 64.
 */
export function harnessDeniedCollapseId(sessionId: string): string {
  return `harness-denied-${sessionId}`;
}

export interface HarnessDeniedPushDeps {
  readonly deviceTokens: Iterable<DeviceTokenEntry>;
  /** The remi session the blocked call belongs to (its collapse key). */
  readonly sessionId: string;
  readonly signalingUrl: string;
  readonly pushSecret?: string | undefined;
  readonly sessionName: string;
  readonly send: (signalingUrl: string, token: string, opts: PushTriggerOptions) => Promise<void>;
  readonly onError: (err: unknown) => void;
}

/**
 * Push one `harness_denied` notice to every device that wants it. No
 * `category` or `options`: nothing answers it. Its `questionId` is the
 * session's collapse key (`harnessDeniedCollapseId`), never a card's id.
 * Fire-and-forget; a failed push is reported to `onError` and never thrown.
 * Returns how many devices it was sent to.
 */
export function pushHarnessDenied(
  deps: HarnessDeniedPushDeps,
  input: Pick<PermissionDeniedHookInput, 'tool_name' | 'tool_input' | 'reason' | 'agent_type'>,
): number {
  const wanting = tokensWanting(deps.deviceTokens, 'harness_denied');
  if (wanting.length === 0) return 0;
  const { title, body } = buildHarnessDeniedText(deps.sessionName, input);
  for (const dt of wanting) {
    void deps
      .send(deps.signalingUrl, dt.token, {
        title,
        body,
        ...(deps.pushSecret !== undefined ? { pushSecret: deps.pushSecret } : {}),
        questionId: harnessDeniedCollapseId(deps.sessionId),
        kind: 'harness_denied',
      })
      .catch(deps.onError);
  }
  return wanting.length;
}
