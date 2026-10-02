/**
 * Which push classes this device wants, as the daemon is told (#968).
 *
 * The push path is daemon -> signaling Worker -> APNS and never consults the
 * client, so a toggle only mutes anything once it rides up on
 * `register_device_token` and the daemon filters its fan-out. Every toggle in
 * the notification settings maps to exactly one field here; a field missing
 * from this mapping would be a toggle that does nothing.
 */

import type { PushPreferences } from '@remi/shared/protocol.ts';
import type { AppSettings } from '@/types';

type PushToggles = Pick<
  AppSettings,
  'notifyQuestions' | 'notifyTurnComplete' | 'notifyHarnessDenied' | 'notifyTurnFailed'
>;

/** The preferences the settings currently express. */
export function pushPreferencesFromSettings(settings: PushToggles): PushPreferences {
  return {
    questions: settings.notifyQuestions,
    turnComplete: settings.notifyTurnComplete,
    harnessDenied: settings.notifyHarnessDenied,
    turnFailed: settings.notifyTurnFailed,
  };
}

/** Same preferences? A re-register is only worth sending when they differ. */
export function pushPreferencesEqual(a: PushPreferences, b: PushPreferences): boolean {
  return (
    a.questions === b.questions &&
    a.turnComplete === b.turnComplete &&
    a.harnessDenied === b.harnessDenied &&
    a.turnFailed === b.turnFailed
  );
}
