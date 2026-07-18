/**
 * Pure label builder for the live-sessions registry's `pendingQuestions`
 * mirror (#786/#787). Produces a short, human-readable string for a pending
 * `Question` — used by the macOS menu-bar app's native notifications and
 * the hub census, neither of which has the full Question payload (only the
 * registry file's flat `{id, label, createdAt}` entries).
 *
 * Not the same string as `notifications/notification-dispatcher.ts`'s
 * `buildPushText`: that one builds a lock-screen title+body pair (session
 * name prefixed, full option list). This one is a single short phrase
 * suitable for a menu-bar list row or a notification body line.
 */

import type { Question } from '@remi/shared';

/** Cap for a generic (non-permission) label — a truncated question/summary
 *  text is still readable at this length in a notification body or list row. */
export const PENDING_QUESTION_LABEL_MAX = 140;

/** Truncate to `max` characters, appending an ellipsis when cut. */
function truncateLabel(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Extract the tool name from a permission-request question's generated
 * text. `HookEventBridge.buildPermissionQuestion` (hook-event-bridge.ts)
 * produces exactly two shapes for the non-AskUserQuestion/ExitPlanMode
 * branch:
 *   - no subagent: "Allow Bash: git push origin main" or "Allow Bash"
 *   - subagent:    "code-reviewer · Bash: git push origin main" or
 *                   "code-reviewer · Bash"
 * Returns null for any other shape (notably the toolQuestion branch, which
 * is already phrased as a natural question with no "Allow " prefix) so the
 * caller falls back to the generic text-based label instead of extracting
 * garbage.
 */
function extractPermissionToolName(text: string): string | null {
  let rest: string;
  const agentSepIdx = text.indexOf(' · ');
  if (agentSepIdx >= 0) {
    rest = text.slice(agentSepIdx + 3);
  } else if (text.startsWith('Allow ')) {
    rest = text.slice('Allow '.length);
  } else {
    return null;
  }
  const colonIdx = rest.indexOf(':');
  const toolName = (colonIdx >= 0 ? rest.slice(0, colonIdx) : rest).trim();
  return toolName.length > 0 ? toolName : null;
}

/**
 * Build a short label for a pending question (#786/#787):
 *   - a multi-question AskUserQuestion form: the topics (header, or text)
 *     of every sub-question, comma-joined
 *   - a permission-request question shaped like "Allow <tool>: <command>"
 *     (or its subagent-prefixed variant): "Permission: <tool>"
 *   - everything else (AskUserQuestion/ExitPlanMode toolQuestion prompts,
 *     StopFailure, PTY-parsed fallback prompts): the summary or question
 *     text, truncated to `PENDING_QUESTION_LABEL_MAX` characters
 */
export function buildPendingQuestionLabel(question: Question): string {
  if (question.kind === 'multi_question' && question.questions && question.questions.length > 0) {
    const topics = question.questions.map((s) => s.header || s.text).join(', ');
    return truncateLabel(topics, PENDING_QUESTION_LABEL_MAX);
  }
  if (question.source === 'permission_request') {
    const toolName = extractPermissionToolName(question.text);
    if (toolName) return `Permission: ${toolName}`;
  }
  return truncateLabel(question.summary || question.text, PENDING_QUESTION_LABEL_MAX);
}
