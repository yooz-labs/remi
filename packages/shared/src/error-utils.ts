/**
 * Error formatting helpers shared across daemon, web, shared, signaling.
 *
 * Consolidates the ~99 instances of the `err instanceof Error ? err.message : String(err)`
 * pattern scattered through the codebase. Prefer `errorToString(e)` at every
 * catch boundary that needs to surface a message to logs or UI.
 */

/** Extract a human-readable string from an unknown caught value. */
export function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === undefined) return 'undefined';
  if (err === null) return 'null';
  try {
    const s = JSON.stringify(err);
    return s ?? String(err);
  } catch {
    return String(err);
  }
}
