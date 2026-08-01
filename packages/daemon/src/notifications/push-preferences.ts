/**
 * Per-device push preferences (#968) — the one place that decides whether a
 * given device wants a given class of push.
 *
 * Why the daemon owns this at all: the push path is daemon -> signaling Worker
 * -> APNS and never consults the client, so a client-side "mute" switch is
 * decoration. (It literally was: `settings.notifications` in the web app was
 * written by the settings panel and read by nothing.) A preference only becomes
 * real once the sender honors it, so the device sends it up on
 * `register_device_token` and the daemon filters its per-token fan-out here.
 *
 * Two deliberate non-preferences:
 *   - `dismiss` pushes are never filtered. They are quiet `content-available`
 *     updates that CLEAR an already-delivered card; suppressing one strands
 *     that card on the lock screen of the very device that asked for less
 *     noise. `wantsPush` returns true for them unconditionally.
 *   - `subagent_alert` is not filtered either. It already has a user-facing
 *     control — it fires only on the patterns the user put in
 *     `auto_approve.subagent_alert` — so a second mute would be redundant.
 *
 * Both are enumerated explicitly rather than defaulted, so adding a new
 * `PushKind` is a type error here instead of a silent "unfiltered".
 */

import type { PushPreferences } from '@remi/shared';

import type { DeviceTokenEntry } from '../cli/handlers/trivial-events.ts';
import type { PushKind } from './push-client.ts';

/** Every preference resolved to a definite boolean. */
export interface ResolvedPushPreferences {
  readonly questions: boolean;
  readonly turnComplete: boolean;
}

/**
 * What a device gets when it expresses no preference: everything.
 *
 * This is also the fail-open direction for malformed input (see
 * `sanitizePushPreferences`). remi exists to tell you your agent needs you; a
 * notification wrongly delivered is a nuisance, one wrongly dropped is the
 * product failing at its only job.
 */
export const DEFAULT_PUSH_PREFERENCES: ResolvedPushPreferences = {
  questions: true,
  turnComplete: true,
};

/**
 * Resolve wire-supplied preferences into definite booleans.
 *
 * The input crosses a trust boundary (it arrives on a client message, and over
 * the relay that client is only as authenticated as the connection was), so
 * nothing here trusts the declared type: any field that is not literally a
 * boolean falls back to the default rather than being coerced. `{questions:
 * 'false'}` therefore means "deliver questions", not "mute them" — a truthy
 * string coerced the other way would silently mute a device that never asked
 * to be muted.
 */
export function sanitizePushPreferences(
  input: PushPreferences | undefined,
): ResolvedPushPreferences {
  if (input === null || typeof input !== 'object') return DEFAULT_PUSH_PREFERENCES;
  return {
    questions:
      typeof input.questions === 'boolean' ? input.questions : DEFAULT_PUSH_PREFERENCES.questions,
    turnComplete:
      typeof input.turnComplete === 'boolean'
        ? input.turnComplete
        : DEFAULT_PUSH_PREFERENCES.turnComplete,
  };
}

/**
 * Does this device want a push of `kind`?
 *
 * An entry with no stored preferences (registered before #968, or by a client
 * that sends none) wants everything.
 */
export function wantsPush(entry: DeviceTokenEntry, kind: PushKind): boolean {
  const prefs = entry.pushPrefs ?? DEFAULT_PUSH_PREFERENCES;
  switch (kind) {
    case 'question':
      return prefs.questions;
    case 'turn_complete':
      return prefs.turnComplete;
    // Never filtered — see the module doc for why each is exempt.
    case 'subagent_alert':
      return true;
    case 'dismiss':
      return true;
  }
}

/** The subset of `tokens` that wants a push of `kind`. */
export function tokensWanting(
  tokens: Iterable<DeviceTokenEntry>,
  kind: PushKind,
): DeviceTokenEntry[] {
  return [...tokens].filter((entry) => wantsPush(entry, kind));
}
