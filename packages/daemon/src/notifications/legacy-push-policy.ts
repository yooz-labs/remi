/** Explicit compatibility policy; the sender also enforces the irreversible secure latch (#1200). */
import type { PushTriggerOptions } from './push-client.ts';
export interface LegacyPushPolicy {
  readonly legacyEnabled?: boolean | undefined;
  readonly authorityDirectory?: string | undefined;
  readonly pushSecret?: string | undefined;
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
