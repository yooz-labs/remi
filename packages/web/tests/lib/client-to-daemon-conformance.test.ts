/**
 * Two-sided conformance test for the C6 daemon inbound-dispatch unification
 * (#899): the DIRECT WEBSOCKET transport.
 *
 * Companion to `relay-client-to-daemon-conformance.test.ts`
 * (packages/daemon/tests), which covers the same client-to-daemon fixture
 * set over the relay transport via `RelayAdapter`'s `createTransport` seam
 * -- documented there as NOT end-to-end (the relay has no real client
 * implementation to drive the other side of the handshake, #881).
 *
 * This file drives the REAL daemon `WebSocketAdapter` and the REAL web
 * `WebSocketClient` over one real Bun-native socket -- no synthetic
 * counterparty on either side (AGENTS.md "Verify before you describe": #543
 * shipped half-built because `relay-encryption.test.ts` drove the daemon
 * with a test-local client that performed a handshake step no real client
 * did; #881 found it). Both endpoints here are the actual shipping classes,
 * imported directly: `packages/daemon/src/adapters/websocket-adapter.ts`
 * and `packages/web/src/lib/websocket-client.ts`. This mirrors the pattern
 * `message-dispatch-conformance.test.ts` (#897/#912) established for the
 * opposite (daemon-to-client) direction.
 *
 * For every `ClientToDaemonType` (every `MESSAGE_DIRECTION` entry that is
 * NOT `d2c` -- packages/shared/src/protocol.ts), this sends the checked-in
 * golden fixture from the real client and asserts the daemon's real
 * `AdapterEvents` callback fires with the right connection id. `hello`,
 * `auth_response`, `ping`, `pong`, and `ack` have no app-level event (by
 * design -- see `connection.ts`'s handler map) and get dedicated tests
 * instead of a generic "some event fired" assertion.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProtocolMessage, ProtocolMessageMap } from '@remi/shared/protocol.ts';
import { MESSAGE_DIRECTION, createHello, deserialize, generateId } from '@remi/shared/protocol.ts';
import type { AdapterEvents } from '../../../daemon/src/adapters/connection-adapter.ts';
// Real daemon adapter -- not a test double. Relative import: packages/web has
// no `@remi/daemon` path alias, so this stays a relative path even though
// `packages/web/tests/**` is now typechecked too (`typecheck:web-tests`,
// #946 -- it was exempt from both gates before that); see
// message-dispatch-conformance.test.ts's "conformance-test placement
// decision" comment for the precedent this follows).
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter.ts';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers.ts';
import { WebSocketClient } from '../../src/lib/websocket-client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '../../../shared/tests/fixtures/protocol');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await wait(10);
  }
  if (!predicate()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}

/** Every type the daemon can legitimately receive from a client, per the
 *  registry's own direction table -- 'c2d' or 'both', never 'd2c'. Mirrors
 *  `ClientToDaemonType` (packages/shared/src/protocol.ts) at runtime; see
 *  `protocol-registry.test.ts`'s independently hand-transcribed
 *  `INBOUND_ROUTED` list for the pin on the type-level derivation itself. */
const C2D_TYPES = (Object.keys(MESSAGE_DIRECTION) as (keyof ProtocolMessageMap)[]).filter(
  (t) => MESSAGE_DIRECTION[t] !== 'd2c',
);

/** Types with no app-level `AdapterEvents` callback by design (connection
 *  setup, liveness, or acknowledgment) -- covered by dedicated tests below
 *  instead of the generic per-type loop. */
const NO_EVENT_TYPES = new Set(['hello', 'auth_response', 'ping', 'pong', 'ack']);

/** Maps each c2d type with a real handler to the `AdapterEvents` callback
 *  name `connection.ts`'s (and the unified router's) handler map invokes. */
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

function loadFixture(type: string): ProtocolMessage {
  const raw = readFileSync(join(FIXTURES_DIR, `${type}.json`), 'utf-8');
  const msg = deserialize(raw);
  if (!msg) throw new Error(`fixture ${type}.json failed to deserialize`);
  return msg;
}

describe('daemon inbound dispatch: real web client -> real daemon adapter conformance (#899)', () => {
  let adapter: WebSocketAdapter;
  let port: number;
  let client: WebSocketClient;
  let connectionId: string | null = null;
  const eventCalls: Array<{ event: string; args: unknown[] }> = [];
  const received: ProtocolMessage[] = [];

  function record(event: string) {
    return (...args: unknown[]) => {
      eventCalls.push({ event, args });
    };
  }

  beforeAll(async () => {
    port = await reserveRange(1);
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
      onError: record('onError'),
    };
    adapter = new WebSocketAdapter({ port }, events);
    await adapter.start();

    client = new WebSocketClient(
      // 'localhost', not '127.0.0.1' -- see message-dispatch-conformance.test.ts.
      { url: `ws://localhost:${port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 },
      { onMessage: (msg) => received.push(msg) },
    );
    client.connect();
    await waitFor(() => client.isConnected || client.isTransportOpen);

    client.send(createHello(generateId(), '0.0.0-test'));
    await waitFor(() => connectionId !== null);
  });

  afterAll(async () => {
    client.disconnect();
    await adapter.stop();
  });

  test('every ClientToDaemonType has a fixture, and the set is exactly the 18 INBOUND_ROUTED types', () => {
    for (const type of C2D_TYPES) {
      expect(() => loadFixture(type)).not.toThrow();
    }
    // Pinned count, independent of protocol-registry.test.ts's own
    // hand-transcribed INBOUND_ROUTED list -- if this drifts, so should that
    // list, and a mismatch between the two is exactly the kind of silent
    // drift #899 exists to make loud.
    expect(C2D_TYPES.length).toBe(18);
  });

  describe.each(C2D_TYPES.filter((t) => EXPECTED_EVENT[t]))('%s', (type) => {
    test('real client send is routed to the correct real AdapterEvents callback', async () => {
      const fixture = loadFixture(type);
      const before = eventCalls.length;
      client.send(fixture);

      await waitFor(() => eventCalls.length > before);
      const call = eventCalls[eventCalls.length - 1];
      // Guaranteed by the describe.each filter above; TS can't see through
      // that filter into this callback, so prove it rather than assert `!`.
      const expectedEvent = EXPECTED_EVENT[type];
      if (!expectedEvent) throw new Error(`unreachable: ${type} has no EXPECTED_EVENT entry`);
      expect(call?.event).toBe(expectedEvent);
      // First positional arg on every AdapterEvents callback is connectionId.
      expect(call?.args[0]).toBe(connectionId);
    });
  });

  test('sanity: every EXPECTED_EVENT key is a real c2d type covered by the loop above', () => {
    for (const type of Object.keys(EXPECTED_EVENT)) {
      expect(C2D_TYPES).toContain(type as keyof ProtocolMessageMap);
    }
  });

  // NO_EVENT_TYPES documents which c2d types deliberately have no
  // AdapterEvents callback; this is the other half of the completeness
  // invariant the type's own doc comment describes -- until #946, nothing
  // asserted it, so a new c2d type added to the registry without an
  // EXPECTED_EVENT entry (and not added here either) would silently fall
  // through both this loop and the generic one above.
  test('sanity: every C2D type is covered by EXPECTED_EVENT or NO_EVENT_TYPES', () => {
    for (const type of C2D_TYPES) {
      const covered = type in EXPECTED_EVENT || NO_EVENT_TYPES.has(type);
      expect(covered).toBe(true);
    }
  });

  // --- Dedicated tests for the 5 no-app-event types ---

  test('ping is routed to handlePing: the real client receives a real pong back', async () => {
    const fixture = loadFixture('ping');
    const before = received.length;
    client.send(fixture);

    await waitFor(() => received.slice(before).some((m) => m.type === 'pong'));
    const pong = received.slice(before).find((m) => m.type === 'pong');
    expect(pong?.type).toBe('pong');
    if (pong?.type !== 'pong') throw new Error('unreachable');
    expect(pong.pingId).toBe(fixture.id);
  });

  test('pong is a routed no-op: no error comes back', async () => {
    const fixture = loadFixture('pong');
    const beforeErrors = eventCalls.filter((c) => c.event === 'onError').length;
    const beforeReceived = received.length;
    client.send(fixture);

    // No positive signal to wait on for a no-op -- give routing a beat, then
    // assert nothing negative happened.
    await wait(150);
    expect(eventCalls.filter((c) => c.event === 'onError').length).toBe(beforeErrors);
    const newErrors = received
      .slice(beforeReceived)
      .filter((m) => m.type === 'error' && m.code === 'UNKNOWN_MESSAGE');
    expect(newErrors).toHaveLength(0);
  });

  // The direct #899 trap check: before this unification, deriving
  // ClientToDaemonType as "tagged c2d" (excluding 'both') would have
  // silently dropped `ack` from the handler map, and the unified router
  // would then reject a real `ack` with UNKNOWN_MESSAGE -- a message
  // connection.ts's switch has always accepted as a no-op. This pins that
  // it still does not, against the REAL daemon over a REAL socket.
  test('ack does not produce UNKNOWN_MESSAGE (#899 trap, pinned end-to-end)', async () => {
    const fixture = loadFixture('ack');
    const beforeReceived = received.length;
    client.send(fixture);

    await wait(150);
    const unknownMessageErrors = received
      .slice(beforeReceived)
      .filter((m) => m.type === 'error' && m.code === 'UNKNOWN_MESSAGE');
    expect(unknownMessageErrors).toHaveLength(0);
  });

  // auth_response arriving outside the authenticating state (this daemon
  // has no authenticator configured) is routed to a REAL handler
  // (`handleAuthResponse`, via connection.ts's `auth_response` map entry)
  // that answers a specific INVALID_STATE, not the generic UNKNOWN_MESSAGE
  // a missing/'ignore' entry would produce. This is the strongest available
  // proof that auth_response is genuinely present in the unified router's
  // handler map, not merely assumed to be.
  test('auth_response outside the handshake is routed to a real handler (INVALID_STATE, not UNKNOWN_MESSAGE)', async () => {
    const fixture = loadFixture('auth_response');
    const beforeReceived = received.length;
    client.send(fixture);

    await waitFor(() => received.slice(beforeReceived).some((m) => m.type === 'error'));
    const err = received.slice(beforeReceived).find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type !== 'error') throw new Error('unreachable');
    expect(err.code).toBe('INVALID_STATE');
  });

  // hello is implicitly proven routed by the connection setup succeeding in
  // beforeAll (onConnect fired). This proves it a second, independent way:
  // resending it post-connect reaches handleHello's own state guard
  // (INVALID_STATE) rather than falling through to UNKNOWN_MESSAGE, which
  // is what a missing/'ignore' map entry would have produced instead.
  test('a second hello post-connect is routed to a real handler (INVALID_STATE, not UNKNOWN_MESSAGE)', async () => {
    const fixture = loadFixture('hello');
    const beforeReceived = received.length;
    client.send(fixture);

    await waitFor(() => received.slice(beforeReceived).some((m) => m.type === 'error'));
    const err = received.slice(beforeReceived).find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type !== 'error') throw new Error('unreachable');
    expect(err.code).toBe('INVALID_STATE');
  });

  test('a genuinely unregistered type is rejected as UNKNOWN_MESSAGE (control: the default path still works)', async () => {
    const bogus = {
      type: 'totally_unknown_future_type',
      id: generateId(),
      timestamp: new Date().toISOString(),
    } as unknown as ProtocolMessage;
    const beforeReceived = received.length;
    client.send(bogus);

    await waitFor(() => received.slice(beforeReceived).some((m) => m.type === 'error'));
    const err = received.slice(beforeReceived).find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type !== 'error') throw new Error('unreachable');
    // Genuinely unregistered types never reach the router at all -- they
    // fail `deserialize`'s envelope validation first (INVALID_MESSAGE), same
    // as before #899. UNKNOWN_MESSAGE is reserved for registered-but-wrong-
    // direction types (see the 'question' test below).
    expect(err.code).toBe('INVALID_MESSAGE');
  });

  test('a registered d2c-only type arriving inbound is rejected as UNKNOWN_MESSAGE', async () => {
    // 'question' is a real registry type (passes deserialize) but tagged
    // 'd2c' -- not a key in ClientToDaemonType/the handler map at all. This
    // is the one case that genuinely reaches routeClientMessage's "not
    // found" path and gets UNKNOWN_MESSAGE, preserving connection.ts's
    // pre-#899 behavior for this exact scenario.
    const fixture = loadFixture('question');
    const beforeReceived = received.length;
    client.send(fixture);

    await waitFor(() => received.slice(beforeReceived).some((m) => m.type === 'error'));
    const err = received.slice(beforeReceived).find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type !== 'error') throw new Error('unreachable');
    expect(err.code).toBe('UNKNOWN_MESSAGE');
  });
});
