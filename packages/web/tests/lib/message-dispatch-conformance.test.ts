/**
 * Two-sided conformance test for the C4 web total-dispatch migration (#897).
 *
 * Drives the REAL daemon `WebSocketAdapter` and the REAL web `WebSocketClient`
 * over one real Bun-native socket -- no synthetic counterparty on either side
 * (AGENTS.md "Verify before you describe": #543 shipped half-built because
 * `relay-encryption.test.ts` drove the daemon with a test-local client that
 * performed a handshake step no real client did; #881 found it). Both
 * endpoints here are the actual shipping classes, imported directly (not
 * reimplemented, not mocked): `packages/daemon/src/adapters/websocket-adapter.ts`
 * and `packages/web/src/lib/websocket-client.ts`.
 *
 * For every message type the daemon can legitimately send a client
 * (`MESSAGE_DIRECTION` 'd2c' or 'both' -- packages/shared/src/protocol.ts),
 * this broadcasts the checked-in golden fixture
 * (packages/shared/tests/fixtures/protocol/) and asserts:
 *
 *   1. the real `WebSocketClient`'s `onMessage` actually receives it,
 *      byte-for-byte round-tripped over the wire (real TCP, real JSON
 *      serialize/deserialize -- not an in-process function call), and
 *   2. `packages/web/src/App.tsx`'s `handleMessage` switch has a real,
 *      explicit `case` for that type.
 *
 * ## Why (2) greps the switch instead of querying a dispatch map
 *
 * #897's issue text describes stage (b): extracting the switch bodies into a
 * `packages/web/src/lib/message-dispatch.ts` total `MessageHandlers` map, and
 * this test asserting that map has an entry per fixture. That extraction did
 * NOT ship in this PR -- see the PR body for the concrete measurement (a
 * 1100+ line switch body closing over 15 distinct refs, 8 setState setters,
 * and 8 locally-defined composite helper closures, one of which recurses into
 * the enclosing `useCallback` for `replay_batch`) that made verbatim
 * extraction judged too risky for this change. Only stage (a) shipped: grouped
 * explicit-ignore cases plus `assertNever` in App.tsx's existing switch, which
 * already gets the real prize (a missing case is a compile error -- see the
 * break-it-then-fix-it evidence in the PR body). Without a `MessageHandlers`
 * object to query, assertion 2 above substitutes the best available REAL
 * artifact for "has an entry": the switch itself, read from the file this
 * suite ships next to. A future PR that lands stage (b) should replace this
 * grep with a lookup against the real map.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProtocolMessage, ProtocolMessageMap } from '@remi/shared/protocol.ts';
import {
  MESSAGE_DIRECTION,
  createHello,
  deserialize,
  generateId,
  isValidMessage,
  serialize,
} from '@remi/shared/protocol.ts';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers.ts';
// Real daemon adapter -- not a test double. Relative import: packages/web has
// no `@remi/daemon` path alias (only `packages/web/tests/**` is exempt from
// both typecheck gates, so this resolves fine at `bun test` runtime; see the
// PR body's "conformance-test placement decision").
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter.ts';
import { WebSocketClient } from '../../src/lib/websocket-client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '../../../shared/tests/fixtures/protocol');
const APP_TSX_PATH = join(HERE, '../../src/App.tsx');
const APP_TSX_SOURCE = readFileSync(APP_TSX_PATH, 'utf-8');

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

/** Every type this daemon can send a client, per the registry's own direction
 *  table -- excludes 'c2d' types the web client only ever SENDS. */
const RECEIVABLE_TYPES = (Object.keys(MESSAGE_DIRECTION) as (keyof ProtocolMessageMap)[]).filter(
  (t) => MESSAGE_DIRECTION[t] === 'd2c' || MESSAGE_DIRECTION[t] === 'both',
);

function loadFixture(type: string): ProtocolMessage {
  const raw = readFileSync(join(FIXTURES_DIR, `${type}.json`), 'utf-8');
  const msg = deserialize(raw);
  if (!msg) throw new Error(`fixture ${type}.json failed to deserialize`);
  return msg;
}

describe('web total dispatch: real daemon <-> real web client conformance (#897)', () => {
  let adapter: WebSocketAdapter;
  let port: number;
  let client: WebSocketClient;
  let connectionId: string | null = null;
  const received: ProtocolMessage[] = [];

  beforeAll(async () => {
    port = await reserveRange(1);
    adapter = new WebSocketAdapter(
      { port },
      {
        onConnect: (id) => {
          connectionId = id;
        },
      },
    );
    await adapter.start();

    client = new WebSocketClient(
      // 'localhost', not '127.0.0.1': WebSocketAdapter's default host binds
      // whatever 'localhost' resolves to first on this machine, which is
      // IPv6 '::1' in this environment -- connecting to the literal IPv4
      // address then gets ECONNREFUSED against a socket that isn't listening
      // on it. Matches the existing convention in
      // packages/daemon/tests/websocket-server.test.ts.
      { url: `ws://localhost:${port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 },
      {
        onMessage: (msg) => {
          received.push(msg);
        },
      },
    );
    client.connect();
    await waitFor(() => client.isConnected || client.isTransportOpen);

    // Real hello handshake -- WebSocketAdapter sets skipHelloAck (the daemon's
    // cli.ts normally acks), so no hello_ack arrives automatically; that's
    // fine, hello_ack is broadcast like every other fixture below.
    client.send(createHello(generateId(), '0.0.0-test'));
    await waitFor(() => connectionId !== null);
  });

  afterAll(async () => {
    client.disconnect();
    await adapter.stop();
  });

  test('every ProtocolMessageMap key has a d2c/both classification and a fixture', () => {
    // Sanity on the fixture set itself before trusting it below.
    const fixtureFiles = new Set(
      readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith('.json') && f !== '__unknown_type__.json')
        .map((f) => f.replace(/\.json$/, '')),
    );
    for (const type of RECEIVABLE_TYPES) {
      expect(fixtureFiles.has(type)).toBe(true);
    }
    expect(RECEIVABLE_TYPES.length).toBeGreaterThan(0);
  });

  describe.each(RECEIVABLE_TYPES)('%s', (type) => {
    test('real daemon broadcast is received by the real web client', async () => {
      const fixture = loadFixture(type);
      const before = received.length;
      // biome-ignore lint/style/noNonNullAssertion: assigned in beforeAll's waitFor
      adapter.sendRaw(connectionId!, fixture);

      await waitFor(() => received.slice(before).some((m) => m.id === fixture.id));
      const got = received.slice(before).find((m) => m.id === fixture.id);
      expect(got).toBeDefined();
      expect(got?.type).toBe(type);
      // Wire fidelity: re-serializing what the client received reproduces the
      // exact bytes the daemon sent (round-tripped through a real socket, not
      // an in-process function call).
      expect(serialize(got as ProtocolMessage)).toBe(serialize(fixture));
    });

    test("App.tsx's handleMessage switch has a real, explicit case for it", () => {
      // See the module doc: this greps the shipped switch itself (the only
      // total-dispatch artifact stage (a) produced) rather than a parallel
      // map, so it cannot drift from what App.tsx actually does.
      expect(APP_TSX_SOURCE).toContain(`case '${type}':`);
    });
  });

  test('replay_batch nested messages survive a real socket round-trip (R2: replay recursion input)', async () => {
    // The checked-in replay_batch.json fixture is intentionally minimal
    // (empty `messages`, shared package golden-fixture convention). App.tsx's
    // `replay_batch` case recursively re-dispatches each nested message with
    // `inReplay=true` (App.tsx, the case right after `question_snapshot`) --
    // the risk this suite exists to guard is nested delivery fidelity, which
    // an empty array can't exercise. Build a realistic non-empty batch here.
    const nested: ProtocolMessage[] = [loadFixture('question'), loadFixture('session_update')];
    const batch: ProtocolMessage = {
      type: 'replay_batch',
      id: generateId(),
      timestamp: new Date().toISOString(),
      sessionId: 'fixture-session-id',
      messages: nested,
      isComplete: true,
    };

    const before = received.length;
    // biome-ignore lint/style/noNonNullAssertion: assigned in beforeAll's waitFor
    adapter.sendRaw(connectionId!, batch);

    await waitFor(() => received.slice(before).some((m) => m.id === batch.id));
    const got = received.slice(before).find((m) => m.id === batch.id);
    expect(got?.type).toBe('replay_batch');
    if (got?.type !== 'replay_batch') throw new Error('unreachable');
    expect(got.messages).toHaveLength(2);
    expect(got.messages.map((m) => m.type)).toEqual(['question', 'session_update']);
    expect(got.messages.map((m) => m.id)).toEqual(nested.map((m) => m.id));
  });

  test('an unknown message type nested in a replay batch survives the round trip unfiltered', async () => {
    // The forward-compat hazard behind App.tsx's replay-batch guard: `deserialize`
    // validates only the OUTER envelope, so a nested message with a type this
    // build has never heard of arrives intact rather than being dropped in
    // transport. An older client replaying a batch from a newer daemon hits
    // exactly this. App.tsx must therefore validate each nested message itself
    // before recursing, or `assertNever` throws and errors the connection --
    // where the pre-exhaustiveness code silently ignored it.
    //
    // This test pins the TRANSPORT half of that claim (nothing filters it),
    // which is what makes the App.tsx guard load-bearing rather than defensive
    // decoration.
    const unknownNested = {
      type: 'totally_unknown_future_type',
      id: generateId(),
      timestamp: new Date().toISOString(),
    } as unknown as ProtocolMessage;

    const batch: ProtocolMessage = {
      type: 'replay_batch',
      id: generateId(),
      timestamp: new Date().toISOString(),
      sessionId: 'fixture-session-id',
      messages: [unknownNested],
      isComplete: true,
    };

    const before = received.length;
    // biome-ignore lint/style/noNonNullAssertion: assigned in beforeAll's waitFor
    adapter.sendRaw(connectionId!, batch);

    await waitFor(() => received.slice(before).some((m) => m.id === batch.id));
    const got = received.slice(before).find((m) => m.id === batch.id);
    if (got?.type !== 'replay_batch') throw new Error('unreachable');

    // Arrived unfiltered: the transport did NOT drop the unknown nested type.
    expect(got.messages).toHaveLength(1);
    expect((got.messages[0] as { type: string }).type).toBe('totally_unknown_future_type');

    // And the guard App.tsx applies to it rejects it, so the recursion skips
    // rather than falling through to assertNever.
    expect(isValidMessage(got.messages[0])).toBe(false);
    expect(isValidMessage(got)).toBe(true);
  });
});
