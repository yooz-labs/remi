/**
 * Relay end-to-end encryption, at the adapter level (#543).
 *
 * These drive a real `RelayAdapter` through a real handshake with a real
 * client-side key exchange, over a stand-in transport that records every byte
 * handed to the relay. That recording IS the signaling Worker's view, and
 * asserting on it is the only thing that actually proves the fix: a test that
 * checked "encryption was called" would pass just as happily while the Worker
 * still received plaintext.
 *
 * Worth stating why this file exists at all: `relay-adapter-auth.test.ts` is
 * named for the adapter but only ever calls `Authenticator` directly, so the
 * relay handshake had no adapter-level coverage. Making the key exchange
 * mandatory broke none of its 29 tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAuthResponse,
  decryptRelayPayload,
  deriveRelaySessionKeys,
  encryptRelayPayload,
  fromBase64,
  generateEphemeralKeyPair,
  kexSigningInput,
  sign,
} from '@remi/shared';
import type { AuthChallengeMessage, RelaySessionKeys } from '@remi/shared';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { RelayAdapter, type RelayTransport } from '../../src/remote/relay-adapter.ts';

/**
 * Stand-in for `SignalingClient`. Records what the adapter hands the relay,
 * which is exactly what the Worker would receive and forward.
 */
class RecordingTransport implements RelayTransport {
  readonly sent: string[] = [];
  isConnected = true;
  connectionCode: string | null = 'TEST-CODE';
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();

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

  /** The most recent payload, parsed as a handshake message. */
  lastAsJson<T>(): T {
    const last = this.sent[this.sent.length - 1];
    if (last === undefined) throw new Error('nothing was sent');
    return JSON.parse(last) as T;
  }
}

/** Wait for the adapter's async handshake continuations to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

describe('relay adapter encrypts what the Worker carries', () => {
  let dir: string;
  let authenticator: Authenticator;
  let transport: RecordingTransport;
  let adapter: RelayAdapter | null = null;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-relay-e2e-'));
    const store = new IdentityStore(dir);
    await store.generate('testpass');
    const identity = await store.unlock('testpass');
    authenticator = new Authenticator({ identity, identityStore: store, tofuMode: 'auto-accept' });
    transport = new RecordingTransport();
  });

  afterEach(async () => {
    await adapter?.stop();
    adapter = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startAdapter(): Promise<void> {
    adapter = new RelayAdapter(
      {
        enabled: true,
        signalingUrl: 'wss://example.invalid',
        code: 'TEST-CODE',
        rotateCode: false,
        authenticator,
        createTransport: () => transport,
      },
      {},
    );
    await adapter.start();
  }

  /**
   * Play the client's half of the handshake: verify nothing, just answer
   * correctly, the way a current web client would.
   */
  async function completeHandshake(options: { offerKex?: boolean } = {}): Promise<{
    keys: RelaySessionKeys | null;
    challenge: AuthChallengeMessage;
  }> {
    const offerKex = options.offerKex !== false;
    transport.emit('peer-connected');
    await settle();

    const challenge = transport.lastAsJson<AuthChallengeMessage>();
    expect(challenge.type).toBe('auth_challenge');

    const clientStore = new IdentityStore(path.join(dir, 'client'));
    await clientStore.generate('clientpass');
    const clientIdentity = await clientStore.unlock('clientpass');
    // `unlock()` already hands back live CryptoKeys; no re-import needed.
    const clientPrivate = clientIdentity.privateKey;

    const challengeSignature = await sign(clientPrivate, fromBase64(challenge.challenge));

    let keys: RelaySessionKeys | null = null;
    let relayKex: { ephemeralKey: string; signature: string } | undefined;
    if (offerKex) {
      const clientEphemeral = await generateEphemeralKeyPair();
      const kexSignature = await sign(
        clientPrivate,
        kexSigningInput(
          challenge.challenge,
          challenge.relayEphemeralKey ?? '',
          clientEphemeral.publicKeyBase64,
        ),
      );
      relayKex = { ephemeralKey: clientEphemeral.publicKeyBase64, signature: kexSignature };
      keys = await deriveRelaySessionKeys(
        clientEphemeral.privateKey,
        challenge.relayEphemeralKey ?? '',
        challenge.challenge,
        false,
      );
    }

    transport.emit(
      'relay',
      JSON.stringify(
        createAuthResponse(
          clientIdentity.publicKeyRaw,
          challengeSignature,
          clientIdentity.fingerprint,
          relayKex,
        ),
      ),
    );
    await settle();
    return { keys, challenge };
  }

  test('the challenge carries a signed ephemeral key', async () => {
    await startAdapter();
    transport.emit('peer-connected');
    await settle();

    const challenge = transport.lastAsJson<AuthChallengeMessage>();
    expect(challenge.relayEphemeralKey).toBeTruthy();
    expect(challenge.relayKexSignature).toBeTruthy();
    // A raw uncompressed P-256 point is 65 bytes.
    expect(fromBase64(challenge.relayEphemeralKey as string).byteLength).toBe(65);
  });

  test('the Worker never sees the plaintext of a relayed message', async () => {
    await startAdapter();
    const { keys } = await completeHandshake();
    expect(keys).not.toBeNull();

    const before = transport.sent.length;
    const secret = 'rm -rf /very/secret/path';
    adapter?.broadcast({
      type: 'agent_output',
      id: '0199f3a1-0000-7000-8000-000000000001',
      timestamp: new Date().toISOString(),
      sessionId: '0199f3a1-0000-7000-8000-000000000002',
      content: secret,
      // biome-ignore lint/suspicious/noExplicitAny: minimal literal for the test
    } as any);
    await settle();

    const onTheWire = transport.sent.slice(before);
    expect(onTheWire.length).toBe(1);
    const payload = onTheWire[0] as string;

    // The Worker's whole view of this message.
    expect(payload).not.toContain(secret);
    expect(payload).not.toContain('agent_output');
    expect(payload).not.toContain('sessionId');

    // ...and the legitimate peer can still read it.
    const plaintext = await decryptRelayPayload((keys as RelaySessionKeys).receive, payload);
    expect(JSON.parse(plaintext).content).toBe(secret);
  });

  test('a message from the client is accepted only when correctly encrypted', async () => {
    await startAdapter();
    const { keys } = await completeHandshake();

    // Correctly sealed: routed normally (no disconnect).
    transport.emit(
      'relay',
      await encryptRelayPayload(
        (keys as RelaySessionKeys).send,
        JSON.stringify({ type: 'ping', id: 'x', timestamp: new Date().toISOString() }),
      ),
    );
    await settle();
    expect(adapter?.hasConnection).toBeTruthy();

    // Plaintext after the handshake is either a downgrade attempt or a broken
    // peer. Either way it must not be honored.
    const beforeCount = transport.sent.length;
    transport.emit('relay', JSON.stringify({ type: 'ping', id: 'y' }));
    await settle();
    expect(transport.sent.length).toBe(beforeCount);
  });

  test('a client that cannot do the key exchange is refused, not served in the clear', async () => {
    // The old-app case. Refusing is the point: continuing would put session
    // content back on the wire, which is the bug this closes.
    await startAdapter();
    const { keys } = await completeHandshake({ offerKex: false });
    expect(keys).toBeNull();

    const result = transport.lastAsJson<{ type: string; success: boolean; error?: string }>();
    expect(result.type).toBe('auth_result');
    expect(result.success).toBe(false);
    expect(result.error).toBe('RELAY_KEX_FAILED');
  });

  test('nothing is relayed before the key exchange completes', async () => {
    await startAdapter();
    transport.emit('peer-connected');
    await settle();

    const before = transport.sent.length;
    const sent = adapter?.broadcast({
      type: 'ping',
      id: '0199f3a1-0000-7000-8000-000000000003',
      timestamp: new Date().toISOString(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal literal for the test
    } as any);
    void sent;
    await settle();
    expect(transport.sent.length).toBe(before);
  });
});
