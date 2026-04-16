import { describe, expect, test } from 'bun:test';
import { classifySessionEvent } from '../../src/hooks/session-lock-classifier.ts';

describe('classifySessionEvent', () => {
  test('unlocked: any event is match (caller handles locking)', () => {
    expect(
      classifySessionEvent({
        currentLock: null,
        incomingSessionId: 'any-id',
        mainPtyRunning: true,
        mainSessionEnded: false,
      }),
    ).toBe('match');
  });

  test('same session_id as lock: match', () => {
    expect(
      classifySessionEvent({
        currentLock: 'main-abc',
        incomingSessionId: 'main-abc',
        mainPtyRunning: true,
        mainSessionEnded: false,
      }),
    ).toBe('match');
  });

  test('different session_id + PTY running + not ended: foreign (subagent/sibling)', () => {
    expect(
      classifySessionEvent({
        currentLock: 'main-abc',
        incomingSessionId: 'subagent-xyz',
        mainPtyRunning: true,
        mainSessionEnded: false,
      }),
    ).toBe('foreign');
  });

  test('different session_id + PTY exited: restart', () => {
    expect(
      classifySessionEvent({
        currentLock: 'main-abc',
        incomingSessionId: 'new-main-def',
        mainPtyRunning: false,
        mainSessionEnded: false,
      }),
    ).toBe('restart');
  });

  test('different session_id + main ended (PTY may still be alive): restart', () => {
    expect(
      classifySessionEvent({
        currentLock: 'main-abc',
        incomingSessionId: 'new-main-def',
        mainPtyRunning: true,
        mainSessionEnded: true,
      }),
    ).toBe('restart');
  });

  test('different session_id + PTY exited + ended: restart', () => {
    expect(
      classifySessionEvent({
        currentLock: 'main-abc',
        incomingSessionId: 'new-main-def',
        mainPtyRunning: false,
        mainSessionEnded: true,
      }),
    ).toBe('restart');
  });

  test('realistic background team spawn: foreign', () => {
    // User runs `remi --auto-approve` and the agent spawns background teams.
    // Teams have different session_ids but fire hooks to the same server.
    // Must NOT hijack our lock.
    expect(
      classifySessionEvent({
        currentLock: 'user-main-1234',
        incomingSessionId: 'team-agent-5678',
        mainPtyRunning: true,
        mainSessionEnded: false,
      }),
    ).toBe('foreign');
  });

  test('realistic Claude crash + user restarts: restart', () => {
    // Claude in our PTY crashed without emitting SessionEnd. User kills remi
    // and restarts. Our PTY is no longer running.
    expect(
      classifySessionEvent({
        currentLock: 'dead-main-1111',
        incomingSessionId: 'fresh-main-2222',
        mainPtyRunning: false,
        mainSessionEnded: false,
      }),
    ).toBe('restart');
  });

  test('realistic clean Claude exit then reopen: restart', () => {
    // Clean exit → SessionEnd → user /resume → new session_id.
    expect(
      classifySessionEvent({
        currentLock: 'old-main-1111',
        incomingSessionId: 'resumed-main-2222',
        mainPtyRunning: true,
        mainSessionEnded: true,
      }),
    ).toBe('restart');
  });
});
