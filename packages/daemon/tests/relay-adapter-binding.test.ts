/**
 * Verifies the relay adapter's routeMessage forwards `claudeSessionId`
 * to onUserInput / onAnswer (#429). Pre-fix the field was silently
 * dropped, so relay-mode clients bypassed the daemon's stale-binding
 * guard entirely.
 */

import { describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import { RelayAdapter } from '../src/remote/relay-adapter.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const SID = 'sess0000-0000-0000-0000-000000000000' as UUID;
const QID = 'ques0000-0000-0000-0000-000000000000' as UUID;
const CSID = '11111111-2222-3333-4444-555555555555';

function makeAdapter(events: object): RelayAdapter {
  const adapter = new RelayAdapter({ signalingUrl: 'wss://ignored.example.com' }, events);
  // routeMessage is private and needs clientConnectionId; this matches
  // the assignment that happens in the real auth flow.
  (adapter as unknown as { clientConnectionId: UUID }).clientConnectionId = CID;
  return adapter;
}

function callRoute(adapter: RelayAdapter, msg: Record<string, unknown>): void {
  (adapter as unknown as { routeMessage: (m: Record<string, unknown>) => void }).routeMessage(msg);
}

describe('relay-adapter routeMessage forwards claudeSessionId (#429)', () => {
  test('user_input with claudeSessionId is forwarded as the 5th arg', () => {
    const calls: Array<{ claudeSessionId: string | undefined }> = [];
    const adapter = makeAdapter({
      onUserInput: (
        _connectionId: UUID,
        _sessionId: UUID,
        _content: string,
        _raw?: boolean,
        claudeSessionId?: string,
      ) => {
        calls.push({ claudeSessionId });
      },
    });

    callRoute(adapter, {
      type: 'user_input',
      sessionId: SID,
      content: 'ls',
      raw: false,
      claudeSessionId: CSID,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.claudeSessionId).toBe(CSID);
  });

  test('user_input without claudeSessionId forwards undefined (back-compat)', () => {
    const calls: Array<{ claudeSessionId: string | undefined }> = [];
    const adapter = makeAdapter({
      onUserInput: (
        _connectionId: UUID,
        _sessionId: UUID,
        _content: string,
        _raw?: boolean,
        claudeSessionId?: string,
      ) => {
        calls.push({ claudeSessionId });
      },
    });

    callRoute(adapter, {
      type: 'user_input',
      sessionId: SID,
      content: 'ls',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.claudeSessionId).toBeUndefined();
  });

  test('answer with claudeSessionId is forwarded as the 5th arg', () => {
    const calls: Array<{ claudeSessionId: string | undefined }> = [];
    const adapter = makeAdapter({
      onAnswer: (
        _connectionId: UUID,
        _sessionId: UUID,
        _questionId: UUID,
        _answer: string,
        claudeSessionId?: string,
      ) => {
        calls.push({ claudeSessionId });
      },
    });

    callRoute(adapter, {
      type: 'answer',
      sessionId: SID,
      questionId: QID,
      answer: 'y',
      claudeSessionId: CSID,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.claudeSessionId).toBe(CSID);
  });

  test('non-string claudeSessionId is dropped to undefined (defensive)', () => {
    const calls: Array<{ claudeSessionId: string | undefined }> = [];
    const adapter = makeAdapter({
      onAnswer: (
        _connectionId: UUID,
        _sessionId: UUID,
        _questionId: UUID,
        _answer: string,
        claudeSessionId?: string,
      ) => {
        calls.push({ claudeSessionId });
      },
    });

    callRoute(adapter, {
      type: 'answer',
      sessionId: SID,
      questionId: QID,
      answer: 'y',
      claudeSessionId: 42,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.claudeSessionId).toBeUndefined();
  });
});
