import { describe, expect, test } from 'bun:test';
import { generateId, now } from '@remi/shared';
import type { SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';
import {
  PROFILE_CONNECTION_CLOSED,
  PROFILE_CHOOSE_REQUIRED,
  canStartCreate,
  createInitialProfileSheetState,
  profileSheetReducer,
} from '../../src/lib/profile-sheet-state';
import type { ProfileSheetState } from '../../src/lib/profile-sheet-state';

function response(requestId: string): SessionProfilesResponseMessage {
  return {
    type: 'session_profiles_response',
    id: generateId(),
    timestamp: now(),
    requestId: requestId as SessionProfilesResponseMessage['requestId'],
    profiles: [
      { id: 'default', label: 'Default sign-in', harnesses: ['claude', 'codex'] },
      { id: 'work', label: 'Work', harnesses: ['claude'] },
    ],
    default: { id: 'work', source: 'folder' },
  };
}

function loadingState(directory: string, requestId = generateId()): ProfileSheetState {
  let state = createInitialProfileSheetState(true);
  state = profileSheetReducer(state, { type: 'directory-selected', directory });
  return profileSheetReducer(state, {
    type: 'lookup-started',
    directory,
    requestId,
    connectionId: 'machine:19200',
  });
}

function readyState(directory = '/tmp/project'): ProfileSheetState {
  const requestId = generateId();
  return profileSheetReducer(loadingState(directory, requestId), {
    type: 'lookup-response',
    response: response(requestId),
  });
}

function creatingState(): ProfileSheetState {
  const ready = readyState();
  return profileSheetReducer(ready, {
    type: 'create-started',
    directory: '/tmp/project',
    profileId: 'work',
    requestId: generateId(),
    connectionId: 'machine:19200',
  });
}

describe('profile sheet state', () => {
  test('ignores lookup and create responses with a different requestId', () => {
    const lookupPending = loadingState('/tmp/project');
    expect(
      profileSheetReducer(lookupPending, {
        type: 'lookup-response',
        response: response(generateId()),
      }),
    ).toBe(lookupPending);

    const createPending = creatingState();
    expect(
      profileSheetReducer(createPending, {
        type: 'create-response',
        requestId: generateId(),
        success: true,
      }),
    ).toBe(createPending);
  });

  test('ignores a lookup response after another directory is selected', () => {
    const pending = loadingState('/tmp/first');
    if (pending.lookup.status !== 'loading') throw new Error('expected loading lookup');
    let changedDirectory = profileSheetReducer(pending, {
      type: 'directory-selected',
      directory: '/tmp/second',
    });
    changedDirectory = profileSheetReducer(changedDirectory, {
      type: 'lookup-response',
      response: response(pending.lookup.requestId),
    });
    expect(changedDirectory.selectedDirectory).toBe('/tmp/second');
    expect(changedDirectory.lookup).toEqual({ status: 'idle' });
    expect(changedDirectory.selectedProfile).toBeNull();
  });

  test('a refused create keeps the chosen directory and profile and sets its error', () => {
    const pending = creatingState();
    if (pending.create.status !== 'pending') throw new Error('expected create pending');
    const refused = profileSheetReducer(pending, {
      type: 'create-response',
      requestId: pending.create.requestId,
      success: false,
      error: 'Profile Work was refused.',
    });
    expect(refused.selectedDirectory).toBe('/tmp/project');
    expect(refused.selectedProfile).toBe('work');
    expect(refused.lookup.status).toBe('ready');
    expect(refused.create).toEqual({ status: 'idle' });
    expect(refused.createError).toBe('Profile Work was refused.');
  });

  test('a new lookup response resets the selection to its offered default', () => {
    const previouslySelected = profileSheetReducer(readyState(), {
      type: 'profile-selected',
      profileId: 'default',
    });
    const requestId = generateId();
    const loading = profileSheetReducer(previouslySelected, {
      type: 'lookup-started',
      directory: '/tmp/project',
      requestId,
      connectionId: 'machine:19200',
    });
    const refreshed = profileSheetReducer(loading, {
      type: 'lookup-response',
      response: response(requestId),
    });
    expect(refreshed.selectedProfile).toBe('work');
  });

  test('a selected profile not offered by the current response is never retained', () => {
    const ready = readyState();
    const selected = profileSheetReducer(ready, {
      type: 'profile-selected',
      profileId: 'codex-only',
    });
    expect(selected).toBe(ready);

    const requestId = generateId();
    const loading = profileSheetReducer(ready, {
      type: 'lookup-started',
      directory: '/tmp/project',
      requestId,
      connectionId: 'machine:19200',
    });
    const refreshed = profileSheetReducer(loading, {
      type: 'lookup-response',
      response: { ...response(requestId), default: { id: 'missing', source: 'folder' } },
    });
    expect(refreshed.selectedProfile).toBeNull();
  });

  test('a successful create closes and resets the sheet', () => {
    const pending = creatingState();
    if (pending.create.status !== 'pending') throw new Error('expected create pending');
    const completed = profileSheetReducer(pending, {
      type: 'create-response',
      requestId: pending.create.requestId,
      success: true,
    });
    expect(completed).toEqual(createInitialProfileSheetState());
  });

  test('closing clears the pending lookup and the pending create', () => {
    const lookupPending = profileSheetReducer(loadingState('/tmp/project'), { type: 'close' });
    expect(lookupPending).toEqual(createInitialProfileSheetState());

    const createPending = profileSheetReducer(creatingState(), { type: 'close' });
    expect(createPending).toEqual(createInitialProfileSheetState());
  });

  test('path edits and directory changes are ignored during a pending create', () => {
    const pending = creatingState();

    expect(profileSheetReducer(pending, { type: 'path-edited' })).toBe(pending);
    expect(
      profileSheetReducer(pending, {
        type: 'directory-selected',
        directory: '/tmp/other-project',
      }),
    ).toBe(pending);
  });

  test('a create response still resolves after a directory choice during the request', () => {
    const pending = creatingState();
    if (pending.create.status !== 'pending') throw new Error('expected create pending');
    const unchanged = profileSheetReducer(pending, {
      type: 'directory-selected',
      directory: '/tmp/other-project',
    });

    const completed = profileSheetReducer(unchanged, {
      type: 'create-response',
      requestId: pending.create.requestId,
      success: true,
    });
    expect(completed).toEqual(createInitialProfileSheetState());

    const refusedPending = creatingState();
    if (refusedPending.create.status !== 'pending') throw new Error('expected create pending');
    const refusedUnchanged = profileSheetReducer(refusedPending, {
      type: 'directory-selected',
      directory: '/tmp/other-project',
    });
    const refused = profileSheetReducer(refusedUnchanged, {
      type: 'create-response',
      requestId: refusedPending.create.requestId,
      success: false,
      error: 'Profile Work was refused.',
    });
    expect(refused.selectedDirectory).toBe('/tmp/project');
    expect(refused.selectedProfile).toBe('work');
    expect(refused.createError).toBe('Profile Work was refused.');
  });

  test('profile create preconditions require an offered selected profile and no pending create', () => {
    const ready = readyState();
    expect(canStartCreate(ready, '/tmp/project', 'work')).toBe(true);
    expect(canStartCreate(ready, '/tmp/project', 'codex-only')).toBe(false);
    expect(canStartCreate(ready, '/tmp/other-project', 'work')).toBe(false);
    expect(canStartCreate(ready, '/tmp/project', '')).toBe(false);
    expect(canStartCreate(creatingState(), '/tmp/project', 'work')).toBe(false);

    const rejected = profileSheetReducer(ready, { type: 'create-start-rejected' });
    expect(rejected.createError).toBe(PROFILE_CHOOSE_REQUIRED);
  });

  test('editing the typed path clears the selected directory, profile, and lookup', () => {
    const edited = profileSheetReducer(loadingState('/tmp/project'), { type: 'path-edited' });
    expect(edited.selectedDirectory).toBeNull();
    expect(edited.selectedProfile).toBeNull();
    expect(edited.lookup).toEqual({ status: 'idle' });
  });

  test('losing the connection during lookup requires a fresh lookup', () => {
    const pending = loadingState('/tmp/project');
    const failed = profileSheetReducer(pending, {
      type: 'connection-lost',
      connectionId: 'machine:19200',
    });
    expect(failed.lookup).toEqual({
      status: 'failed',
      directory: '/tmp/project',
      message: PROFILE_CONNECTION_CLOSED,
    });
    expect(failed.create).toEqual({ status: 'idle' });

    const retried = profileSheetReducer(failed, {
      type: 'lookup-started',
      directory: '/tmp/project',
      requestId: generateId(),
      connectionId: 'machine:19200',
    });
    expect(retried.lookup.status).toBe('loading');
  });

  test('losing the connection during create clears it and requires a fresh lookup', () => {
    const pending = creatingState();
    const disconnected = profileSheetReducer(pending, {
      type: 'connection-lost',
      connectionId: 'machine:19200',
    });
    expect(disconnected.lookup).toEqual({
      status: 'failed',
      directory: '/tmp/project',
      message: PROFILE_CONNECTION_CLOSED,
    });
    expect(disconnected.create).toEqual({ status: 'idle' });
    expect(disconnected.selectedProfile).toBeNull();
  });

  test('losing a ready lookup connection requires a fresh lookup', () => {
    const ready = readyState();
    const disconnected = profileSheetReducer(ready, {
      type: 'connection-lost',
      connectionId: 'machine:19200',
    });
    expect(disconnected.lookup).toEqual({
      status: 'failed',
      directory: '/tmp/project',
      message: PROFILE_CONNECTION_CLOSED,
    });
    expect(disconnected.selectedProfile).toBeNull();
  });

  test('connection loss clears a pending create even when the selected directory is null', () => {
    const pending = { ...creatingState(), selectedDirectory: null };
    const disconnected = profileSheetReducer(pending, {
      type: 'connection-lost',
      connectionId: 'machine:19200',
    });
    expect(disconnected.create).toEqual({ status: 'idle' });
    expect(disconnected.createError).toBe(PROFILE_CONNECTION_CLOSED);
  });
});
