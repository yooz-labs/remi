import type { SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';
import type { UUID } from '@remi/shared/types.ts';

export type ProfileLookupState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'loading';
      readonly directory: string;
      readonly requestId: UUID;
      readonly connectionId: string;
    }
  | {
      readonly status: 'ready';
      readonly directory: string;
      readonly requestId: UUID;
      readonly connectionId: string;
      readonly response: SessionProfilesResponseMessage;
    }
  | { readonly status: 'failed'; readonly directory: string; readonly message: string };

export type ProfileCreateState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'pending';
      readonly requestId: UUID;
      readonly directory: string;
      readonly profileId: string;
      readonly connectionId: string;
    };

export interface ProfileSheetState {
  readonly open: boolean;
  readonly selectedDirectory: string | null;
  readonly selectedProfile: string | null;
  readonly lookup: ProfileLookupState;
  readonly create: ProfileCreateState;
  readonly createError: string | null;
}

export type ProfileSheetAction =
  | { readonly type: 'open' }
  | { readonly type: 'close' }
  | { readonly type: 'directory-selected'; readonly directory: string }
  | { readonly type: 'path-edited' }
  | {
      readonly type: 'lookup-started';
      readonly directory: string;
      readonly requestId: UUID;
      readonly connectionId: string;
    }
  | { readonly type: 'lookup-failed'; readonly directory: string; readonly message: string }
  | { readonly type: 'lookup-response'; readonly response: SessionProfilesResponseMessage }
  | { readonly type: 'profile-selected'; readonly profileId: string }
  | {
      readonly type: 'create-started';
      readonly directory: string;
      readonly profileId: string;
      readonly requestId: UUID;
      readonly connectionId: string;
    }
  | { readonly type: 'create-start-rejected' }
  | {
      readonly type: 'create-response';
      readonly requestId: UUID;
      readonly success: boolean;
      readonly error?: string | undefined;
    }
  | { readonly type: 'connection-lost'; readonly connectionId: string };

export const PROFILE_LOOKUP_FAILURE = 'Unable to load profiles from this machine.';
export const PROFILE_CONNECTION_CLOSED = 'The connection to this machine closed. Try again.';
export const PROFILE_CREATE_FAILURE = 'The machine refused this request.';
export const PROFILE_CHOOSE_REQUIRED = 'Choose a profile first.';

export function createInitialProfileSheetState(open = false): ProfileSheetState {
  return {
    open,
    selectedDirectory: null,
    selectedProfile: null,
    lookup: { status: 'idle' },
    create: { status: 'idle' },
    createError: null,
  };
}

export function selectableProfileIds(response: SessionProfilesResponseMessage): readonly string[] {
  if (!Array.isArray(response.profiles)) return [];
  return response.profiles
    .filter(
      (profile) =>
        profile &&
        typeof profile.id === 'string' &&
        Array.isArray(profile.harnesses) &&
        profile.harnesses.includes('claude'),
    )
    .map((profile) => profile.id);
}

export function offeredDefaultProfileId(response: SessionProfilesResponseMessage): string | null {
  const id = response.default?.id;
  return id !== undefined && selectableProfileIds(response).includes(id) ? id : null;
}

export function canStartCreate(
  state: ProfileSheetState,
  directory: string,
  profileId: string,
): boolean {
  return (
    state.create.status !== 'pending' &&
    state.lookup.status === 'ready' &&
    state.selectedDirectory === directory &&
    state.selectedProfile === profileId &&
    selectableProfileIds(state.lookup.response).includes(profileId)
  );
}

export function runProfileCreateIfAllowed<T>(
  state: ProfileSheetState,
  directory: string,
  profileId: string,
  request: () => T,
): { readonly allowed: false } | { readonly allowed: true; readonly result: T } {
  if (!canStartCreate(state, directory, profileId)) return { allowed: false };
  return { allowed: true, result: request() };
}

export function profileSheetReducer(
  state: ProfileSheetState,
  action: ProfileSheetAction,
): ProfileSheetState {
  switch (action.type) {
    case 'open':
      return createInitialProfileSheetState(true);
    case 'close':
      return createInitialProfileSheetState();
    case 'directory-selected':
      if (state.create.status === 'pending') return state;
      return {
        ...state,
        selectedDirectory: action.directory,
        selectedProfile: null,
        lookup: { status: 'idle' },
        create: { status: 'idle' },
        createError: null,
      };
    case 'path-edited':
      if (state.create.status === 'pending') return state;
      return {
        ...state,
        selectedDirectory: null,
        selectedProfile: null,
        lookup: { status: 'idle' },
        createError: null,
      };
    case 'lookup-started':
      if (state.selectedDirectory !== action.directory) return state;
      return {
        ...state,
        selectedProfile: null,
        lookup: {
          status: 'loading',
          directory: action.directory,
          requestId: action.requestId,
          connectionId: action.connectionId,
        },
        createError: null,
      };
    case 'lookup-failed':
      if (state.selectedDirectory !== action.directory) return state;
      return {
        ...state,
        selectedProfile: null,
        lookup: { status: 'failed', directory: action.directory, message: action.message },
        create: { status: 'idle' },
        createError: null,
      };
    case 'lookup-response': {
      if (
        state.lookup.status !== 'loading' ||
        state.lookup.requestId !== action.response.requestId ||
        state.selectedDirectory !== state.lookup.directory
      ) {
        return state;
      }
      return {
        ...state,
        selectedProfile: offeredDefaultProfileId(action.response),
        lookup: { ...state.lookup, status: 'ready', response: action.response },
        create: { status: 'idle' },
        createError: null,
      };
    }
    case 'profile-selected':
      if (state.lookup.status !== 'ready') return state;
      if (
        action.profileId !== '' &&
        !selectableProfileIds(state.lookup.response).includes(action.profileId)
      ) {
        return state;
      }
      return { ...state, selectedProfile: action.profileId || null, createError: null };
    case 'create-started':
      if (!canStartCreate(state, action.directory, action.profileId)) return state;
      return {
        ...state,
        create: {
          status: 'pending',
          requestId: action.requestId,
          directory: action.directory,
          profileId: action.profileId,
          connectionId: action.connectionId,
        },
        createError: null,
      };
    case 'create-start-rejected':
      if (state.create.status === 'pending') return state;
      return { ...state, createError: PROFILE_CHOOSE_REQUIRED };
    case 'create-response':
      if (state.create.status !== 'pending' || state.create.requestId !== action.requestId)
        return state;
      if (action.success) return createInitialProfileSheetState();
      return {
        ...state,
        create: { status: 'idle' },
        createError: action.error || PROFILE_CREATE_FAILURE,
      };
    case 'connection-lost': {
      const lookupTracksConnection =
        state.lookup.status === 'loading' || state.lookup.status === 'ready';
      const lookupConnectionId = lookupTracksConnection ? state.lookup.connectionId : null;
      const createTracksConnection = state.create.status === 'pending';
      const createConnectionId = createTracksConnection ? state.create.connectionId : null;
      const lookupLost = lookupConnectionId === action.connectionId;
      const createLost = createConnectionId === action.connectionId;
      if (!lookupLost && !createLost) return state;
      const lookupDirectory = lookupTracksConnection ? state.lookup.directory : null;
      const createDirectory = createTracksConnection ? state.create.directory : null;
      const directory = state.selectedDirectory ?? createDirectory ?? lookupDirectory;
      const createError = createLost && state.selectedDirectory === null
        ? PROFILE_CONNECTION_CLOSED
        : null;
      if (directory === null) {
        return {
          ...state,
          selectedProfile: null,
          create: createLost ? { status: 'idle' } : state.create,
          createError,
        };
      }
      return {
        ...state,
        selectedProfile: null,
        lookup: { status: 'failed', directory, message: PROFILE_CONNECTION_CLOSED },
        create: createLost ? { status: 'idle' } : state.create,
        createError,
      };
    }
  }
}
