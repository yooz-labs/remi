import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateId, now } from '@remi/shared';
import type { ProtocolMessage, SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';
import { sendNewSessionRequest, sendSessionProfilesRequest } from '../../src/lib/profile-requests';
import {
  canStartCreate,
  createInitialProfileSheetState,
  profileSheetReducer,
  runProfileCreateIfAllowed,
} from '../../src/lib/profile-sheet-state';
import type { ProfileSheetState } from '../../src/lib/profile-sheet-state';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(join(HERE, '../../src/App.tsx'), 'utf-8');
const HOOK_SOURCE = readFileSync(join(HERE, '../../src/hooks/useConnectionManager.ts'), 'utf-8');

function caseBlock(type: string): string {
  const start = APP_SOURCE.indexOf(`      case '${type}': {`);
  if (start === -1) throw new Error(`no case for ${type}`);
  const next = APP_SOURCE.indexOf('\n      case ', start + 1);
  return APP_SOURCE.slice(start, next === -1 ? undefined : next);
}

function readyProfileState(): ProfileSheetState {
  const requestId = generateId();
  const response: SessionProfilesResponseMessage = {
    type: 'session_profiles_response',
    id: generateId(),
    timestamp: now(),
    requestId,
    profiles: [
      { id: 'default', label: 'Default sign-in', harnesses: ['claude'] },
      { id: 'work', label: 'Work', harnesses: ['claude'] },
      { id: 'codex-only', label: 'Codex only', harnesses: ['codex'] },
    ],
    default: { id: 'work', source: 'folder' },
  };
  const selected = profileSheetReducer(createInitialProfileSheetState(true), {
    type: 'directory-selected',
    directory: '/tmp/project',
  });
  const loading = profileSheetReducer(selected, {
    type: 'lookup-started',
    directory: '/tmp/project',
    requestId,
    connectionId: 'host:19200',
  });
  return profileSheetReducer(loading, { type: 'lookup-response', response });
}

describe('App profile wiring', () => {
  test('copies the profile from hello_ack and session_list_response', () => {
    expect(caseBlock('hello_ack')).toContain('profile: message.profile');
    expect(caseBlock('session_list_response')).toContain('profile: ds.profile');
  });

  test('the hook routes both profile requests through the gated senders', () => {
    expect(HOOK_SOURCE).toContain('sendSessionProfilesRequest(');
    expect(HOOK_SOURCE).toContain('sendNewSessionRequest(');
  });

  test('App drops per-connection profile evidence when a connection is removed', () => {
    expect(APP_SOURCE).toContain('removeProfileConnectionState(');
    expect(APP_SOURCE).toContain('profileSharingRef.current.keys()');
    expect(APP_SOURCE).toContain("profileSheetState.lookup.status === 'ready'");
  });

  test('a profile lookup without session_profiles emits no frame', () => {
    const frames: ProtocolMessage[] = [];
    const requestId = sendSessionProfilesRequest(
      { protocolVersion: 1, capabilities: [] },
      (frame) => {
        frames.push(frame);
        return true;
      },
      '/tmp/project',
    );
    expect(requestId).toBeNull();
    expect(frames).toEqual([]);
  });

  test('a profile lookup with session_profiles sends the selected directory', () => {
    const frames: ProtocolMessage[] = [];
    const requestId = sendSessionProfilesRequest(
      { protocolVersion: 1, capabilities: ['session_profiles'] },
      (frame) => {
        frames.push(frame);
        return true;
      },
      '/tmp/project',
    );
    expect(requestId).toBe(frames[0]?.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'session_profiles_request', directory: '/tmp/project' });
  });

  test('requestNewSession includes profile and Claude harness only with the capability', () => {
    const frames: ProtocolMessage[] = [];
    const send = (frame: ProtocolMessage) => {
      frames.push(frame);
      return true;
    };
    sendNewSessionRequest({ protocolVersion: 1, capabilities: [] }, send, '/tmp/project', {
      profile: 'work',
    });
    expect(frames[0]).toMatchObject({ type: 'create_session_request', directory: '/tmp/project' });
    expect(frames[0]).not.toHaveProperty('profile');
    expect(frames[0]).not.toHaveProperty('harness');

    frames.length = 0;
    sendNewSessionRequest(
      { protocolVersion: 1, capabilities: ['session_profiles'] },
      send,
      '/tmp/project',
      { profile: 'work' },
    );
    expect(frames[0]).toMatchObject({
      type: 'create_session_request',
      directory: '/tmp/project',
      harness: 'claude',
      profile: 'work',
    });
  });

  test('the App validates a profile create before calling requestNewSession', () => {
    const start = APP_SOURCE.slice(
      APP_SOURCE.indexOf('const handleStartSessionInDir = useCallback('),
      APP_SOURCE.indexOf('// Surface a system message in a specific session', APP_SOURCE.indexOf('const handleStartSessionInDir = useCallback(')),
    );
    expect(start).toContain('runProfileCreateIfAllowed(');
    expect(start).toContain("type: 'create-start-rejected'");
    expect(start.indexOf('runProfileCreateIfAllowed(')).toBeLessThan(
      start.indexOf('requestNewSession('),
    );
  });

  test('the create helper accepts only a ready selected profile', () => {
    const state = readyProfileState();
    expect(canStartCreate(state, '/tmp/project', 'work')).toBe(true);
    expect(canStartCreate(state, '/tmp/project', 'codex-only')).toBe(false);
    expect(canStartCreate(state, '/tmp/other-project', 'work')).toBe(false);
  });

  test('an invalid profile create does not call the request sender', () => {
    const state = readyProfileState();
    const frames: ProtocolMessage[] = [];
    const result = runProfileCreateIfAllowed(state, '/tmp/project', 'codex-only', () =>
      sendNewSessionRequest(
        { protocolVersion: 1, capabilities: ['session_profiles'] },
        (frame) => {
          frames.push(frame);
          return true;
        },
        '/tmp/project',
        { profile: 'codex-only' },
      ),
    );
    expect(result).toEqual({ allowed: false });
    expect(frames).toEqual([]);
  });
});
