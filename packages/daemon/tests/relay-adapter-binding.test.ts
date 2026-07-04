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

/**
 * Inject a fake SignalingClient whose `sendRelay` records every payload.
 * routeMessage's default (rejection) branch routes through `this.client?.sendRelay`,
 * which is the same seam the real adapter uses for challenges/auth results.
 */
function attachSendRelaySpy(adapter: RelayAdapter): string[] {
  const sent: string[] = [];
  (adapter as unknown as { client: { sendRelay: (p: string) => void } }).client = {
    sendRelay: (payload: string) => {
      sent.push(payload);
    },
  };
  return sent;
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

  test('user_input with id forwards it as messageId, the 6th arg (#681)', () => {
    const calls: Array<{ messageId: string | undefined }> = [];
    const adapter = makeAdapter({
      onUserInput: (
        _connectionId: UUID,
        _sessionId: UUID,
        _content: string,
        _raw?: boolean,
        _claudeSessionId?: string,
        messageId?: string,
      ) => {
        calls.push({ messageId });
      },
    });

    const msgId = 'aaaa1111-2222-3333-4444-555555555555';
    callRoute(adapter, {
      type: 'user_input',
      sessionId: SID,
      content: 'ls',
      id: msgId,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.messageId).toBe(msgId);
  });

  test('user_input without id forwards messageId undefined', () => {
    const calls: Array<{ messageId: string | undefined }> = [];
    const adapter = makeAdapter({
      onUserInput: (
        _connectionId: UUID,
        _sessionId: UUID,
        _content: string,
        _raw?: boolean,
        _claudeSessionId?: string,
        messageId?: string,
      ) => {
        calls.push({ messageId });
      },
    });

    callRoute(adapter, {
      type: 'user_input',
      sessionId: SID,
      content: 'ls',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.messageId).toBeUndefined();
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

describe('relay-adapter routeMessage no-longer-silently-drops requests (#453 phase 5)', () => {
  const RID = 'req00000-0000-0000-0000-000000000000' as UUID;

  test('kill_session_request dispatches onKillSessionRequest with sessionId + requestId', () => {
    const calls: Array<{ connectionId: UUID; sessionId: UUID; requestId: UUID }> = [];
    const adapter = makeAdapter({
      onKillSessionRequest: (connectionId: UUID, sessionId: UUID, requestId: UUID) => {
        calls.push({ connectionId, sessionId, requestId });
      },
    });

    callRoute(adapter, { type: 'kill_session_request', sessionId: SID, id: RID });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.connectionId).toBe(CID);
    expect(calls[0]?.sessionId).toBe(SID);
    expect(calls[0]?.requestId).toBe(RID);
  });

  test('detach_session dispatches onDetachSession with sessionId + requestId', () => {
    const calls: Array<{ connectionId: UUID; sessionId: UUID; requestId: UUID }> = [];
    const adapter = makeAdapter({
      onDetachSession: (connectionId: UUID, sessionId: UUID, requestId: UUID) => {
        calls.push({ connectionId, sessionId, requestId });
      },
    });

    callRoute(adapter, { type: 'detach_session', sessionId: SID, id: RID });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.connectionId).toBe(CID);
    expect(calls[0]?.sessionId).toBe(SID);
    expect(calls[0]?.requestId).toBe(RID);
  });

  test('session_history_request dispatches onSessionHistoryRequest with requestId + limit', () => {
    const calls: Array<{ connectionId: UUID; requestId: UUID; limit: number | undefined }> = [];
    const adapter = makeAdapter({
      onSessionHistoryRequest: (connectionId: UUID, requestId: UUID, limit: number | undefined) => {
        calls.push({ connectionId, requestId, limit });
      },
    });

    callRoute(adapter, { type: 'session_history_request', id: RID, limit: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.connectionId).toBe(CID);
    expect(calls[0]?.requestId).toBe(RID);
    expect(calls[0]?.limit).toBe(5);
  });

  test('session_history_request without limit forwards undefined', () => {
    const calls: Array<{ limit: number | undefined }> = [];
    const adapter = makeAdapter({
      onSessionHistoryRequest: (_c: UUID, _r: UUID, limit: number | undefined) => {
        calls.push({ limit });
      },
    });

    callRoute(adapter, { type: 'session_history_request', id: RID });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.limit).toBeUndefined();
  });

  test('register_device_token with valid platform dispatches onRegisterDeviceToken', () => {
    const calls: Array<{ connectionId: UUID; token: string; platform: 'ios' | 'android' }> = [];
    const adapter = makeAdapter({
      onRegisterDeviceToken: (connectionId: UUID, token: string, platform: 'ios' | 'android') => {
        calls.push({ connectionId, token, platform });
      },
    });

    callRoute(adapter, { type: 'register_device_token', token: 'abc123', platform: 'ios' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.connectionId).toBe(CID);
    expect(calls[0]?.token).toBe('abc123');
    expect(calls[0]?.platform).toBe('ios');
  });

  test('register_device_token with invalid platform is NOT dispatched', () => {
    const calls: Array<{ token: string }> = [];
    const adapter = makeAdapter({
      onRegisterDeviceToken: (_c: UUID, token: string) => {
        calls.push({ token });
      },
    });

    callRoute(adapter, { type: 'register_device_token', token: 'abc123', platform: 'windows' });

    expect(calls).toHaveLength(0);
  });

  test('unregister_device_token dispatches onUnregisterDeviceToken (#690)', () => {
    const calls: Array<{ connectionId: UUID; token: string }> = [];
    const adapter = makeAdapter({
      onUnregisterDeviceToken: (connectionId: UUID, token: string) => {
        calls.push({ connectionId, token });
      },
    });

    callRoute(adapter, { type: 'unregister_device_token', token: 'abc123' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.connectionId).toBe(CID);
    expect(calls[0]?.token).toBe('abc123');
  });

  test('unregister_device_token with missing token is NOT dispatched', () => {
    const calls: Array<{ token: string }> = [];
    const adapter = makeAdapter({
      onUnregisterDeviceToken: (_c: UUID, token: string) => {
        calls.push({ token });
      },
    });

    callRoute(adapter, { type: 'unregister_device_token' });

    expect(calls).toHaveLength(0);
  });

  test('unknown type now rejects via sendRelay with error + UNSUPPORTED (no silent drop)', () => {
    const adapter = makeAdapter({});
    const sent = attachSendRelaySpy(adapter);

    callRoute(adapter, { type: 'bogus_request', id: RID });

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0] as string);
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('UNSUPPORTED');
    expect(typeof parsed.message).toBe('string');
    expect(parsed.message).toContain('bogus_request');
  });

  test('ping is an explicit no-op: no rejection emitted', () => {
    const adapter = makeAdapter({});
    const sent = attachSendRelaySpy(adapter);

    callRoute(adapter, { type: 'ping', id: RID });

    expect(sent).toHaveLength(0);
  });
});
