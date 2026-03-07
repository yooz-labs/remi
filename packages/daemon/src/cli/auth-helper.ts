/**
 * Shared CLI auth helper for WebSocket clients (ls, attach, etc.).
 *
 * Handles the auth_challenge -> sign -> auth_response -> auth_result
 * handshake so that subcommands can connect to an auth-enabled daemon.
 */

import {
  createAuthResponse,
  deserialize,
  fromBase64,
  isEncrypted,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import type { ProtocolMessage, UnlockedIdentity } from '@remi/shared';
import { IdentityStore } from '../auth/identity-store.ts';

export interface AuthHandshakeResult {
  /** The unlocked identity used for signing */
  identity: UnlockedIdentity;
}

const AUTH_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Perform auth handshake on a WebSocket that just received an auth_challenge.
 *
 * Resolves when auth_result with success=true is received.
 * Rejects on auth failure, timeout, or connection error.
 *
 * @param ws Open WebSocket connection
 * @param challengeMsg The auth_challenge message already received
 * @returns Promise that resolves when auth succeeds
 */
export async function performAuthHandshake(
  ws: WebSocket,
  challengeMsg: ProtocolMessage & { type: 'auth_challenge' },
): Promise<AuthHandshakeResult> {
  const store = new IdentityStore();

  // Auto-generate identity if missing
  if (!store.exists()) {
    console.error('No client identity found. Generating new Ed25519 keypair...');
    try {
      const newIdentity = await store.generate();
      console.error(`Client identity created (fingerprint: ${newIdentity.fingerprint})`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to auto-generate client identity: ${detail}. Check permissions on ~/.remi or generate manually with "remi keygen".`,
      );
    }
  }

  const storedIdentity = store.load();
  if (!storedIdentity) {
    throw new Error('No identity found. Run "remi keygen" first.');
  }

  let identity: UnlockedIdentity;
  if (isEncrypted(storedIdentity)) {
    const envPassphrase = process.env['REMI_PASSPHRASE'];
    if (!envPassphrase) {
      throw new Error(
        'Identity is encrypted and REMI_PASSPHRASE is not set. ' +
          'Set REMI_PASSPHRASE or use an unencrypted identity.',
      );
    }
    try {
      identity = await unlockIdentity(storedIdentity, envPassphrase);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to unlock identity: ${detail}. Wrong passphrase?`);
    }
  } else {
    try {
      identity = await unlockIdentity(storedIdentity);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to unlock identity: ${detail}. Identity file may be corrupt. Run "remi keygen --force" to regenerate.`,
      );
    }
  }

  // Sign the challenge
  try {
    const challengeData = fromBase64(challengeMsg.challenge);
    const signature = await sign(identity.privateKey, challengeData);
    const response = createAuthResponse(identity.publicKeyRaw, signature, identity.fingerprint);
    ws.send(serialize(response));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to sign auth challenge: ${detail}`);
  }

  // Wait for auth_result (with timeout and close/error handling)
  return new Promise<AuthHandshakeResult>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', messageHandler);
      ws.removeEventListener('close', closeHandler);
      ws.removeEventListener('error', errorHandler);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Auth handshake timed out waiting for auth_result'));
    }, AUTH_HANDSHAKE_TIMEOUT_MS);

    const closeHandler = () => {
      cleanup();
      reject(new Error('WebSocket closed during auth handshake'));
    };

    const errorHandler = () => {
      cleanup();
      reject(new Error('WebSocket error during auth handshake'));
    };

    const messageHandler = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) return;

      if (msg.type === 'auth_result') {
        cleanup();
        if (msg.success) {
          resolve({ identity });
        } else {
          reject(new Error(`Authentication failed: ${msg.error ?? 'unknown'}`));
        }
      }
    };

    ws.addEventListener('message', messageHandler);
    ws.addEventListener('close', closeHandler);
    ws.addEventListener('error', errorHandler);
  });
}
