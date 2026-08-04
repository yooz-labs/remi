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
 * `createTransport` test seam -- the same fake-transport pattern
 * `relay-client-to-daemon-conformance.test.ts` uses -- with a throwing event
 * callback wired through the adapter's real `AdapterEvents` extension point.
 */

import { describe, expect, test } from 'bun:test';
import { createTerminalResize, createUserInput } from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';
import type { AdapterEvents } from '../../src/adapters/connection-adapter.ts';
import { RelayAdapter, type RelayTransport } from '../../src/remote/relay-adapter.ts';

/** Minimal stand-in for the signaling Worker connection, via the same seam
 *  `relay-client-to-daemon-conformance.test.ts` uses -- not a stand-in for
 *  `RelayAdapter` itself, which is constructed for real below. */
class FakeRelayTransport implements RelayTransport {
  readonly isConnected = true;
  readonly connectionCode: string | null = 'TEST-CODE';
  readonly sent: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: matches RelayTransport's catch-all overload
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  // biome-ignore lint/suspicious/noExplicitAny: matches RelayTransport's catch-all overload
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

  emitPeerConnected(): void {
    this.fire('peer-connected');
  }

  emitRelay(message: ProtocolMessage): void {
    this.fire('relay', JSON.stringify(message));
  }
}

describe('RelayAdapter.routeMessage seam guard (#916)', () => {
  test('a handler that throws synchronously is contained, replied to, and does not wedge the peer', async () => {
    const transport = new FakeRelayTransport();
    const events: Partial<AdapterEvents> = {
      onTerminalResize: () => {
        throw new Error('boom: relay handler forgot to guard itself');
      },
      onUserInput: () => {
        // Used to prove routing still works afterward; no-op.
      },
    };

    const adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: 'wss://ignored.example.com',
        createTransport: () => transport,
      },
      events,
    );

    await adapter.start();
    transport.emitPeerConnected(); // no authenticator configured -> authenticated immediately

    // (1) the throw must not escape the transport's 'relay' event handler.
    expect(() => {
      transport.emitRelay(createTerminalResize(80, 24));
    }).not.toThrow();

    // (2) the peer receives an error reply naming the failing type -- this is
    // the behavioral change: before #916, handleRelayMessage's outer catch
    // logged the throw but sent NOTHING back to the peer.
    const lastSent = transport.sent.at(-1);
    expect(lastSent).toBeDefined();
    const reply = JSON.parse(lastSent as string) as { type: string; code?: string };
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('INTERNAL_ERROR');

    // (3) the adapter is not wedged: a later, unrelated message on the same
    // peer connection still routes.
    const before = transport.sent.length;
    transport.emitRelay(createUserInput('sess-id' as UUID, 'hello', false));
    // onUserInput is a no-op above; absence of a NEW error/UNSUPPORTED reply
    // (and no throw) is the routing proof for a handled type.
    expect(transport.sent.length).toBe(before);

    await adapter.stop();
  });
});
