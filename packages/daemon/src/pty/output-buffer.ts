/**
 * Per-session rolling buffer of recent decoded PTY output (#627).
 *
 * The AskUserQuestion runner reads this to detect the review screen and the
 * "User answered" closure marker while driving the interactive TUI. Capped so it
 * can never grow unbounded; the runner calls `resetPtyOutput` before driving so a
 * stale marker from a previous prompt can't be mistaken for the current one.
 */

const MAX_BYTES = 16_384;
const buffers = new Map<string, string>();

/** Append newly-decoded PTY output for a session (trims to the last MAX_BYTES). */
export function appendPtyOutput(sessionId: string, text: string): void {
  const next = (buffers.get(sessionId) ?? '') + text;
  buffers.set(sessionId, next.length > MAX_BYTES ? next.slice(next.length - MAX_BYTES) : next);
}

/** Read the buffered recent output for a session ('' when none). */
export function readPtyOutput(sessionId: string): string {
  return buffers.get(sessionId) ?? '';
}

/** Clear a session's buffer (runner start) so prior-prompt markers are ignored. */
export function resetPtyOutput(sessionId: string): void {
  buffers.set(sessionId, '');
}

/** Drop a session's buffer entirely (session teardown) to avoid a leak. */
export function clearPtyOutput(sessionId: string): void {
  buffers.delete(sessionId);
}
