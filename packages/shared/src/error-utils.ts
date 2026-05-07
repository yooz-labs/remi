/**
 * Error formatting helpers shared across daemon, web, shared, signaling.
 *
 * Use `errorToString(e)` at every catch boundary that needs to surface a
 * message to logs or UI. Replaces ad-hoc `err instanceof Error ? err.message
 * : String(err)` patterns and handles non-Error throws (strings, null,
 * objects with a `.message`) consistently.
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
