/**
 * Tests for session-display helpers. Pure functions; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import { sessionPillState, splitSessionName } from '../../src/lib/session-display';
import type { ConnectionId } from '../../src/types';

const cid = (s: string): ConnectionId => s as unknown as ConnectionId;

describe('splitSessionName', () => {
  test('full "host:project/branch" splits all three parts', () => {
    expect(
      splitSessionName({ name: 'macbook:remi/feat/notif-sheet', connectionId: cid('macbook:18924') }),
    ).toEqual({ host: 'macbook', project: 'remi', branch: 'feat/notif-sheet' });
  });

  test('no host prefix falls back to the connectionId hostname (port stripped)', () => {
    expect(splitSessionName({ name: 'remi/develop', connectionId: cid('localhost:18765') })).toEqual({
      host: 'localhost',
      project: 'remi',
      branch: 'develop',
    });
  });

  test('a colon after a slash is NOT treated as a host prefix', () => {
    // "project/sub:extra" -- the colon belongs to the path, not a host.
    expect(splitSessionName({ name: 'project/sub:extra', connectionId: cid('beelink:18924') })).toEqual({
      host: 'beelink',
      project: 'project',
      branch: 'sub:extra',
    });
  });

  test('no slash yields a null branch (project becomes the headline)', () => {
    expect(splitSessionName({ name: 'host:soloproject', connectionId: cid('host:1') })).toEqual({
      host: 'host',
      project: 'soloproject',
      branch: null,
    });
  });

  test('empty name falls back to "session" project and connectionId host', () => {
    expect(splitSessionName({ name: '', connectionId: cid('192.168.1.4:19924') })).toEqual({
      host: '192.168.1.4',
      project: 'session',
      branch: null,
    });
  });

  test('deep branch path keeps every component after the first slash', () => {
    expect(
      splitSessionName({ name: 'host:repo/feature/issue-447/phase2', connectionId: cid('host:1') }),
    ).toEqual({ host: 'host', project: 'repo', branch: 'feature/issue-447/phase2' });
  });
});

describe('sessionPillState', () => {
  test('error connection is offline regardless of agent status or question', () => {
    expect(
      sessionPillState({ connectionStatus: 'error', status: 'thinking', questionPending: true }),
    ).toBe('offline');
    expect(sessionPillState({ connectionStatus: 'unreachable', status: 'idle' })).toBe('offline');
  });

  test('connection status wins: disconnected with a stale question is idle, not asking', () => {
    expect(
      sessionPillState({ connectionStatus: 'disconnected', status: 'idle', questionPending: true }),
    ).toBe('idle');
  });

  test('connecting / reconnecting / authenticating all map to connecting', () => {
    expect(sessionPillState({ connectionStatus: 'connecting', status: 'idle' })).toBe('connecting');
    expect(sessionPillState({ connectionStatus: 'reconnecting', status: 'idle' })).toBe('connecting');
    expect(sessionPillState({ connectionStatus: 'authenticating', status: 'idle' })).toBe('connecting');
  });

  test('connected + pending question is asking', () => {
    expect(
      sessionPillState({ connectionStatus: 'connected', status: 'idle', questionPending: true }),
    ).toBe('asking');
  });

  test('connected + thinking/executing is working', () => {
    expect(sessionPillState({ connectionStatus: 'connected', status: 'thinking' })).toBe('working');
    expect(sessionPillState({ connectionStatus: 'connected', status: 'executing' })).toBe('working');
  });

  test('connected + idle is idle', () => {
    expect(sessionPillState({ connectionStatus: 'connected', status: 'idle' })).toBe('idle');
  });

  test('connected + waiting is asking (no longer collapses to idle) (#576)', () => {
    // A blocked agent (PreToolUse / PermissionRequest -> 'waiting') must surface
    // as "Needs you", even before a discrete question record arrives.
    expect(sessionPillState({ connectionStatus: 'connected', status: 'waiting' })).toBe('asking');
  });

  test('connected + evaluating/approved is working (#576)', () => {
    expect(sessionPillState({ connectionStatus: 'connected', status: 'evaluating' })).toBe('working');
    expect(sessionPillState({ connectionStatus: 'connected', status: 'approved' })).toBe('working');
  });

  test('connected + starting is connecting (session spinning up) (#576)', () => {
    expect(sessionPillState({ connectionStatus: 'connected', status: 'starting' })).toBe('connecting');
  });

  test('a pending question still wins over a busy/waiting agent status', () => {
    expect(
      sessionPillState({ connectionStatus: 'connected', status: 'evaluating', questionPending: true }),
    ).toBe('asking');
    expect(
      sessionPillState({ connectionStatus: 'connected', status: 'waiting', questionPending: true }),
    ).toBe('asking');
  });
});
