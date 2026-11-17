/**
 * Helpers for reconciling the client's view of a session's Claude binding.
 *
 * A `/clear` or `/resume` rotates Claude's session id (but not `/compact`,
 * which keeps the same id); while the client is connected this arrives as a
 * `session_rotated` event. But if the client was DISCONNECTED when it happened,
 * it misses that broadcast and learns the new binding only from the `hello_ack`
 * on reconnect. This helper detects that "binding changed while we were away"
 * case so the chat can re-fetch the new transcript instead of lingering on the
 * old one (#439).
 */

/**
 * True when a reconnect's `hello_ack` reveals the Claude binding rotated while
 * the client was away, so the session's stale chat must be cleared and
 * re-fetched. False on first-connect (no prior binding, nothing stale), on a
 * steady reconnect (same id), and when the ack omits the binding (older daemon,
 * nothing to reconcile against).
 */
export function bindingRotated(
  prevClaudeSessionId: string | undefined,
  ackClaudeSessionId: string | undefined,
): boolean {
  return (
    prevClaudeSessionId !== undefined &&
    ackClaudeSessionId !== undefined &&
    prevClaudeSessionId !== ackClaudeSessionId
  );
}

/** Apply a rotation without retaining a path the daemon withheld. */
export function applySessionRotation<T extends { claudeSessionId?: string | undefined; transcriptPath?: string | undefined }>(
  session: T,
  rotation: { newClaudeSessionId: string; newTranscriptPath?: string | undefined },
): Omit<T, 'transcriptPath'> & { transcriptPath?: string | undefined } {
  const { transcriptPath: _oldPath, ...rest } = session;
  return { ...rest, claudeSessionId: rotation.newClaudeSessionId,
    ...(rotation.newTranscriptPath !== undefined && { transcriptPath: rotation.newTranscriptPath }) };
}
