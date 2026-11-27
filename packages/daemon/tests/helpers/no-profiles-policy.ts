/**
 * Remote profile policy for a machine with no `[profiles]` table (#1749, PR 1828 round 1 F1).
 * The policy dependencies have no defaults, so tests that do not exercise profiles pass these
 * explicitly: no configured profile, an empty readable sidecar, no record, no resume owner and
 * no hidden owner, which is what the composition root resolves on such a machine.
 */
import type { Profiles } from '../../src/profiles/profile-config.ts';
import type { ProfileSidecar } from '../../src/profiles/session-owner.ts';

export const noProfiles = (): Profiles => ({ entries: {}, notices: [] });
export const emptySidecar = (): ProfileSidecar => ({ ok: true, entries: {} });
export const noRecord = (): null => null;
export const noResumeOwner = (): null => null;
export const noHiddenOwner = (): boolean => false;
