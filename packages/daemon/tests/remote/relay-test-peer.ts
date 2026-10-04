/**
 * A real relay peer for adapter-level tests.
 *
 * Builds a real `RelayAdapter` in permanent-code mode (a real `Authenticator`
 * over a real `IdentityStore`), plays the client half of the handshake with the
 * shared crypto primitives, and hands back an adapter that is authenticated and
 * holds real session keys. Nothing here replaces adapter logic; the only
 * stand-in is the signaling Worker connection, through the adapter's own
 * `createTransport` seam.
 *
 * The client half is written by the test because no shipped client implements
 * it (#881). That makes these tests proof of the daemon's behavior, not of
 * interoperability with a client.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAuthResponse,
  deriveRelaySessionKeys,
  encryptRelayPayload,
  fromBase64,
  generateEphemeralKeyPair,
  kexSigningInput,
  sign,
} from '@remi/shared';
import type { AuthChallengeMessage, RelaySessionKeys } from '@remi/shared';
import type { AdapterEvents } from '../../src/adapters/connection-adapter.ts';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { RelayAdapter, type RelayTransport } from '../../src/remote/relay-adapter.ts';

/** Stands in for the Worker connection. `sent` is everything the Worker would receive. */
export class RecordingTransport implements RelayTransport {
  readonly sent: string[] = [];
  readonly isConnected = true;
  readonly connectionCode: string | null = 'TEST-CODE';
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the emitter's shape
  private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();

  // biome-ignore lint/suspicious/noExplicitAny: mirrors the emitter's shape
  on(event: string, cb: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  sendRelay(payload: string): void {
    this.sent.push(payload);
  }

  connect(): void {}
  close(): void {}
}

/** Wait for the adapter's async handshake and decryption continuations to settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

export interface AuthenticatedRelayPeer {
  readonly adapter: RelayAdapter;
  readonly transport: RecordingTransport;
  /** What the daemon handed the Worker after the handshake finished. */
  sentAfterHandshake(): string[];
  /** Seal one client-to-daemon message with the session keys and deliver it, as the Worker would. */
  send(message: object): Promise<void>;
  dispose(): Promise<void>;
}

export async function startAuthenticatedRelayPeer(
  events: Partial<AdapterEvents>,
): Promise<AuthenticatedRelayPeer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-relay-peer-'));
  const transport = new RecordingTransport();
  let adapter: RelayAdapter | null = null;
  try {
    const store = new IdentityStore(dir);
    await store.generate('testpass');
    const identity = await store.unlock('testpass');
    const authenticator = new Authenticator({
      identity,
      identityStore: store,
      tofuMode: 'auto-accept',
    });
    adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: 'wss://example.invalid',
        code: 'ABCD-2345',
        rotateCode: false,
        authenticator,
        createTransport: () => transport,
      },
      events,
    );
    await adapter.start();

    transport.emit('peer-connected');
    await settle();
    const challenge = JSON.parse(transport.sent.at(-1) ?? 'null') as AuthChallengeMessage | null;
    if (challenge?.type !== 'auth_challenge') throw new Error('the adapter sent no auth challenge');

    const clientStore = new IdentityStore(path.join(dir, 'client'));
    await clientStore.generate('clientpass');
    const client = await clientStore.unlock('clientpass');
    const clientEphemeral = await generateEphemeralKeyPair();
    const kexSignature = await sign(
      client.privateKey,
      kexSigningInput(
        challenge.challenge,
        challenge.relayEphemeralKey ?? '',
        clientEphemeral.publicKeyBase64,
      ),
    );
    const keys: RelaySessionKeys = await deriveRelaySessionKeys(
      clientEphemeral.privateKey,
      challenge.relayEphemeralKey ?? '',
      challenge.challenge,
      false,
    );
    transport.emit(
      'relay',
      JSON.stringify(
        createAuthResponse(
          client.publicKeyRaw,
          await sign(client.privateKey, fromBase64(challenge.challenge)),
          client.fingerprint,
          { ephemeralKey: clientEphemeral.publicKeyBase64, signature: kexSignature },
        ),
      ),
    );
    await settle();
    const result = JSON.parse(transport.sent.at(-1) ?? 'null') as {
      type?: string;
      success?: boolean;
    };
    if (result?.type !== 'auth_result' || result.success !== true) {
      throw new Error(
        'the handshake did not authenticate; a test built on it would pass vacuously',
      );
    }

    const handshakeSent = transport.sent.length;
    const started = adapter;
    return {
      adapter: started,
      transport,
      sentAfterHandshake: () => transport.sent.slice(handshakeSent),
      send: async (message) => {
        transport.emit('relay', await encryptRelayPayload(keys.send, JSON.stringify(message)));
        await settle();
      },
      dispose: async () => {
        await started.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await adapter?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
