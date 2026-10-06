/**
 * Legacy plaintext policy; the sender also enforces the irreversible secure latch (#1200).
 * `legacyEnabled` comes from `notifications.legacy_push_enabled` (ON by default until the R7 gate).
 */
import type { PushTriggerOptions } from './push-client.ts';
export interface LegacyPushPolicy {
  readonly legacyEnabled?: boolean | undefined;
  readonly authorityDirectory?: string | undefined;
  readonly pushSecret?: string | undefined;
}
/**
 * Whether the plaintext sender can be tried at all: enabled, with the secret it authenticates by.
 * Recipients are counted only then (#1200, B6), so an explicit `legacy_push_enabled = false`, or a
 * machine with no push secret, reports `no_channel` for its old device tokens instead of an
 * error-level "legacy failed" per token and a `failed` outcome per event. The sender still refuses
 * on its own (`LEGACY_PUSH_DISABLED`, `LEGACY_PUSH_SECRET_REQUIRED`); this keeps that refusal out of
 * the failure path. The activation latch cannot be read cheaply here and is answered by the sender
 * (`LEGACY_PUSH_NOT_ELIGIBLE`), which the dispatcher also reports as no channel.
 */
export function legacyChannelOpen(policy: LegacyPushPolicy): boolean {
  return (
    policy.legacyEnabled === true &&
    typeof policy.pushSecret === 'string' &&
    policy.pushSecret.trim().length > 0
  );
}

export function legacyPushFields(
  policy: LegacyPushPolicy,
): Pick<PushTriggerOptions, 'legacyEnabled' | 'authorityDirectory' | 'pushSecret'> {
  return {
    legacyEnabled: policy.legacyEnabled === true,
    ...(policy.authorityDirectory === undefined
      ? {}
      : { authorityDirectory: policy.authorityDirectory }),
    ...(policy.pushSecret === undefined ? {} : { pushSecret: policy.pushSecret }),
  };
}
