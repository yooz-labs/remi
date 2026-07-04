/**
 * One-shot "did the daemon ack THIS exact message" primitive (#690).
 *
 * Distinct from message-ack-tracker.ts, which tracks CHAT `user_input` sends
 * specifically for the sending -> sent -> delivered bubble lifecycle (with
 * resend-on-timeout). This is a generic, single-use wait used where a
 * protocol action (not a chat bubble) needs a completion signal before the
 * caller proceeds -- e.g. handleDisconnect awaiting the unregister_device_token
 * ack (a "tombstone committed to disk" signal -- see the daemon's
 * Connection.handleUnregisterDeviceToken, which deliberately sends this ack
 * AFTER the tombstone write, not before like every other message type)
 * before it is safe to re-register with sibling connections.
 */

export type AckWaiters = Map<string, () => void>;

/** Resolve (and remove) the waiter for `messageId`, if one is registered.
 *  Called from the inbound `ack` handler. No-op if nothing is waiting on it
 *  (e.g. an ack for a chat message, which message-ack-tracker already
 *  handles, or one that already timed out) -- so wiring this in is always
 *  safe, never a new error path. */
export function resolveAckWaiter(waiters: AckWaiters, messageId: string): void {
  const resolve = waiters.get(messageId);
  if (!resolve) return;
  waiters.delete(messageId);
  resolve();
}

/**
 * Register a waiter for `messageId`, resolving `true` as soon as
 * `resolveAckWaiter` is called for it, or `false` if `timeoutMs` elapses
 * first. Never rejects -- a timeout is an expected, not-exceptional outcome
 * (the daemon may be slow, offline, or the ack may get lost), so callers
 * branch on the boolean rather than a try/catch.
 */
export function awaitAck(waiters: AckWaiters, messageId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(messageId);
      resolve(false);
    }, timeoutMs);
    waiters.set(messageId, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
