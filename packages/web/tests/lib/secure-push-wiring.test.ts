/**
 * `App.tsx` connects the secure push subscription manager (#1200). `App.tsx`
 * has no component test and a browser cannot host the native identity, so this
 * is a source-wiring pin, the repo's idiom for wiring nothing else exercises.
 * The manager's behavior is tested against the real hub in
 * `secure-push-subscriptions.test.ts`; the Settings control in the WebKit tests.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'App.tsx'),
  'utf-8',
);

describe('App.tsx wires secure relay push (#1200)', () => {
  test('the manager registers through the relay connection with a native ticket', () => {
    expect(SOURCE).toContain('new SecurePushSubscriptions(');
    expect(SOURCE).toContain('registerRelayPush(connectionId as ConnectionId, registration)');
    expect(SOURCE).toContain('validate: () => validateNativePushRegistration(ticket)');
  });

  test('a new OS token re-registers', () => {
    expect(SOURCE).toContain(
      "window.addEventListener('remi:native-push-token-changed', changed)",
    );
    expect(SOURCE).toContain('const changed = () => securePushRef.current?.tokenChanged();');
  });

  test('only connected relay machines with a pin are targets, and only with a native identity', () => {
    expect(SOURCE).toContain(
      "connection.mode === 'relay' && connection.status === 'connected' && connection.relayPin",
    );
    expect(SOURCE).toContain('const targets = nativeIdentityKey === null ? [] :');
  });

  test('Settings offers the enable control only with a native identity and a relay machine', () => {
    expect(SOURCE).toContain(
      'nativeIdentity && hasRelayMachine ? () => enableNativeSecurePush(nativeIdentity) : undefined',
    );
  });

  test('forgetting a machine unregisters before the synchronous disconnect', () => {
    const forget = SOURCE.slice(SOURCE.indexOf('forget={async () => {'));
    const unregister = forget.indexOf('void unregisterRelayPush(deviceConnectionId)');
    const disconnect = forget.indexOf('disconnectConnection(deviceConnectionId);');
    expect(unregister).toBeGreaterThan(-1);
    expect(disconnect).toBeGreaterThan(unregister);
  });
});
