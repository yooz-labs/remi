import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import { sendNewSessionRequest, sendSessionProfilesRequest } from '../../src/lib/profile-requests';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(join(HERE, '../../src/App.tsx'), 'utf-8');
const HOOK_SOURCE = readFileSync(join(HERE, '../../src/hooks/useConnectionManager.ts'), 'utf-8');

function caseBlock(type: string): string {
  const start = APP_SOURCE.indexOf(`      case '${type}': {`);
  if (start === -1) throw new Error(`no case for ${type}`);
  const next = APP_SOURCE.indexOf('\n      case ', start + 1);
  return APP_SOURCE.slice(start, next === -1 ? undefined : next);
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
});
