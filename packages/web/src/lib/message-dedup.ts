/**
 * Cross-type message deduplication logic.
 *
 * When both PTY (structured_agent_output) and transcript (transcript_content)
 * sources deliver the same message, we need to deduplicate:
 *
 * 1. transcript_content arrives and a PTY-sourced message already exists with
 *    matching sessionId+sender+content but no entryUuid: replace the PTY message
 *    with the transcript version (which carries the authoritative entryUuid).
 *
 * 2. structured_agent_output arrives and a transcript message already exists
 *    with matching sessionId+sender+content that has an entryUuid: skip the
 *    PTY message entirely since the transcript version is already present.
 */

import type { MessageSource, UIMessage } from '../types';

export type { MessageSource } from '../types';

export interface IncomingMessage {
  readonly sessionId: string;
  readonly sender: string;
  readonly content: string;
  readonly entryUuid?: string | undefined;
  readonly source: MessageSource;
}

export type DedupResult =
  | { readonly action: 'add' }
  | { readonly action: 'replace'; readonly replaceIndex: number; readonly preserveId?: string }
  | { readonly action: 'skip' };

/**
 * Determine whether an incoming message should be added, should replace
 * an existing message, or should be skipped entirely.
 *
 * Three-way dedup handles: optimistic (user-sent) + PTY echo + transcript.
 *
 * When replacing an optimistic or PTY message, `preserveId` is set to the
 * original message's `id` so the caller can keep the same React key and
 * avoid a remount/flicker.
 */
export function deduplicateMessage(
  existingMessages: readonly UIMessage[],
  incoming: IncomingMessage,
): DedupResult {
  if (incoming.source === 'transcript') {
    // Transcript is the authoritative source. Look for any non-transcript
    // duplicate (optimistic or PTY) with matching sessionId+sender+content
    // and no entryUuid yet.
    const dupIdx = existingMessages.findIndex(
      (m) =>
        !m.entryUuid &&
        m.source !== 'transcript' &&
        m.sessionId === incoming.sessionId &&
        m.sender === incoming.sender &&
        m.content === incoming.content,
    );
    if (dupIdx >= 0) {
      return {
        action: 'replace',
        replaceIndex: dupIdx,
        preserveId: existingMessages[dupIdx].id,
      };
    }
    return { action: 'add' };
  }

  if (incoming.source === 'pty') {
    // PTY echo arriving: skip if an optimistic message already exists with
    // matching sessionId+sender+content (the optimistic version is already
    // displayed; the transcript version will replace it later).
    const hasOptimisticDup = existingMessages.some(
      (m) =>
        m.source === 'optimistic' &&
        m.sessionId === incoming.sessionId &&
        m.sender === incoming.sender &&
        m.content === incoming.content,
    );
    if (hasOptimisticDup) {
      return { action: 'skip' };
    }

    // Also skip if transcript already delivered this content
    const hasTranscriptDup = existingMessages.some(
      (m) =>
        m.entryUuid &&
        m.source === 'transcript' &&
        m.sessionId === incoming.sessionId &&
        m.sender === incoming.sender &&
        m.content === incoming.content,
    );
    if (hasTranscriptDup) {
      return { action: 'skip' };
    }

    return { action: 'add' };
  }

  // Optimistic or unknown source: just add
  return { action: 'add' };
}
