import { describe, expect, test } from 'bun:test';
import { generateId, now } from '@remi/shared';
import type { SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';
import {
  EMPTY_PROFILE_SHARING_SOURCES,
  deriveProfileDisplay,
  hasSharedProfiles,
  removeProfileConnectionState,
  updateProfileSharingSources,
} from '../../src/lib/profile-sharing';

function lookupResponse(
  profiles: SessionProfilesResponseMessage['profiles'],
  refused?: SessionProfilesResponseMessage['refused'],
): SessionProfilesResponseMessage {
  return {
    type: 'session_profiles_response',
    id: generateId(),
    timestamp: now(),
    requestId: generateId(),
    profiles,
    ...(refused !== undefined && { refused }),
  };
}

const defaultProfile = { id: 'default', label: 'Default sign-in', harnesses: ['claude'] } as const;
const workProfile = { id: 'work', label: 'Work', harnesses: ['claude'] } as const;

describe('profile sharing signals', () => {
  test('a lookup does not overwrite profile evidence from the session list', () => {
    let sources = updateProfileSharingSources(EMPTY_PROFILE_SHARING_SOURCES, {
      type: 'session-list',
      carriesProfile: true,
    });
    sources = updateProfileSharingSources(sources, {
      type: 'lookup',
      response: lookupResponse([defaultProfile]),
    });
    expect(sources).toEqual({ sharedBySessions: true, sharedByLookup: false });
    expect(deriveProfileDisplay(true, sources)).toBe('card');
  });

  test('a session list without profile refs does not overwrite lookup evidence', () => {
    let sources = updateProfileSharingSources(EMPTY_PROFILE_SHARING_SOURCES, {
      type: 'lookup',
      response: lookupResponse([defaultProfile, workProfile]),
    });
    sources = updateProfileSharingSources(sources, {
      type: 'session-list',
      carriesProfile: false,
    });
    expect(sources).toEqual({ sharedBySessions: false, sharedByLookup: true });
    expect(hasSharedProfiles(sources)).toBe(true);
    expect(deriveProfileDisplay(true, sources)).toBe('card');
  });

  test('a refused lookup leaves the earlier lookup signal unchanged', () => {
    const sources = updateProfileSharingSources(EMPTY_PROFILE_SHARING_SOURCES, {
      type: 'lookup',
      response: lookupResponse([defaultProfile, workProfile]),
    });
    const afterRefusal = updateProfileSharingSources(sources, {
      type: 'lookup',
      response: lookupResponse([], 'profiles_invalid'),
    });
    expect(afterRefusal).toBe(sources);
    expect(afterRefusal.sharedByLookup).toBe(true);
  });

  test('a reconnect resets both signals before applying the attached session profile', () => {
    const oldSources = updateProfileSharingSources(
      { sharedBySessions: true, sharedByLookup: true },
      { type: 'reconnect' },
    );
    expect(oldSources).toEqual({ sharedBySessions: false, sharedByLookup: false });
    expect(deriveProfileDisplay(true, oldSources)).toBe('header');

    const newSources = updateProfileSharingSources(oldSources, {
      type: 'reconnect',
      profile: { id: 'work', label: 'Work' },
    });
    expect(newSources).toEqual({ sharedBySessions: true, sharedByLookup: false });
    expect(deriveProfileDisplay(true, newSources)).toBe('card');
  });

  test('profile display stays hidden without the capability', () => {
    expect(deriveProfileDisplay(false, { sharedBySessions: true, sharedByLookup: true })).toBe(
      'hidden',
    );
  });

  test('removing a connection deletes all of its profile state and preserves other connections', () => {
    const capabilities = new Map([
      ['removed', true],
      ['kept', false],
    ]);
    const sharing = new Map([
      ['removed', { sharedBySessions: true, sharedByLookup: false }],
      ['kept', { sharedBySessions: false, sharedByLookup: true }],
    ]);
    const ackCarries = new Map([
      ['removed', true],
      ['kept', false],
    ]);

    removeProfileConnectionState('removed', capabilities, sharing, ackCarries);

    expect(capabilities.has('removed')).toBe(false);
    expect(sharing.has('removed')).toBe(false);
    expect(ackCarries.has('removed')).toBe(false);
    expect(capabilities.get('kept')).toBe(false);
    expect(sharing.get('kept')).toEqual({ sharedBySessions: false, sharedByLookup: true });
    expect(ackCarries.get('kept')).toBe(false);
  });
});
