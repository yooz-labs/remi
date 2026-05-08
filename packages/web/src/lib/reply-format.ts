/**
 * Reply / quoted-context message formatter (#401).
 *
 * The user can long-press any message bubble to "reply" to it. When a
 * reply context is active and the user sends a message, the outgoing
 * payload includes the quoted context as a markdown blockquote so
 * Claude Code interprets it naturally. The user's own chat history
 * also renders the blockquote nicely thanks to the existing markdown
 * styling at `ChatMessage.tsx`.
 */

/** Captures which message the user is replying to. */
export interface ReplyContext {
  readonly messageId: string;
  readonly content: string;
}

/** Maximum visible chars in the reply preview before truncation. */
export const REPLY_PREVIEW_LENGTH = 50;

/**
 * Render a single-line preview of a message for the reply banner and the
 * outgoing blockquote line. Collapses runs of whitespace and trims, then
 * truncates with an ellipsis when over the preview length.
 */
export function previewText(content: string, maxLength: number = REPLY_PREVIEW_LENGTH): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}

/**
 * Build the wire-format message string when a reply context is set.
 * The markdown blockquote prefix carries the quoted context to the
 * agent and renders nicely in the chat history. The user's typed text
 * is preserved verbatim including newlines.
 */
export function formatReplyMessage(reply: ReplyContext, userText: string): string {
  return `> ${previewText(reply.content)}\n\n${userText}`;
}
