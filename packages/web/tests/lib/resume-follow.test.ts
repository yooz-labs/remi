/**
 * What the client does with a `resume_session_response` (#1129). A session daemon resumes in its
 * own process, so the session is on the connection that asked and the client opens it at once. A
 * hub starts a CHILD daemon on another port: the session is not in the client's list yet, it
 * appears through the live-sessions `daemonPorts` broadcast and a direct connection, and the client
 * opens it when its `hello_ack` arrives, unless the person has gone elsewhere since (#688: a
 * background event must never replace a choice the person made).
 *
 * Pure functions, no mocks; `App.tsx` has no component test, so its wiring is pinned in source,
 * the repo's idiom (see `harness-wiring.test.ts`).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResumeSessionResponseMessage } from '@remi/shared';
import {
  FOLLOW_WINDOW_MS,
  followLanding,
  resumeOutcome,
  startFollow,
} from '../../src/lib/resume-follow';

const response = (over: Partial<ResumeSessionResponseMessage>): ResumeSessionResponseMessage =>
  ({
    type: 'resume_session_response',
    id: 'id',
    timestamp: 't',
    requestId: 'req',
    success: true,
    ...over,
  }) as ResumeSessionResponseMessage;

describe('resumeOutcome', () => {
  test("a session daemon's success opens the session at once", () => {
    expect(resumeOutcome(response({ sessionId: 's1' as never }))).toEqual({
      kind: 'open',
      sessionId: 's1',
    });
  });

  test("a hub's success names a child on another port, which the client follows rather than opens", () => {
    expect(resumeOutcome(response({ sessionId: 's2' as never, port: 19931 }))).toEqual({
      kind: 'follow',
      sessionId: 's2',
      port: 19931,
    });
  });

  test('a failure carries its error, and says so when there is none', () => {
    expect(resumeOutcome(response({ success: false, error: 'nope' }))).toEqual({
      kind: 'failed',
      error: 'nope',
    });
    expect(resumeOutcome(response({ success: false }))).toEqual({
      kind: 'failed',
      error: 'Unknown error',
    });
  });

  test('a success without a session id is a failure, never an open of nothing', () => {
    expect(resumeOutcome(response({}))).toEqual({ kind: 'failed', error: 'Unknown error' });
  });

  test('a port that is not a usable port is ignored: the session is opened as a daemon would', () => {
    for (const port of [0, -1, 70000, 1.5, Number.NaN]) {
      expect(resumeOutcome(response({ sessionId: 's3' as never, port })).kind).toBe('open');
    }
  });
});

describe('followLanding', () => {
  const NOW = 1_000_000;

  test('opens the session when it appears and the person is where they were', () => {
    const pending = startFollow('child', 'dead-one', NOW);
    expect(followLanding(pending, 'child', 'dead-one', NOW + 5000)).toBe('child');
  });

  test('opens it from the list when the person had nothing open', () => {
    const pending = startFollow('child', null, NOW);
    expect(followLanding(pending, 'child', null, NOW + 1)).toBe('child');
  });

  test('never replaces a choice the person made in the meantime (#688)', () => {
    const pending = startFollow('child', 'dead-one', NOW);
    expect(followLanding(pending, 'child', 'another-session', NOW + 1000)).toBeNull();
    expect(followLanding(pending, 'child', null, NOW + 1000)).toBeNull();
  });

  test('ignores any other session appearing', () => {
    const pending = startFollow('child', null, NOW);
    expect(followLanding(pending, 'some-other-session', null, NOW + 1)).toBeNull();
  });

  test('gives up after the window, so a session that never appears cannot capture a later one', () => {
    const pending = startFollow('child', null, NOW);
    expect(followLanding(pending, 'child', null, NOW + FOLLOW_WINDOW_MS - 1)).toBe('child');
    expect(followLanding(pending, 'child', null, NOW + FOLLOW_WINDOW_MS)).toBeNull();
  });

  test('nothing pending lands nothing', () => {
    expect(followLanding(null, 'child', null, NOW)).toBeNull();
  });
});

describe('App.tsx follows a resumed child session (#1129)', () => {
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'App.tsx'),
    'utf-8',
  );
  const caseBlock = (type: string): string => {
    const start = SOURCE.indexOf(`      case '${type}': {`);
    if (start === -1) throw new Error(`no case for ${type}`);
    const next = SOURCE.indexOf('\n      case ', start + 1);
    return SOURCE.slice(start, next === -1 ? undefined : next);
  };

  test('the resume response is decided by resumeOutcome, and a follow refreshes the list instead of opening an unknown session', () => {
    const block = caseBlock('resume_session_response');
    expect(block).toContain('resumeOutcome(message)');
    expect(block).toContain("outcome.kind === 'follow'");
    expect(block).toContain('startFollow(');
    expect(block).toContain('reqList(conn.connectionId');
    // The only setActiveSessionId left opens a session the connection itself owns.
    expect(block.match(/setActiveSessionId\(/g)).toHaveLength(1);
    expect(block).toContain("outcome.kind === 'open'");
  });

  test("the child's hello_ack opens the session through followLanding", () => {
    const block = caseBlock('hello_ack');
    expect(block).toContain('followLanding(pendingFollowRef.current, sessionId');
    expect(block).toContain('pendingFollowRef.current = null');
  });
});
