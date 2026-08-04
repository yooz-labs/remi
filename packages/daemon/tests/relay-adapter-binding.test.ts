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

  // #899: routeMessage's ad-hoc `typeof claudeSessionId === 'string'` guard
  // (pre-unification) is GONE, not relocated -- connection.ts's inbound
  // switch never had an equivalent guard either (it forwards
  // `message.claudeSessionId` straight from the parsed JSON, trusting the
  // type system same as every other field). This test now pins the new,
  // unified behavior instead of the old defensive one: a malformed field
  // is forwarded as-is, matching the direct-WebSocket path exactly.
  test('non-string claudeSessionId is forwarded as-is (#899 parity with connection.ts)', () => {
    const calls: Array<{ claudeSessionId: unknown }> = [];
    const adapter = makeAdapter({
      onAnswer: (
        _connectionId: UUID,
        _sessionId: UUID,
        _questionId: UUID,
        _answer: string,
        claudeSessionId?: unknown,
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
    expect(calls[0]?.claudeSessionId).toBe(42);
  });

  // #899: previously dropped over relay -- connection.ts's handleAnswer has
  // always forwarded the structured AskUserQuestion selections/cancel
  // (#627) alongside a plain answer, but the pre-unification relay switch
  // never computed the equivalent `extra` argument at all. Found while
  // unifying the two dispatchers onto the same handler body.
  test('answer selections/cancel are forwarded as extra (#899: previously dropped over relay)', () => {
    const calls: Array<{ extra: unknown }> = [];
    const adapter = makeAdapter({
      onAnswer: (
        _connectionId: UUID,
        _sessionId: UUID,
        _questionId: UUID,
        _answer: string,
        _claudeSessionId?: string,
        extra?: unknown,
      ) => {
        calls.push({ extra });
      },
    });

    callRoute(adapter, {
      type: 'answer',
      sessionId: SID,
      questionId: QID,
      answer: '',
      selections: [{ questionIndex: 0, optionIndices: [1] }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.extra).toEqual({
      selections: [{ questionIndex: 0, optionIndices: [1] }],
      cancel: undefined,
    });
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

  // #899: routeMessage's ad-hoc `platform !== 'ios' && platform !== 'android'`
  // guard (pre-unification) is GONE, not relocated -- connection.ts's
  // handleRegisterDeviceToken never validated this field either. Pins the
  // new, unified (permissive) behavior instead of the old defensive one.
  test('register_device_token with an unrecognized platform is forwarded as-is (#899 parity)', () => {
    const calls: Array<{ token: string; platform: unknown }> = [];
    const adapter = makeAdapter({
      onRegisterDeviceToken: (_c: UUID, token: string, platform: unknown) => {
        calls.push({ token, platform });
      },
    });

    callRoute(adapter, { type: 'register_device_token', token: 'abc123', platform: 'windows' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe('abc123');
    expect(calls[0]?.platform).toBe('windows');
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

  // #899: routeMessage's ad-hoc `typeof token !== 'string'` guard
  // (pre-unification) is GONE, not relocated -- connection.ts's
  // handleUnregisterDeviceToken never validated this field either
  // (`this.events.onUnregisterDeviceToken?.(message.token)`, no check).
  // Pins the new, unified (permissive) behavior instead of the old
  // defensive one.
  test('unregister_device_token with a missing token forwards undefined (#899 parity)', () => {
    const calls: Array<{ token: unknown }> = [];
    const adapter = makeAdapter({
      onUnregisterDeviceToken: (_c: UUID, token: unknown) => {
        calls.push({ token });
      },
    });

    callRoute(adapter, { type: 'unregister_device_token' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBeUndefined();
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

  // #899's trap, pinned at the relay call site: before this unification,
  // relay's routeMessage switch had no `case 'ack'` or `case 'pong'` at all,
  // so both fell to the default branch and got rejected as UNSUPPORTED --
  // even though `ack`/`pong` are legitimate client-to-daemon types
  // (MESSAGE_DIRECTION tags both 'both', not 'd2c') and connection.ts's
  // direct-WebSocket switch has always accepted them as no-ops. A
  // `ClientToDaemonType` derived as "tagged c2d" (excluding 'both') would
  // have reproduced exactly this bug in the unified router; deriving it as
  // "not d2c" is what fixes it here.
  test('ack is a no-op over relay: no UNSUPPORTED rejection (#899 trap)', () => {
    const adapter = makeAdapter({});
    const sent = attachSendRelaySpy(adapter);

    callRoute(adapter, { type: 'ack', id: RID, ack: { messageId: RID, state: 'delivered' } });

    expect(sent).toHaveLength(0);
  });

  test('pong is a no-op over relay: no UNSUPPORTED rejection (#899 trap)', () => {
    const adapter = makeAdapter({});
    const sent = attachSendRelaySpy(adapter);

    callRoute(adapter, { type: 'pong', id: RID, pingId: RID });

    expect(sent).toHaveLength(0);
  });

  test('hello is a no-op over relay (connection established via peer-connected, not message)', () => {
    const adapter = makeAdapter({});
    const sent = attachSendRelaySpy(adapter);

    callRoute(adapter, { type: 'hello', id: RID });

    expect(sent).toHaveLength(0);
  });

  // In real operation, `handleRelayMessage` intercepts `auth_response`
  // BEFORE `routeMessage` is ever called (state-gated, unconditional -- see
  // relay-adapter.ts's `handleRelayMessage`), so the map's `auth_response`
  // entry cannot be reached this way outside a test. This proves the entry
  // itself is real (not missing / not silently rejected) by calling
  // routeMessage directly, bypassing that earlier interception -- the entry
  // exists purely for exhaustiveness + defense in depth (#899), and this is
  // the only way to exercise it at all.
  test('auth_response reaching routeMessage directly is routed, not rejected as UNSUPPORTED (#899)', () => {
    const adapter = makeAdapter({});
    const sent = attachSendRelaySpy(adapter);

    callRoute(adapter, {
      type: 'auth_response',
      id: RID,
      clientPublicKey: 'base64-pubkey',
      signature: 'base64-sig',
      clientFingerprint: 'AA:BB:CC:DD',
    });

    // handleAuthResponse's own state guard (authState is 'none' here, not
    // 'challenging') makes it a no-op with a console.warn -- the point of
    // this test is only that it got THAT far, i.e. NOT rejected as
    // UNSUPPORTED the way a missing map entry would have been.
    expect(sent).toHaveLength(0);
  });
});
