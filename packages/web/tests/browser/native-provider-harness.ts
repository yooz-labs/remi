import { createIdentity, fromBase64, relayV2, sign, unlockIdentity } from '@remi/shared';
import { signClient } from '../../src/lib/client-signer';
import { saveIdentity } from '../../src/lib/identity-client';
import {
  chooseNativeIdentity,
  currentNativeIdentity,
  inspectNativeIdentity,
  unlockNativeIdentity,
} from '../../src/lib/native-identity';
/** Runs the actual provider inside WKWebView; the Swift host supplies real guarded ingress. */
import { readNativePairingQR } from '../../src/lib/native-pairing-qr';

Object.assign(window, {
  nativeProviderTest: {
    chooseNativeIdentity,
    inspectNativeIdentity,
    unlockNativeIdentity,
    currentNativeIdentity,
    signClient,
    readNativePairingQR,
    async freshQRToken() {
      const { signer } = await relayV2.generateIdentity();
      return relayV2.encodePairingToken({
        relayUrl: 'ws://127.0.0.1:19999',
        machinePublicKey: signer.publicKey,
        secret: crypto.getRandomValues(new Uint8Array(32)),
        expiresAtSec: Math.floor(Date.now() / 1000) + 600,
      });
    },
    async storeLegacy(passphrase?: string) {
      const stored = await createIdentity(passphrase);
      saveIdentity(stored);
      const unlocked = await unlockIdentity(stored, passphrase);
      const probe = new TextEncoder().encode('native migration probe');
      return {
        publicKey: stored.publicKey,
        fingerprint: stored.fingerprint,
        signature: await sign(unlocked.privateKey, probe.buffer),
        message: Array.from(probe),
        publicLength: fromBase64(stored.publicKey).byteLength,
      };
    },
  },
});
