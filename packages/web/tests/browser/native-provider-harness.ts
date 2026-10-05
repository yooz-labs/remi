import { createIdentity, fromBase64, sign, unlockIdentity } from '@remi/shared';
/** Runs the actual provider inside WKWebView; the Swift host supplies real guarded ingress. */
import { signClient } from '../../src/lib/client-signer';
import { saveIdentity } from '../../src/lib/identity-client';
import {
  chooseNativeIdentity,
  currentNativeIdentity,
  inspectNativeIdentity,
  unlockNativeIdentity,
} from '../../src/lib/native-identity';

Object.assign(window, {
  nativeProviderTest: {
    chooseNativeIdentity,
    inspectNativeIdentity,
    unlockNativeIdentity,
    currentNativeIdentity,
    signClient,
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
