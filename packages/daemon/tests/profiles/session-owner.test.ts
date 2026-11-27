import { expect, test } from 'bun:test';
import { parseProfiles } from '../../src/profiles/profile-config.ts';
import {
  readProfileSidecar,
  sessionProfileOwner,
  sidecarGetter,
} from '../../src/profiles/session-owner.ts';
import type { StoredSession } from '../../src/session/session-store.ts';

test('remote owner requires consistent sidecar evidence', () => {
  const profiles = parseProfiles({
    work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
    secret: { label: 'Secret', remote_visible: false, claude: { expects: 'subscription' } },
  });
  const empty = parseProfiles(undefined);
  const record: StoredSession = {
    remiSessionId: crypto.randomUUID(),
    claudeSessionId: null,
    projectPath: '/project',
    port: 0,
    pid: null,
    startedAt: '',
    exitedAt: null,
    exitCode: null,
  };
  const sidecar = (profile: string) => ({
    ok: true as const,
    entries: { [record.remiSessionId]: { profile, revision: 'r' } },
  });
  const absent = { ok: true as const, entries: {} };
  const bad = { ok: false as const };
  let reads = 0;
  const lazy = readProfileSidecar({
    snapshot: () => {
      reads++;
      throw new Error('unreadable');
    },
  });
  // The sidecar is read for every record, also a bare one with no [profiles] table (lead, PR 1828
  // round 2), and only once per snapshot.
  expect(reads).toBe(0);
  expect(sessionProfileOwner(record, lazy, empty)).toEqual({ owner: 'hidden' });
  expect(reads).toBe(1);
  expect(sessionProfileOwner(record, lazy, profiles)).toEqual({ owner: 'hidden' });
  expect(() => sidecarGetter(lazy).get(record.remiSessionId)).toThrow();
  expect(reads).toBe(1);
  // No table: an absent session-profiles.json (no entries) leaves a bare record the default.
  expect(sessionProfileOwner(record, absent, empty)).toEqual({ owner: 'default' });
  // No table: an existing but unreadable sidecar hides even a bare record (J9).
  expect(sessionProfileOwner(record, bad, empty)).toEqual({ owner: 'hidden' });
  // No table: a stripped record whose sidecar entry names work, no longer configured, is hidden
  // (L1), and so is one naming a hidden profile.
  expect(sessionProfileOwner(record, sidecar('work'), empty)).toEqual({ owner: 'hidden' });
  expect(sessionProfileOwner(record, sidecar('secret'), empty)).toEqual({ owner: 'hidden' });
  // With a table: a stripped record whose entry names a removed profile is hidden too.
  expect(sessionProfileOwner(record, sidecar('gone'), profiles)).toEqual({ owner: 'hidden' });
  expect(sessionProfileOwner(record, bad, profiles)).toEqual({ owner: 'hidden' });
  expect(sessionProfileOwner({ ...record, profile: 'work' }, bad, profiles)).toEqual({
    owner: 'hidden',
  });
  expect(
    sessionProfileOwner({ ...record, profileSnapshot: { revision: 'r' } }, bad, profiles),
  ).toEqual({ owner: 'hidden' });
  expect(sessionProfileOwner(record, absent, profiles)).toEqual({ owner: 'default' });
  expect(sessionProfileOwner(record, sidecar('secret'), profiles)).toEqual({ owner: 'hidden' });
  expect(sessionProfileOwner(record, sidecar('work'), profiles)).toEqual({
    owner: 'profile',
    id: 'work',
    configured: true,
  });
  expect(sessionProfileOwner({ ...record, profile: 'work' }, sidecar('work'), profiles)).toEqual({
    owner: 'profile',
    id: 'work',
    configured: true,
  });
  expect(
    sessionProfileOwner(
      { ...record, profileSnapshot: { revision: 'r' } },
      sidecar('work'),
      profiles,
    ),
  ).toEqual({ owner: 'profile', id: 'work', configured: true });
  expect(sessionProfileOwner({ ...record, profile: 'work' }, sidecar('secret'), profiles)).toEqual({
    owner: 'hidden',
  });
  expect(sessionProfileOwner({ ...record, profile: 'work' }, absent, profiles)).toEqual({
    owner: 'hidden',
  });
  expect(
    sessionProfileOwner({ ...record, profileSnapshot: { revision: 'r' } }, absent, profiles),
  ).toEqual({ owner: 'hidden' });
  expect(sessionProfileOwner({ transcriptProfile: undefined }, bad, profiles)).toEqual({
    owner: 'default',
  });
  expect(sessionProfileOwner({ transcriptProfile: 'work' }, bad, profiles)).toEqual({
    owner: 'profile',
    id: 'work',
    configured: true,
  });
  expect(sessionProfileOwner({ transcriptProfile: 'gone' }, bad, profiles)).toEqual({
    owner: 'hidden',
  });
  expect(sessionProfileOwner(record, sidecar('work'), { error: 'invalid' })).toEqual({
    owner: 'hidden',
  });
  expect(sessionProfileOwner({ transcriptProfile: undefined }, bad, { error: 'invalid' })).toEqual({
    owner: 'default',
  });
});
