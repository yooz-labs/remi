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

/**
 * Perform auth handshake on a WebSocket that just received an auth_challenge.
 *
 * Resolves when auth_result with success=true is received.
 * Rejects on auth failure, timeout, or connection error.
 *
 * @param ws Open WebSocket connection
 * @param challengeMsg The auth_challenge message already received
 * @param onMessage Callback invoked for non-auth messages received during handshake
 * @returns Promise that resolves when auth succeeds
 */
export async function performAuthHandshake(
  ws: WebSocket,
  challengeMsg: ProtocolMessage & { type: 'auth_challenge' },
  onMessage?: (msg: ProtocolMessage) => void,
): Promise<AuthHandshakeResult> {
  const store = new IdentityStore();

  // Auto-generate identity if missing
  if (!store.exists()) {
    await store.generate();
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
    identity = await unlockIdentity(storedIdentity, envPassphrase);
  } else {
    identity = await unlockIdentity(storedIdentity);
  }

  // Sign the challenge
  const challengeData = fromBase64(challengeMsg.challenge);
  const signature = await sign(identity.privateKey, challengeData);
  const response = createAuthResponse(identity.publicKeyRaw, signature, identity.fingerprint);
  ws.send(serialize(response));

  // Wait for auth_result
  return new Promise<AuthHandshakeResult>((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) return;

      if (msg.type === 'auth_result') {
        ws.removeEventListener('message', handler);
        if (msg.success) {
          resolve({ identity });
        } else {
          reject(new Error(`Authentication failed: ${msg.error ?? 'unknown'}`));
        }
        return;
      }

      // Forward non-auth messages to caller
      onMessage?.(msg);
    };

    ws.addEventListener('message', handler);
  });
}
