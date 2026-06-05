/**
 * Reply / quoted-context message formatter (#401).
 *
 * The user can long-press any message bubble to "reply" to it. When a
 * reply context is active and the user sends a message, the outgoing
 * payload includes the quoted context as a markdown blockquote so
 * Claude Code interprets it naturally. The user's own chat history
 * also renders the blockquote nicely thanks to the existing markdown
 * styling at `ChatMessage.tsx`.
 *
 * Two surfaces are distinct:
 *   - Banner display: a single-line `previewText(content)` with
 *     whitespace collapsed and an ellipsis after 50 chars so the X
 *     button stays clear on narrow screens.
 *   - Wire payload: full multi-line blockquote so the agent gets the
 *     complete context, not just a fifty-char excerpt. Capped at
 *     `MAX_QUOTED_BYTES` to avoid pathological 50 KB transcript echoes
 *     that would dominate the prompt.
 */

import type { UUID } from '@remi/shared';

/** Captures which message the user is replying to. */
export interface ReplyContext {
  readonly messageId: UUID;
  readonly content: string;
}

/** Single-line preview length used by the reply banner UI. */
export const REPLY_PREVIEW_LENGTH = 50;

/** Hard cap on quoted content forwarded to the agent on the wire (bytes-ish). */
export const MAX_QUOTED_BYTES = 2000;

/**
 * Render a single-line preview for the reply banner. Collapses runs of
 * whitespace and trims, then truncates with an ellipsis past `maxLength`.
 * The collapse keeps a multi-line quoted message from leaking newlines
 * into the inline banner.
 */
export function previewText(content: string, maxLength: number = REPLY_PREVIEW_LENGTH): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}

/**
 * Build the wire-format message string when a reply context is set.
 * Full content is preserved as a multi-line markdown blockquote (each
 * line prefixed with `> `) so the agent can read every line of the
 * referenced message. Content over `MAX_QUOTED_BYTES` is truncated
 * with an ellipsis to keep the prompt budget sane on huge transcript
 * bubbles.
 */
export function formatReplyMessage(reply: ReplyContext, userText: string): string {
  const truncated =
    reply.content.length > MAX_QUOTED_BYTES
      ? `${reply.content.slice(0, MAX_QUOTED_BYTES - 1)}…`
      : reply.content;
  const quoted = truncated
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${quoted}\n\n${userText}`;
}
