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
import { beginNativePairingTrust, cancelNativePairingTrust, commitNativePairingTrust, forgetNativeRelayPin, loadNativeRelayPins } from '../../src/lib/native-push-trust';
import { enableNativeSecurePush, prepareNativePushRegistration, validateNativePushRegistration } from '../../src/lib/native-push-registration';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel } from '../../src/components/settings/SettingsPanel';
import { DEFAULT_SETTINGS } from '../../src/types';

Object.assign(window, {
  nativeProviderTest: {
    chooseNativeIdentity,
    inspectNativeIdentity,
    unlockNativeIdentity,
    currentNativeIdentity,
    signClient,
    readNativePairingQR,
    beginNativePairingTrust,
    commitNativePairingTrust,
    cancelNativePairingTrust,
    loadNativeRelayPins,
    forgetNativeRelayPin,
    enableNativeSecurePush,
    prepareNativePushRegistration,
    validateNativePushRegistration,
    async renderNativeSettings() {
      const state = await inspectNativeIdentity();
      if (state.kind !== 'ready') throw new Error('Owned fixture identity unavailable.');
      const element = document.createElement('div');document.body.append(element);
      createRoot(element).render(createElement(SettingsPanel, {open:true,settings:DEFAULT_SETTINGS,onChange:()=>{},onClose:()=>{},
        onEnableSecurePush:()=>enableNativeSecurePush(state.identity)}));
      return true;
    },
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
