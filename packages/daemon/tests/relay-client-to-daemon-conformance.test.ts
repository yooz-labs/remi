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
 * daemon-side adapter expects. The client half is therefore played by
 * `remote/relay-test-peer.ts` from the shared crypto primitives, the same way
 * `remote/relay-encryption.test.ts` does it. These tests prove the daemon's
 * dispatch, not interoperability with a client.
 *
 * What is real: the shipping `RelayAdapter`
 * (packages/daemon/src/remote/relay-adapter.ts), a real `Authenticator` over a
 * real `IdentityStore`, a real Ed25519 challenge-response, a real key exchange
 * and AES-GCM sealing of every inbound payload. Only the signaling Worker
 * connection is replaced, through the adapter's `createTransport` seam,
 * documented in relay-adapter.ts as existing "so a test can stand in for the
 * transport without a network or a Worker" (#543).
 *
 * The adapter runs in permanent-code mode because that is the only mode that
 * accepts a peer (#1193): without an authenticator it refuses every peer, which
 * `remote/relay-fail-closed.test.ts` pins.
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
import { MESSAGE_DIRECTION, createCreateSessionRequest, deserialize } from '@remi/shared';
import type { ProtocolMessage, ProtocolMessageMap, UUID } from '@remi/shared';
import type { AdapterEvents } from '../src/adapters/connection-adapter.ts';
import {
  type AuthenticatedRelayPeer,
  startAuthenticatedRelayPeer,
} from './remote/relay-test-peer.ts';

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
  recent_repositories_request: 'onRecentRepositoriesRequest',
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

describe('daemon inbound dispatch: RelayAdapter transport-seam conformance (#899, NOT end-to-end)', () => {
  let peer: AuthenticatedRelayPeer;
  let connectionId: UUID | null = null;
  const eventCalls: Array<{ event: string; args: unknown[] }> = [];

  function record(event: string) {
    return (...args: unknown[]) => {
      eventCalls.push({ event, args });
    };
  }

  beforeEach(async () => {
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
      onRecentRepositoriesRequest: record('onRecentRepositoriesRequest'),
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

    peer = await startAuthenticatedRelayPeer(events);
    if (!connectionId) throw new Error('the handshake did not fire onConnect');
    // Reset AFTER the connect handshake so each test's assertions only see
    // calls caused by the message it emits, not the setup's own onConnect.
    eventCalls.length = 0;
  });

  afterEach(async () => {
    await peer.dispose();
  });

  test('every ClientToDaemonType has a fixture, and the set is exactly the 19 INBOUND_ROUTED types', () => {
    for (const type of C2D_TYPES) {
      expect(() => loadFixture(type)).not.toThrow();
    }
    expect(C2D_TYPES.length).toBe(19);
  });

  describe.each(C2D_TYPES.filter((t) => EXPECTED_EVENT[t]))('%s', (type) => {
    test('emitted relay message is routed to the correct real AdapterEvents callback', async () => {
      const fixture = loadFixture(type);
      await peer.send(fixture, () => eventCalls.length > 0);

      expect(eventCalls).toHaveLength(1);
      expect(eventCalls[0]?.event).toBe(EXPECTED_EVENT[type]);
      expect(eventCalls[0]?.args[0]).toBe(connectionId);
      // No rejection was sent back for a type the router does recognize.
      expect(peer.sentAfterHandshake()).toHaveLength(0);
    });
  });

  test('a create request carries its harness and args to onCreateSessionRequest as extra (#1179)', async () => {
    // The shipping factory builds the request, as the CLI and the web client do.
    const request = createCreateSessionRequest('/work/project', {
      harness: 'codex',
      args: ['-m', 'some-model'],
    });
    await peer.send(request);

    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]?.event).toBe('onCreateSessionRequest');
    // onCreateSessionRequest(connectionId, directory, requestId, extra)
    expect(eventCalls[0]?.args.slice(1)).toEqual([
      '/work/project',
      request.id,
      { harness: 'codex', args: ['-m', 'some-model'] },
    ]);
  });

  test('a plain create request has no extra, and a hostile one reaches the handler untouched to be refused there (#1179)', async () => {
    await peer.send(createCreateSessionRequest('/work/project'));
    expect(eventCalls[0]?.args[3]).toBeUndefined();

    // Nothing is validated in the transport: a field that is not what the type says flows
    // through for the handler's trust-boundary checks, as every other field does.
    eventCalls.length = 0;
    const hostile = {
      ...createCreateSessionRequest('/work/project'),
      harness: 5,
      args: 'not an array',
    } as unknown as ProtocolMessage;
    await peer.send(hostile);
    expect(eventCalls[0]?.args[3]).toEqual({ harness: 5, args: 'not an array' });
  });

  test('answer selections/cancel are forwarded as extra over relay (#899: previously dropped)', async () => {
    const fixture = loadFixture('answer');
    if (fixture.type !== 'answer') throw new Error('unreachable');
    const withSelections: ProtocolMessage = {
      ...fixture,
      answer: '',
      selections: [{ questionIndex: 0, optionIndices: [1] }],
    };
    await peer.send(withSelections, () => eventCalls.length > 0);

    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]?.event).toBe('onAnswer');
    // onAnswer(connectionId, sessionId, questionId, answer, claudeSessionId, extra)
    expect(eventCalls[0]?.args[5]).toEqual({
      selections: [{ questionIndex: 0, optionIndices: [1] }],
      cancel: undefined,
    });
  });

  test('a free-text AskUserQuestion answer (AnswerSelection.text) is forwarded verbatim over relay (#1127)', async () => {
    const fixture = loadFixture('answer');
    if (fixture.type !== 'answer') throw new Error('unreachable');
    const selections = [
      { questionIndex: 0, optionIndices: [], text: 'Teal with a hint of gold' },
      { questionIndex: 1, optionIndices: [0, 2] },
    ];
    await peer.send({ ...fixture, answer: '', selections }, () => eventCalls.length > 0);

    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]?.event).toBe('onAnswer');
    expect(eventCalls[0]?.args[5]).toEqual({ selections, cancel: undefined });
  });

  test("a held card's deny message is forwarded as extra.message over relay (#1126)", async () => {
    const fixture = loadFixture('answer');
    if (fixture.type !== 'answer') throw new Error('unreachable');
    const withMessage: ProtocolMessage = {
      ...fixture,
      answer: 'No',
      message: 'run the tests first',
    };
    await peer.send(withMessage, () => eventCalls.length > 0);

    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]?.event).toBe('onAnswer');
    const extra = eventCalls[0]?.args[5] as { message?: string } | undefined;
    expect(extra?.message).toBe('run the tests first');
  });

  test('hello over relay is a no-op: connection is already established via peer-connected', async () => {
    const fixture = loadFixture('hello');
    await peer.send(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(peer.sentAfterHandshake()).toHaveLength(0);
  });

  test('ping over relay is a no-op: no reply needed', async () => {
    const fixture = loadFixture('ping');
    await peer.send(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(peer.sentAfterHandshake()).toHaveLength(0);
  });

  // #899's trap, pinned end-to-end through the real adapter's real 'relay'
  // event path: before this unification, relay's routeMessage switch had no
  // case for 'pong'/'ack' at all, so both were rejected as UNSUPPORTED even
  // though MESSAGE_DIRECTION tags both 'both' (real client-to-daemon
  // types) and connection.ts has always accepted them as no-ops.
  test('pong over relay does not produce an UNSUPPORTED rejection (#899 trap)', async () => {
    const fixture = loadFixture('pong');
    await peer.send(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(peer.sentAfterHandshake()).toHaveLength(0);
  });

  test('ack over relay does not produce an UNSUPPORTED rejection (#899 trap)', async () => {
    const fixture = loadFixture('ack');
    await peer.send(fixture);

    expect(eventCalls).toHaveLength(0);
    expect(peer.sentAfterHandshake()).toHaveLength(0);
  });

  test('a genuinely unregistered type is rejected as UNSUPPORTED, naming the type (control)', async () => {
    const bogus = {
      type: 'totally_unknown_future_type',
      id: 'bogus-id',
      timestamp: new Date().toISOString(),
    } as unknown as ProtocolMessage;
    await peer.send(bogus, () => peer.sentAfterHandshake().length > 0);

    expect(eventCalls).toHaveLength(0);
    expect(peer.sentAfterHandshake()).toHaveLength(1);
    const parsed = JSON.parse(peer.sentAfterHandshake()[0] as string);
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('UNSUPPORTED');
    expect(parsed.message).toContain('totally_unknown_future_type');
  });

  test('a registered d2c-only type arriving over relay is rejected as UNSUPPORTED', async () => {
    // 'question' is a real registry type but tagged 'd2c' -- not a key in
    // the relay's handler map. Preserves relay's pre-#899 behavior for this
    // exact scenario (see connection.ts's analogous UNKNOWN_MESSAGE case in
    // the web-side conformance test).
    const fixture = loadFixture('question');
    await peer.send(fixture, () => peer.sentAfterHandshake().length > 0);

    expect(eventCalls).toHaveLength(0);
    expect(peer.sentAfterHandshake()).toHaveLength(1);
    const parsed = JSON.parse(peer.sentAfterHandshake()[0] as string);
    expect(parsed.code).toBe('UNSUPPORTED');
    expect(parsed.message).toContain('question');
  });
});
