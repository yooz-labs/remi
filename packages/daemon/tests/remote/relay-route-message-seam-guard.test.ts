/**
 * #916: the relay's inbound dispatch, `RelayAdapter.routeMessage`, now
 * try/catches its `routeClientMessage` call the same way `connection.ts`'s
 * `handleMessage` does.
 *
 * Correction to the issue's premise, recorded here per AGENTS.md "Verify
 * before you describe": unlike `connection.ts`, this seam was NOT actually
 * exposed to a fatal `uncaughtException` exit. `routeMessage` has exactly one
 * caller, `handleRelayMessage` (relay-adapter.ts:271-327), whose own
 * try/catch already wraps the `routeMessage` call -- so a synchronous handler
 * throw was already caught there, just mislabeled as "Failed to parse relay
 * payload" and, critically, never replied to the peer at all (that catch
 * only logs). This change does not close a crash gap on the relay side; it
 * fixes the misdiagnosis and adds the reply the issue requires ("never
 * swallow... send the client an error reply"), matching what `connection.ts`
 * already does. Both are verified below.
 *
 * Constructs the REAL `RelayAdapter` (ADR 0014) through its documented
 * `createTransport` test seam, authenticated by a real handshake
 * (`relay-test-peer.ts`), with a throwing event callback wired through the
 * adapter's real `AdapterEvents` extension point.
 */

import { describe, expect, test } from 'bun:test';
import { createTerminalResize, createUserInput } from '@remi/shared';
import type { UUID } from '@remi/shared';
import type { AdapterEvents } from '../../src/adapters/connection-adapter.ts';
import { startAuthenticatedRelayPeer } from './relay-test-peer.ts';

describe('RelayAdapter.routeMessage seam guard (#916)', () => {
  test('a handler that throws synchronously is contained, replied to, and does not wedge the peer', async () => {
    let userInputs = 0;
    const events: Partial<AdapterEvents> = {
      onTerminalResize: () => {
        throw new Error('boom: relay handler forgot to guard itself');
      },
      onUserInput: () => {
        // Used to prove routing still works afterward.
        userInputs++;
      },
    };

    // Permanent-code mode with a real handshake: without an authenticator the
    // adapter refuses every peer (#1193), so this is the only way to reach
    // routeMessage through the transport.
    const peer = await startAuthenticatedRelayPeer(events);
    try {
      // (1) the throw must not escape the adapter's 'relay' event handler.
      await expect(peer.send(createTerminalResize(80, 24))).resolves.toBeUndefined();

      // (2) the peer receives an error reply naming the failing type -- this is
      // the behavioral change: before #916, handleRelayMessage's outer catch
      // logged the throw but sent NOTHING back to the peer.
      const lastSent = peer.sentAfterHandshake().at(-1);
      expect(lastSent).toBeDefined();
      const reply = JSON.parse(lastSent as string) as { type: string; code?: string };
      expect(reply.type).toBe('error');
      expect(reply.code).toBe('INTERNAL_ERROR');

      // (3) the adapter is not wedged: a later, unrelated message on the same
      // peer connection still routes.
      const before = peer.sentAfterHandshake().length;
      await peer.send(createUserInput('sess-id' as UUID, 'hello', false));
      // The handler ran, and no NEW error/UNSUPPORTED reply was sent. The
      // handler count is what shows the peer survived: over the encrypted
      // path a dropped peer would also send nothing.
      expect(userInputs).toBe(1);
      expect(peer.sentAfterHandshake().length).toBe(before);
    } finally {
      await peer.dispose();
    }
  });
});
