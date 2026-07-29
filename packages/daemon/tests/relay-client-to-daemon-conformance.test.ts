/**
 * Two-sided conformance test for the C6 daemon inbound-dispatch unification
 * (#899): the RELAY transport.
 *
 * Companion to `packages/web/tests/lib/client-to-daemon-conformance.test.ts`,
 * which covers the same client-to-daemon fixture set over the direct
 * WebSocket transport with a real daemon `WebSocketAdapter` AND a real web
 * `WebSocketClient` on both ends.
 *
 * ## This is NOT an end-to-end relay test -- said plainly, per AGENTS.md
 * "Verify before you describe"
 *
 * The relay has no real client-side implementation to drive the other end
 * of the wire: #881 is that the web client's key-exchange half was never
 * built, so a real remote client cannot complete the relay handshake this
 * daemon-side adapter expects. Building a second, parallel client
 * implementation just for this test would itself be exactly the kind of
 * synthetic counterparty AGENTS.md warns about (`relay-encryption.test.ts`
 * drove the daemon with a test-local client that performed a handshake step
 * no real client did, and #543 shipped half-built as a result).
 *
 * Instead, this drives the REAL, shipping `RelayAdapter`
 * (packages/daemon/src/remote/relay-adapter.ts) through its `createTransport`
 * seam -- a `RelayTransport` stand-in, documented in relay-adapter.ts as
 * existing "so a test can stand in for the transport without a network or a
 * Worker" (#543). The daemon-side class, its handler map, and its dispatch
 * logic are all real and unmodified; only the signaling Worker connection is
 * replaced with a fake event emitter that a real client's traffic would look
 * identical to on the wire (plain JSON `ProtocolMessage` payloads emitted on
 * a `relay` event, matching what `handleRelayMessage` expects once
 * authenticated). No `authenticator` is configured here (default
 * rotating-code mode), so the adapter accepts the fake peer immediately on
 * `peer-connected` without needing to fake the Ed25519 challenge-response.
 *
 * For every `ClientToDaemonType` this asserts the daemon's real
 * `AdapterEvents` callback fires. `hello`/`ping`/`pong`/`ack` are explicit
 * no-ops over relay by design (see relay-adapter.ts's handler map) and get
 * dedicated tests instead of a generic "some event fired" assertion.
 * `auth_response` is proven separately in `relay-adapter-binding.test.ts`
 * (it is intercepted by `handleRelayMessage` before the unified router is
 * ever reached in real operation, so it cannot be exercised through this
 * `relay` event path at all).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_DIRECTION, deserialize } from '@remi/shared';
import type { ProtocolMessage, ProtocolMessageMap, UUID } from '@remi/shared';
import type { AdapterEvents } from '../src/adapters/connection-adapter.ts';
import { RelayAdapter, type RelayTransport } from '../src/remote/relay-adapter.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '../../shared/tests/fixtures/protocol');

function loadFixture(type: string): ProtocolMessage {
  const raw = readFileSync(join(FIXTURES_DIR, `${type}.json`), 'utf-8');
  const msg = deserialize(raw);
  if (!msg) throw new Error(`fixture ${type}.json failed to deserialize`);
  return msg;
}

/** Every type the daemon can legitimately receive from a client (mirrors
 *  ClientToDaemonType at runtime -- see the web-side conformance test's
 *  identical definition for the full rationale). */
const C2D_TYPES = (Object.keys(MESSAGE_DIRECTION) as (keyof ProtocolMessageMap)[]).filter(
  (t) => MESSAGE_DIRECTION[t] !== 'd2c',
);

const EXPECTED_EVENT: Partial<Record<keyof ProtocolMessageMap, string>> = {
  user_input: 'onUserInput',
  answer: 'onAnswer',
  bullet_expand_request: 'onBulletExpandRequest',
  session_list_request: 'onSessionListRequest',
  transcript_load_request: 'onTranscriptLoadRequest',
  create_session_request: 'onCreateSessionRequest',
  terminal_resize: 'onTerminalResize',
  kill_session_request: 'onKillSessionRequest',
  resume_session_request: 'onResumeSessionRequest',
  session_history_request: 'onSessionHistoryRequest',
  detach_session: 'onDetachSession',
  register_device_token: 'onRegisterDeviceToken',
  unregister_device_token: 'onUnregisterDeviceToken',
};

/**
 * Stands in for `SignalingClient` (the real Worker transport) via the seam
 * `RelayAdapter` already exposes for exactly this. A real client's traffic
 * looks identical to `emitRelay` on the wire once past the handshake: plain
 * JSON `ProtocolMessage` payloads. `sent` records everything the adapter
 * tried to send back (`sendRelay`), the same seam production code uses for
 * challenges, auth results, and error replies.
 */
class FakeRelayTransport implements RelayTransport {
  readonly isConnected = true;
  readonly connectionCode: string | null = 'TEST-CODE';
  readonly sent: string[] = [];
  // Matches RelayTransport's own catch-all `on` overload (`any[]`, same reason: the emitter is heterogeneous by design).
  // biome-ignore lint/suspicious/noExplicitAny: matches RelayTransport's catch-all overload
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  // biome-ignore lint/suspicious/noExplicitAny: implements RelayTransport's catch-all overload signature
  on(event: string, cb: (...args: any[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  // biome-ignore lint/suspicious/noExplicitAny: forwarding whatever `on` was registered with
  private fire(event: string, ...args: any[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  sendRelay(payload: string): void {
    this.sent.push(payload);
  }

  connect(): void {}
  close(): void {}

  /** Simulate the peer (client) connecting -- fires the adapter's real
   *  `peer-connected` handler. */
  emitPeerConnected(): void {
    this.fire('peer-connected');
  }

  /** Simulate the peer sending one plaintext protocol message -- fires the
   *  adapter's real `relay` handler, exactly as an authenticated client's
   *  traffic would (no `sessionKeys` here since no authenticator is
   *  configured, so the adapter processes it as plaintext, matching #881:
   *  the DEFAULT rotating-code path never derives session keys). */
  emitRelay(message: ProtocolMessage): void {
    this.fire('relay', JSON.stringify(message));
  }
}

describe('daemon inbound dispatch: RelayAdapter transport-seam conformance (#899, NOT end-to-end)', () => {
  let transport: FakeRelayTransport;
  let adapter: RelayAdapter;
  let connectionId: UUID | null = null;
  const eventCalls: Array<{ event: string; args: unknown[] }> = [];

  function record(event: string) {
    return (...args: unknown[]) => {
      eventCalls.push({ event, args });
    };
  }

  beforeEach(async () => {
    transport = new FakeRelayTransport();
    connectionId = null;
    eventCalls.length = 0;
    const events: Partial<AdapterEvents> = {
      onConnect: (id) => {
        connectionId = id;
        record('onConnect')(id);
      },
      onDisconnect: record('onDisconnect'),
      onUserInput: record('onUserInput'),
      onAnswer: record('onAnswer'),
      onBulletExpandRequest: record('onBulletExpandRequest'),
      onSessionListRequest: record('onSessionListRequest'),
      onTranscriptLoadRequest: record('onTranscriptLoadRequest'),
      onCreateSessionRequest: record('onCreateSessionRequest'),
      onTerminalResize: record('onTerminalResize'),
      onKillSessionRequest: record('onKillSessionRequest'),
      onResumeSessionRequest: record('onResumeSessionRequest'),
      onSessionHistoryRequest: record('onSessionHistoryRequest'),
      onDetachSession: record('onDetachSession'),
      onRegisterDeviceToken: record('onRegisterDeviceToken'),
      onUnregisterDeviceToken: record('onUnregisterDeviceToken'),
    };

    adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: 'wss://ignored.example.com',
        createTransport: () => transport,
      },
      events,
    );
    await adapter.start();
    transport.emitPeerConnected();
    if (!connectionId) throw new Error('peer-connected did not fire onConnect');
    // Reset AFTER the connect handshake so each test's assertions only see
    // calls caused by the message it emits, not the setup's own onConnect.
    eventCalls.length = 0;
  });

  afterEach(async () => {
    await adapter.stop();
  });

  test('every ClientToDaemonType has a fixture, and the set is exactly the 18 INBOUND_ROUTED types', () => {
    for (const type of C2D_TYPES) {
      expect(() => loadFixture(type)).not.toThrow();
    }
    expect(C2D_TYPES.length).toBe(18);
  });

  describe.each(C2D_TYPES.filter((t) => EXPECTED_EVENT[t]))('%s', (type) => {
    test('emitted relay message is routed to the correct real AdapterEvents callback', () => {
      const fixture = loadFixture(type);
      transport.emitRelay(fixture);

      expect(eventCalls).toHaveLength(1);
      expect(eventCalls[0]?.event).toBe(EXPECTED_EVENT[type]);
      expect(eventCalls[0]?.args[0]).toBe(connectionId);
      // No rejection was sent back for a type the router does recognize.
      expect(transport.sent).toHaveLength(0);
    });
  });

  test('answer selections/cancel are forwarded as extra over relay (#899: previously dropped)', () => {
    const fixture = loadFixture('answer');
    if (fixture.type !== 'answer') throw new Error('unreachable');
    const withSelections: ProtocolMessage = {
      ...fixture,
      answer: '',
      selections: [{ questionIndex: 0, optionIndices: [1] }],
    };
    transport.emitRelay(withSelections);

    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]?.event).toBe('onAnswer');
    // onAnswer(connectionId, sessionId, questionId, answer, claudeSessionId, extra)
    expect(eventCalls[0]?.args[5]).toEqual({
      selections: [{ questionIndex: 0, optionIndices: [1] }],
      cancel: undefined,
    });
  });

  test('hello over relay is a no-op: connection is already established via peer-connected', () => {
    const fixture = loadFixture('hello');
    transport.emitRelay(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  test('ping over relay is a no-op: no reply needed', () => {
    const fixture = loadFixture('ping');
    transport.emitRelay(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  // #899's trap, pinned end-to-end through the real adapter's real 'relay'
  // event path: before this unification, relay's routeMessage switch had no
  // case for 'pong'/'ack' at all, so both were rejected as UNSUPPORTED even
  // though MESSAGE_DIRECTION tags both 'both' (real client-to-daemon
  // types) and connection.ts has always accepted them as no-ops.
  test('pong over relay does not produce an UNSUPPORTED rejection (#899 trap)', () => {
    const fixture = loadFixture('pong');
    transport.emitRelay(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  test('ack over relay does not produce an UNSUPPORTED rejection (#899 trap)', () => {
    const fixture = loadFixture('ack');
    transport.emitRelay(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  test('a genuinely unregistered type is rejected as UNSUPPORTED, naming the type (control)', () => {
    const bogus = {
      type: 'totally_unknown_future_type',
      id: 'bogus-id',
      timestamp: new Date().toISOString(),
    } as unknown as ProtocolMessage;
    transport.emitRelay(bogus);

    expect(eventCalls).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);
    const parsed = JSON.parse(transport.sent[0] as string);
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('UNSUPPORTED');
    expect(parsed.message).toContain('totally_unknown_future_type');
  });

  test('a registered d2c-only type arriving over relay is rejected as UNSUPPORTED', () => {
    // 'question' is a real registry type but tagged 'd2c' -- not a key in
    // the relay's handler map. Preserves relay's pre-#899 behavior for this
    // exact scenario (see connection.ts's analogous UNKNOWN_MESSAGE case in
    // the web-side conformance test).
    const fixture = loadFixture('question');
    transport.emitRelay(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);
    const parsed = JSON.parse(transport.sent[0] as string);
    expect(parsed.code).toBe('UNSUPPORTED');
    expect(parsed.message).toContain('question');
  });
});
