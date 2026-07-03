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

/**
 * Observable transport state for one connection, used to decide whether an
 * `app-force-reconnect` sweep (app resume / network change) needs to touch
 * it (#664).
 */
export interface ForceReconnectCandidate<Id extends string = string> {
  readonly connectionId: Id;
  /** Raw WebSocket.OPEN check (WebSocketClient#isTransportOpen), independent
   *  of the higher-level status machine: a zombie socket after a long
   *  background suspend can still report a stale 'connected' status. */
  readonly isOpen: boolean;
  /** Whether the connection has seen inbound traffic recently enough to be
   *  trusted without a proactive reconnect (WebSocketClient#isHealthy). */
  readonly isHealthy: boolean;
}

/** Decision for one candidate: whether and when to call `forceReconnect()`. */
export interface ForceReconnectDecision<Id extends string = string> {
  readonly connectionId: Id;
  readonly shouldReconnect: boolean;
  /** ms to wait before reconnecting; 0 means immediately. */
  readonly delayMs: number;
}

export interface PlanForceReconnectOptions {
  /** Fixed spacing multiplied by the candidate's stagger index. */
  readonly staggerStepMs: number;
  /** Extra random jitter added per staggered candidate, in [0, staggerJitterMs). */
  readonly staggerJitterMs: number;
  /** Injectable for deterministic tests; defaults to `Math.random`. */
  readonly random?: () => number;
}

/**
 * Decide what an `app-force-reconnect` sweep (app resume / network change,
 * `main.tsx`) should do with each currently managed connection (#664).
 *
 * - A healthy, open connection is left alone entirely: force-reconnecting a
 *   socket that was never actually broken was the original bug -- roughly 5
 *   daemons all visibly cycling on every foreground.
 * - A connection whose transport isn't open is already dead; reconnect it
 *   immediately. There's no simultaneous-teardown risk to protect against,
 *   it's already down.
 * - An open-but-not-recently-active connection is uncertain (an iOS
 *   background suspend can leave a zombie handle the internal heartbeat
 *   hasn't caught up to yet); it does need reconnecting, but staggered with
 *   jitter across however many such connections there are, so they don't all
 *   drop and reconnect in the same instant.
 */
export function planForceReconnect<Id extends string = string>(
  candidates: readonly ForceReconnectCandidate<Id>[],
  options: PlanForceReconnectOptions,
): ForceReconnectDecision<Id>[] {
  const random = options.random ?? Math.random;
  let staggerIndex = 0;

  return candidates.map(({ connectionId, isOpen, isHealthy }) => {
    if (isOpen && isHealthy) {
      return { connectionId, shouldReconnect: false, delayMs: 0 };
    }
    if (!isOpen) {
      return { connectionId, shouldReconnect: true, delayMs: 0 };
    }
    const delayMs = staggerIndex * options.staggerStepMs + random() * options.staggerJitterMs;
    staggerIndex++;
    return { connectionId, shouldReconnect: true, delayMs };
  });
}
