/**
 * Which peer events the relay adapter believes (#1193 review).
 *
 * The Worker gives a socket that never joined the role `pending`, and tells the
 * host `peer-disconnected` with the closing socket's role when ANY socket in the
 * room closes. A bare "a peer left" would let a stranger who connects and
 * closes drop the real, authenticated peer with one frame. The adapter must act
 * only on the role `client`, for both events.
 *
 * Two layers: the real adapter over a recording transport (every role, with the
 * authenticated peer's state checked afterwards), and the real adapter over the
 * real `SignalingClient` against a loopback Worker stand-in, so the role really
 * does travel from the wire to the adapter.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { AdapterEvents } from '../../src/adapters/connection-adapter.ts';
import { RelayAdapter } from '../../src/remote/relay-adapter.ts';
import { type FakeWorker, startFakeWorker, until } from './fake-worker.ts';
import {
  RecordingTransport,
  makeAuthenticator,
  settle,
  startAuthenticatedRelayPeer,
} from './relay-test-peer.ts';

const KEYSTROKE = { type: 'user_input', sessionId: 'x', content: '1\r', raw: true };

describe('a connected, authenticated peer is only dropped by a client leaving', () => {
  let log: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    log = (['log', 'warn', 'error'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    for (const spy of log) spy.mockRestore();
  });

  async function connected(): Promise<{
    peer: Awaited<ReturnType<typeof startAuthenticatedRelayPeer>>;
    disconnects: string[];
    inputs: unknown[][];
  }> {
    const disconnects: string[] = [];
    const inputs: unknown[][] = [];
    const events: Partial<AdapterEvents> = {
      onDisconnect: (_id, reason) => {
        disconnects.push(String(reason));
      },
      onUserInput: (...args: unknown[]) => {
        inputs.push(args);
      },
    };
    const peer = await startAuthenticatedRelayPeer(events);
    expect(peer.adapter.connectionCount).toBe(1);
    return { peer, disconnects, inputs };
  }

  test.each([['pending'], ['host'], ['something-else'], [undefined]])(
    'peer-disconnected with role %p leaves the peer connected and still served',
    async (role) => {
      const { peer, disconnects, inputs } = await connected();
      try {
        peer.transport.emit('peer-disconnected', role);
        await settle();

        expect(disconnects).toEqual([]);
        expect(peer.adapter.connectionCount).toBe(1);
        // Still served: its sealed message reaches the handler.
        await peer.send(KEYSTROKE, () => inputs.length > 0);
        expect(inputs).toHaveLength(1);
      } finally {
        await peer.dispose();
      }
    },
  );

  test('peer-disconnected with role client drops the peer, once', async () => {
    const { peer, disconnects, inputs } = await connected();
    try {
      peer.transport.emit('peer-disconnected', 'client');
      await settle();

      expect(disconnects).toHaveLength(1);
      expect(peer.adapter.connectionCount).toBe(0);
      // Gone: a late sealed message no longer reaches the handler.
      await peer.send(KEYSTROKE);
      expect(inputs).toHaveLength(0);
    } finally {
      await peer.dispose();
    }
  });
});

describe('only a client starts a handshake', () => {
  test.each([['pending'], ['host'], [undefined]])(
    'peer-connected with role %p starts nothing',
    async (role) => {
      const { authenticator, remove } = await makeAuthenticator();
      const transport = new RecordingTransport();
      const adapter = new RelayAdapter(
        {
          enabled: true,
          signalingUrl: 'wss://example.invalid',
          code: 'ABCD-2345',
          rotateCode: false,
          authenticator,
          createTransport: () => transport,
        },
        {},
      );
      const quiet = (['log', 'warn', 'error'] as const).map((m) =>
        spyOn(console, m).mockImplementation(() => {}),
      );
      try {
        await adapter.start();
        transport.emit('peer-connected', role);
        await settle();
        expect(adapter.connectionCount).toBe(0);
        expect(transport.sent).toHaveLength(0);

        // The control: the same adapter does start one for a client.
        transport.emit('peer-connected', 'client');
        await settle(() => transport.sent.length > 0);
        expect(adapter.connectionCount).toBe(1);
        expect(JSON.parse(transport.sent[0] as string).type).toBe('auth_challenge');
      } finally {
        await adapter.stop();
        for (const spy of quiet) spy.mockRestore();
        remove();
      }
    },
  );
});

describe('through the real SignalingClient and a loopback Worker', () => {
  let worker: FakeWorker | null = null;
  let adapter: RelayAdapter | null = null;
  let remove: (() => void) | null = null;
  let errors: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];

  afterEach(async () => {
    await adapter?.stop();
    worker?.stop();
    remove?.();
    for (const spy of spies) spy.mockRestore();
    adapter = null;
    worker = null;
    remove = null;
    spies = [];
  });

  test('a stranger socket closing does not drop the peer; the client leaving does', async () => {
    errors = [];
    spies = [
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'warn').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      }),
    ];
    const made = await makeAuthenticator();
    remove = made.remove;
    worker = startFakeWorker((frame, w) => {
      if (frame['type'] === 'register') {
        w.send({ type: 'registered', code: 'ABCD-2345', expiresAt: new Date().toISOString() });
        w.send({ type: 'peer-connected', role: 'client' });
      }
    });
    adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: worker.url,
        code: 'ABCD-2345',
        rotateCode: false,
        authenticator: made.authenticator,
      },
      {},
    );
    await adapter.start();
    // The adapter challenged the client the Worker reported.
    await until(
      () => worker?.received().some((f) => f['type'] === 'relay') ?? false,
      'the auth challenge',
    );
    expect(adapter.connectionCount).toBe(1);

    // A barrier frame after the events under test proves they were processed.
    const barrier = async (name: string) => {
      worker?.send({ type: 'error', code: name, message: 'barrier' });
      await until(() => errors.some((line) => line.includes(name)), `barrier ${name}`);
    };
    worker.send({ type: 'peer-disconnected', role: 'pending' });
    worker.send({ type: 'peer-disconnected' });
    await barrier('BARRIER_ONE');
    expect(adapter.connectionCount).toBe(1);

    worker.send({ type: 'peer-disconnected', role: 'client' });
    await barrier('BARRIER_TWO');
    expect(adapter.connectionCount).toBe(0);
  });
});
