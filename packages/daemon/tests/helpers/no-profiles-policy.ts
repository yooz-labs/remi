/**
 * Remote profile policy for a machine with no `[profiles]` table (#1749, PR 1828 round 1 F1).
 * The policy dependencies have no defaults, so tests that do not exercise profiles pass these
 * explicitly: no configured profile, an empty readable sidecar, no record, no resume owner and
 * no hidden owner, which is what the composition root resolves on such a machine.
 */
import { join } from 'node:path';
import type { Profiles } from '../../src/profiles/profile-config.ts';
import type { ProfileSidecar } from '../../src/profiles/session-owner.ts';
import { SessionStore } from '../../src/session/session-store.ts';

export const noProfiles = (): Profiles => ({ entries: {}, notices: [] });
export const emptySidecar = (): ProfileSidecar => ({ ok: true, entries: {} });
export const noRecord = (): null => null;
export const noResumeOwner = (): null => null;
export const noHiddenOwner = (): boolean => false;

/**
 * A hub relay's `remotePolicy` on a machine with no `[profiles]` table: the real session store
 * under the test's own directory and a snapshot that configures nothing.
 */
export function noProfilesRelayPolicy(dir: string) {
  return {
    sessionStore: new SessionStore(join(dir, 'sessions.json')),
    snapshot: () => ({ profiles: noProfiles(), sidecar: emptySidecar() }),
    run: <T>(fn: () => T): T => fn(),
  };
}
