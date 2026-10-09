/** Monotonic plaintext-compatibility retirement, serialized with authorization/enrollment (#1200). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withInterprocessFileLock } from './interprocess-file-lock.ts';
import { readRelayEnrollments } from './relay-enrollments.ts';
import { writeRestrictedJson } from './restricted-json.ts';
export type LegacyPushInvocation<T> =
  | { readonly allowed: true; readonly result: T }
  | { readonly allowed: false };

function readActivation(directory: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.join(directory, 'secure_push_activation.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('SECURE_PUSH_STORE_ERROR');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'activated,version' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('activated' in value) ||
    value.activated !== true
  )
    throw new Error('SECURE_PUSH_STORE_ERROR');
  return true;
}

/** Call inside the authorization lock, BEFORE any new enrollment becomes durable. */
export function activateSecurePushLocked(directory: string): void {
  if (readActivation(directory)) return;
  try {
    writeRestrictedJson(path.join(directory, 'secure_push_activation.json'), {
      version: 1,
      activated: true,
    });
  } catch {
    throw new Error('SECURE_PUSH_STORE_ERROR');
  }
}

/**
 * The operation must be synchronous up to the actual network invocation. It may
 * return that promise, which is awaited only after this lock is released.
 * An already invoked request cannot be undone by a later secure activation.
 * The caller must separately require the explicit legacy flag and secret.
 */
export function withLegacyPushEligibility<T>(
  directory: string,
  operation: () => T,
): LegacyPushInvocation<T> {
  let invoked = false;
  try {
    return withInterprocessFileLock(path.join(directory, 'authorized_keys.json'), () => {
      let eligible = false;
      try {
        eligible = !readActivation(directory);
        if (eligible && readRelayEnrollments(directory).length > 0) {
          activateSecurePushLocked(directory);
          eligible = false;
        }
      } catch {
        eligible = false;
      }
      if (!eligible) return { allowed: false };
      invoked = true;
      return { allowed: true, result: operation() };
    });
  } catch (error) {
    if (invoked) throw error;
    return { allowed: false };
  }
}
