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

import type { UIMessage } from '../types';

export type MessageSource = 'pty' | 'transcript';

export interface IncomingMessage {
  readonly sessionId: string;
  readonly sender: string;
  readonly content: string;
  readonly entryUuid?: string | undefined;
  readonly source: MessageSource;
}

export type DedupResult =
  | { readonly action: 'add' }
  | { readonly action: 'replace'; readonly replaceIndex: number }
  | { readonly action: 'skip' };

/**
 * Determine whether an incoming message should be added, should replace
 * an existing message, or should be skipped entirely.
 */
export function deduplicateMessage(
  existingMessages: readonly UIMessage[],
  incoming: IncomingMessage,
): DedupResult {
  if (incoming.source === 'transcript') {
    // Transcript message arriving: look for a PTY-sourced duplicate
    // (no entryUuid, same sessionId+sender+content)
    const dupIdx = existingMessages.findIndex(
      (m) =>
        !m.entryUuid &&
        m.source !== 'transcript' &&
        m.sessionId === incoming.sessionId &&
        m.sender === incoming.sender &&
        m.content === incoming.content,
    );
    if (dupIdx >= 0) {
      return { action: 'replace', replaceIndex: dupIdx };
    }
    return { action: 'add' };
  }

  // PTY message arriving: check if transcript already delivered this content
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
