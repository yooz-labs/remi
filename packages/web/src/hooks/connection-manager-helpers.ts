/**
 * Pure helpers for useConnectionManager.
 *
 * Extracted into a separate module so tests can exercise them without
 * pulling in React, the WebSocket client, or identity-store side effects.
 */

import { generateId } from '@remi/shared';

/**
 * Minimal storage shape (matches the subset of the DOM `Storage` API this
 * needs) so `getOrCreateDeviceId` can be unit-tested without a browser/DOM
 * environment; callers pass `window.localStorage` in the app.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * localStorage key for the stable per-device identifier (#662). Fixed so the
 * same id survives app restarts — every existing install would otherwise
 * silently lose its lock-reclaim identity if this changed across releases.
 */
export const DEVICE_ID_STORAGE_KEY = 'remi-device-id';

/**
 * Get this browser/app install's stable device id, generating and
 * persisting one on first use (#662). The daemon uses this to recognize a
 * `hello` as the SAME device reconnecting (vs. a second client) and reclaim
 * the session's exclusive write lock instead of queuing behind a connection
 * that died without a clean close. Reads/writes `storage` (not in-memory
 * state) so the id survives page reloads and app restarts.
 */
export function getOrCreateDeviceId(storage: KeyValueStorage): string {
  const existing = storage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;
  const generated = generateId();
  storage.setItem(DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

/**
 * Collect all connections that are currently waiting on a passphrase so a
 * single unlock can satisfy them at once (#257).
 *
 * Without this, the UI would re-prompt for every sibling daemon port (e.g.
 * after restoring auto-connections from localStorage on launch) even though
 * the same identity unlocks all of them.
 */
export function collectPendingChallengeConnections<
  T extends { pendingChallenge: unknown; needsPassphrase: boolean },
>(connections: Iterable<T>): T[] {
  const out: T[] = [];
  for (const c of connections) {
    if (c.pendingChallenge) out.push(c);
  }
  return out;
}
